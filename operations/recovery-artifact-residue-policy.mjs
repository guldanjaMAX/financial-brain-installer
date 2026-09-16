import { resolve, sep } from "node:path";

/**
 * Plaintext and staging names used by the fixed recovery-artifact pipeline.
 * A closeout path containing any of these names is never retained evidence.
 */
export const RECOVERY_ARTIFACT_RESIDUE_EXACT_NAMES = Object.freeze([
  ".brain-recovery-export.sql.tmp-data",
  ".brain-recovery-export.sql.tmp-combined",
]);

export const RECOVERY_ARTIFACT_RESIDUE_PREFIXES = Object.freeze([
  ".brain-recovery-plaintext.tmp-",
  ".brain-recovery-encrypted.tmp-",
  ".brain-recovery-runtime-",
]);

export function isRecoveryArtifactResiduePathComponent(value) {
  const component = typeof value === "string" ? value : "";
  return RECOVERY_ARTIFACT_RESIDUE_EXACT_NAMES.includes(component) ||
    RECOVERY_ARTIFACT_RESIDUE_PREFIXES.some((prefix) =>
      component.startsWith(prefix));
}

export function hasRecoveryArtifactResiduePathComponent(path) {
  if (typeof path !== "string" || path.length === 0) return true;
  return resolve(path).split(sep).some(isRecoveryArtifactResiduePathComponent);
}
