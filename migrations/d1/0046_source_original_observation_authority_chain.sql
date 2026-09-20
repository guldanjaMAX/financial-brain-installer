-- 0046_source_original_observation_authority_chain
--
-- Schema 45 made an accepted resolution atomic, but two machines could still
-- approve different plans over the same empty history and later create two
-- immutable branches. It also did not make a later exclusion supersede an
-- older accepted activation. The observation ledger is already append-only,
-- so schema 46 turns its per-original sequence into an optimistic authority
-- chain: every new observation names the exact head against which it was
-- approved, and D1 compares that predecessor in the inserting transaction.
--
-- Existing schema-42..45 observations are a legacy version-zero prefix. The
-- first schema-46 transition may point to the latest legacy row. Recovery
-- preserves both columns with the observation row and validates the complete
-- chain before its import marker can close. A legacy version-zero accepted row
-- may legally resolve an earlier, non-immediate gap under schema 45. Recovery
-- preserves that history, but the current view and admission head check keep it
-- non-authoritative and non-reactivatable.

ALTER TABLE source_original_observations ADD COLUMN authority_chain_version INTEGER
  NOT NULL DEFAULT 0
  CHECK (typeof(authority_chain_version) = 'integer' AND authority_chain_version IN (0,1));

ALTER TABLE source_original_observations ADD COLUMN predecessor_observation_hash TEXT
  CHECK (
    predecessor_observation_hash IS NULL OR (
      length(predecessor_observation_hash) = 71
      AND substr(predecessor_observation_hash,1,7) = 'sha256:'
      AND substr(predecessor_observation_hash,8) = lower(substr(predecessor_observation_hash,8))
      AND substr(predecessor_observation_hash,8) NOT GLOB '*[^0-9a-f]*'
    )
  );

-- NULL is the genesis predecessor. Coalescing it in the unique key makes two
-- empty-history writers contend on the same immutable predecessor just like
-- two writers extending a non-empty history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_original_observation_authority_predecessor
  ON source_original_observations
     (tenant_id,source,original_id,coalesce(predecessor_observation_hash,''))
  WHERE authority_chain_version = 1;

-- Install a temporary accepted-write barrier before replacing schema 45's
-- commit trigger. D1 commits migration statements independently, so every
-- interrupted prefix must remain fail closed.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_schema46_transition_block
BEFORE INSERT ON source_original_accepted_resolution_admissions
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution schema-46 transition is incomplete');
END;

-- Non-accepted observations are admitted directly by the Worker. The supplied
-- predecessor came from its complete, approval-bound history snapshot. The
-- latest per-original sequence is authoritative; wall-clock timestamps are
-- deliberately irrelevant across machines.
CREATE TRIGGER IF NOT EXISTS source_original_observation_authority_head_insert
BEFORE INSERT ON source_original_observations
WHEN NEW.outcome <> 'accepted'
 AND NOT EXISTS (
       SELECT 1 FROM source_original_result_family_recovery_state
        WHERE id = 1 AND mode = 'verified_recovery_import'
     )
BEGIN
  SELECT RAISE(ABORT, 'source original observation authority chain requires schema 46')
   WHERE (SELECT count(*) FROM install_state WHERE id = 1 AND schema_version >= 46) <> 1;

  SELECT RAISE(ABORT, 'source original observation requires a schema-46 authority predecessor')
   WHERE NEW.authority_chain_version <> 1;

  SELECT RAISE(ABORT, 'source original observation history advanced') WHERE
    (NEW.predecessor_observation_hash IS NULL AND EXISTS (
      SELECT 1 FROM source_original_observations prior
       WHERE prior.tenant_id = NEW.tenant_id
         AND prior.source = NEW.source
         AND prior.original_id = NEW.original_id
    )) OR
    (NEW.predecessor_observation_hash IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM source_original_observations prior
       WHERE prior.tenant_id = NEW.tenant_id
         AND prior.source = NEW.source
         AND prior.original_id = NEW.original_id
         AND prior.observation_hash = NEW.predecessor_observation_hash
         AND prior.sequence = (
           SELECT max(head.sequence) FROM source_original_observations head
            WHERE head.tenant_id = NEW.tenant_id
              AND head.source = NEW.source
              AND head.original_id = NEW.original_id
         )
    ));
END;

-- A new accepted resolution must resolve the exact current gap/failure. An
-- exact portable replay or recovery reactivation instead requires its accepted
-- observation itself to remain the current head. Thus any later observation,
-- including adjudicated_exclusion, invalidates reactivation atomically.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_authority_head_insert
BEFORE INSERT ON source_original_accepted_resolution_admissions
BEGIN
  SELECT RAISE(ABORT, 'source original accepted resolution authority chain requires schema 46')
   WHERE (SELECT count(*) FROM install_state WHERE id = 1 AND schema_version >= 46) <> 1;

  SELECT RAISE(ABORT, 'source original accepted resolution history advanced') WHERE NOT EXISTS (
    SELECT 1 FROM source_original_observations head
     WHERE head.tenant_id = NEW.tenant_id
       AND head.source = NEW.source
       AND head.original_id = NEW.original_id
       AND head.sequence = (
         SELECT max(candidate.sequence) FROM source_original_observations candidate
          WHERE candidate.tenant_id = NEW.tenant_id
            AND candidate.source = NEW.source
            AND candidate.original_id = NEW.original_id
       )
       AND head.observation_hash = CASE WHEN EXISTS (
         SELECT 1 FROM source_original_accepted_resolutions resolution
          WHERE resolution.resolution_hash = NEW.resolution_hash
            AND resolution.tenant_id = NEW.tenant_id
            AND resolution.source = NEW.source
            AND resolution.original_id = NEW.original_id
            AND resolution.resolves_observation_hash = NEW.resolves_observation_hash
            AND resolution.accepted_observation_hash = NEW.accepted_observation_hash
       ) THEN NEW.accepted_observation_hash ELSE NEW.resolves_observation_hash END
       AND (
         NOT EXISTS (
           SELECT 1 FROM source_original_accepted_resolutions resolution
            WHERE resolution.resolution_hash = NEW.resolution_hash
              AND resolution.tenant_id = NEW.tenant_id
              AND resolution.source = NEW.source
              AND resolution.original_id = NEW.original_id
              AND resolution.resolves_observation_hash = NEW.resolves_observation_hash
              AND resolution.accepted_observation_hash = NEW.accepted_observation_hash
         ) OR (
           head.outcome = 'accepted'
           AND head.resolves_observation_hash = NEW.resolves_observation_hash
           AND EXISTS (
             SELECT 1 FROM source_original_observations prior
              WHERE prior.tenant_id = NEW.tenant_id
                AND prior.source = NEW.source
                AND prior.original_id = NEW.original_id
                AND prior.observation_hash = NEW.resolves_observation_hash
                AND prior.outcome IN ('gap','failed')
                AND prior.sequence = (
                  SELECT max(candidate.sequence)
                    FROM source_original_observations candidate
                   WHERE candidate.tenant_id = NEW.tenant_id
                     AND candidate.source = NEW.source
                     AND candidate.original_id = NEW.original_id
                     AND candidate.sequence < head.sequence
                )
           )
         )
       )
  );
END;

DROP TRIGGER IF EXISTS source_original_accepted_resolution_admission_commit;

-- Schema 45's atomic admission remains the only accepted-write path. Its
-- accepted observation is now also the next immutable authority-chain row.
CREATE TRIGGER IF NOT EXISTS source_original_accepted_resolution_admission_commit
AFTER INSERT ON source_original_accepted_resolution_admissions
BEGIN
  INSERT INTO source_original_accepted_resolutions
    (contract_version,tenant_id,source,original_id,locator_kind,
     original_content_sha256,original_byte_count,resolves_observation_hash,
     accepted_observation_hash,result_document_count,result_document_set_hash,
     family_receipt_hash,admission_verification_hash,
     resolution_hash,admitted_at)
  SELECT
     NEW.contract_version,NEW.tenant_id,NEW.source,NEW.original_id,NEW.locator_kind,
     NEW.original_content_sha256,NEW.original_byte_count,NEW.resolves_observation_hash,
     NEW.accepted_observation_hash,NEW.result_document_count,NEW.result_document_set_hash,
     NEW.family_receipt_hash,NEW.verification_hash,
     NEW.resolution_hash,NEW.recorded_at
   WHERE NOT EXISTS (
     SELECT 1 FROM source_original_accepted_resolutions resolution
      WHERE resolution.resolution_hash = NEW.resolution_hash
   );

  INSERT INTO source_original_accepted_resolution_activations
    (contract_version,tenant_id,resolution_hash,verification_hash,activation_hash,activated_at)
  SELECT
     NEW.contract_version,NEW.tenant_id,NEW.resolution_hash,NEW.verification_hash,
     NEW.activation_hash,NEW.activated_at
   WHERE NOT EXISTS (
     SELECT 1 FROM source_original_accepted_resolution_activations activation
      WHERE activation.resolution_hash = NEW.resolution_hash
        AND activation.verification_hash = NEW.verification_hash
        AND activation.activation_hash = NEW.activation_hash
   );

  INSERT INTO source_original_observations
    (contract_version,tenant_id,source,original_id,locator_kind,run_id,plan_id,
     source_snapshot_id,target_set_hash,target_count,observation_stage,outcome,
     reason_code,text_state,original_content_sha256,original_byte_count,page_count,
     page_count_state,result_document_count,result_document_set_hash,
     resolves_observation_hash,observation_hash,recorded_at,
     authority_chain_version,predecessor_observation_hash)
  SELECT
     NEW.contract_version,NEW.tenant_id,NEW.source,NEW.original_id,NEW.locator_kind,
     NEW.run_id,NEW.plan_id,NEW.source_snapshot_id,NEW.target_set_hash,NEW.target_count,
     'repair','accepted','accepted_provenance_verified',NEW.text_state,
     NEW.original_content_sha256,NEW.original_byte_count,NEW.page_count,
     NEW.page_count_state,NEW.result_document_count,NEW.result_document_set_hash,
     NEW.resolves_observation_hash,NEW.accepted_observation_hash,NEW.recorded_at,
     1,NEW.resolves_observation_hash
   WHERE NOT EXISTS (
     SELECT 1 FROM source_original_observations accepted
      WHERE accepted.tenant_id = NEW.tenant_id
        AND accepted.source = NEW.source
        AND accepted.original_id = NEW.original_id
        AND accepted.observation_hash = NEW.accepted_observation_hash
   );

  DELETE FROM source_original_accepted_resolution_admissions
   WHERE resolution_hash = NEW.resolution_hash;
END;

-- Current authority requires the accepted observation to remain the latest
-- same-original row. A newer gap, failure, or adjudicated exclusion therefore
-- demotes it immediately even when its old local activation still exists.
DROP VIEW IF EXISTS source_original_current_accepted_resolutions;

CREATE VIEW IF NOT EXISTS source_original_current_accepted_resolutions AS
SELECT resolution.sequence,
       resolution.source,
       resolution.original_id,
       resolution.locator_kind,
       resolution.resolves_observation_hash,
       resolution.accepted_observation_hash,
       resolution.family_receipt_hash,
       resolution.resolution_hash,
       resolution.admitted_at
  FROM source_original_accepted_resolutions resolution
  JOIN source_original_observations accepted
    ON accepted.tenant_id = resolution.tenant_id
   AND accepted.source = resolution.source
   AND accepted.original_id = resolution.original_id
   AND accepted.locator_kind = resolution.locator_kind
   AND accepted.observation_hash = resolution.accepted_observation_hash
   AND accepted.observation_stage = 'repair'
   AND accepted.outcome = 'accepted'
   AND accepted.reason_code = 'accepted_provenance_verified'
   AND accepted.original_content_sha256 = resolution.original_content_sha256
   AND accepted.original_byte_count = resolution.original_byte_count
   AND accepted.resolves_observation_hash = resolution.resolves_observation_hash
   AND accepted.result_document_count = resolution.result_document_count
   AND accepted.result_document_set_hash = resolution.result_document_set_hash
  JOIN source_original_result_family_receipts family
    ON family.family_receipt_hash = resolution.family_receipt_hash
   AND family.tenant_id = resolution.tenant_id
   AND family.source = resolution.source
   AND family.original_id = resolution.original_id
   AND family.locator_kind = resolution.locator_kind
   AND family.original_content_sha256 = resolution.original_content_sha256
   AND family.original_byte_count = resolution.original_byte_count
   AND family.document_count = resolution.result_document_count
  JOIN install_state installed
    ON installed.id = 1 AND installed.schema_version >= 46
 WHERE EXISTS (
   SELECT 1
     FROM source_original_accepted_resolution_activations activation
     JOIN source_original_current_result_family_verifications current
       ON current.verification_hash = activation.verification_hash
      AND current.family_receipt_hash = resolution.family_receipt_hash
    WHERE activation.resolution_hash = resolution.resolution_hash
      AND activation.tenant_id = resolution.tenant_id
 )
   AND accepted.text_state IN ('native_readable','ocr_reliable')
   AND EXISTS (
     SELECT 1 FROM source_original_observations prior
      WHERE prior.tenant_id = accepted.tenant_id
        AND prior.source = accepted.source
        AND prior.original_id = accepted.original_id
        AND prior.observation_hash = accepted.resolves_observation_hash
        AND prior.outcome IN ('gap','failed')
        AND prior.sequence = (
          SELECT max(candidate.sequence)
            FROM source_original_observations candidate
           WHERE candidate.tenant_id = accepted.tenant_id
             AND candidate.source = accepted.source
             AND candidate.original_id = accepted.original_id
             AND candidate.sequence < accepted.sequence
        )
   )
   AND NOT EXISTS (
     SELECT 1 FROM source_original_observations later
      WHERE later.tenant_id = accepted.tenant_id
        AND later.source = accepted.source
        AND later.original_id = accepted.original_id
        AND later.sequence > accepted.sequence
   )
   AND NOT EXISTS (
     SELECT 1
       FROM source_original_result_family_members member
       JOIN documents document
         ON document.document_revision_id = member.document_revision_id
        AND document.source_original_binding_hash = member.source_original_binding_hash
      WHERE member.family_receipt_hash = resolution.family_receipt_hash
        AND (
          (accepted.text_state = 'native_readable' AND document.text_source IS NOT 'native') OR
          (accepted.text_state = 'ocr_reliable' AND document.text_source IS NOT 'ocr')
        )
   );

-- Import bypasses the live CAS because portable rows can be replayed only in
-- their exported sequence order. Closing the marker proves that all schema-46
-- rows form one immediate-predecessor chain after a legacy version-zero prefix,
-- and that every schema-46 accepted row resolves the immediately preceding
-- gap/failure. Schema-45 version-zero acceptance remains historical evidence.
CREATE TRIGGER IF NOT EXISTS source_original_observation_authority_recovery_close_validate
BEFORE DELETE ON source_original_result_family_recovery_state
WHEN OLD.id = 1 AND OLD.mode = 'verified_recovery_import'
BEGIN
  SELECT RAISE(ABORT, 'recovered source original authority chain is not contiguous') WHERE EXISTS (
    SELECT 1 FROM source_original_observations observation
     WHERE (
       observation.authority_chain_version = 1
       AND (
         (observation.predecessor_observation_hash IS NULL AND EXISTS (
           SELECT 1 FROM source_original_observations prior
            WHERE prior.tenant_id = observation.tenant_id
              AND prior.source = observation.source
              AND prior.original_id = observation.original_id
              AND prior.sequence < observation.sequence
         )) OR
         (observation.predecessor_observation_hash IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM source_original_observations prior
            WHERE prior.tenant_id = observation.tenant_id
              AND prior.source = observation.source
              AND prior.original_id = observation.original_id
              AND prior.observation_hash = observation.predecessor_observation_hash
              AND prior.sequence = (
                SELECT max(candidate.sequence)
                  FROM source_original_observations candidate
                 WHERE candidate.tenant_id = observation.tenant_id
                   AND candidate.source = observation.source
                   AND candidate.original_id = observation.original_id
                   AND candidate.sequence < observation.sequence
              )
         ))
       )
     ) OR (
       observation.authority_chain_version = 0
       AND observation.predecessor_observation_hash IS NOT NULL
     ) OR (
       observation.authority_chain_version = 0
       AND EXISTS (
         SELECT 1 FROM source_original_observations prior
          WHERE prior.tenant_id = observation.tenant_id
            AND prior.source = observation.source
            AND prior.original_id = observation.original_id
            AND prior.sequence < observation.sequence
            AND prior.authority_chain_version = 1
       )
     )
  );

  -- Immediate-edge validation belongs to schema-46 authority rows only.
  -- Schema-45 accepted rows remain recoverable historical evidence even when
  -- an intervening observation makes their old resolution noncurrent.
  SELECT RAISE(ABORT, 'recovered accepted source original does not resolve the immediate authority predecessor') WHERE EXISTS (
    SELECT 1 FROM source_original_observations accepted
     WHERE accepted.outcome = 'accepted'
       AND accepted.authority_chain_version = 1
       AND NOT EXISTS (
         SELECT 1 FROM source_original_observations prior
          WHERE prior.tenant_id = accepted.tenant_id
            AND prior.source = accepted.source
            AND prior.original_id = accepted.original_id
            AND prior.observation_hash = accepted.resolves_observation_hash
            AND prior.outcome IN ('gap','failed')
            AND prior.sequence = (
              SELECT max(candidate.sequence)
                FROM source_original_observations candidate
               WHERE candidate.tenant_id = accepted.tenant_id
                 AND candidate.source = accepted.source
                 AND candidate.original_id = accepted.original_id
                 AND candidate.sequence < accepted.sequence
            )
       )
  );
END;

-- The replacement trigger, current view, and recovery validator are all live.
-- Remove the temporary barrier only as the final migration statement.
DROP TRIGGER IF EXISTS source_original_accepted_resolution_schema46_transition_block;
