-- Co-admins, observers and a second approver (business-logic plan item 3).
--
--   campaign_members  who besides the creator has a role on a campaign:
--                       co_admin  can run it (edit, start, close, publish, export) but not reset, delete, archive or change the team;
--                       observer  read-only: turnout, the sealed result once closed, verification, the audit entries. Never live counts.
--   approvals         a reset or a permanent delete of a campaign that has require_approval set is REQUESTED by the creator, APPROVED by a
--                     co-admin (never the requester) and then EXECUTED by the creator. The database refuses an approval by the requester.
--   campaigns.require_approval   switched on by the creator, can never be switched off again (otherwise the rule could be bypassed).

CREATE TABLE campaign_members (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_oid uuid NOT NULL REFERENCES users(entra_oid),
  role text NOT NULL CHECK (role IN ('co_admin', 'observer')),
  added_by uuid NOT NULL REFERENCES users(entra_oid),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_oid)
);
CREATE INDEX campaign_members_user_idx ON campaign_members (user_oid);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reset', 'permanent_delete')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,      -- the reason and new closing time of a reset; never anything about votes
  requested_by uuid NOT NULL REFERENCES users(entra_oid),
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'cancelled')),
  decided_by uuid REFERENCES users(entra_oid),
  decided_at timestamptz,
  decision_note text,
  executed_at timestamptz,
  -- the second person: an approval or a rejection by someone other than the requester, recorded with who and when
  CONSTRAINT approvals_second_person CHECK (status IN ('pending', 'cancelled') OR (decided_by IS NOT NULL AND decided_by <> requested_by AND decided_at IS NOT NULL))
);
CREATE INDEX approvals_campaign_idx ON approvals (campaign_id, requested_at DESC);

GRANT SELECT, INSERT, DELETE ON campaign_members TO namra_app;
GRANT SELECT, INSERT, UPDATE ON approvals TO namra_app;

CREATE FUNCTION approvals_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.campaign_id <> OLD.campaign_id OR NEW.kind <> OLD.kind OR NEW.payload <> OLD.payload
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'an approval request cannot be changed, only decided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'cancelled'))) THEN
    RAISE EXCEPTION 'illegal approval status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('rejected', 'executed', 'cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a finished approval request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'executed' AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'the approval cannot be altered when it is executed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_guard BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION approvals_guard();

ALTER TABLE campaigns ADD COLUMN require_approval boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.share_token <> OLD.share_token OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a campaign''s id, share token and creator cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'namra_app' THEN
    IF OLD.require_approval AND NOT NEW.require_approval THEN
      RAISE EXCEPTION 'the second-approver rule cannot be switched off once it is on' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.allow_abstain <> OLD.allow_abstain AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'campaign % is locked', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.runoff_round <> OLD.runoff_round OR (NEW.parent_campaign_id IS DISTINCT FROM OLD.parent_campaign_id AND NEW.parent_campaign_id IS NOT NULL) THEN
      RAISE EXCEPTION 'a campaign''s run-off link cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status = 'open') OR (OLD.status = 'open' AND NEW.status = 'closed')) THEN
      RAISE EXCEPTION 'illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'draft' THEN
      IF NEW.opens_at IS DISTINCT FROM OLD.opens_at OR NEW.eligibility <> OLD.eligibility
         OR NEW.allow_edits_after_start <> OLD.allow_edits_after_start THEN
        RAISE EXCEPTION 'campaign % is locked', OLD.id USING ERRCODE = 'check_violation';
      END IF;
      IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description OR NEW.closes_at IS DISTINCT FROM OLD.closes_at)
         AND NOT (OLD.status = 'open' AND NEW.status = 'open' AND OLD.allow_edits_after_start) THEN
        RAISE EXCEPTION 'campaign % is locked', OLD.id USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.results_published AND NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'results can only be published for a closed campaign' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.results_published AND NOT NEW.results_published THEN
      RAISE EXCEPTION 'published results cannot be withdrawn' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL AND NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'only a closed campaign can be archived' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
