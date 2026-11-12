-- SEC-17: (1) the clean-up functions no longer take the actor as an argument; they derive it from a live server-side session,
--         (2) the campaign state machine is enforced by the database for the app role.
--
-- (1) Before, `delete_archived_campaign(campaign, actor)` believed whatever actor id the caller passed. Now the caller passes
-- the RAW session id from the browser's cookie and the function looks up whose live (unexpired, unrevoked) session it is.
-- The database only stores a hash of session ids (migration 010), so a reader of the sessions table cannot name an actor.
-- The functions stay SECURITY DEFINER with a pinned search_path (pg_catalog first), re-check creator + state, and are not
-- executable by PUBLIC.

CREATE FUNCTION session_actor(p_session text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.user_oid FROM sessions s
   WHERE p_session IS NOT NULL AND s.id_hash = encode(sha256(convert_to(p_session, 'UTF8')), 'hex')
     AND s.revoked_at IS NULL AND s.expires_at > now()
$$;
REVOKE ALL ON FUNCTION session_actor(text) FROM PUBLIC;   -- only the functions below call it (they run as the owner)

DROP FUNCTION delete_draft_campaign(uuid, uuid);
DROP FUNCTION delete_archived_campaign(uuid, uuid);
DROP FUNCTION reset_campaign_votes(uuid, uuid, text, timestamptz);

-- Errors: NR401 = no live session, NR404 = no such campaign for this actor (not found OR not the creator), NR409 = wrong state.
CREATE FUNCTION delete_draft_campaign(p_campaign uuid, p_session text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor uuid := session_actor(p_session);
  c campaigns%ROWTYPE;
  photos text[];
  n_cand int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = 'NR401'; END IF;
  SELECT * INTO c FROM campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR c.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = 'NR404';
  END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft can be deleted (status is %)', c.status USING ERRCODE = 'NR409';
  END IF;
  SELECT coalesce(array_agg(photo_path) FILTER (WHERE photo_path IS NOT NULL), '{}'), count(*)::int
    INTO photos, n_cand FROM candidates WHERE campaign_id = p_campaign;
  DELETE FROM eligible_voters WHERE campaign_id = p_campaign;
  DELETE FROM candidates WHERE campaign_id = p_campaign;        -- allowed: the campaign is still a draft
  DELETE FROM campaigns WHERE id = p_campaign;
  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (v_actor, 'campaign.delete_draft', p_campaign, jsonb_build_object('title', c.title, 'candidates', n_cand));
  RETURN jsonb_build_object('title', c.title, 'candidates', n_cand, 'photos', to_jsonb(photos));
END $$;

CREATE FUNCTION delete_archived_campaign(p_campaign uuid, p_session text) RETURNS jsonb
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
  DELETE FROM eligible_voters WHERE campaign_id = p_campaign;
  DELETE FROM campaigns WHERE id = p_campaign;                  -- cascades to candidates, tallies and the voter snapshot
  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (v_actor, 'campaign.delete_permanent', p_campaign,
            jsonb_build_object('title', c.title, 'ballots_removed', n_ballots, 'receipts_removed', n_receipts, 'candidates_removed', n_cand));
  RETURN jsonb_build_object('title', c.title, 'ballots', n_ballots, 'receipts', n_receipts, 'candidates', n_cand, 'photos', to_jsonb(photos));
END $$;

CREATE FUNCTION reset_campaign_votes(p_campaign uuid, p_session text, p_reason text, p_closes_at timestamptz DEFAULT NULL) RETURNS jsonb
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'votes', t.votes) ORDER BY t.sort_order, t.name), '[]'::jsonb) INTO tally_json
    FROM (SELECT k.name, k.sort_order, coalesce(y.votes, 0) AS votes
            FROM candidates k LEFT JOIN tallies y ON y.candidate_id = k.id AND y.campaign_id = k.campaign_id
           WHERE k.campaign_id = p_campaign) t;
  snapshot := jsonb_build_object('candidates', tally_json, 'turnout', jsonb_build_object('votes', n_receipts, 'ballots', n_ballots));

  UPDATE tallies SET votes = 0 WHERE campaign_id = p_campaign;
  DELETE FROM vote_receipts WHERE campaign_id = p_campaign;
  UPDATE campaigns SET status = 'open', results_published = false, closes_at = coalesce(p_closes_at, closes_at) WHERE id = p_campaign;

  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (v_actor, 'campaign.reset', p_campaign,
            jsonb_build_object('reason', btrim(p_reason), 'previous_status', c.status, 'new_closes_at', p_closes_at, 'snapshot', snapshot));
  RETURN jsonb_build_object('votes_cleared', n_receipts, 'snapshot', snapshot);
END $$;

REVOKE ALL ON FUNCTION delete_draft_campaign(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_archived_campaign(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_campaign_votes(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_draft_campaign(uuid, text) TO namra_app;
GRANT EXECUTE ON FUNCTION delete_archived_campaign(uuid, text) TO namra_app;
GRANT EXECUTE ON FUNCTION reset_campaign_votes(uuid, text, text, timestamptz) TO namra_app;

-- (2) The state machine, enforced by the database for the app role (the definer functions above run as the owner and are
-- the only way back from closed to open). Even a buggy or compromised app cannot reopen a closed campaign, edit a started
-- one, change who owns it, or unpublish results.
CREATE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.share_token <> OLD.share_token OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a campaign''s id, share token and creator cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'namra_app' THEN
    IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status = 'open') OR (OLD.status = 'open' AND NEW.status = 'closed')) THEN
      RAISE EXCEPTION 'illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'draft' AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
         OR NEW.opens_at IS DISTINCT FROM OLD.opens_at OR NEW.closes_at IS DISTINCT FROM OLD.closes_at OR NEW.eligibility <> OLD.eligibility) THEN
      RAISE EXCEPTION 'campaign % is locked', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.results_published AND NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'results can only be published for a closed campaign' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.results_published AND NOT NEW.results_published THEN
      RAISE EXCEPTION 'published results cannot be withdrawn' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL AND NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'only a closed campaign can be archived' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_guard BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION campaigns_guard();
