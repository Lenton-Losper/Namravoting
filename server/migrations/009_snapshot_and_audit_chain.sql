-- SEC-05: the Umoja voter list is frozen when a campaign starts.
-- Identities only (employee code, matched account id, active flag): no names, no emails.
CREATE TABLE campaign_voters (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  member_code text NOT NULL,
  entra_oid uuid,
  active boolean NOT NULL,
  PRIMARY KEY (campaign_id, member_code)
);
CREATE INDEX campaign_voters_oid_idx ON campaign_voters (campaign_id, entra_oid) WHERE entra_oid IS NOT NULL;
GRANT SELECT, INSERT ON campaign_voters TO namra_app;   -- append-only for the app

-- Campaigns that have already started get a snapshot of today's list (the best available).
INSERT INTO campaign_voters (campaign_id, member_code, entra_oid, active)
SELECT c.id, m.employee_code, m.entra_oid, m.active FROM campaigns c CROSS JOIN umoja_members m
 WHERE c.eligibility = 'umoja' AND c.status <> 'draft';

-- SEC-04: a hash chain over the audit log. Each entry stores the previous entry's hash and its own, so an edited, removed
-- or re-ordered entry breaks verification (audit_chain_verify). `seq` is assigned under a lock, so it is gap-free.
ALTER TABLE audit_log ADD COLUMN seq bigint, ADD COLUMN prev_hash text, ADD COLUMN hash text;

CREATE FUNCTION audit_row_hash(p_prev text, p_seq bigint, p_id bigint, p_actor uuid, p_action text, p_campaign uuid, p_details jsonb, p_at timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
    coalesce(p_prev, '') || '|' || coalesce(p_seq::text, '') || '|' || coalesce(p_id::text, '') || '|' || coalesce(p_actor::text, '') || '|' ||
    coalesce(p_action, '') || '|' || coalesce(p_campaign::text, '') || '|' || coalesce(p_details::text, '') || '|' ||
    coalesce(to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), ''), 'UTF8')), 'hex')
$$;

-- Existing rows become the start of the chain, in id order.
DO $$
DECLARE r record; prev text := NULL; n bigint := 0; h text;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    n := n + 1;
    h := audit_row_hash(prev, n, r.id, r.actor_oid, r.action, r.campaign_id, r.details, r.at);
    UPDATE audit_log SET seq = n, prev_hash = prev, hash = h WHERE id = r.id;
    prev := h;
  END LOOP;
END $$;
ALTER TABLE audit_log ALTER COLUMN seq SET NOT NULL, ALTER COLUMN hash SET NOT NULL;
CREATE UNIQUE INDEX audit_log_seq_idx ON audit_log (seq);

CREATE FUNCTION audit_chain_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev text; last_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(724001);   -- one writer at a time, so seq has no gaps and prev_hash is the true head
  SELECT seq, hash INTO last_seq, prev FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.at := coalesce(NEW.at, now());
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := prev;
  NEW.hash := audit_row_hash(prev, NEW.seq, NEW.id, NEW.actor_oid, NEW.action, NEW.campaign_id, NEW.details, NEW.at);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chain_stamp BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_chain_stamp();

-- Walks the whole chain. ok=false names the first broken entry.
CREATE FUNCTION audit_chain_verify() RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE r record; prev text := NULL; n bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY seq LOOP
    n := n + 1;
    IF r.seq <> n OR r.prev_hash IS DISTINCT FROM prev
       OR r.hash <> audit_row_hash(prev, r.seq, r.id, r.actor_oid, r.action, r.campaign_id, r.details, r.at) THEN
      RETURN jsonb_build_object('ok', false, 'checked', n, 'broken_at_seq', r.seq);
    END IF;
    prev := r.hash;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'checked', n, 'head', prev);
END $$;
