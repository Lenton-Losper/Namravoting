-- A candidate withdraws after voting has started (business-logic plan item 4).
--
-- A withdrawn candidate stays on the ballot, greyed out and impossible to choose. Votes already cast for them are VOID: they stay in the
-- counters (turnout and the seal are unchanged) but are reported separately and can never make the candidate win or tie. Because a ballot
-- is secret nobody can say WHO voted for them, so voters cannot be asked to vote again; to have everyone vote again the creator uses
-- "Reset votes". The row is only ever marked, never changed or deleted, and a withdrawal cannot be undone.

ALTER TABLE candidates ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE candidates ADD COLUMN withdrawn_by uuid REFERENCES users(entra_oid);
ALTER TABLE candidates ADD COLUMN withdrawn_reason text;
ALTER TABLE candidates ADD CONSTRAINT candidates_withdrawn_consistent CHECK ((withdrawn_at IS NULL) = (withdrawn_reason IS NULL));
ALTER TABLE candidates ADD CONSTRAINT candidates_abstain_not_withdrawn CHECK (NOT (is_abstain AND withdrawn_at IS NOT NULL));

CREATE OR REPLACE FUNCTION candidates_require_draft() RETURNS trigger AS $$
DECLARE cid uuid; st text; allow boolean;
BEGIN
  cid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status, allow_edits_after_start INTO st, allow FROM campaigns WHERE id = cid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    -- the one change an OPEN campaign always allows: marking a candidate withdrawn (nothing else about the row may change)
    IF st = 'open' AND TG_OP = 'UPDATE' AND OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
       AND NEW.campaign_id = OLD.campaign_id AND NEW.name IS NOT DISTINCT FROM OLD.name AND NEW.bio IS NOT DISTINCT FROM OLD.bio
       AND NEW.photo_path IS NOT DISTINCT FROM OLD.photo_path AND NEW.sort_order = OLD.sort_order AND NEW.is_abstain = OLD.is_abstain THEN
      RETURN NEW;
    END IF;
    IF st = 'open' AND allow AND NOT EXISTS (SELECT 1 FROM vote_receipts WHERE campaign_id = cid) THEN
      -- (edits after start, migration 012) but a withdrawal is never undone or edited away
      IF TG_OP = 'UPDATE' AND OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason) THEN
        RAISE EXCEPTION 'a withdrawal cannot be undone' USING ERRCODE = 'check_violation';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END IF;
    RAISE EXCEPTION 'campaign % is locked', cid USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
