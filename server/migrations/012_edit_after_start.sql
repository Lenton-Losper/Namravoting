-- "Allow edits after start": an owner can choose, while the campaign is still a draft, to keep a few things editable once it is open.
--
--   * title, description and closing time stay editable while the campaign is OPEN;
--   * candidates can be added, edited or removed only until the FIRST VOTE is cast (no receipt exists yet);
--   * eligibility, the opening time and this flag itself are locked from the moment the campaign starts (the voter list is
--     frozen in a snapshot at start, SEC-05);
--   * a closed campaign is locked completely.
-- The application writes an audit entry for every such edit; the database enforces the limits below even if the app is wrong.

ALTER TABLE campaigns ADD COLUMN allow_edits_after_start boolean NOT NULL DEFAULT false;

-- Candidates: draft as before; open + allow_edits_after_start + no receipt yet is the one new exception. (The application takes the
-- campaign row FOR UPDATE and a vote holds it FOR SHARE, so "no receipt yet" cannot change underneath an edit.)
CREATE OR REPLACE FUNCTION candidates_require_draft() RETURNS trigger AS $$
DECLARE cid uuid; st text; allow boolean;
BEGIN
  cid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status, allow_edits_after_start INTO st, allow FROM campaigns WHERE id = cid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    IF st = 'open' AND allow AND NOT EXISTS (SELECT 1 FROM vote_receipts WHERE campaign_id = cid) THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
    RAISE EXCEPTION 'campaign % is locked', cid USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

-- Campaigns: same state machine as migration 011, with the post-start exception for title, description and closing time.
CREATE OR REPLACE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.share_token <> OLD.share_token OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a campaign''s id, share token and creator cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'namra_app' THEN
    IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status = 'open') OR (OLD.status = 'open' AND NEW.status = 'closed')) THEN
      RAISE EXCEPTION 'illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'draft' THEN
      IF NEW.opens_at IS DISTINCT FROM OLD.opens_at OR NEW.eligibility <> OLD.eligibility
         OR NEW.allow_edits_after_start <> OLD.allow_edits_after_start THEN
        RAISE EXCEPTION 'campaign % is locked', OLD.id USING ERRCODE = 'check_violation';
      END IF;
      IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description OR NEW.closes_at IS DISTINCT FROM OLD.closes_at)
         AND NOT (OLD.status = 'open' AND NEW.status = 'open' AND OLD.allow_edits_after_start) THEN
        RAISE EXCEPTION 'campaign % is locked', OLD.id USING ERRCODE = 'check_violation';
      END IF;
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
