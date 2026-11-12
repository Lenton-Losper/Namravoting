-- SEC-06: server-side sessions. The browser holds only a random session id (signed); the database holds a SHA-256 of it, so
-- a database leak does not hand out working sessions, and logout / revocation really invalidate.
-- Roles and the employee code are NOT stored here: they are read live on every request (admin status from the token's app
-- role, ADMIN_OIDS / ADMIN_EMAILS, and the users row), so removing an admin takes effect at once.
CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_oid uuid NOT NULL REFERENCES users(entra_oid),
  claim_admin boolean NOT NULL DEFAULT false,   -- the identity provider asserted the CampaignAdmin app role at sign-in
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_oid, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO namra_app;
