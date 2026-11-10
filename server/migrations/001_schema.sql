CREATE TABLE users (
  entra_oid uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_token text UNIQUE NOT NULL CHECK (char_length(share_token) >= 32),
  created_by uuid NOT NULL REFERENCES users(entra_oid),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  opens_at timestamptz,
  closes_at timestamptz,
  eligibility text NOT NULL DEFAULT 'all' CHECK (eligibility IN ('all','list')),
  results_published boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name text NOT NULL,
  bio text CHECK (char_length(bio) <= 500),
  photo_path text,
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (id, campaign_id)   -- target of the composite FK from ballots
);

CREATE TABLE eligible_voters (
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  voter_email text,
  PRIMARY KEY (campaign_id, voter_email)
);

-- Proves someone voted. NO candidate, NO timestamp.
CREATE TABLE vote_receipts (
  campaign_id uuid REFERENCES campaigns(id),
  voter_oid uuid REFERENCES users(entra_oid),
  PRIMARY KEY (campaign_id, voter_oid)
);

-- The vote itself. NO voter id, NO timestamp, NO IP.
-- Composite FK guarantees the candidate belongs to the same campaign (DB-level rule).
CREATE TABLE ballots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  candidate_id uuid NOT NULL,
  FOREIGN KEY (candidate_id, campaign_id) REFERENCES candidates(id, campaign_id)
);
CREATE INDEX ballots_campaign_candidate_idx ON ballots (campaign_id, candidate_id);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_oid uuid,
  action text NOT NULL,
  campaign_id uuid,
  details jsonb,
  at timestamptz DEFAULT now()
);
