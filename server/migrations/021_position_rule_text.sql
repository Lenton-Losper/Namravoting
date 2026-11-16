-- Multi-position ballots: an optional line of eligibility text per position, e.g. "Must be from the HR Department".
--
--   positions.rule_text   optional, at most 200 characters. INFORMATIONAL ONLY: it is shown to voters under the position title and
--                         constrains nominations (an admin applies it when accepting a nominee), never who may vote. Nothing in the vote
--                         transaction reads it.
--
-- The positions guard (positions_require_draft, migration 019) compares the columns that must not change once voting starts; rule_text is
-- not one of them, so it can be corrected on an open campaign that allows edits after start, like the title and description.

ALTER TABLE positions ADD COLUMN rule_text text CHECK (rule_text IS NULL OR char_length(btrim(rule_text)) BETWEEN 1 AND 200);
