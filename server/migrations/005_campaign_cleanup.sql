-- Campaign clean-up: archive closed campaigns, delete drafts, permanently delete archived campaigns.
--
-- The app role (namra_app) deliberately gets NO new DELETE grants: it still cannot delete from ballots, vote_receipts,
-- audit_log or campaigns. Deletion happens only through the two SECURITY DEFINER functions below, which are owned by
-- the migration (owner) role, re-check creator + status inside the function, run in one transaction, and write the
-- audit entry in that same transaction. The audit log itself is never deleted.

ALTER TABLE campaigns ADD COLUMN archived_at timestamptz;
-- Only a closed campaign can be archived (defence in depth; the app checks too).
ALTER TABLE campaigns ADD CONSTRAINT campaigns_archive_only_closed CHECK (archived_at IS NULL OR status = 'closed');

-- Hard-deletes a DRAFT: its candidates, eligibility rows and the campaign. Returns what the caller must clean up afterwards
-- (photo files). Errors: NR404 = no such campaign for this actor (not found OR not the creator), NR409 = not a draft.
CREATE FUNCTION delete_draft_campaign(p_campaign uuid, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c campaigns%ROWTYPE;
  photos text[];
  n_cand int;
BEGIN
  SELECT * INTO c FROM campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR c.created_by IS DISTINCT FROM p_actor THEN
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
    VALUES (p_actor, 'campaign.delete_draft', p_campaign, jsonb_build_object('title', c.title, 'candidates', n_cand));
  RETURN jsonb_build_object('title', c.title, 'candidates', n_cand, 'photos', to_jsonb(photos));
END $$;

-- Permanently deletes an ARCHIVED campaign: ballots, receipts, candidates, eligibility and the campaign, in one
-- transaction. Errors: NR404 = not found / not the creator, NR409 = not archived.
-- (The candidates are removed by the campaign's ON DELETE CASCADE: the draft-only trigger on candidates allows that
--  because the parent row is already gone. Ballots and receipts have no cascade, so they are deleted first, explicitly.)
CREATE FUNCTION delete_archived_campaign(p_campaign uuid, p_actor uuid) RETURNS jsonb
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
  DELETE FROM ballots WHERE campaign_id = p_campaign;          GET DIAGNOSTICS n_ballots = ROW_COUNT;
  DELETE FROM vote_receipts WHERE campaign_id = p_campaign;    GET DIAGNOSTICS n_receipts = ROW_COUNT;
  DELETE FROM eligible_voters WHERE campaign_id = p_campaign;
  DELETE FROM campaigns WHERE id = p_campaign;                  -- cascades to candidates
  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (p_actor, 'campaign.delete_permanent', p_campaign,
            jsonb_build_object('title', c.title, 'ballots_removed', n_ballots, 'receipts_removed', n_receipts, 'candidates_removed', n_cand));
  RETURN jsonb_build_object('title', c.title, 'ballots', n_ballots, 'receipts', n_receipts, 'candidates', n_cand, 'photos', to_jsonb(photos));
END $$;

-- Resets an OPEN or CLOSED (not archived) campaign: snapshots the tallies and turnout into the audit log, deletes every ballot
-- and receipt, and re-opens the campaign (optionally with a new closes_at). Candidates, photos and eligibility are untouched.
-- Takes FOR UPDATE on the campaign row, the same row every vote holds FOR SHARE: a vote in flight finishes first (and is then
-- wiped with the rest), a vote arriving meanwhile waits, retries and sees the re-opened campaign. So ballots = receipts always.
-- Errors: NR404 not found / not creator; NR409 wrong state (draft, archived) or the closing time has passed and no new one was
-- given; NR400 reason too short / new closing time not in the future.
CREATE FUNCTION reset_campaign_votes(p_campaign uuid, p_actor uuid, p_reason text, p_closes_at timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c campaigns%ROWTYPE;
  n_ballots int;
  n_receipts int;
  tallies jsonb;
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

  SELECT count(*)::int INTO n_ballots FROM ballots WHERE campaign_id = p_campaign;
  SELECT count(*)::int INTO n_receipts FROM vote_receipts WHERE campaign_id = p_campaign;
  SELECT coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'votes', t.votes) ORDER BY t.sort_order, t.name), '[]'::jsonb) INTO tallies
    FROM (SELECT k.name, k.sort_order, count(b.id)::int AS votes
            FROM candidates k LEFT JOIN ballots b ON b.candidate_id = k.id AND b.campaign_id = k.campaign_id
           WHERE k.campaign_id = p_campaign GROUP BY k.id) t;
  snapshot := jsonb_build_object('candidates', tallies, 'turnout', jsonb_build_object('votes', n_receipts, 'ballots', n_ballots));

  DELETE FROM ballots WHERE campaign_id = p_campaign;
  DELETE FROM vote_receipts WHERE campaign_id = p_campaign;
  UPDATE campaigns SET status = 'open', results_published = false, closes_at = coalesce(p_closes_at, closes_at) WHERE id = p_campaign;

  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (p_actor, 'campaign.reset', p_campaign,
            jsonb_build_object('reason', btrim(p_reason), 'previous_status', c.status, 'new_closes_at', p_closes_at, 'snapshot', snapshot));
  RETURN jsonb_build_object('votes_cleared', n_receipts, 'snapshot', snapshot);
END $$;

REVOKE ALL ON FUNCTION delete_draft_campaign(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_archived_campaign(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_draft_campaign(uuid, uuid) TO namra_app;
GRANT EXECUTE ON FUNCTION delete_archived_campaign(uuid, uuid) TO namra_app;
REVOKE ALL ON FUNCTION reset_campaign_votes(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_campaign_votes(uuid, uuid, text, timestamptz) TO namra_app;
