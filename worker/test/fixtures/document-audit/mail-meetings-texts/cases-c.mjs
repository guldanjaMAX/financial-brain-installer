import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Calendar cases built by the real Google Calendar connector, money-word routing cases, and two status cases.
import { rec, calEvent } from "./harness.mjs";
const mail = (t, c, o = {}) => rec(t, c, { source: "mail", kind: "gmail", dateSource: "email:sent", ...o });
const meet = (t, c, o = {}) => rec(t, c, { source: "meetings", kind: "zoom", ...o });
const text = (t, c, o = {}) => rec(t, c, { source: "texts", kind: "imessage", ...o });
const series = () => calEvent({ id: "series", status: "confirmed", summary: "Meeting with the accountant",
  start: { dateTime: "2026-09-01T10:00:00-07:00" }, end: { dateTime: "2026-09-01T10:30:00-07:00" }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
  attendees: [{ email: "accountant@example.invalid", displayName: "The accountant" }] });
const instance = () => calEvent({ id: "inst", status: "confirmed", summary: "Meeting with the accountant",
  start: { dateTime: "2026-11-17T10:00:00-07:00" }, end: { dateTime: "2026-11-17T10:30:00-07:00" } });

export const cases = [
  { id: "RT17a3-next-meeting-real-connector-weekly-series", source_report: "REDTEAM Q17",
    question: "When is my next meeting with the accountant?", records: [series()],
    draft: "Your next meeting with the accountant is likely Tuesday 2026-11-17 at 10:00 AM, from the weekly Tuesday series that began 2026-09-01 [r0]." },
  { id: "RT17a4-next-meeting-real-connector-series-hedged-no-date", source_report: "REDTEAM Q17",
    question: "When is my next meeting with the accountant?", records: [series()],
    draft: "Your meeting with the accountant repeats weekly on Tuesday at 10:00 AM, so the next one is likely next Tuesday [r0]." },
  { id: "RT17c3-next-meeting-real-connector-dated-event-control", source_report: "REDTEAM Q17 (control)",
    question: "When is my next meeting with the accountant?", records: [instance()],
    draft: "Your next meeting with the accountant is on 2026-11-17 at 10:00 AM [r0]." },
  { id: "RT17b3-next-meeting-real-connector-dated-event-no-timezone", source_report: "REDTEAM Q17",
    question: "When is my next meeting with the accountant?", timezone: null, records: [instance()],
    draft: "Your next meeting with the accountant is on 2026-11-17 at 10:00 AM [r0]." },

  { id: "RT17c4-next-appointment-real-connector-control-no-meeting-word", source_report: "REDTEAM Q17 (control)",
    question: "When is my next appointment with the accountant?",
    records: [calEvent({ id: "inst2", status: "confirmed", summary: "Appointment with the accountant",
      start: { dateTime: "2026-11-17T10:00:00-07:00" }, end: { dateTime: "2026-11-17T10:30:00-07:00" } })],
    draft: "Your next appointment with the accountant is on 2026-11-17 [r0]." },
  { id: "FB16-next-call-with-client-real-connector", source_report: "auditor",
    question: "When is my next call with the client?",
    records: [calEvent({ id: "inst3", status: "confirmed", summary: "Call with the client",
      start: { dateTime: "2026-11-16T14:00:00-07:00" }, end: { dateTime: "2026-11-16T14:30:00-07:00" } })],
    draft: "Your next call with the client is on 2026-11-16 [r0]." },
  { id: "FB11-did-supplier-text-about-refund", source_report: "auditor",
    question: "Did the supplier text me about the refund?",
    records: [text("Text thread with supplier", "Supplier: we approved the refund for the damaged crates, you should see it within five business days.", { date: "2026-11-09" })],
    draft: "Yes. On 2026-11-09 the supplier texted that the refund for the damaged crates was approved and should arrive within five business days [r0]." },
  { id: "FB12-bank-rep-on-call-about-loan", source_report: "auditor",
    question: "What did the bank rep tell me on the call about the loan?",
    records: [meet("Call with bank rep", "Bank rep: the loan committee meets on the 20th and we need two more years of statements before then.", { date: "2026-11-10" })],
    draft: "The bank rep said the loan committee meets on the 20th and needs two more years of statements before then [r0]." },
  { id: "FB13-who-emailed-about-unpaid-invoice", source_report: "auditor (control: not handed off)",
    question: "Who emailed me about the unpaid invoice?",
    records: [mail("Past due notice", "From: Supplier North accounts team. Invoice 2210 is unpaid and now 15 days past due.", { date: "2026-11-08" })],
    draft: "Supplier North's accounts team emailed you on 2026-11-08 that invoice 2210 is unpaid and 15 days past due [r0]." },
  { id: "FB14-is-contractor-still-coming-friday", source_report: "auditor",
    question: "Is the contractor still coming Friday?",
    records: [text("Text thread with contractor", "Contractor: yes, see you Friday at 8, I'll bring the tile.", { date: "2026-11-11" })],
    draft: "Yes. On 2026-11-11 the contractor texted \"yes, see you Friday at 8\" and said he will bring the tile [r0]." },
  { id: "FB15-has-client-signed-yet-latest-email", source_report: "auditor",
    question: "What's the latest email from the client about the proposal?",
    records: [mail("Re: proposal", "From: the client. We reviewed the proposal and the board is not ready to sign; we need one more week.", { date: "2026-11-10" }),
      mail("Proposal", "From: the client. Thanks for sending the proposal, we will review it.", { date: "2026-11-03" })],
    draft: "The latest email from the client says the board is not ready to sign and needs one more week [r0]." },
];
