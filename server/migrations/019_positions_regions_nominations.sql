-- Multi-position campaigns, candidate self-nomination and regions.
--
-- A campaign (e.g. "Umoja Committee 2026") now holds one or more POSITIONS (Press Secretary, Finance Officer ...). Each position has its own
-- candidates, its own tallies and its own receipts: a member votes once PER POSITION (unique on campaign + position + member).
-- Every guarantee of the single-question design is kept: a tally row per candidate (no row per ballot), a receipt with no candidate and no
-- timestamp, one vote per member, snapshots, seals and the audit chain.
--
--   positions   title, description, order, seats (kept for future rules), min/max candidates, nomination status, a `rules` JSON column
--               (unused for now: see docs/rules-hooks.md) and the nomination link token.
--   regions     a per-campaign list (seeded from the 14 regions of Namibia, which an admin can rename, add to or remove).
--   candidates  position_id (required), region_id, status (invited / submitted / approved / rejected / withdrawn), who submitted it and when.
--   tallies     (campaign, position, candidate).
--   vote_receipts  (campaign, position, member).
--
-- Existing single-question campaigns each get ONE default position named after the campaign, so nothing breaks.

-- ---- positions ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (char_length(description) <= 2000),
  sort_order int NOT NULL DEFAULT 0,
  seats int NOT NULL DEFAULT 1 CHECK (seats >= 1),                -- future rules (several winners); plurality with 1 seat today
  min_candidates int CHECK (min_candidates >= 1),                  -- NULL = the campaign default of 2 approved candidates
  max_candidates int CHECK (max_candidates >= 1),                  -- NULL = no limit
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),   -- nominations for this position: open / closed by an admin
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,                        -- unused for now (docs/rules-hooks.md)
  invite_token text UNIQUE CHECK (invite_token IS NULL OR char_length(invite_token) >= 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, campaign_id),
  CONSTRAINT positions_min_max CHECK (min_candidates IS NULL OR max_candidates IS NULL OR max_candidates >= min_candidates)
);
CREATE INDEX positions_campaign_idx ON positions (campaign_id, sort_order);

-- ---- regions -----------------------------------------------------------------------------------------------------------------------
CREATE TABLE regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (id, campaign_id)
);
CREATE UNIQUE INDEX regions_campaign_name_idx ON regions (campaign_id, lower(name));

-- ---- campaign settings -------------------------------------------------------------------------------------------------------------
ALTER TABLE campaigns ADD COLUMN nominations_close_at timestamptz;                      -- optional; nominations also close when the campaign starts
ALTER TABLE campaigns ADD COLUMN nominate_eligibility text CHECK (nominate_eligibility IN ('all', 'umoja'));   -- NULL = same as the voters
ALTER TABLE campaigns ADD COLUMN results_group_by_region boolean NOT NULL DEFAULT false;

-- ---- default position for every existing campaign ----------------------------------------------------------------------------------
INSERT INTO positions (campaign_id, title, sort_order) SELECT id, left(btrim(title), 200), 0 FROM campaigns;

-- Every existing campaign gets the 14 regions of Namibia (an admin can change them while the campaign is a draft).
INSERT INTO regions (campaign_id, name, sort_order)
SELECT c.id, r.name, r.ord
  FROM campaigns c CROSS JOIN (VALUES
    ('Erongo', 1), ('Hardap', 2), ('//Kharas', 3), ('Kavango East', 4), ('Kavango West', 5), ('Khomas', 6), ('Kunene', 7),
    ('Ohangwena', 8), ('Omaheke', 9), ('Omusati', 10), ('Oshana', 11), ('Oshikoto', 12), ('Otjozondjupa', 13), ('Zambezi', 14)) AS r(name, ord);

-- ---- candidates --------------------------------------------------------------------------------------------------------------------
ALTER TABLE candidates DISABLE TRIGGER candidates_draft_only;     -- the data move below touches candidates of started campaigns

ALTER TABLE candidates ADD COLUMN position_id uuid;
ALTER TABLE candidates ADD COLUMN region_id uuid;
ALTER TABLE candidates ADD COLUMN status text NOT NULL DEFAULT 'approved' CHECK (status IN ('invited', 'submitted', 'approved', 'rejected', 'withdrawn'));
ALTER TABLE candidates ADD COLUMN submitted_by_oid uuid REFERENCES users(entra_oid);
ALTER TABLE candidates ADD COLUMN submitted_at timestamptz;
ALTER TABLE candidates ADD COLUMN reviewed_by uuid REFERENCES users(entra_oid);
ALTER TABLE candidates ADD COLUMN reviewed_at timestamptz;
ALTER TABLE candidates ADD COLUMN review_reason text;

UPDATE candidates k SET position_id = (SELECT p.id FROM positions p WHERE p.campaign_id = k.campaign_id ORDER BY p.sort_order, p.created_at LIMIT 1);
ALTER TABLE candidates ALTER COLUMN position_id SET NOT NULL;
ALTER TABLE candidates ADD CONSTRAINT candidates_position_fk FOREIGN KEY (position_id, campaign_id) REFERENCES positions (id, campaign_id) ON DELETE CASCADE;
ALTER TABLE candidates ADD CONSTRAINT candidates_region_fk FOREIGN KEY (region_id, campaign_id) REFERENCES regions (id, campaign_id);
ALTER TABLE candidates ADD CONSTRAINT candidates_id_campaign_position_key UNIQUE (id, campaign_id, position_id);
ALTER TABLE candidates ADD CONSTRAINT candidates_abstain_approved CHECK (NOT is_abstain OR status = 'approved');
-- One profile per person per position (a withdrawn or rejected profile is edited and re-submitted, not duplicated).
CREATE UNIQUE INDEX candidates_one_profile_idx ON candidates (position_id, submitted_by_oid) WHERE submitted_by_oid IS NOT NULL;
CREATE INDEX candidates_position_idx ON candidates (position_id);

-- The Abstain line is now one per POSITION.
DROP INDEX candidates_one_abstain_idx;
CREATE UNIQUE INDEX candidates_one_abstain_idx ON candidates (position_id) WHERE is_abstain;

ALTER TABLE candidates ENABLE TRIGGER candidates_draft_only;

-- ---- tallies: per (campaign, position, candidate) ----------------------------------------------------------------------------------
ALTER TABLE tallies ADD COLUMN position_id uuid;
UPDATE tallies t SET position_id = k.position_id FROM candidates k WHERE k.id = t.candidate_id AND k.campaign_id = t.campaign_id;
ALTER TABLE tallies ALTER COLUMN position_id SET NOT NULL;
ALTER TABLE tallies DROP CONSTRAINT tallies_pkey;
ALTER TABLE tallies ADD PRIMARY KEY (campaign_id, position_id, candidate_id);
ALTER TABLE tallies ADD CONSTRAINT tallies_position_fk FOREIGN KEY (candidate_id, campaign_id, position_id)
  REFERENCES candidates (id, campaign_id, position_id) ON DELETE CASCADE;
CREATE INDEX tallies_candidate_idx ON tallies (campaign_id, candidate_id);

CREATE OR REPLACE FUNCTION tallies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_id <> OLD.campaign_id OR NEW.candidate_id <> OLD.candidate_id OR NEW.position_id <> OLD.position_id THEN
    RAISE EXCEPTION 'a tally row cannot be moved' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'namra_app' AND NEW.votes NOT IN (OLD.votes, OLD.votes + 1) THEN
    RAISE EXCEPTION 'a tally can only grow by one vote at a time' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---- vote_receipts: per (campaign, position, member) -------------------------------------------------------------------------------
-- Still NO candidate and NO timestamp. A receipt now says "this member voted in this position".
ALTER TABLE vote_receipts ADD COLUMN position_id uuid;
UPDATE vote_receipts r SET position_id = (SELECT p.id FROM positions p WHERE p.campaign_id = r.campaign_id ORDER BY p.sort_order, p.created_at LIMIT 1);
ALTER TABLE vote_receipts ALTER COLUMN position_id SET NOT NULL;
ALTER TABLE vote_receipts ADD CONSTRAINT vote_receipts_position_fk FOREIGN KEY (position_id, campaign_id) REFERENCES positions (id, campaign_id);
ALTER TABLE vote_receipts DROP CONSTRAINT vote_receipts_pkey;
ALTER TABLE vote_receipts ADD PRIMARY KEY (campaign_id, position_id, voter_oid);
ALTER TABLE vote_receipts DROP CONSTRAINT vote_receipts_member_unique;
ALTER TABLE vote_receipts ADD CONSTRAINT vote_receipts_member_unique UNIQUE (campaign_id, position_id, member_key);
CREATE INDEX vote_receipts_voter_idx ON vote_receipts (campaign_id, voter_oid);
CREATE INDEX vote_receipts_member_idx ON vote_receipts (campaign_id, member_key);

-- ---- grants ------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON positions TO namra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON regions TO namra_app;

-- ---- guards (defence in depth, like candidates_draft_only) ------------------------------------------------------------------------
-- Positions follow the candidate rules: freely editable in a draft; once the campaign is OPEN with "Allow edits after start", only a
-- position's title and description may change (never its seats, limits, order or rules, and never added or removed); otherwise locked.
-- (A cascade from a deleted campaign finds no campaign row, so it is allowed.)
CREATE FUNCTION positions_require_draft() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cid uuid; st text; allow boolean;
BEGIN
  cid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status, allow_edits_after_start INTO st, allow FROM campaigns WHERE id = cid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    IF TG_OP = 'UPDATE' AND st = 'open' AND allow AND NEW.campaign_id = OLD.campaign_id AND NEW.sort_order = OLD.sort_order AND NEW.seats = OLD.seats
       AND NEW.min_candidates IS NOT DISTINCT FROM OLD.min_candidates AND NEW.max_candidates IS NOT DISTINCT FROM OLD.max_candidates
       AND NEW.status = OLD.status AND NEW.rules = OLD.rules AND NEW.invite_token IS NOT DISTINCT FROM OLD.invite_token THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'campaign % is locked', cid USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER positions_draft_only BEFORE INSERT OR UPDATE OR DELETE ON positions FOR EACH ROW EXECUTE FUNCTION positions_require_draft();

CREATE FUNCTION regions_require_draft() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cid uuid; st text;
BEGIN
  cid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status INTO st FROM campaigns WHERE id = cid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'campaign % is locked', cid USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER regions_draft_only BEFORE INSERT OR UPDATE OR DELETE ON regions FOR EACH ROW EXECUTE FUNCTION regions_require_draft();

-- Candidates: as migration 016, plus the new columns. A withdrawal changes nothing but withdrawn_*; the position, region and status of a
-- candidate on a started campaign never change (edits after start, before the first vote, are the one exception, as before).
CREATE OR REPLACE FUNCTION candidates_require_draft() RETURNS trigger AS $$
DECLARE cid uuid; st text; allow boolean;
BEGIN
  cid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status, allow_edits_after_start INTO st, allow FROM campaigns WHERE id = cid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    IF st = 'open' AND TG_OP = 'UPDATE' AND OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
       AND NEW.campaign_id = OLD.campaign_id AND NEW.name IS NOT DISTINCT FROM OLD.name AND NEW.bio IS NOT DISTINCT FROM OLD.bio
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

-- ---- reset: the snapshot of the old round now names the position ------------------------------------------------------------------
-- (Same function as migration 011; only the snapshot gains `position`.)
CREATE OR REPLACE FUNCTION reset_campaign_votes(p_campaign uuid, p_session text, p_reason text, p_closes_at timestamptz DEFAULT NULL) RETURNS jsonb
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'votes', t.votes, 'position', t.position) ORDER BY t.pos_order, t.sort_order, t.name), '[]'::jsonb) INTO tally_json
    FROM (SELECT k.name, k.sort_order, p.sort_order AS pos_order, p.title AS position, coalesce(y.votes, 0) AS votes
            FROM candidates k JOIN positions p ON p.id = k.position_id
            LEFT JOIN tallies y ON y.candidate_id = k.id AND y.campaign_id = k.campaign_id
           WHERE k.campaign_id = p_campaign AND k.status = 'approved') t;
  snapshot := jsonb_build_object('candidates', tally_json, 'turnout', jsonb_build_object('votes', n_receipts, 'ballots', n_ballots));

  UPDATE tallies SET votes = 0 WHERE campaign_id = p_campaign;
  DELETE FROM vote_receipts WHERE campaign_id = p_campaign;
  UPDATE campaigns SET status = 'open', results_published = false, closes_at = coalesce(p_closes_at, closes_at) WHERE id = p_campaign;

  INSERT INTO audit_log (actor_oid, action, campaign_id, details)
    VALUES (v_actor, 'campaign.reset', p_campaign,
            jsonb_build_object('reason', btrim(p_reason), 'previous_status', c.status, 'new_closes_at', p_closes_at, 'snapshot', snapshot));
  RETURN jsonb_build_object('votes_cleared', n_receipts, 'snapshot', snapshot);
END $$;
