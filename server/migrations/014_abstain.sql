-- Abstain / none of the above (business-logic plan item 2).
--   campaigns.allow_abstain  set while the campaign is a draft, locked from the moment it starts (like eligibility).
--   candidates.is_abstain    the Abstain line is a candidate row with this flag, so it has a tally counter like any candidate and the
--                            invariant "receipts = sum of tallies" (SEC-16) holds with no special case. It is never a winner (domain/results.ts).
ALTER TABLE campaigns ADD COLUMN allow_abstain boolean NOT NULL DEFAULT false;
ALTER TABLE candidates ADD COLUMN is_abstain boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX candidates_one_abstain_idx ON candidates (campaign_id) WHERE is_abstain;

CREATE OR REPLACE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.share_token <> OLD.share_token OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a campaign''s id, share token and creator cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'namra_app' THEN
    IF NEW.allow_abstain <> OLD.allow_abstain AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'campaign % is locked', OLD.id USING ERRCODE = 'check_violation';
    END IF;
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
