-- Quorum and scheduled publishing (business-logic plan item 8).
--   quorum_percent        optional minimum turnout, as a percentage of the eligible voters. A result below it is flagged everywhere (it can
--                         still be published, but only after the creator acknowledges it). Set while a draft, locked at start.
--   publish_at            optional time at which the closed result is published automatically (checked whenever the campaign is looked at,
--                         like the automatic close; there is no scheduler). Never published automatically if the result does not match its
--                         seal or is below quorum: that needs a person.
--   publish_scheduled_by  who scheduled it. That person is the "approved by" of an automatic publication.
--   published_at / published_by / publish_scheduled   who published, when, and whether it was the schedule.

ALTER TABLE campaigns ADD COLUMN quorum_percent smallint CHECK (quorum_percent BETWEEN 1 AND 100);
ALTER TABLE campaigns ADD COLUMN publish_at timestamptz;
ALTER TABLE campaigns ADD COLUMN publish_scheduled_by uuid REFERENCES users(entra_oid);
ALTER TABLE campaigns ADD COLUMN published_at timestamptz;
ALTER TABLE campaigns ADD COLUMN published_by uuid REFERENCES users(entra_oid);
ALTER TABLE campaigns ADD COLUMN publish_scheduled boolean NOT NULL DEFAULT false;

-- Existing published campaigns have no record of who or when; they stay as they are (the results page shows no "approved by" line for them).
CREATE FUNCTION campaigns_publication_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'namra_app' THEN
    IF NEW.quorum_percent IS DISTINCT FROM OLD.quorum_percent AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'campaign % is locked', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.results_published AND NOT OLD.results_published AND (NEW.published_at IS NULL OR NEW.published_by IS NULL) THEN
      RAISE EXCEPTION 'a publication must record who published and when' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.results_published AND (NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by
         OR NEW.publish_scheduled IS DISTINCT FROM OLD.publish_scheduled OR NEW.publish_at IS DISTINCT FROM OLD.publish_at) THEN
      RAISE EXCEPTION 'a publication cannot be altered' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_publication_guard BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION campaigns_publication_guard();
