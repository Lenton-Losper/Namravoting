-- Bind an Umoja member to a Microsoft account by the address the member list carries (migration 025).
--
-- Called by the app at Entra sign-in (the app role has no write right on umoja_members, so this is the one controlled way in):
--   * the account is already bound to a member                          -> 'already_bound' (nothing to do)
--   * no member has this address                                          -> 'no_match'
--   * the member with this address is already bound to ANOTHER account    -> 'conflict' (NOT bound; audited umoja.bind_conflict)
--   * more than one member has this address (cannot happen while the unique index exists; defended anyway) -> 'conflict' (NOT bound)
--   * otherwise the member's entra_oid is set                              -> 'bound' (audited umoja.member_bound)
-- Audit entries hold the account id and the reason only: no address, no name, no employee code.
CREATE FUNCTION bind_umoja_member(p_oid uuid, p_email text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  n int; m record;
BEGIN
  IF p_oid IS NULL OR v_email IS NULL OR v_email = '' THEN RETURN 'no_match'; END IF;
  IF EXISTS (SELECT 1 FROM umoja_members WHERE entra_oid = p_oid) THEN RETURN 'already_bound'; END IF;
  SELECT count(*) INTO n FROM umoja_members WHERE email = v_email;
  IF n = 0 THEN RETURN 'no_match'; END IF;
  IF n > 1 THEN
    IF NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'umoja.bind_conflict' AND details->>'oid' = p_oid::text AND at > now() - interval '1 day') THEN   -- once a day per account, not once per sign-in
      INSERT INTO audit_log (actor_oid, action, details) VALUES (NULL, 'umoja.bind_conflict', jsonb_build_object('oid', p_oid, 'reason', 'ambiguous'));
    END IF;
    RETURN 'conflict';
  END IF;
  SELECT * INTO m FROM umoja_members WHERE email = v_email FOR UPDATE;
  IF m.entra_oid IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'umoja.bind_conflict' AND details->>'oid' = p_oid::text AND at > now() - interval '1 day') THEN   -- once a day per account, not once per sign-in
      INSERT INTO audit_log (actor_oid, action, details) VALUES (NULL, 'umoja.bind_conflict', jsonb_build_object('oid', p_oid, 'reason', 'bound_to_other_account'));
    END IF;
    RETURN 'conflict';
  END IF;
  UPDATE umoja_members SET entra_oid = p_oid WHERE employee_code = m.employee_code;
  INSERT INTO audit_log (actor_oid, action, details) VALUES (NULL, 'umoja.member_bound', jsonb_build_object('oid', p_oid, 'by', 'email'));
  RETURN 'bound';
END $$;
REVOKE ALL ON FUNCTION bind_umoja_member(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bind_umoja_member(uuid, text) TO namra_app;
