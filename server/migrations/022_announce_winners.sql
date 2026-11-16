-- Results privacy: voters never see results. The creator ANNOUNCES the winners instead (names only, no counts), once, after the close.
--
--   campaigns.winners_announced_at / _by / winners_announcement
--       The one-time claim. winners_announcement is the text and the winners per position, as announced (jsonb, names only). The app claims it
--       with UPDATE ... WHERE winners_announced_at IS NULL, so a double click or two admins cannot announce twice. Only a reset of the votes
--       (reset_campaign_votes, a trusted function) clears it, because a reset voids the result it announced.
--   notify_claims
--       One row per (campaign, kind of reminder): when it was last claimed. The reminder send takes the claim atomically BEFORE sending, so two
--       clicks cannot both pass the "not sent in the last hour" check. It holds no names.
--   results_published / publish_at / ... stay in the table (history) but nothing reads or writes them any more.

ALTER TABLE campaigns ADD COLUMN winners_announced_at timestamptz;
ALTER TABLE campaigns ADD COLUMN winners_announced_by uuid REFERENCES users(entra_oid);
ALTER TABLE campaigns ADD COLUMN winners_announcement jsonb;

CREATE FUNCTION campaigns_announcement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'namra_app' THEN
    IF NEW.winners_announced_at IS NOT NULL AND OLD.winners_announced_at IS NULL THEN
      IF NEW.status <> 'closed' THEN RAISE EXCEPTION 'winners can only be announced for a closed campaign' USING ERRCODE = 'check_violation'; END IF;
      IF NEW.winners_announced_by IS NULL OR NEW.winners_announcement IS NULL THEN
        RAISE EXCEPTION 'an announcement must record who announced, when, and what' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF OLD.winners_announced_at IS NOT NULL AND (NEW.winners_announced_at IS DISTINCT FROM OLD.winners_announced_at
         OR NEW.winners_announced_by IS DISTINCT FROM OLD.winners_announced_by OR NEW.winners_announcement IS DISTINCT FROM OLD.winners_announcement) THEN
      RAISE EXCEPTION 'an announcement cannot be altered or withdrawn' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_announcement_guard BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION campaigns_announcement_guard();

CREATE TABLE notify_claims (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('open', 'reminder', 'closing_soon')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  claimed_by uuid REFERENCES users(entra_oid),
  PRIMARY KEY (campaign_id, kind)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON notify_claims TO namra_app;

-- A reset voids the announcement (same function as migration 019, plus the three columns).
CREATE OR REPLACE FUNCTION reset_campaign_votes(p_campaign uuid, p_session text, p_reason text, p_closes_at timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor uuid := session_actor(p_session);
  c campaigns%ROWTYPE;
  n_ballots int;
  n_receipts int;
  tally_json jsonb;
  snapshot jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = 'NR401'; END IF;
  SELECT * INTO c FROM campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR c.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = 'NR404';
  END IF;
  IF c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'an archived campaign cannot be reset' USING ERRCODE = 'NR409';
  END IF;
  IF c.status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'only an open or closed campaign can be reset (status is %)', c.status USING ERRCODE = 'NR409';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'a reason of at least 10 characters is required' USING ERRCODE = 'NR400';
  END IF;
  IF p_closes_at IS NOT NULL AND p_closes_at <= now() THEN
    RAISE EXCEPTION 'the new closing time must be in the future' USING ERRCODE = 'NR400';
  END IF;
  IF p_closes_at IS NULL AND c.closes_at IS NOT NULL AND c.closes_at <= now() THEN
    RAISE EXCEPTION 'the closing time has passed: give a new closing time' USING ERRCODE = 'NR409';
  END IF;

  SELECT coalesce(sum(votes), 0)::int INTO n_ballots FROM tallies WHERE campaign_id = p_campaign;
  SELECT count(*)::int INTO n_receipts FROM vote_receipts WHERE campaign_id = p_campaign;
  SELECT coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'votes', t.votes, 'position', t.position) ORDER BY t.pos_order, t.sort_order, t.name), '[]'::jsonb) INTO tally_json
    FROM (SELECT k.name, k.sort_order, p.sort_order AS pos_order, p.title AS position, coalesce(y.votes, 0) AS votes
            FROM candidates k JOIN positions p ON p.id = k.position_id
            LEFT JOIN tallies y ON y.candidate_id = k.id AND y.campaign_id = k.campaign_id
           WHERE k.campaign_id = p_campaign AND k.status = 'approved') t;
  snapshot := jsonb_build_object('candidates', tally_json, 'turnout', jsonb_build_object('votes', n_receipts, 'ballots', n_ballots));

  UPDATE tallies SET votes = 0 WHERE campaign_id = p_campaign;
  DELETE FROM vote_receipts WHERE campaign_id = p_campaign;
  UPDATE campaigns SET status = 'open', results_published = false, closes_at = coalesce(p_closes_at, closes_at),
         winners_announced_at = NULL, winners_announced_by = NULL, winners_announcement = NULL WHERE id = p_campaign;   -- a reset voids the announcement

  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (v_actor, 'campaign.reset', p_campaign,
            jsonb_build_object('reason', btrim(p_reason), 'previous_status', c.status, 'new_closes_at', p_closes_at, 'snapshot', snapshot));
  RETURN jsonb_build_object('votes_cleared', n_receipts, 'snapshot', snapshot);
END $$;
