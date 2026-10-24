import { createHash } from "node:crypto";
import { gmailAttachmentReviewCandidates } from "./gmail-attachment-review.mjs";
import {
  GMAIL_ATTACHMENT_BACKFILL_LIMIT, GMAIL_EXTRACTION_POLICY_VERSION, GMAIL_MAX_PAGES,
  gmailAttachmentCandidateQuery, gmailRevisionIsCurrent,
} from "../connectors/gmail.mjs";

export const GMAIL_ATTACHMENT_BACKFILL_PAGES = 10;
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const validToken = value => value === null || typeof value === "string" &&
  value.length > 0 && value.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(value);
const tokenHash = value => createHash("sha256").update(value).digest("hex");
const unsettledReview = review => review !== undefined && (!review || typeof review !== "object" ||
  Array.isArray(review) || review.ingest_removal_plan ||
  Object.keys(review.ingest_pending_families || {}).length || Object.keys(review.done || {}).length);
const failure = code => Object.assign(new Error(
  `Gmail attachment backfill is incomplete (${code}). Its checkpoint was kept; run ingestion again.`,
), { code: "INGEST_FAILED" });

function validateCheckpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1 ||
      !Number.isSafeInteger(value.extraction_version) || typeof value.query !== "string" ||
      typeof value.scanner_fingerprint !== "string" || typeof value.complete !== "boolean" ||
      !Array.isArray(value.pending_ids) || value.pending_ids.length > GMAIL_ATTACHMENT_BACKFILL_LIMIT ||
      value.pending_ids.some(id => !validId(id)) || new Set(value.pending_ids).size !== value.pending_ids.length ||
      !validToken(value.next_page_token) ||
      (value.refresh_ids !== undefined && (!Array.isArray(value.refresh_ids) ||
        value.refresh_ids.length > GMAIL_ATTACHMENT_BACKFILL_LIMIT ||
        value.refresh_ids.some(id => !validId(id) || !value.pending_ids.includes(id)))) ||
      (value.complete && (value.pending_ids.length || value.next_page_token !== null || unsettledReview(value.review))) ||
      (value.enumeration_started !== undefined && typeof value.enumeration_started !== "boolean") ||
      (value.page_token_hashes !== undefined && (!Array.isArray(value.page_token_hashes) ||
        value.page_token_hashes.length > GMAIL_MAX_PAGES ||
        value.page_token_hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))))) {
    throw failure("invalid_checkpoint");
  }
}

/** Runs after normal history settles, under its existing source lease. No
 * provider cursor, inventory or credential store belongs to this module.
 * The caller injects the same preparation, batching and exact receipt boundary
 * used by ordinary ingestion. Candidate enumeration never proves absence.
 */
export async function runGmailAttachmentBackfill({
  state, source, scannerFingerprint, since = null, dryRun = false,
  limit = GMAIL_ATTACHMENT_BACKFILL_LIMIT, gmail, getToken,
  saveState, assertOwned = () => {}, prepare, send, recordAccepted, createReview,
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > GMAIL_ATTACHMENT_BACKFILL_LIMIT) {
    throw new TypeError("Gmail attachment backfill limit must be between 1 and 100");
  }
  const query = gmailAttachmentCandidateQuery({ since });
  const result = { attempted: 0, accepted: 0, excluded: 0, pages: 0, would_send: 0, complete: false, error: null };
  // Dry previews use a private copy and never persist candidate or cleanup state.
  const working = dryRun ? { ...state, gmail_attachment_backfill: structuredClone(state.gmail_attachment_backfill) } : state;
  let checkpoint = working.gmail_attachment_backfill;
  const persist = () => { if (!dryRun) { assertOwned(); saveState(); } };
  try {
    if (checkpoint !== undefined) validateCheckpoint(checkpoint);
    const cleanup = gmailAttachmentReviewCandidates({ state: working, source, query, scannerFingerprint,
      extractionVersion: GMAIL_EXTRACTION_POLICY_VERSION });
    if (!checkpoint || checkpoint.extraction_version !== GMAIL_EXTRACTION_POLICY_VERSION ||
        checkpoint.query !== query || checkpoint.scanner_fingerprint !== scannerFingerprint) {
      // Keep cleanup identities when restarting the search. An old approval is
      // invalidated, never reused under a different scanner or corpus policy.
      checkpoint = working.gmail_attachment_backfill = {
        schema_version: 1, extraction_version: GMAIL_EXTRACTION_POLICY_VERSION,
        query, scanner_fingerprint: scannerFingerprint, pending_ids: [...cleanup.ids],
        refresh_ids: [...cleanup.ids], next_page_token: null,
        complete: false, enumeration_started: false, page_token_hashes: [],
      };
      persist();
    } else if (cleanup.changed) {
      const pending = [...new Set([...cleanup.ids, ...checkpoint.pending_ids])];
      if (pending.length > GMAIL_ATTACHMENT_BACKFILL_LIMIT) throw failure("invalid_cleanup_queue");
      checkpoint.pending_ids = pending;
      checkpoint.refresh_ids = [...new Set([...cleanup.ids, ...(checkpoint.refresh_ids || [])])];
      delete checkpoint.review;
      persist(); // Fresh candidate intent replaces the stale approval atomically.
    }
    if (checkpoint.complete) {
      if (checkpoint.review !== undefined) createReview();
      result.complete = true;
      return result;
    }
    const review = dryRun ? null : createReview();
    if (dryRun && cleanup.ids.length && !cleanup.changed) return result;
    // Never overwrite an unresolved exact approval with another candidate page.
    if (review && (review.pending() || Object.keys(checkpoint.review.done || {}).length)) await review.finish();
    checkpoint.enumeration_started ??= checkpoint.pending_ids.length > 0 || checkpoint.next_page_token !== null;
    checkpoint.page_token_hashes ||= [];
    delete checkpoint.last_error;
    while (result.attempted < limit) {
      if (!checkpoint.pending_ids.length) {
        if (checkpoint.enumeration_started && checkpoint.next_page_token === null) {
          checkpoint.complete = true;
          persist();
          break;
        }
        if (result.pages >= GMAIL_ATTACHMENT_BACKFILL_PAGES) break;
        if (checkpoint.page_token_hashes.length >= GMAIL_MAX_PAGES) throw failure("candidate_page_limit");
        const requested = checkpoint.next_page_token;
        const digest = requested === null ? null : tokenHash(requested);
        if (digest && checkpoint.page_token_hashes.includes(digest)) throw failure("repeated_page_token");
        result.pages++;
        let page;
        try {
          page = await gmail.listAttachmentCandidates(getToken, {
            query, pageToken: requested, pageSize: limit - result.attempted,
          });
        } catch (error) {
          if (requested !== null && error?.reason === "attachmentPageTokenExpired") {
            checkpoint.next_page_token = null;
            checkpoint.enumeration_started = false;
            checkpoint.page_token_hashes = [];
            persist();
            throw failure("candidate_token_restarted");
          }
          throw failure("candidate_page_unavailable");
        }
        // Validate the seam too: a replacement pager cannot silently broaden or
        // truncate the requested page, even when the production pager is strict.
        if (!page || !Array.isArray(page.ids) || page.ids.length > limit - result.attempted ||
            page.ids.some(id => !validId(id)) || new Set(page.ids).size !== page.ids.length ||
            !validToken(page.nextPageToken) || (page.nextPageToken !== null &&
              (page.nextPageToken === requested || checkpoint.page_token_hashes.includes(tokenHash(page.nextPageToken))))) {
          throw failure("invalid_candidate_page");
        }
        if (digest) checkpoint.page_token_hashes.push(digest);
        checkpoint.pending_ids = [...page.ids];
        checkpoint.next_page_token = page.nextPageToken;
        checkpoint.enumeration_started = true;
        persist(); // IDs and following token are durable before any raw read.
        if (!checkpoint.pending_ids.length) continue;
      }
      const id = checkpoint.pending_ids[0];
      const key = `${source}:${id}`;
      result.attempted++;
      // A restarted search may encounter exact receipts from an earlier page.
      // Scanner changes start a new walk, so old extraction receipts alone do
      // not establish a new scanner decision; normal history settles that first.
      if (checkpoint.refresh_ids?.includes(id) || !gmailRevisionIsCurrent(state.done?.[key]) || state.skipped?.[key]) {
        let prepared;
        try { prepared = await prepare(id); }
        catch { throw failure("candidate_preparation_failed"); }
        if (prepared?.terminal) {
          result.excluded++;
          if (!dryRun) {
            state.skipped ||= {};
            state.skipped[key] = prepared.terminal;
          }
        } else if (!prepared?.familyPlan) {
          throw failure("candidate_evidence_missing");
        } else if (dryRun) {
          result.would_send += prepared.familyPlan.expectedParts;
        } else if (!dryRun) {
          let accepted;
          try { accepted = await send(prepared); }
          catch { throw failure("candidate_write_unconfirmed"); }
          if (accepted !== true) throw failure("candidate_write_unconfirmed");
          const previousRevision = state.done?.[key];
          const previousSkip = state.skipped?.[key];
          recordAccepted(prepared.familyPlan);
          try { review.remember([prepared.familyPlan]); }
          catch (error) {
            // A rejected selector must not leave a current-version receipt that
            // could bypass cleanup on retry. If remember installed the exact
            // intent before a save failed, keep that pair together for recovery.
            if (checkpoint.review?.ingest_pending_families?.[key]?.hash !== prepared.familyPlan.hash) {
              if (previousRevision === undefined) delete state.done[key];
              else state.done[key] = previousRevision;
              if (previousSkip === undefined) delete state.skipped[key];
              else state.skipped[key] = previousSkip;
            }
            throw error;
          }
          checkpoint.refresh_ids = (checkpoint.refresh_ids || []).filter(value => value !== id);
          persist(); // Acceptance and cleanup intent survive a preview failure.
          result.accepted++;
          await review.finish();
        }
      }
      checkpoint.pending_ids.shift();
      checkpoint.refresh_ids = (checkpoint.refresh_ids || []).filter(value => value !== id);
      if (!checkpoint.pending_ids.length && checkpoint.next_page_token === null && checkpoint.enumeration_started) checkpoint.complete = true;
      persist();
      if (checkpoint.complete) break;
    }
    result.complete = checkpoint.complete && !(dryRun && cleanup.ids.length);
  } catch (error) {
    if (checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)) {
      checkpoint.last_error = error?.code === "SAFETY_REVIEW_REQUIRED" ? "cleanup_review_required" : "candidate_work_incomplete";
      persist();
    }
    result.error = error;
  }
  return result;
}
