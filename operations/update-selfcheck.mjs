import { BANK_ACCESS_WRAPPING_KEY_SECRET } from "./bank-access-wrapping-key.mjs";
import { createHash, randomBytes } from "node:crypto";
import { upgradeSelfcheckCheckpoint } from "./upgrade-bookmark.mjs";

const CHECKS = Object.freeze({
  bank: ["bank connections", "BANK_CHANGED"],
  secrets: ["Worker secret names", "SECRETS_CHANGED"],
  sources: ["connected sources", "SOURCES_CHANGED"],
  daily: ["the daily job", "DAILY_CHANGED"],
  claude: ["the Claude connection", "CLAUDE_CHANGED"],
});

const CUSTODY_MESSAGES = Object.freeze({
  BANK_ACCESS_REFERENCE_UNREADABLE: "Saved bank access cannot be opened.",
  BANK_ACCESS_LEGACY_KEY_UNAVAILABLE: "The legacy bank access key is unavailable.",
  BANK_ACCESS_WRAPPING_KEY_UNAVAILABLE: "The bank wrapping key is unavailable.",
  BANK_ACCESS_WRAPPING_KEY_INVALID: "The bank wrapping key is invalid.",
  BANK_ACCESS_WRAPPING_KEY_VERSION_UNSUPPORTED: "The saved bank access key version is unsupported.",
  BANK_PAGE_CUSTODY_MISMATCH: "The bank page and saved connection inventory disagree.",
});
const UNCHECKED = "UPDATE_SELFCHECK_NOT_CHECKED";
const LEGACY_BANK_PROOF = "The older Worker did not report whether saved bank access could be opened.";
const LEGACY_BANK_STATE = "The older Worker proved saved bank access without reporting the bank page state.";
export const UPDATE_SELFCHECK_RECEIPT_FAILED = "UPDATE_SELFCHECK_RECEIPT_FAILED";

export function previewUpdateSelfcheck(write) {
  write("Dry run. Before and after the update, the self-check would read bank connections, Worker secret names (including the bank wrapping key), connected sources and their last runs, the daily job and its schedule, and the Claude connection. Nothing was written.");
  return { dry_run: true };
}

function exactRows(rows, { allowUnchecked = false } = {}) {
  if (!Array.isArray(rows)) throw new Error("Missing inventory");
  const refs = new Set();
  for (const row of rows) {
    if (typeof row?.ref !== "string" || !row.ref || refs.has(row.ref) ||
        !(typeof row.ok === "boolean" || (allowUnchecked && row.ok === null))) {
      throw new Error("Ambiguous inventory");
    }
    refs.add(row.ref);
  }
  return rows;
}

export function bankSelfcheckRows(body, { legacy = false } = {}) {
  const hasCurrent = Object.hasOwn(body ?? {}, "update_selfcheck");
  const hasCustody = body?.read_only === true;
  const page = !hasCustody && typeof body?.configured === "boolean" && Array.isArray(body.connections)
    ? exactRows(body.connections.map(row => ({
      ref: row.item_ref, state: bankPageState(row.status), ok: null, message: LEGACY_BANK_PROOF,
    })), { allowUnchecked: true }) : null;
  if (!hasCurrent && !hasCustody && legacy && page) return page;
  const custody = hasCustody ? bankOpeningRows(body.connections, true) : null;
  if (!hasCurrent && legacy && custody) {
    return custody.map(row => ({ ...row, state_unchecked: row.state === undefined }));
  }
  const current = bankOpeningRows(body?.update_selfcheck, false);
  const alternate = custody ?? page;
  if (!alternate) return current;
  const byRef = new Map(alternate.map(row => [row.ref, row]));
  const mismatched = row => ({ ...row, ok: false, mismatch: true,
    message: CUSTODY_MESSAGES.BANK_PAGE_CUSTODY_MISMATCH });
  // A page row contributes state only. A custody row contributes opening
  // evidence, and any state it carries must agree with the current proof.
  const rows = current.map(row => {
    const other = byRef.get(row.ref);
    byRef.delete(row.ref);
    if (custody && !other && row.openingNotApplicable) return row;
    return !other || (other.state !== undefined && row.state !== other.state) ||
      (custody && (row.ok !== other.ok || row.message !== other.message)) ? mismatched(row) : row;
  });
  return [...rows, ...Array.from(byRef.values(), mismatched)];
}

function bankOpeningRows(connections, legacy) {
  if (!Array.isArray(connections)) throw new Error("Bank access proof is unavailable");
  return exactRows(connections.map(row => {
    const state = legacy && row?.state === undefined ? undefined : row?.state === null ? null : bankPageState(row?.state);
    if (state === null && row?.code !== "BANK_PAGE_CUSTODY_MISMATCH") {
      throw new Error("Bank access proof is unavailable");
    }
    if (row?.opens === false && row.code === "BANK_ACCESS_CHECK_UNAVAILABLE") {
      return { ref: row.connection_ref, state, ok: null };
    }
    if (row?.opens === false && row.code === "BANK_ACCESS_NOT_APPLICABLE" &&
        ["removed", "permission_revoked"].includes(state)) {
      return { ref: row.connection_ref, state, ok: false, openingNotApplicable: true };
    }
    const message = Object.hasOwn(CUSTODY_MESSAGES, row?.code) ? CUSTODY_MESSAGES[row.code] : null;
    if (!(row?.opens === true && row.code === "BANK_ACCESS_READABLE") &&
        !(row?.opens === false && message)) throw new Error("Bank access proof is unavailable");
    return {
      ref: row.connection_ref, state, ok: row.opens, message,
      mismatch: row.code === "BANK_PAGE_CUSTODY_MISMATCH",
    };
  }), { allowUnchecked: true });
}

function bankPageState(state) {
  if (typeof state !== "string" || !/^[a-z][a-z_]{0,47}$/u.test(state)) {
    throw new Error("Bank access proof is unavailable");
  }
  return state;
}

export function sourceSelfcheckRows(inventory, noChangeCheckAt) {
  const connected = inventory.sources.filter(row => row?.registered !== false &&
    !(row?.registered === undefined && row?.freshness?.state === "unregistered"));
  return connected.map(({ name, source_id, kind, connector, receipt, registered }) => {
    if (typeof kind !== "string" || !kind || typeof name !== "string" || !name || !receipt ||
        (registered !== undefined && registered !== true)) {
      throw new Error("Invalid source inventory row");
    }
    return {
      ref: JSON.stringify([name, kind]),
      // Older compact freshness receipts omitted these fields.
      identity: [source_id ?? null, connector?.provider ?? null, receipt.registered_at ?? null],
      oldRef: JSON.stringify([name, name, kind, null, null]),
      ok: receipt.latest_run?.outcome === "completed" || Boolean(noChangeCheckAt(kind, receipt.latest_run)),
    };
  });
}

function dailySchedule(value) {
  if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== "string" ||
      !/^(?:\d{4}-\d{2}-\d{2}T)?(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.0+)?)?$/u.test(value[0]) ||
      !Number.isSafeInteger(value[1]) || value[1] <= 0 || typeof value[2] !== "boolean") return null;
  const [start, interval, enabled] = value;
  const boundary = start.replace(/\.0+$/u, "");
  // A past start date has no remaining effect on a daily trigger. A future
  // activation date still limits when the owner receives updates.
  const time = interval === 1 && Date.parse(boundary) <= Date.now() ? boundary.split("T").at(-1) : boundary;
  return [time.length === 5 ? time + ":00" : time, interval, enabled];
}

function validate(category, value) {
  if (category === "bank" || category === "sources") {
    return exactRows(value, { allowUnchecked: category === "bank" })
      .map(({ ref, ok, message, state, mismatch, state_unchecked, identity, oldRef }) => ({
        ref, ok, ...(category === "bank" ? {
          state: state == null ? state : bankPageState(state), mismatch: mismatch === true,
          ...(state_unchecked === true ? { state_unchecked: true } : {}),
          message: [LEGACY_BANK_PROOF, ...Object.values(CUSTODY_MESSAGES)].includes(message) ? message : undefined,
        } : identity === undefined ? {} : {
          identity: validateSourceIdentity(identity),
          ...(typeof oldRef === "string" ? { oldRef } : {}),
        }),
      }));
  }
  if (category === "secrets") {
    if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)) ||
        new Set(value).size !== value.length) throw new Error("Invalid Worker secret names");
    return [...value].sort();
  }
  if (typeof value?.present !== "boolean") throw new Error("Missing local readback");
  if (category === "daily") {
    const keys = values => {
      if (!Array.isArray(values) || values.some(key => typeof key !== "string" || !key)) throw new Error("Invalid daily source scope");
      return [...new Set(values)].sort();
    };
    const bridges = (value.bridges ?? []).map(row => ({ schedule: dailySchedule(row.schedule), keys: keys(row.keys) }));
    if (!value.present) return { present: false, bridges };
    const schedule = dailySchedule(value.schedule);
    if (typeof value.enabled === "boolean" && schedule) {
      return { present: true, enabled: value.enabled, schedule, bridges, keys: keys(value.keys ?? []) };
    }
    throw new Error("Invalid daily readback");
  }
  if (!value.present) return { present: false };
  if (category === "claude" && typeof value.points_here === "boolean") {
    return { present: true, points_here: value.points_here };
  }
  throw new Error("Invalid local readback");
}

function validateSourceIdentity(identity) {
  if (!Array.isArray(identity) || identity.length !== 3 ||
      identity.some(value => value !== null && (typeof value !== "string" || !value))) {
    throw new Error("Invalid source inventory identity");
  }
  return identity;
}

export async function captureUpdateSelfcheck(readers, categories = Object.keys(CHECKS)) {
  const checks = await Promise.all(categories.map(async category => {
    try {
      return [category, { value: validate(category, await readers[category]()) }];
    } catch (error) {
      // The request URL, provider text and body can contain private data.
      const status = error?.status;
      return [category, { unavailable: true, ...(Number.isInteger(status) && status >= 400 && status <= 599
        ? { message: `The service returned HTTP ${status}.` } : {}) }];
    }
  }));
  return Object.fromEntries(checks);
}

function entryState(category, ok) {
  if (ok === null) return "not_checked";
  if (ok) return "ok";
  return category === "bank" ? "unreadable" : "not_ok";
}

function summarize(category, value) {
  if (category === "bank" || category === "sources") {
    return {
      count: value.length,
      ok: value.filter(row => row.ok).length,
      entries: value.map(row => entryState(category, row.ok)),
      ...(category === "bank" && value.some(row => row.message === LEGACY_BANK_PROOF)
        ? { message: LEGACY_BANK_PROOF } : category === "bank" && value.some(row => row.state_unchecked)
          ? { message: LEGACY_BANK_STATE } : {}),
    };
  }
  if (category === "secrets") {
    return { names: value, bank_wrapping_key_present: value.includes(BANK_ACCESS_WRAPPING_KEY_SECRET) };
  }
  if (category === "daily") {
    const { keys, bridges, ...permanent } = value;
    return { ...permanent, bridges: bridges.map(bridge => ({ schedule: bridge.schedule })) };
  }
  return value;
}

function projectObservation(category, snapshot) {
  return snapshot.unavailable
    ? { status: "not_checked", ...(snapshot.message ? { message: snapshot.message } : {}) }
    : summarize(category, snapshot.value);
}

export function summarizeUpdateSelfcheck(snapshot) {
  return Object.fromEntries(Object.keys(CHECKS).map(category =>
    [category, projectObservation(category, snapshot[category])]));
}

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sameSchedule = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function bridgeHasReplacement(bridge, daily) {
  return bridge.schedule?.[2] === true && daily.present && daily.enabled &&
    sameSchedule(daily.schedule, bridge.schedule) && bridge.keys.length > 0 &&
    bridge.keys.every(key => daily.keys.includes(key));
}

export function equivalentDailyBridgeReplacement(bridges, replacement) {
  const previous = validate("daily", { present: false, bridges });
  const next = validate("daily", replacement);
  return previous.bridges.every(bridge => bridgeHasReplacement(bridge, next));
}

function committedSnapshot(snapshot, salt) {
  return Object.fromEntries(Object.entries(snapshot).map(([category, observation]) => {
    if (observation.unavailable) return [category, observation];
    const { value } = observation;
    const commit = ref => digest([salt, category, ref]);
    if (["bank", "sources"].includes(category)) {
      return [category, { value: value.map(({ ref, identity, oldRef, ...row }) => ({
        ...row, ref: commit(ref),
        ...(identity ? { identity: identity.map(value => value === null ? null : commit(value)) } : {}),
        ...(oldRef ? { oldRef: commit(oldRef) } : {}),
      })) }];
    }
    if (category === "daily") {
      const withScope = row => row.keys ? { ...row, keys: row.keys.map(commit).sort() } : row;
      return [category, { value: { ...withScope(value), bridges: value.bridges.map(withScope) } }];
    }
    return [category, observation];
  }));
}

// Only per-update commitments leave memory. Keep them in a separate private
// checkpoint so diagnostic receipts cannot be used to correlate connections.
export function openUpdateSelfcheck(account, database, options) {
  if (!account || !database) throw new Error("Missing update checkpoint binding");
  const binding = digest([account, database]);
  const store = upgradeSelfcheckCheckpoint(binding, options);
  let record = store.read();
  let before;
  if (record !== null) {
    if (record.version !== 1 || record.binding !== binding || !isDigest(record.salt)) {
      throw new Error("Invalid update checkpoint");
    }
    before = Object.fromEntries(Object.keys(CHECKS).map(category => {
      const observation = record.before?.[category];
      if (observation?.unavailable === true) {
        const { message } = observation;
        return [category, { unavailable: true, ...(typeof message === "string" &&
          /^The service returned HTTP [45]\d{2}\.$/u.test(message) ? { message } : {}) }];
      }
      const value = validate(category, observation?.value);
      if (["bank", "sources"].includes(category) && value.some(row => !isDigest(row.ref))) {
        throw new Error("Invalid update checkpoint");
      }
      if (category === "sources" && value.some(row => row.identity?.some(id => id !== null && !isDigest(id)) ||
          (row.oldRef !== undefined && !isDigest(row.oldRef)))) throw new Error("Invalid source checkpoint");
      return [category, { value }];
    }));
  }
  const resumed = record !== null;
  return {
    before,
    claim(before) {
      if (record) return;
      const salt = randomBytes(32).toString("hex");
      record = { version: 1, binding, salt, before: committedSnapshot(before, salt) };
      store.claim(record);
    },
    compare(before, after) {
      return compareUpdateSelfcheck(before, resumed ? committedSnapshot(after, record.salt) : after, { resumed });
    },
    unprovedRecovery(after) {
      return resumed && Object.keys(CHECKS).some(category => !before[category].unavailable &&
        (after[category].unavailable || (category === "bank" &&
          after.bank.value.some(row => row.ok === null || row.state_unchecked))));
    },
    clear() { store.clear(record); },
  };
}

function compare(category, before, after) {
  if (category === "bank" || category === "sources") {
    const byRef = new Map(after.map(row => [row.ref, row]));
    const byOldRef = new Map(after.filter(row => row.oldRef).map(row => [row.oldRef, row]));
    const lost = before.flatMap((row, index) => {
      const next = byRef.get(row.ref) ?? byOldRef.get(row.ref);
      const sourceChanged = category === "sources" && row.identity?.some((value, position) =>
        value !== null && value !== next?.identity?.[position]);
      const stateChanged = category === "bank" && row.state !== undefined && row.state !== null &&
        row.state !== next?.state && (row.state === "connected" || next?.state !== "connected");
      // An old page can advertise a link as connected without proving that
      // its saved access opens. A verified unreadable link cannot uphold that
      // baseline, even though we cannot date when access first broke.
      const advertisedConnected = row.message === LEGACY_BANK_PROOF && row.state === "connected";
      const unreadable = (row.ok === true || advertisedConnected) && next?.ok === false;
      return !next || sourceChanged || stateChanged || (!row.mismatch && next.mismatch) || unreadable ? [{
        entry: index + 1,
        before: entryState(category, row.ok),
        after: !next || sourceChanged || next.state === null ? "missing" : stateChanged ? "state_changed" : entryState(category, next.ok),
        ...(advertisedConnected && unreadable && !stateChanged ? { opening_unverified_before: true } : {}),
        ...(Object.values(CUSTODY_MESSAGES).includes(next?.message) ? { message: next.message } : {}),
      }] : [];
    });
    return lost.length ? { lost } : null;
  }
  if (category === "secrets") {
    const missing = before.filter(name => !after.includes(name));
    return missing.length ? { missing } : null;
  }
  if (category === "claude") {
    return before.present && (!after.present || (before.points_here && !after.points_here)) ? {} : null;
  }
  const bridgeChanged = before.bridges.some(bridge => !after.bridges.some(current =>
    sameSchedule(current.schedule, bridge.schedule) && sameSchedule(current.keys, bridge.keys)) &&
    !bridgeHasReplacement(bridge, after));
  if (bridgeChanged) return { bridge_changed: true };
  if (!before.present) return null;
  if (!after.present) return {};
  const scopeChanged = before.enabled && before.keys.some(key => !after.keys.includes(key));
  return scopeChanged || before.enabled !== after.enabled || !sameSchedule(before.schedule, after.schedule)
    ? { scope_changed: scopeChanged } : null;
}

export function compareUpdateSelfcheck(before, after, { resumed = false } = {}) {
  const checks = Object.entries(CHECKS).map(([category, [, changedCode]]) => {
    const previous = before[category];
    const current = after[category];
    const evidence = {
      category, before: projectObservation(category, previous), after: projectObservation(category, current),
    };
    if (category === "bank") {
      const inconsistent = [current, ...(!resumed || current.unavailable ? [previous] : [])]
        .filter(observation => !observation.unavailable)
        .find(observation => observation.value.some(row => row.mismatch));
      if (inconsistent) {
        return { ...evidence, status: "changed", code: `UPDATE_SELFCHECK_${changedCode}`, lost: [],
          proof_conflict: true };
      }
    }
    if (previous.unavailable || current.unavailable) {
      return { ...evidence, status: "not_checked", code: UNCHECKED };
    }
    const diff = compare(category, previous.value, current.value);
    if (diff) return { ...evidence, status: "changed", code: `UPDATE_SELFCHECK_${changedCode}`, ...diff };
    if (category === "bank" && [previous, current].some(snapshot =>
      snapshot.value.some(row => row.ok === null || row.state_unchecked))) {
      return { ...evidence, status: "not_checked", code: UNCHECKED };
    }
    return { ...evidence, status: "passed" };
  });
  const status = checks.some(check => check.status === "changed") ? "changed"
    : checks.some(check => check.status === "not_checked") ? "not_checked" : "passed";
  return { status, checks };
}

function describeChange(check) {
  if (check.category === "secrets") return `Missing names: ${check.missing.join(", ")}.`;
  if (check.category === "daily") {
    if (check.bridge_changed) return "An enabled daily bridge lost its schedule without an equivalent enabled replacement.";
    if (!check.after.present) return "The daily job is missing.";
    return [
      ...(check.before.enabled !== check.after.enabled ? [`The daily job is now ${check.after.enabled ? "enabled" : "disabled"}.`] : []),
      ...(JSON.stringify(check.before.schedule) !== JSON.stringify(check.after.schedule) ? ["The daily schedule changed."] : []),
      ...(check.scope_changed ? ["The daily schedule lost source coverage."] : []),
    ].join(" ");
  }
  if (check.category === "claude") {
    return check.after.present ? "The entry points to a different destination." : "The entry is missing.";
  }
  if (check.proof_conflict) return "The bank inventory or saved opening proofs disagree.";
  const missing = check.lost.filter(row => row.after === "missing").length;
  const stateChanged = check.lost.filter(row => row.after === "state_changed").length;
  const degraded = check.lost.length - missing - stateChanged;
  const unverifiedBefore = check.lost.filter(row => row.opening_unverified_before).length;
  return [
    ...(missing ? [`Missing entries: ${missing}.`] : []),
    ...(stateChanged ? [`Bank links with a changed connection state: ${stateChanged}.`] : []),
    ...(unverifiedBefore ? [`Unreadable links previously listed as connected: ${unverifiedBefore}.`] : []),
    ...(degraded > unverifiedBefore ? [check.category === "bank" ? `Newly unreadable links: ${degraded - unverifiedBefore}.`
      : `Last run became unsuccessful for ${degraded}.`] : []),
  ].join(" ");
}

export function updateSelfcheckMessage(report) {
  const lines = report.checks.flatMap(check => {
    if (check.status === "passed") return [];
    const [label] = CHECKS[check.category];
    const messages = [...new Set([
      check.before?.message, check.after?.message, ...(check.lost || []).map(row => row.message),
    ].filter(Boolean))];
    const openingUnproved = check.category === "bank" && check.lost?.length &&
      check.lost.every(row => row.opening_unverified_before);
    const opening = check.status === "not_checked"
      ? `Updated, but this check could not run for ${label}.`
      : `Update completion stopped because ${openingUnproved ? "saved bank access cannot be opened" : `${label} changed`}. ${describeChange(check)}`;
    return [`${opening} ${messages.join(" ")}`.trimEnd(),
      `[${check.code}] https://financialbrain.ai/help/${check.code}`];
  });
  if (report.status === "changed") lines.push("The self-check only read the bank, Worker secret names, sources, daily job, and Claude entry. It made no changes to them.");
  return lines.join("\n");
}
