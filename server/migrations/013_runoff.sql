-- Ties (business-logic plan item 1): a run-off is a new campaign linked to the one that tied.
--   parent_campaign_id  the campaign this is a run-off of (SET NULL if the parent is ever permanently deleted: the run-off stands alone)
--   runoff_round        0 = an ordinary campaign, 1 = first run-off, 2 = second run-off ...
-- Both are set when the row is created and never change.
ALTER TABLE campaigns ADD COLUMN parent_campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD COLUMN runoff_round int NOT NULL DEFAULT 0 CHECK (runoff_round >= 0);
CREATE INDEX campaigns_parent_idx ON campaigns (parent_campaign_id) WHERE parent_campaign_id IS NOT NULL;

CREATE OR REPLACE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.share_token <> OLD.share_token OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a campaign''s id, share token and creator cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'namra_app' THEN
    IF NEW.runoff_round <> OLD.runoff_round OR (NEW.parent_campaign_id IS DISTINCT FROM OLD.parent_campaign_id AND NEW.parent_campaign_id IS NOT NULL) THEN
      RAISE EXCEPTION 'a campaign''s run-off link cannot change' USING ERRCODE = 'check_violation';
    END IF;
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
