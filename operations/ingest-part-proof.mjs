import { createHash } from 'node:crypto';
import { chunkText } from '../worker/src/lib/store.js';

const sameDatabase = (a,b) => a?.instance === b?.instance && a?.nonce === b?.nonce && a?.generation === b?.generation;
const validDatabase = value => /^[a-f0-9]{32}$/.test(value?.instance) && /^[a-f0-9]{32}$/.test(value?.nonce) &&
  Number.isSafeInteger(value?.generation) && value.generation >= 0;

/** A saved offset is acceptance too. Audit the whole accepted map before a
 * source can claim coverage, including entries behind a saved page/window.
 * The bounded continuation is useful only at the exact current database cut.
 * An ordinary write may restart it conservatively, just as a restore does.
 */
export async function revalidateIngestProgress({ state, source, proofs, checkpointKey, policyFingerprint,
  read, invalidate, save, maxEntries = 97, expired = () => false }) {
  const keys = Object.keys(proofs || {}).filter(key => key.startsWith(`${source}:`)).sort();
  if (!keys.length) {
    if (state[checkpointKey]) { delete state[checkpointKey]; save(); }
    return true;
  }
  const fingerprint = () => createHash('sha256').update(JSON.stringify([policyFingerprint,keys.filter(key => proofs[key]).map(key => {
    const {revision,policy_fingerprint,geometry,parts} = proofs[key];
    return [key,state.done?.[key],revision,policy_fingerprint,geometry,parts];
  })])).digest('hex');
  if (expired()) return false;
  // This bounded exact-identity read also observes the marker when its part is
  // absent. Never infer a database cut from the saved marker or family presence.
  const sample = proofs[keys[0]];
  const observed = await read({proof:{...sample,parts:Array.isArray(sample?.parts) && sample.parts.length
    ? sample.parts.slice(0,1) : [{source_id:keys[0].slice(source.length+1)}]}});
  if (!observed) return false;
  if (!validDatabase(observed.database)) throw new Error('Current database progress proof is invalid.');
  let check = state[checkpointKey];
  const initialFingerprint = fingerprint();
  if (!sameDatabase(check?.database,observed.database) || check.fingerprint !== initialFingerprint) {
    check = state[checkpointKey] = {database:observed.database,fingerprint:initialFingerprint,after:null,complete:false};
    save();
  }
  if (check.complete === true) return true;
  let count = 0;
  let invalidated = false;
  const finish = complete => {
    // Hash once per slice, rather than once per accepted entry. A crash before
    // this save conservatively restarts the scan if invalidation changed its set.
    if (invalidated) check.fingerprint = fingerprint();
    check.complete = complete; save(); return complete;
  };
  for (const key of keys) {
    if (check.after !== null && key <= check.after) continue;
    if (count++ >= maxEntries || expired()) return finish(false);
    const saved = proofs[key];
    const reusable = Array.isArray(saved?.parts) && saved.parts.length > 0 && saved.revision === state.done?.[key] &&
      saved.policy_fingerprint === policyFingerprint;
    const proof = reusable ? await read({proof:saved}) : null;
    if (reusable && !proof) return finish(false);
    if (proof && !sameDatabase(check.database,proof.database)) {
      // Preserve every unvisited identity; a suffix at a different cut cannot
      // certify the earlier prefix. The next invocation starts at the beginning.
      delete state[checkpointKey]; save(); return false;
    }
    if (!reusable || proof.parts.length !== saved.parts.length) {
      invalidate(key);
      delete proofs[key];
      invalidated = true;
    } else proofs[key] = {...saved,...proof};
    check.after = key;
    // Save invalidation and its exact retry obligation together, before the
    // next request or a source cursor can cross this identity.
    save();
  }
  return finish(true);
}

// Waits between read-only retries when the database is briefly busy.
export const PART_READBACK_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 10000]);
const TRANSIENT_D1_READBACK = /D1 DB is overloaded|exceeded its CPU time limit|Database reset because/i;
let sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Test seam: replace the wait between readback retries. */
export function setPartReadbackSleepForTest(fn) { sleepMs = fn; }

/** Every reuse reads current D1, even if a saved database marker still matches.
 * A backup imported into another database, time travel, and missing chunks all
 * invalidate the affected part without replaying an intact sibling.
 */
export async function readCurrentIngestParts({ base, adminKey, source, envelopes, proof, request = fetch,
  assertOwned, deadlineAt = Infinity, now = Date.now, matchCalendarRevision = false }) {
  const candidates = envelopes || proof?.parts || [];
  if (!candidates.length) return null;
  const ids = candidates.map(part => part.source_id);
  if (new Set(ids).size !== ids.length) throw new Error('Part readback needs unique identities.');
  const confirmed = [];
  let database, geometry;
  for (let offset = 0; offset < ids.length; offset += 50) {
    if (now() >= deadlineAt) throw Object.assign(new Error('Part readback deadline reached.'), {reason:'requestDeadline'});
    assertOwned?.();
    const selected = ids.slice(offset,offset+50);
    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await request(`${base}/api/admin/brain/ingest-part-proof`, {
        method:'POST', redirect:'error', headers:{'Content-Type':'application/json','X-Admin-Key':adminKey},
        body:JSON.stringify({source,source_ids:selected,...(matchCalendarRevision ? {calendar_revision:true} : {})}), signal:AbortSignal.timeout(Math.max(1,Math.min(30000,Math.ceil(deadlineAt-now())))),
      });
      assertOwned?.();
      // This readback only reads. A large Brain's database can refuse it for a
      // few seconds right after a write batch ("D1 DB is overloaded", or a CPU
      // reset); wait and read again rather than failing the whole source.
      if (response.ok || attempt >= PART_READBACK_RETRY_DELAYS_MS.length || ![429,500,503].includes(response.status)) break;
      const detail = await response.clone().text().catch(() => '');
      if (response.status !== 429 && !TRANSIENT_D1_READBACK.test(detail)) break;
      const wait = PART_READBACK_RETRY_DELAYS_MS[attempt];
      if (now() + wait >= deadlineAt) break;
      await sleepMs(wait);
    }
    if (!response.ok) throw Object.assign(new Error('Current database part readback failed; source work remains pending.'), {status:response.status});
    const body = await response.json();
    const g = body?.geometry;
    if (body?.source !== source || !validDatabase(body.database) || !Array.isArray(body.parts) ||
        !Number.isInteger(g?.size) || g.size < 256 || g.size > 1800 || !Number.isInteger(g.overlap) || g.overlap < 0 || g.overlap >= g.size ||
        new Set(body.parts.map(p=>p.source_id)).size !== body.parts.length ||
        body.parts.some(p=>!selected.includes(p.source_id) || !/^[a-f0-9]{64}$/.test(p.content_hash) || !Number.isInteger(p.chunk_count) || p.chunk_count < 1 || p.chunk_count > 512) ||
        (database && (!sameDatabase(database,body.database) || geometry.size !== g.size || geometry.overlap !== g.overlap))) {
      throw new Error('Current database part readback changed or was invalid; source work remains pending.');
    }
    database = body.database; geometry = g;
    for (const part of body.parts) {
      const candidate = candidates.find(p=>p.source_id===part.source_id);
      const expectedHash = envelopes ? createHash('sha256').update(`chunk-v1:${g.size}:${g.overlap}\0${candidate.content}`).digest('hex') : candidate.content_hash;
      const count = envelopes ? chunkText(candidate.content,g).length : candidate.chunk_count;
      const revision = candidate.metadata?.calendar_revision;
      const exactCalendarRevision = !matchCalendarRevision ||
        (typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision) &&
          part.calendar_revision === revision && part.document_date === Date.parse(candidate.occurred_at));
      if (exactCalendarRevision && part.content_hash === expectedHash && part.chunk_count === count &&
          (envelopes || (proof.geometry?.size === g.size && proof.geometry?.overlap === g.overlap))) confirmed.push(part);
    }
  }
  return { database, geometry, parts:confirmed };
}
