/**
 * A Zoom passcode pasted into an event's description or location must not
 * reach the ingest envelope.
 *
 * WHY THIS EXISTS. sanitizeConferenceUri already strips `?pwd=` from the
 * structured conference link, but the same link pasted by hand into the
 * DESCRIPTION or LOCATION went through untouched. The worker's credential gate
 * (worker/src/lib/secret-scan.js) then refused the whole envelope on
 * `pwd=<long token>`, and because one event was refused the calendar sync never
 * completed and reported "failed" every day while new events kept arriving.
 *
 * The proof runs the real rendered envelope through scanEnvelope, the same gate
 * the worker applies, rather than asserting on a regex in isolation.
 *
 * The same rule covers the event TITLE, and a bare `pwd=` / `passcode=` /
 * `pw=` key=value typed outside any URL in the title, description or location
 * (the partner's ruling on the two review notes). Microsoft Graph events and
 * .ics imports are proven end to end through syncMicrosoftGraph and extract().
 *
 * All fixtures are synthetic. The passcode tokens are invented strings shaped
 * like a Zoom pwd value; they open nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnvelope, renderEvent } from "../connectors/google-calendar.mjs";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import { extract } from "../ingest/extract.mjs";
import { scanEnvelope } from "../worker/src/lib/secret-scan.js";

const CAL = { id: "calendar-owner@example.com", key: "primary", label: "Calendar Owner" };
// Invented 32-character token, shaped like a Zoom pwd value.
const TOKEN = "Q7mXk2LpR9vT4wNz8bHc3JdF6gYs1aEu";
const ZOOM_PATH = "https://us02web.zoom.us/j/81234567890";
const ZOOM_WITH_PWD = `${ZOOM_PATH}?pwd=${TOKEN}`;

function baseEvent(overrides = {}) {
  return {
    kind: "calendar#event",
    id: "evt_pwd_fixture_001",
    status: "confirmed",
    htmlLink: "https://www.google.com/calendar/event?eid=ZXZ0X3B3ZF9maXh0dXJl",
    updated: "2026-10-19T16:00:00.000Z",
    summary: "Quarterly review with Vendor Alpha LLC",
    organizer: { email: "calendar-owner@example.com", displayName: "Calendar Owner" },
    start: { dateTime: "2026-10-21T09:00:00-07:00", timeZone: "America/Phoenix" },
    end: { dateTime: "2026-10-21T10:00:00-07:00", timeZone: "America/Phoenix" },
    attendees: [
      { email: "calendar-owner@example.com", displayName: "Calendar Owner", responseStatus: "accepted" },
      { email: "payer-one@vendor-alpha.example", displayName: "Payer One", responseStatus: "accepted" },
    ],
    ...overrides,
  };
}

function upsert(event) {
  const out = buildEnvelope(event, { calendar: CAL });
  assert.equal(out.kind, "upsert", `expected an upsert, got ${out.kind}: ${out.reason || ""}`);
  return out.envelope;
}

function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); stringsIn(v, out); }
  return out;
}

function assertNoPasscode(envelope) {
  const json = JSON.stringify(envelope);
  assert.ok(!json.includes(TOKEN), "the passcode token must not appear anywhere in the envelope");
  assert.ok(!/[?&](pwd|passcode|pw)=/i.test(json), "no passcode query parameter may survive in the envelope");
  for (const s of stringsIn(envelope)) {
    assert.ok(!/(?<![A-Za-z0-9_])(pwd|passcode|pw)=\S/i.test(s), `no bare passcode key=value may survive: ${s}`);
  }
}

function assertGatePasses(envelope) {
  const verdict = scanEnvelope(envelope);
  assert.equal(verdict.shouldRefuse, false, `credential gate refused the envelope: ${JSON.stringify(verdict.labels)}`);
}

// The envelope title is "<summary> <em dash> <local start date>".
const titleFor = (summary) => `${summary} \u2014 2026-10-21`;

test("gate: a Zoom link with ?pwd= pasted into the DESCRIPTION no longer gets the event refused", () => {
  const event = baseEvent({
    description: `Agenda: review the Vendor Alpha LLC renewal terms.<br>Join here: ${ZOOM_WITH_PWD}<br>Bring the signed scope.`,
  });
  const env = upsert(event);
  const verdict = scanEnvelope(env);
  assert.equal(verdict.shouldRefuse, false, `credential gate refused the envelope: ${JSON.stringify(verdict.labels)}`);
  assertNoPasscode(env);
  // The meeting link still identifies the meeting for a human reader.
  assert.ok(env.content.includes(`Join here: ${ZOOM_PATH}\n`), env.content);
  assert.ok(env.content.includes("Agenda: review the Vendor Alpha LLC renewal terms."), env.content);
  assert.ok(env.content.includes("Bring the signed scope."), env.content);
});

test("gate: a Zoom link with ?pwd= in the LOCATION no longer gets the event refused", () => {
  const event = baseEvent({ location: `Owner Holdings LLC office, or ${ZOOM_WITH_PWD}` });
  const env = upsert(event);
  const verdict = scanEnvelope(env);
  assert.equal(verdict.shouldRefuse, false, `credential gate refused the envelope: ${JSON.stringify(verdict.labels)}`);
  assertNoPasscode(env);
  assert.ok(env.content.includes(`Where: Owner Holdings LLC office, or ${ZOOM_PATH}\n`), env.content);
  assert.equal(env.metadata.location, `Owner Holdings LLC office, or ${ZOOM_PATH}`);
});

test("renderEvent (also used for .ics and Microsoft Graph events) strips the passcode from description and location", () => {
  const out = renderEvent(baseEvent({
    description: `Notes before.\n${ZOOM_WITH_PWD}\nNotes after.`,
    location: ZOOM_WITH_PWD,
  }), { calendar: CAL });
  assert.ok(!out.includes(TOKEN), out);
  assert.ok(out.includes(`Where: ${ZOOM_PATH}\n`), out);
  assert.ok(out.includes(`Notes before.\n${ZOOM_PATH}\nNotes after.`), out);
});

test("passcode parameter names are matched case-insensitively and other parameters are kept in order", () => {
  const description = [
    `A: https://zoom.us/j/111?uname=guest&PWD=${TOKEN}&from=addon`,
    `B: https://zoom.us/j/222?Passcode=${TOKEN}`,
    `C: https://zoom.us/j/333?pw=${TOKEN}#success`,
    `D: zoommtg://zoom.us/join?confno=444&pwd=${TOKEN}`,
    `E: us02web.zoom.us/j/555?pwd=${TOKEN}`,
  ].join("\n");
  const env = upsert(baseEvent({ description }));
  assert.equal(scanEnvelope(env).shouldRefuse, false);
  assertNoPasscode(env);
  assert.ok(env.content.includes(
    [
      "A: https://zoom.us/j/111?uname=guest&from=addon",
      "B: https://zoom.us/j/222",
      "C: https://zoom.us/j/333#success",
      "D: zoommtg://zoom.us/join?confno=444",
      "E: us02web.zoom.us/j/555",
    ].join("\n")
  ), env.content);
});

test("trailing sentence punctuation after a passcode URL is preserved", () => {
  const env = upsert(baseEvent({ description: `Use the link (${ZOOM_WITH_PWD}). Or ${ZOOM_WITH_PWD}, then dial in.` }));
  assertNoPasscode(env);
  assert.ok(env.content.includes(`Use the link (${ZOOM_PATH}). Or ${ZOOM_PATH}, then dial in.`), env.content);
});

test("control: other URLs and all other description text are byte-identical", () => {
  const description = [
    "Prep list for Vendor Alpha LLC:",
    "  - agenda doc https://docs.example.com/d/abc123/edit?usp=sharing&tab=t.0#heading=h.1",
    "  - tracker: https://tracker.example.com/issues?id=42&sort=desc",
    "Plain words with a question? Yes. And an ampersand & an equals = sign.",
    "Mail payer-one@vendor-alpha.example if anything changes.",
  ].join("\n");
  const env = upsert(baseEvent({ description, location: "Room 4, https://maps.example.com/place?q=Owner+Holdings+LLC" }));
  assert.equal(scanEnvelope(env).shouldRefuse, false);
  assert.ok(env.content.includes(`Notes:\n${description}\n`), env.content);
  assert.equal(env.metadata.location, "Room 4, https://maps.example.com/place?q=Owner+Holdings+LLC");
});

test("control: a URL whose PATH merely contains the text pwd is unchanged", () => {
  const description = [
    "Policy: https://wiki.example.com/pwd=policy/reset-pwd",
    "Help: https://help.example.com/pwd/reset?step=2&pwdhint=none",
    "Exact: https://example.com/a/pwd?x=1",
  ].join("\n");
  const location = "https://wiki.example.com/rooms/pwd-lab?floor=2";
  const env = upsert(baseEvent({ description, location }));
  assert.ok(env.content.includes(`Notes:\n${description}\n`), env.content);
  assert.equal(env.metadata.location, location);
});

test("control: the structured conference link is still sanitized", () => {
  const event = baseEvent({
    conferenceData: {
      conferenceSolution: { name: "Zoom Meeting" },
      entryPoints: [{ entryPointType: "video", uri: ZOOM_WITH_PWD }],
    },
  });
  const env = upsert(event);
  assert.equal(scanEnvelope(env).shouldRefuse, false);
  assertNoPasscode(env);
  assert.equal(env.metadata.conference_url, ZOOM_PATH);
  assert.ok(env.content.includes(`Video link: ${ZOOM_PATH}`), env.content);
});

/* ------------------------------------------------------------------------
 * Second commit: the event TITLE, and bare pwd= / passcode= / pw= outside URLs.
 * --------------------------------------------------------------------- */

test("gate: a Zoom link with ?pwd= in the TITLE no longer gets the event refused", () => {
  const env = upsert(baseEvent({ summary: `Vendor Alpha LLC renewal ${ZOOM_WITH_PWD}` }));
  assertGatePasses(env);
  assertNoPasscode(env);
  assert.equal(env.title, titleFor(`Vendor Alpha LLC renewal ${ZOOM_PATH}`));
  assert.ok(env.content.startsWith(`Meeting: Vendor Alpha LLC renewal ${ZOOM_PATH}\n`), env.content);
});

test("gate: a bare pwd=<token> in the DESCRIPTION no longer gets the event refused", () => {
  const env = upsert(baseEvent({
    description: `Agenda: review the renewal terms.<br>Room code pwd=${TOKEN} then dial in.<br>Bring the signed scope.`,
  }));
  assertGatePasses(env);
  assertNoPasscode(env);
  // Only the key=value token goes; the text on both sides is untouched.
  assert.ok(env.content.includes(
    "Notes:\nAgenda: review the renewal terms.\nRoom code  then dial in.\nBring the signed scope.\n"
  ), env.content);
});

test("gate: a bare pwd=<token> in the LOCATION no longer gets the event refused", () => {
  const env = upsert(baseEvent({ location: `Owner Holdings LLC office, pwd=${TOKEN} at the front desk` }));
  assertGatePasses(env);
  assertNoPasscode(env);
  assert.equal(env.metadata.location, "Owner Holdings LLC office,  at the front desk");
  assert.ok(env.content.includes("Where: Owner Holdings LLC office,  at the front desk\n"), env.content);
});

test("gate: a bare pwd=<token> in the TITLE no longer gets the event refused", () => {
  const env = upsert(baseEvent({ summary: `Weekly sync pwd=${TOKEN}` }));
  assertGatePasses(env);
  assertNoPasscode(env);
  assert.equal(env.title, titleFor("Weekly sync"));
  assert.ok(env.content.startsWith("Meeting: Weekly sync\n"), env.content);

  // A title that was nothing but the passcode falls back like an empty title.
  const bare = upsert(baseEvent({ summary: `pwd=${TOKEN}` }));
  assertGatePasses(bare);
  assertNoPasscode(bare);
  assert.equal(bare.title, titleFor("(untitled event)"));
  assert.ok(bare.content.startsWith("Meeting: (untitled event)\n"), bare.content);
});

test("a title that is only a passcode plus spaces falls back to (untitled event) in the envelope title too", () => {
  // The envelope title must agree with the rendered Meeting line. Before this,
  // the title fell back before trimming, so 'pwd=<token> ' left an empty name:
  // " <em dash> 2026-10-21". A whitespace-only title did the same.
  for (const summary of [`pwd=${TOKEN} `, `   pwd=${TOKEN}   `, `\tpasscode=${TOKEN}\n`, "   "]) {
    const env = upsert(baseEvent({ summary }));
    assertGatePasses(env);
    assertNoPasscode(env);
    assert.equal(env.title, titleFor("(untitled event)"), JSON.stringify(summary));
    assert.ok(env.content.startsWith("Meeting: (untitled event)\n"), env.content);
  }
  // A title with real words around the passcode keeps those words, trimmed.
  const kept = upsert(baseEvent({ summary: `  Weekly sync pwd=${TOKEN} ` }));
  assert.equal(kept.title, titleFor("Weekly sync"));
  assert.ok(kept.content.startsWith("Meeting: Weekly sync\n"), kept.content);
});

test("a '.1'-suffixed Zoom token is stripped even though the gate alone would let it through", () => {
  const dotted = `${TOKEN}.1`;
  // Why the gate is not enough: its lookahead stops at the '.', so this exact
  // credential passes the gate untouched. It must be removed anyway.
  assert.equal(scanEnvelope({ content: `pwd=${dotted}` }).shouldRefuse, false);

  const env = upsert(baseEvent({
    summary: `Weekly sync pwd=${dotted}`,
    description: `Room code pwd=${dotted}. Or ${ZOOM_PATH}?pwd=${dotted}, then dial in.`,
    location: `Owner Holdings LLC office pwd=${dotted}`,
  }));
  assertGatePasses(env);
  assertNoPasscode(env);
  assert.equal(env.title, titleFor("Weekly sync"));
  // Trailing sentence punctuation after the token is kept.
  assert.ok(env.content.includes(`Notes:\nRoom code . Or ${ZOOM_PATH}, then dial in.\n`), env.content);
  assert.equal(env.metadata.location, "Owner Holdings LLC office ");
});

test("bare passcode keys are matched case-insensitively and quoted or bracketed values go whole", () => {
  const env = upsert(baseEvent({
    summary: `Sync PWD=${TOKEN} today`,
    description: [
      `A: Passcode=${TOKEN} for the room`,
      `B: PW=${TOKEN}`,
      `C: pwd="${TOKEN}" as sent`,
      `D: (pwd=${TOKEN}).`,
      `E: confno=444&pwd=${TOKEN}&uname=guest`,
    ].join("\n"),
    location: `Room 4 passcode=${TOKEN}`,
  }));
  assertGatePasses(env);
  assertNoPasscode(env);
  assert.equal(env.title, titleFor("Sync  today"));
  assert.ok(env.content.includes(
    ["A:  for the room", "B:", "C:  as sent", "D: ().", "E: confno=444&&uname=guest"].join("\n")
  ), env.content);
  assert.equal(env.metadata.location, "Room 4 ");
});

test("control: ordinary text containing pw, pwd or passcode is byte-identical in title, description and location", () => {
  const summary = "pw is short for password; the word pwd alone stays";
  const description = [
    "pw is short for password.",
    "The word pwd alone is not a passcode, and neither is PWD in capitals.",
    "Keys that only contain the letters stay: spw=abc npw=abc pwdhint=x my_pwd=abc pw2=abc passcodes=abc.",
    "Passcode lines are filtered by the boilerplate rule, not by this one.",
    "A key with no value stays as written: pwd= and pwd=.",
  ].join("\n");
  const location = "Room pw-4, spw=abc, pwdhint=x";
  const env = upsert(baseEvent({ summary, description, location }));
  assertGatePasses(env);
  assert.equal(env.title, titleFor(summary));
  assert.ok(env.content.startsWith(`Meeting: ${summary}\n`), env.content);
  assert.ok(env.content.includes(`Notes:\n${description}\n`), env.content);
  assert.equal(env.metadata.location, location);
  assert.ok(env.content.includes(`Where: ${location}\n`), env.content);
});

test("control: a 'Passcode:' line is still dropped by the boilerplate rule, as before", () => {
  const env = upsert(baseEvent({ description: "Before the call.\nPasscode: 482913\nAfter the call." }));
  assert.ok(env.content.includes("Notes:\nBefore the call.\nAfter the call.\n"), env.content);
  assert.ok(!env.content.includes("482913"), env.content);
});

test("control: other URLs in the TITLE, including a path containing pwd=, are byte-identical", () => {
  const summary =
    "Review https://docs.example.com/d/abc123/edit?usp=sharing#heading=h.1 and https://wiki.example.com/pwd=policy/reset-pwd";
  const env = upsert(baseEvent({ summary }));
  assert.equal(env.title, titleFor(summary));
  assert.ok(env.content.startsWith(`Meeting: ${summary}\n`), env.content);
});

test("control: the conference link is still sanitized when the title also carries a passcode", () => {
  const env = upsert(baseEvent({
    summary: `Vendor Alpha LLC renewal pwd=${TOKEN}`,
    conferenceData: {
      conferenceSolution: { name: "Zoom Meeting" },
      entryPoints: [{ entryPointType: "video", uri: ZOOM_WITH_PWD }],
    },
  }));
  assertGatePasses(env);
  assertNoPasscode(env);
  assert.equal(env.metadata.conference_url, ZOOM_PATH);
  assert.ok(env.content.includes(`Video link: ${ZOOM_PATH}`), env.content);
});

test("Microsoft Graph: a passcode in the subject, body and location is removed before the gate", async () => {
  const graphEvent = {
    id: "graph-pwd-fixture-1",
    subject: `Vendor Alpha LLC renewal ${ZOOM_WITH_PWD} pwd=${TOKEN}`,
    body: { contentType: "text", content: `Agenda first.\nRoom code pwd=${TOKEN} then dial in.\nJoin: ${ZOOM_WITH_PWD}` },
    start: { dateTime: "2026-10-21T16:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-21T17:00:00.0000000", timeZone: "UTC" },
    organizer: { emailAddress: { name: "Calendar Owner", address: "calendar-owner@example.com" } },
    attendees: [{ type: "required", status: { response: "accepted" }, emailAddress: { name: "Payer One", address: "payer-one@vendor-alpha.example" } }],
    location: { displayName: `Owner Holdings LLC office pwd=${TOKEN}` },
    webLink: "https://outlook.office.invalid/calendar/item/pwd-fixture",
    lastModifiedDateTime: "2026-10-19T16:00:00.000Z",
    iCalUId: "pwd-fixture-ical-uid",
  };
  const result = await syncMicrosoftGraph({
    accessToken: "offline-token",
    mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    now: () => Date.parse("2026-10-20T12:00:00.000Z"),
    fetchImpl: async () => new Response(JSON.stringify({
      value: [graphEvent],
      "@odata.deltaLink": "https://graph.microsoft.com/calendar-delta-pwd-fixture",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.documents.length, 1, JSON.stringify(result.warnings));
  const env = result.documents[0];
  assertGatePasses(env);
  assertNoPasscode(env);
  assert.ok(env.title.startsWith(`Vendor Alpha LLC renewal ${ZOOM_PATH} — `), env.title);
  assert.ok(env.content.includes(`Room code  then dial in.\nJoin: ${ZOOM_PATH}`), env.content);
  assert.equal(env.metadata.location, "Owner Holdings LLC office ");
});

test(".ics import: a passcode in SUMMARY, DESCRIPTION and LOCATION is removed from the rendered text", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Fixture//Passcode//EN",
    "X-WR-CALNAME:Calendar Owner",
    "BEGIN:VEVENT",
    "UID:pwd-fixture-1@example.test",
    "DTSTART:20261021T160000Z",
    "DTEND:20261021T170000Z",
    `SUMMARY:Vendor Alpha LLC renewal ${ZOOM_WITH_PWD} pwd=${TOKEN}.1`,
    `DESCRIPTION:Agenda first.\\nRoom code pwd=${TOKEN} then dial in.\\nJoin: ${ZOOM_WITH_PWD}`,
    `LOCATION:Owner Holdings LLC office\\, passcode=${TOKEN}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const got = await extract(Buffer.from(ics, "utf-8"), "owner-calendar.ics");
  assert.equal(got.how, "calendar", JSON.stringify(got));
  assert.ok(got.text, JSON.stringify(got));
  assertGatePasses({ content: got.text });
  assert.ok(!got.text.includes(TOKEN), got.text);
  assert.ok(got.text.includes(`Meeting: Vendor Alpha LLC renewal ${ZOOM_PATH}\n`), got.text);
  assert.ok(got.text.includes(`Room code  then dial in.\nJoin: ${ZOOM_PATH}`), got.text);
  assert.ok(got.text.includes("Where: Owner Holdings LLC office, \n"), got.text);
});
