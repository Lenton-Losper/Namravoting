-- SEC-03: one vote per MEMBER, not per Entra account.
--
-- `member_key` is the identity the vote counts against: 'code:<employee code>' for Umoja campaigns (resolved from the matched
-- entra_oid first, then the employee code, as in services/umoja.ts), 'email:<address>' for the demo override, and
-- 'oid:<account id>' for campaigns open to everyone or to an email list. `voter_oid` stays, for "have I voted" lookups.
-- It carries no candidate and no timestamp, so secrecy is unchanged.
ALTER TABLE vote_receipts ADD COLUMN member_key text;

-- Existing receipts: derive the key the same way. If two receipts of one campaign would share a key (a double vote that
-- already happened), only the first keeps it; the others get a unique 'dup:' key so the constraint can be added.
WITH k AS (
  SELECT r.campaign_id, r.voter_oid,
         CASE WHEN c.eligibility = 'umoja'
              THEN coalesce('code:' || m.employee_code, 'code:' || u.employee_code, 'oid:' || r.voter_oid::text)
              ELSE 'oid:' || r.voter_oid::text END AS key
    FROM vote_receipts r
    JOIN campaigns c ON c.id = r.campaign_id
    LEFT JOIN umoja_members m ON m.entra_oid = r.voter_oid
    LEFT JOIN users u ON u.entra_oid = r.voter_oid
), d AS (
  SELECT campaign_id, voter_oid, key, row_number() OVER (PARTITION BY campaign_id, key ORDER BY voter_oid) AS rn FROM k
)
UPDATE vote_receipts r SET member_key = CASE WHEN d.rn = 1 THEN d.key ELSE 'dup:' || r.voter_oid::text END
  FROM d WHERE d.campaign_id = r.campaign_id AND d.voter_oid = r.voter_oid;

ALTER TABLE vote_receipts ALTER COLUMN member_key SET NOT NULL;
ALTER TABLE vote_receipts ADD CONSTRAINT vote_receipts_member_unique UNIQUE (campaign_id, member_key);
