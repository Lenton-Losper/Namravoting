-- Ballot redesign: a one-line pledge per candidate, an optional results-release date per campaign, and a receipt code per vote.
--
--   candidates.pledge              optional, at most 160 characters: the one line voters see on the ballot card (the bio is the full
--                                  statement). Locked with the rest of the candidate once the campaign starts (candidates_require_draft).
--   campaigns.results_release_at   optional, DISPLAY ONLY: the receipt says "Results will be shared on <date>". Publishing stays manual.
--   vote_receipts.receipt_code     a random, human-readable code (e.g. UV-7K3M-Q9TD) made when the vote is cast and stored ONLY on the
--                                  receipt row, which has no candidate. It proves that the member voted in that position, never for whom:
--                                  it is not derived from the choice (services/voting.ts makes it from crypto randomness), never logged,
--                                  never audited. Receipts cast before this migration have none (NULL). Unique, so a code names one receipt.

ALTER TABLE candidates ADD COLUMN pledge text CHECK (pledge IS NULL OR char_length(pledge) <= 160);
ALTER TABLE campaigns ADD COLUMN results_release_at timestamptz;
ALTER TABLE vote_receipts ADD COLUMN receipt_code text CHECK (receipt_code IS NULL OR receipt_code ~ '^UV-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$');
ALTER TABLE vote_receipts ADD CONSTRAINT vote_receipts_receipt_code_key UNIQUE (receipt_code);

-- Candidates: as migration 019, plus the pledge: a withdrawal still changes nothing but withdrawn_*.
CREATE OR REPLACE FUNCTION candidates_require_draft() RETURNS trigger AS $$
DECLARE cid uuid; st text; allow boolean;
BEGIN
  cid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status, allow_edits_after_start INTO st, allow FROM campaigns WHERE id = cid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    IF st = 'open' AND TG_OP = 'UPDATE' AND OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
       AND NEW.campaign_id = OLD.campaign_id AND NEW.name IS NOT DISTINCT FROM OLD.name AND NEW.bio IS NOT DISTINCT FROM OLD.bio
       AND NEW.pledge IS NOT DISTINCT FROM OLD.pledge
       AND NEW.photo_path IS NOT DISTINCT FROM OLD.photo_path AND NEW.sort_order = OLD.sort_order AND NEW.is_abstain = OLD.is_abstain
       AND NEW.position_id = OLD.position_id AND NEW.region_id IS NOT DISTINCT FROM OLD.region_id AND NEW.status = OLD.status THEN
      RETURN NEW;
    END IF;
    IF st = 'open' AND allow AND NOT EXISTS (SELECT 1 FROM vote_receipts WHERE campaign_id = cid) THEN
      IF TG_OP = 'UPDATE' AND OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason) THEN
        RAISE EXCEPTION 'a withdrawal cannot be undone' USING ERRCODE = 'check_violation';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END IF;
    RAISE EXCEPTION 'campaign % is locked', cid USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
