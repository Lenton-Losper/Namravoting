-- Selection range per position, an optional region vote rule, and a required region for every candidate.
--
--  1. positions.min_picks / max_picks: how many candidates a voter may choose in the position. Exact = both equal. Existing positions get
--     min = max = their current `seats` (what a voter had to pick until now). `seats` stays what it was for RESULTS: how many winners.
--     The rule only governs voting; it never changes who wins.
--  2. positions.region_rule_min + region_rule_region_id: the optional rule "at least N picks from outside <region>", stored as data
--     (both set or both NULL). The region belongs to the same campaign (composite FK) and cannot be deleted while a rule names it.
--  3. Every candidate has a region (the Abstain line is the one exception). Candidates that already exist without one are NOT deleted
--     and not forced: they keep working, but a draft campaign cannot START while any approved candidate has no region (a trigger on
--     campaigns, for every role) and the region has to be chosen to save such a candidate. A started campaign never changes a region.

-- ---- 1. pick range -----------------------------------------------------------------------------------------------------------------
ALTER TABLE positions ADD COLUMN min_picks int;
ALTER TABLE positions ADD COLUMN max_picks int;
-- (Positions of started campaigns are guarded by positions_draft_only: it is switched off for this one data move, like migration 019 did.)
ALTER TABLE positions DISABLE TRIGGER positions_draft_only;
UPDATE positions SET min_picks = seats, max_picks = seats;
ALTER TABLE positions ENABLE TRIGGER positions_draft_only;
ALTER TABLE positions ALTER COLUMN min_picks SET NOT NULL;
ALTER TABLE positions ALTER COLUMN max_picks SET NOT NULL;
ALTER TABLE positions ALTER COLUMN min_picks SET DEFAULT 1;
ALTER TABLE positions ALTER COLUMN max_picks SET DEFAULT 1;
ALTER TABLE positions ADD CONSTRAINT positions_picks_range CHECK (min_picks >= 1 AND max_picks >= min_picks AND max_picks <= 50);

-- ---- 2. region rule ----------------------------------------------------------------------------------------------------------------
ALTER TABLE positions ADD COLUMN region_rule_min int;
ALTER TABLE positions ADD COLUMN region_rule_region_id uuid;
ALTER TABLE positions ADD CONSTRAINT positions_region_rule_pair CHECK ((region_rule_min IS NULL) = (region_rule_region_id IS NULL));
ALTER TABLE positions ADD CONSTRAINT positions_region_rule_min CHECK (region_rule_min IS NULL OR (region_rule_min >= 1 AND region_rule_min <= max_picks));
ALTER TABLE positions ADD CONSTRAINT positions_region_rule_region_fk FOREIGN KEY (region_rule_region_id, campaign_id) REFERENCES regions (id, campaign_id);

-- The positions guard (migration 019): on an open campaign that allows edits after start only title, description and rule_text may change.
-- The pick range and the region rule are voting rules: locked from the start, like the number of winners.
CREATE OR REPLACE FUNCTION positions_require_draft() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cid uuid; st text; allow boolean;
BEGIN
  cid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status, allow_edits_after_start INTO st, allow FROM campaigns WHERE id = cid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    IF TG_OP = 'UPDATE' AND st = 'open' AND allow AND NEW.campaign_id = OLD.campaign_id AND NEW.sort_order = OLD.sort_order AND NEW.seats = OLD.seats
       AND NEW.min_picks = OLD.min_picks AND NEW.max_picks = OLD.max_picks
       AND NEW.region_rule_min IS NOT DISTINCT FROM OLD.region_rule_min AND NEW.region_rule_region_id IS NOT DISTINCT FROM OLD.region_rule_region_id
       AND NEW.min_candidates IS NOT DISTINCT FROM OLD.min_candidates AND NEW.max_candidates IS NOT DISTINCT FROM OLD.max_candidates
       AND NEW.status = OLD.status AND NEW.rules = OLD.rules AND NEW.invite_token IS NOT DISTINCT FROM OLD.invite_token THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'campaign % is locked', cid USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- ---- 3. regions --------------------------------------------------------------------------------------------------------------------
-- A candidate needs a region. NOT NULL cannot be a plain column rule because the Abstain line has none and because existing candidates
-- without one must stay (nothing is deleted), so the database enforces it here:
--   * a new candidate always needs one;
--   * an existing candidate without one stays as it is, but cannot be saved in a DRAFT without choosing one;
--   * once the campaign has started a region never changes.
CREATE FUNCTION candidates_region_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE st text;
BEGIN
  IF NEW.is_abstain THEN RETURN NEW; END IF;
  SELECT status INTO st FROM campaigns WHERE id = NEW.campaign_id;
  IF TG_OP = 'UPDATE' AND st IS NOT NULL AND st <> 'draft' AND NEW.region_id IS DISTINCT FROM OLD.region_id THEN
    RAISE EXCEPTION 'a candidate''s region cannot change once voting has started' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.region_id IS NULL AND (TG_OP = 'INSERT' OR OLD.region_id IS NOT NULL OR st = 'draft') THEN
    RAISE EXCEPTION 'every candidate needs a region' USING ERRCODE = 'not_null_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidates_region_required BEFORE INSERT OR UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION candidates_region_guard();

-- A campaign cannot start while an approved candidate has no region (every role; the app checks first and says which candidates).
CREATE FUNCTION campaigns_start_needs_regions() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM candidates k WHERE k.campaign_id = NEW.id AND NOT k.is_abstain AND k.status = 'approved' AND k.region_id IS NULL) THEN
    RAISE EXCEPTION 'campaign % cannot start: a candidate has no region', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_start_regions BEFORE UPDATE OF status ON campaigns FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status = 'open') EXECUTE FUNCTION campaigns_start_needs_regions();
