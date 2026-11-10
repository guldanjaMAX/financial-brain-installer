-- Provider positions retain their sign independently of a mutable label or
-- owner type review. Never reconstruct old positions from today's account kind.
-- Legacy SimpleFIN snapshots need a fresh observation before reinterpretation.
ALTER TABLE fin_balance_snapshots ADD COLUMN provider_position_minor INTEGER;
