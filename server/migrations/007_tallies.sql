-- SEC-02: no row per vote. A per-candidate counter replaces the `ballots` table.
--
-- Why: a `ballots` row and its `vote_receipts` row were written in the same transaction, so both carried the same hidden
-- `xmin` (and adjacent `ctid`s). Anyone with SELECT could join receipts to ballots and read every vote. With counters there
-- is no per-vote row at all. The vote transaction does `votes = votes + 1` on one tally row in the same transaction as the
-- receipt; the application then "re-stamps" every tally row of the campaign in a separate transaction so that no tally row
-- keeps the xmin of a voter's transaction (see services/voting.ts).

CREATE TABLE tallies (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL,
  votes int NOT NULL DEFAULT 0 CHECK (votes >= 0),
  PRIMARY KEY (campaign_id, candidate_id),
  FOREIGN KEY (candidate_id, campaign_id) REFERENCES candidates (id, campaign_id) ON DELETE CASCADE
);

-- Existing data: one row per candidate of every campaign that has started (drafts get their rows when they start).
INSERT INTO tallies (campaign_id, candidate_id, votes)
SELECT k.campaign_id, k.id, count(b.id)::int
  FROM candidates k
  JOIN campaigns c ON c.id = k.campaign_id AND c.status <> 'draft'
  LEFT JOIN ballots b ON b.candidate_id = k.id AND b.campaign_id = k.campaign_id
 GROUP BY k.campaign_id, k.id;

DROP TABLE ballots;

GRANT SELECT, INSERT, UPDATE ON tallies TO namra_app;   -- no DELETE, no TRUNCATE

-- Defence in depth for the app role: a counter may grow by one vote (or be re-stamped unchanged), nothing else. The
-- SECURITY DEFINER reset function runs as the owner, so it can zero the counters.
CREATE FUNCTION tallies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_id <> OLD.campaign_id OR NEW.candidate_id <> OLD.candidate_id THEN
    RAISE EXCEPTION 'a tally row cannot be moved' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'namra_app' AND NEW.votes NOT IN (OLD.votes, OLD.votes + 1) THEN
    RAISE EXCEPTION 'a tally can only grow by one vote at a time' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tallies_guard BEFORE UPDATE ON tallies FOR EACH ROW EXECUTE FUNCTION tallies_guard();

-- Permanent delete: ballots no longer exist; the tally rows go with the campaign (ON DELETE CASCADE).
CREATE OR REPLACE FUNCTION delete_archived_campaign(p_campaign uuid, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c campaigns%ROWTYPE;
  photos text[];
  n_cand int;
  n_ballots int;
  n_receipts int;
BEGIN
  SELECT * INTO c FROM campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR c.created_by IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = 'NR404';
  END IF;
  IF c.status <> 'closed' OR c.archived_at IS NULL THEN
    RAISE EXCEPTION 'only an archived campaign can be permanently deleted' USING ERRCODE = 'NR409';
  END IF;
  SELECT coalesce(array_agg(photo_path) FILTER (WHERE photo_path IS NOT NULL), '{}'), count(*)::int
    INTO photos, n_cand FROM candidates WHERE campaign_id = p_campaign;
  SELECT coalesce(sum(votes), 0)::int INTO n_ballots FROM tallies WHERE campaign_id = p_campaign;
  DELETE FROM vote_receipts WHERE campaign_id = p_campaign;    GET DIAGNOSTICS n_receipts = ROW_COUNT;
  DELETE FROM eligible_voters WHERE campaign_id = p_campaign;
  DELETE FROM campaigns WHERE id = p_campaign;                  -- cascades to candidates and tallies
  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (p_actor, 'campaign.delete_permanent', p_campaign,
            jsonb_build_object('title', c.title, 'ballots_removed', n_ballots, 'receipts_removed', n_receipts, 'candidates_removed', n_cand));
  RETURN jsonb_build_object('title', c.title, 'ballots', n_ballots, 'receipts', n_receipts, 'candidates', n_cand, 'photos', to_jsonb(photos));
END $$;

-- Reset: snapshot the counters, zero them, delete the receipts, re-open. Same locking as before (FOR UPDATE on the campaign
-- row, which every vote holds FOR SHARE), so receipts always equal the sum of the tallies.
CREATE OR REPLACE FUNCTION reset_campaign_votes(p_campaign uuid, p_actor uuid, p_reason text, p_closes_at timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c campaigns%ROWTYPE;
  n_ballots int;
  n_receipts int;
  tally_json jsonb;
  snapshot jsonb;
BEGIN
  SELECT * INTO c FROM campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR c.created_by IS DISTINCT FROM p_actor THEN
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'votes', t.votes) ORDER BY t.sort_order, t.name), '[]'::jsonb) INTO tally_json
    FROM (SELECT k.name, k.sort_order, coalesce(y.votes, 0) AS votes
            FROM candidates k LEFT JOIN tallies y ON y.candidate_id = k.id AND y.campaign_id = k.campaign_id
           WHERE k.campaign_id = p_campaign) t;
  snapshot := jsonb_build_object('candidates', tally_json, 'turnout', jsonb_build_object('votes', n_receipts, 'ballots', n_ballots));

  UPDATE tallies SET votes = 0 WHERE campaign_id = p_campaign;
  DELETE FROM vote_receipts WHERE campaign_id = p_campaign;
  UPDATE campaigns SET status = 'open', results_published = false, closes_at = coalesce(p_closes_at, closes_at) WHERE id = p_campaign;

  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (p_actor, 'campaign.reset', p_campaign,
            jsonb_build_object('reason', btrim(p_reason), 'previous_status', c.status, 'new_closes_at', p_closes_at, 'snapshot', snapshot));
  RETURN jsonb_build_object('votes_cleared', n_receipts, 'snapshot', snapshot);
END $$;
