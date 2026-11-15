import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Re-runs with corrected fixtures (real calendar date_source, real spend cap) plus the auditor's own hard cases.
import { rec } from "./harness.mjs";
const mail = (t, c, o = {}) => rec(t, c, { source: "mail", kind: "gmail", dateSource: "email:sent", ...o });
const meet = (t, c, o = {}) => rec(t, c, { source: "meetings", kind: "zoom", ...o });
const text = (t, c, o = {}) => rec(t, c, { source: "texts", kind: "imessage", ...o });
const cal = (t, c, o = {}) => rec(t, c, { source: "calendar", kind: "calendar", dateSource: "calendar:event_start", ...o });
const filler = (n) => Array.from({ length: n }, (_, i) => `Speaker ${1 + (i % 3)}: item ${i + 1} on the agenda was the weekly numbers review, nothing changed from the prior week and no action was taken.`).join(" ");

export const cases = [
  { id: "RT17a2-next-meeting-weekly-series-calendar-source", source_report: "REDTEAM Q17",
    question: "When is my next meeting with the accountant?",
    records: [cal("Accountant weekly check-in", "Meeting with the accountant. Recurring: every Tuesday since 2026-09-01 at 10:00 am.", { date: "2026-09-01T17:00:00Z" })],
    draft: "Your next meeting with the accountant is likely Tuesday 2026-11-17 at 10:00 am, from the weekly series that began 2026-09-01 [r0]." },
  { id: "RT17c2-next-meeting-explicit-event-control", source_report: "REDTEAM Q17 (control)",
    question: "When is my next meeting with the accountant?",
    records: [cal("Meeting with the accountant", "Meeting with the accountant on 2026-11-17.", { date: "2026-11-17T17:00:00Z" })],
    draft: "Your next meeting with the accountant is on 2026-11-17 [r0]." },
  { id: "RT17b2-next-meeting-explicit-event-no-timezone", source_report: "REDTEAM Q17",
    question: "When is my next meeting with the accountant?", timezone: null,
    records: [cal("Meeting with the accountant", "Meeting with the accountant on 2026-11-17.", { date: "2026-11-17T17:00:00Z" })],
    draft: "Your next meeting with the accountant is on 2026-11-17 [r0]." },
  { id: "RT18b-install-day-zero-rows-index-building", source_report: "REDTEAM Q18",
    question: "What did the property manager write about fixing the leak?",
    records: [mail("Roof repair", "From the landlord: the roofer comes Thursday and the repair will take two days.", { date: "2026-11-09" })],
    projection: { status: "pending", expected: 500, actual: 3 }, empty: true,
    draft: "The landlord said the roofer comes Thursday and the repair takes two days [r0]." },
  { id: "RT21b-daily-limit-real-spend-cap", source_report: "REDTEAM Q21",
    question: "What did the landlord's email say about the roof repair?", env: { DAILY_LLM_CAP_USD: "0" },
    records: [mail("Roof repair", "From the landlord: the roofer comes Thursday and the repair will take two days.", { date: "2026-11-09" })],
    draft: "The landlord said the roofer comes Thursday and the repair takes two days [r0]." },
  { id: "RT23b-own-emails-claim-landlord-agreed-fresh", source_report: "REDTEAM Q23",
    question: "Did the landlord agree to let us sublease the back unit?",
    records: [
      mail("Sublease back unit", "From: the owner. To: the manager. The landlord agreed we can sublease the back unit.", { date: "2026-11-05" }),
      mail("Re: sublease plan", "From: the owner. To: the bookkeeper. Good news, the landlord agreed to the back unit sublease.", { date: "2026-11-06" }),
      mail("Sublease update", "From: the owner. To: the broker. The landlord agreed to let us sublease the back unit, please list it.", { date: "2026-11-07" })],
    draft: "Yes. The landlord agreed to let you sublease the back unit [r0][r1][r2]." },

  { id: "FB01-client-text-reschedule", source_report: "auditor",
    question: "What did the client text me about rescheduling?",
    records: [text("Text thread with client", "Client: can we move Thursday's session to Friday at 2 pm? I have a conflict that morning.", { date: "2026-11-10" })],
    draft: "The client asked to move Thursday's session to Friday at 2 pm because of a morning conflict [r0]." },
  { id: "FB02-how-much-contractor-quote-email", source_report: "auditor",
    question: "How much did the contractor quote me in his email?",
    records: [mail("Patio quote", "From: the contractor. Quote for the patio: $4,800 including materials. Valid for 30 days.", { date: "2026-11-06" })],
    draft: "The contractor quoted $4,800 for the patio, including materials, valid for 30 days [r0]." },
  { id: "FB03-did-landlord-reply-about-deposit", source_report: "auditor",
    question: "Did the landlord reply to my email about the deposit?",
    records: [mail("Re: deposit", "From: the landlord. To: the owner. Got your note. I will return the deposit within 14 days of move-out.", { date: "2026-11-09" })],
    draft: "Yes. On 2026-11-09 the landlord replied that he will return the deposit within 14 days of move-out [r0]." },
  { id: "FB04-gate-code-texted", source_report: "auditor",
    question: "What's the gate code the property manager texted me?",
    records: [text("Text thread with property manager", "Property manager: the gate code for the back lot is 4471. It changes on the first of each month.", { date: "2026-11-02" })],
    draft: "The property manager texted that the gate code for the back lot is 4471 and that it changes on the first of each month [r0]." },
  { id: "FB05-summarize-accountant-emails-this-month", source_report: "auditor",
    question: "Summarize my emails from the accountant this month",
    records: [
      mail("Quarterly estimate", "From: the accountant. Your fourth quarter estimate is due January 15. I will send the voucher next week.", { date: "2026-11-03" }),
      mail("Payroll forms", "From: the accountant. Please sign the payroll authorization form by Friday.", { date: "2026-11-06" }),
      mail("Year-end meeting", "From: the accountant. Let's hold the year-end planning meeting the first week of December.", { date: "2026-11-10" })],
    draft: "The accountant says your fourth quarter estimate is due January 15 [r0].\nThe accountant asks you to sign the payroll authorization form by Friday [r1].\nThe accountant proposes a year-end planning meeting the first week of December [r2]." },
  { id: "FB06-dentist-appointment-time-from-text", source_report: "auditor",
    question: "What time is the dentist appointment the office texted about?",
    records: [text("Text from dental office", "Reminder: your dentist appointment is on 2026-11-19 at 3:30 pm. Reply C to confirm.", { date: "2026-11-10" })],
    draft: "The dental office texted that your dentist appointment is on 2026-11-19 at 3:30 pm [r0]." },
  { id: "FB07-lender-said-in-meeting-interest-rate", source_report: "auditor",
    question: "What did the lender say in the meeting about the interest rate?",
    records: [meet("Call with lender", "Lender: we can hold the rate at 7.25% fixed for 60 days. Owner: that works if closing is before January.", { date: "2026-11-09" })],
    draft: "The lender said they can hold the rate at 7.25% fixed for 60 days [r0]." },
  { id: "FB08-walkthrough-moved-email-thread", source_report: "auditor",
    question: "When is the walkthrough with the inspector?",
    records: [
      mail("Walkthrough", "From: the inspector. The walkthrough with the inspector is on 2026-11-16 at 9 am.", { date: "2026-11-08" }),
      mail("Re: Walkthrough", "From: the inspector. Change of plans: the walkthrough with the inspector is moved to 2026-11-18 at 1 pm.", { date: "2026-11-10" })],
    draft: "The walkthrough with the inspector is on 2026-11-18 at 1 pm; it was moved from 2026-11-16 [r1]." },
  { id: "FB09-decision-at-end-of-long-transcript", source_report: "auditor",
    question: "What did we decide about the holiday schedule in the staff meeting?",
    records: [meet("Staff meeting transcript", `Staff meeting. ${filler(60)} Speaker 1: Decision on the holiday schedule: the shop is closed December 24 through December 26 and everyone gets paid for the 24th.`, { date: "2026-11-09" })],
    draft: (prompt) => /closed December 24/.test(prompt)
      ? "You decided the shop is closed December 24 through December 26 and everyone is paid for the 24th [r0]."
      : "The documents do not answer the question." },
  { id: "FB10-who-was-on-yesterdays-call-unverified-date", source_report: "auditor",
    question: "Who was on yesterday's call with the supplier?",
    records: [meet("Supplier call transcript", "Call with the supplier. Attendees: the owner, the supplier's account manager, and the shop manager.", { date: "2026-11-11", dateReliable: false, dateSource: "file:modified" })],
    draft: "The call with the supplier had the owner, the supplier's account manager and the shop manager [r0]." },
];
