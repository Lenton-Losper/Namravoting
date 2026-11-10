-- Restricted runtime role. Password is injected by the migration runner from APP_DB_PASSWORD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'namra_app') THEN
    EXECUTE format('CREATE ROLE namra_app LOGIN PASSWORD %L', '{{APP_DB_PASSWORD}}');
  ELSE
    EXECUTE format('ALTER ROLE namra_app PASSWORD %L', '{{APP_DB_PASSWORD}}');
  END IF;
END $$;

GRANT CONNECT ON DATABASE {{DB_NAME}} TO namra_app;
GRANT USAGE ON SCHEMA public TO namra_app;

GRANT SELECT, INSERT, UPDATE ON users TO namra_app;
GRANT SELECT, INSERT, UPDATE ON campaigns TO namra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON candidates TO namra_app;
GRANT SELECT, INSERT, DELETE ON eligible_voters TO namra_app;
GRANT SELECT, INSERT ON vote_receipts TO namra_app;   -- append-only
GRANT SELECT, INSERT ON ballots TO namra_app;         -- INSERT + SELECT only
GRANT SELECT, INSERT ON audit_log TO namra_app;       -- INSERT + SELECT only
GRANT USAGE ON SEQUENCE audit_log_id_seq TO namra_app;
