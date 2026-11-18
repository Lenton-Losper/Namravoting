-- Eligible-list hardening.
--
--  1. eligible_voters can only change while the campaign is a DRAFT. A database trigger rejects INSERT / DELETE (and any other UPDATE) once the
--     campaign has started, for every role. The only ways through are two audited paths, each of which switches the guard off for ONE
--     transaction with a named reason AND is refused for the application role itself (`namra_app` cannot flip the switch):
--       'late_add'  late_add_eligible(): the creator adds one person to a running vote (SECURITY DEFINER, audited as voter.late_added);
--       'retention' the retention job (owner role): marks a leaver, or purges the list of a closed + archived campaign (audited per campaign).
--     Binding a row to the person's account id (voter_oid, NULL -> value, once) is allowed at any time: it adds no one and removes no one.
--  2. A SHA-256 of the sorted list (eligible_list_sha256) is recorded in the audit trail at eligibility.set, campaign.start, every late add
--     and every purge, so a later change to the list is detectable.
--  3. A leaver is MARKED (left_at), never removed, on a campaign that has started: eligible counts and quorums stay what they were.
--  4. voter_oid: the Entra object id of the person an address belongs to, set the first time they sign in with Microsoft. From then on
--     eligibility follows the account, not the address (an address that is renamed or reused by someone else no longer matches).
--     users.entra_signin_at records that an account has signed in through Microsoft (as opposed to the typed-email demo).

ALTER TABLE eligible_voters ADD COLUMN left_at timestamptz;
ALTER TABLE eligible_voters ADD COLUMN voter_oid uuid REFERENCES users(entra_oid);
CREATE INDEX eligible_voters_oid_idx ON eligible_voters (campaign_id, voter_oid) WHERE voter_oid IS NOT NULL;
ALTER TABLE users ADD COLUMN entra_signin_at timestamptz;

-- The app may bind an address to an account (voter_oid only). It still cannot change anything else.
GRANT UPDATE (voter_oid) ON eligible_voters TO namra_app;

-- SHA-256 (hex) of the list: the lower-case addresses sorted byte-wise, joined by line feeds. Leavers stay in it (the list itself did not change).
CREATE FUNCTION eligible_list_sha256(p_campaign uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(sha256(convert_to(coalesce(string_agg(voter_email, E'\n' ORDER BY voter_email COLLATE "C"), ''), 'UTF8')), 'hex')
    FROM eligible_voters WHERE campaign_id = p_campaign
$$;

-- The same for an Umoja campaign's frozen voter list: the active member codes, sorted byte-wise, joined by line feeds.
CREATE FUNCTION campaign_voters_sha256(p_campaign uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(sha256(convert_to(coalesce(string_agg(member_code, E'\n' ORDER BY member_code COLLATE "C"), ''), 'UTF8')), 'hex')
    FROM campaign_voters WHERE campaign_id = p_campaign AND active
$$;

CREATE FUNCTION eligible_voters_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cid uuid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  st text; archived timestamptz;
  bypass text := current_setting('namra.eligible_bypass', true);
  app boolean := current_user = 'namra_app';
BEGIN
  SELECT status, archived_at INTO st, archived FROM campaigns WHERE id = cid;
  -- A draft is free to edit. No campaign row (it is being deleted: the cascade, or the delete of a draft) is fine too.
  IF st IS NULL OR st = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.voter_email IS DISTINCT FROM OLD.voter_email THEN
      RAISE EXCEPTION 'the voter list of campaign % is locked: an address cannot be changed', cid USING ERRCODE = 'check_violation';
    END IF;
    -- binding an address to the account that owns it: once (NULL -> value), at any time
    IF NEW.left_at IS NOT DISTINCT FROM OLD.left_at AND OLD.voter_oid IS NULL AND NEW.voter_oid IS NOT NULL THEN RETURN NEW; END IF;
    -- marking a leaver: retention job only, once
    IF NEW.voter_oid IS NOT DISTINCT FROM OLD.voter_oid AND OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
       AND bypass = 'retention' AND NOT app THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'the voter list of campaign % is locked: a started vote keeps its list', cid USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' AND bypass = 'late_add' AND st = 'open' AND NOT app THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND bypass = 'retention' AND st = 'closed' AND archived IS NOT NULL AND NOT app THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'the voter list of campaign % is locked: it cannot be %', cid, CASE TG_OP WHEN 'INSERT' THEN 'added to' ELSE 'removed from' END
    USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER eligible_voters_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON eligible_voters
  FOR EACH ROW EXECUTE FUNCTION eligible_voters_guard();

-- The whole table cannot be emptied with TRUNCATE by the app role either (it has no TRUNCATE right, so this is only a reminder):
-- the owner role is the retention/migration role and is not the application.

-- Late add: the one way the app can add an address to a running vote. The creator only (checked here from the live session), open
-- campaign, listed mode, a reason of 10+ characters. It writes the audit entry itself, with the hash of the list after the change.
-- Errors: NR401 no live session, NR404 not found / not the creator, NR409 wrong state, NR400 bad input.
CREATE FUNCTION late_add_eligible(p_campaign uuid, p_session text, p_email text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor uuid := session_actor(p_session);
  c campaigns%ROWTYPE;
  v_email text := lower(btrim(p_email));
  n int; total int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = 'NR401'; END IF;
  SELECT * INTO c FROM campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR c.created_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'campaign not found' USING ERRCODE = 'NR404'; END IF;
  IF c.status <> 'open' THEN RAISE EXCEPTION 'only a running vote can have a voter added (status is %)', c.status USING ERRCODE = 'NR409'; END IF;
  IF c.eligibility <> 'list' THEN RAISE EXCEPTION 'this vote does not use an email list' USING ERRCODE = 'NR409'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN RAISE EXCEPTION 'give a reason of at least 10 characters' USING ERRCODE = 'NR400'; END IF;
  IF v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' OR char_length(v_email) > 254 THEN RAISE EXCEPTION 'not a valid email address' USING ERRCODE = 'NR400'; END IF;
  PERFORM set_config('namra.eligible_bypass', 'late_add', true);   -- this transaction only
  INSERT INTO eligible_voters (campaign_id, voter_email) VALUES (p_campaign, v_email) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('namra.eligible_bypass', '', true);
  IF n = 0 THEN RETURN jsonb_build_object('inserted', false); END IF;
  SELECT count(*)::int INTO total FROM eligible_voters WHERE campaign_id = p_campaign;
  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (v_actor, 'voter.late_added', p_campaign,
            jsonb_build_object('mode', 'list', 'email', v_email, 'reason', btrim(p_reason), 'list_count', total, 'list_sha256', eligible_list_sha256(p_campaign)));
  RETURN jsonb_build_object('inserted', true, 'list_count', total, 'list_sha256', eligible_list_sha256(p_campaign));
END $$;
REVOKE ALL ON FUNCTION late_add_eligible(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION late_add_eligible(uuid, text, text, text) TO namra_app;

-- The permanent delete of an archived campaign used to delete the voter list first, on its own. With the guard in place the list goes
-- with the campaign (ON DELETE CASCADE), which the guard allows because the campaign is being removed. Everything else is unchanged (migration 011).
CREATE OR REPLACE FUNCTION delete_archived_campaign(p_campaign uuid, p_session text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor uuid := session_actor(p_session);
  c campaigns%ROWTYPE;
  photos text[];
  n_cand int;
  n_ballots int;
  n_receipts int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = 'NR401'; END IF;
  SELECT * INTO c FROM campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR c.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = 'NR404';
  END IF;
  IF c.status <> 'closed' OR c.archived_at IS NULL THEN
    RAISE EXCEPTION 'only an archived campaign can be permanently deleted' USING ERRCODE = 'NR409';
  END IF;
  SELECT coalesce(array_agg(photo_path) FILTER (WHERE photo_path IS NOT NULL), '{}'), count(*)::int
    INTO photos, n_cand FROM candidates WHERE campaign_id = p_campaign;
  SELECT coalesce(sum(votes), 0)::int INTO n_ballots FROM tallies WHERE campaign_id = p_campaign;
  DELETE FROM vote_receipts WHERE campaign_id = p_campaign;    GET DIAGNOSTICS n_receipts = ROW_COUNT;
  DELETE FROM campaigns WHERE id = p_campaign;                  -- cascades to candidates, tallies, the voter snapshot and the voter list
  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (v_actor, 'campaign.delete_permanent', p_campaign,
            jsonb_build_object('title', c.title, 'ballots_removed', n_ballots, 'receipts_removed', n_receipts, 'candidates_removed', n_cand));
  RETURN jsonb_build_object('title', c.title, 'ballots', n_ballots, 'receipts', n_receipts, 'candidates', n_cand, 'photos', to_jsonb(photos));
END $$;
