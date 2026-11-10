-- Defence in depth: candidates of a non-draft campaign cannot be changed, even by buggy app code.
CREATE FUNCTION candidates_require_draft() RETURNS trigger AS $$
DECLARE cid uuid; st text;
BEGIN
  cid := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status INTO st FROM campaigns WHERE id = cid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'campaign % is locked', cid USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER candidates_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON candidates
  FOR EACH ROW EXECUTE FUNCTION candidates_require_draft();
