-- Umoja-only voting. Membership is sensitive personal data: store ONLY what the check needs
-- (normalised employee code + active flag). No names, gender, position, dates or months.
CREATE TABLE umoja_members (
  employee_code text PRIMARY KEY CHECK (employee_code ~ '^[A-Z]{3}[0-9]{4}$'),
  active boolean NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- The app role can only read. Writes happen through `npm run umoja:import` as the owner role.
REVOKE ALL ON umoja_members FROM PUBLIC;
GRANT SELECT ON umoja_members TO namra_app;

-- Filled from the auth layer on every login (Entra: employeeId attribute). Nullable.
ALTER TABLE users ADD COLUMN employee_code text;

-- New eligibility mode, and it becomes the default for new campaigns. Existing campaigns keep their mode.
ALTER TABLE campaigns DROP CONSTRAINT campaigns_eligibility_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_eligibility_check CHECK (eligibility IN ('all','list','umoja'));
ALTER TABLE campaigns ALTER COLUMN eligibility SET DEFAULT 'umoja';
