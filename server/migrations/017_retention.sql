-- Retention (business-logic plan item 5): the scheduled clean-up of old campaigns keeps the SEALED RESULT (counters, audit entries) and removes
-- the personal data around it: receipts (who voted), the voter list, the voter snapshot and candidate photos.
--   receipts_purged_at / photos_purged_at  when that happened. Set only by the retention job (the owner role); the app role cannot touch them.
-- verifySeal() treats "receipts_match" as not applicable once the receipts are gone (the sealed turnout stays in the audit chain).

ALTER TABLE campaigns ADD COLUMN receipts_purged_at timestamptz;
ALTER TABLE campaigns ADD COLUMN photos_purged_at timestamptz;

CREATE FUNCTION campaigns_retention_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'namra_app' AND (NEW.receipts_purged_at IS DISTINCT FROM OLD.receipts_purged_at OR NEW.photos_purged_at IS DISTINCT FROM OLD.photos_purged_at) THEN
    RAISE EXCEPTION 'only the retention job can mark a campaign as purged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_retention_guard BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION campaigns_retention_guard();
