-- Contract expectations are proposals, never cash or bank transactions.
-- Re-extraction cannot confirm or replace an owner's reviewed proposal.
CREATE TABLE IF NOT EXISTS fin_expectations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'primary',
  client TEXT NOT NULL CHECK(length(trim(client)) BETWEEN 1 AND 200),
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 9007199254740991),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
  cadence TEXT NOT NULL CHECK(cadence IN ('once','weekly','monthly','quarterly','yearly')),
  start_on TEXT NOT NULL CHECK(length(start_on)=10 AND date(start_on,'+0 days') IS NOT NULL AND date(start_on,'+0 days')=start_on),
  end_on TEXT CHECK(end_on IS NULL OR (length(end_on)=10 AND date(end_on,'+0 days') IS NOT NULL AND date(end_on,'+0 days')=end_on AND end_on>=start_on)),
  source_document_id TEXT NOT NULL CHECK(length(source_document_id)>0),
  source_title TEXT NOT NULL CHECK(length(trim(source_title))>0),
  source_date TEXT NOT NULL CHECK(length(source_date)=10 AND date(source_date,'+0 days') IS NOT NULL AND date(source_date,'+0 days')=source_date),
  confirmed_by_owner INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_by_owner IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_expectations_range ON fin_expectations(tenant_id,start_on,end_on);
