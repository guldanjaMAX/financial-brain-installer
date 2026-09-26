/**
 * The one reviewed Wrangler package identity used by every executable path.
 *
 * Keep the exact version here so legacy session refresh, named-profile OAuth,
 * doctor, source preparation, and the locked recovery closure cannot select
 * different dependency trees. Package metadata and its lock are checked
 * against this contract by test/wrangler-spec-pinned.test.mjs.
 */
export const REVIEWED_WRANGLER_PACKAGE_NAME = "wrangler";
export const REVIEWED_WRANGLER_VERSION = "4.131.1";
export const REVIEWED_WRANGLER_SPEC =
  `${REVIEWED_WRANGLER_PACKAGE_NAME}@${REVIEWED_WRANGLER_VERSION}`;
export const MINIMUM_REVIEWED_SHARP_VERSION = "0.35.4";
