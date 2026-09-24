-- 0047_restricted_cash
--
-- The shipped fin_accounts.account_kind constraint predates provider subtypes
-- that distinguish restricted from spendable deposits. Rebuilding that table
-- would make an interrupted D1 migration non-resumable, so this additive field
-- carries the narrower durable classification. The legacy account_kind remains
-- a compatibility value; every product read prefers this field when present.

ALTER TABLE fin_accounts ADD COLUMN restricted_cash_kind TEXT
  CHECK (restricted_cash_kind IS NULL OR restricted_cash_kind IN ('cd', 'hsa'));
