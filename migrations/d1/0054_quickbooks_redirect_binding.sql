-- A pre-upgrade pending intent has no exact redirect proof and must restart.
-- Shipped migration 0032 remains immutable.
ALTER TABLE quickbooks_oauth_intents ADD COLUMN redirect_uri TEXT;
