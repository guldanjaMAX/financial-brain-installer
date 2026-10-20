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
 * All fixtures are synthetic. The passcode tokens are invented strings shaped
 * like a Zoom pwd value; they open nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnvelope, renderEvent } from "../connectors/google-calendar.mjs";
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

function assertNoPasscode(envelope) {
  const json = JSON.stringify(envelope);
  assert.ok(!json.includes(TOKEN), "the passcode token must not appear anywhere in the envelope");
  assert.ok(!/[?&](pwd|passcode|pw)=/i.test(json), "no passcode query parameter may survive in the envelope");
}

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
