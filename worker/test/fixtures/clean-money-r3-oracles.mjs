// 0.4.28 closed-world party certificates and question-scoped pending evidence (triage #51).
const reviewedSelectionScores={"cards":{"C04":89,"C07":65,"C10":65,"C11":65,"C16":65,"C19":78,"C20":65,"C21":65,"C27":67,"C36":65,"C43":54,"C44":54,"C45":54,"C46":40,"C47":65,"C56":65,"C57":65,"C58":75,"C62":65,"C63":65,"C70":75},"payouts":{"P04":100,"P32":51,"P39":65,"P42":50,"P43":79,"P67":100}};
const reviewedAnswerScores={"cards":{"C17":89,"C29":89,"C33":66,"C04":75},"payouts":{"P20":89,"P25":89,"P45":89,"P47":89,"P60":89,"P32":50,"P43":75},"periods":{"P12":89,"P26":69,"P27":69,"P28":69,"P39":89,"P45":89,"P61":89,"P62":89,"P65":89}};
// Independent figures stay in the finder JSON. These exceptions implement the
// founder's higher-priority rule: an unproved guess remains counted and flagged.
export const figureAdjudications={
 // 0.4.28 loan-proceeds rule restores C16 to the independent finder figure.
 'cards:C20':{minor:40000,rows:['r2'],why:'A merchant-named statement credit does not prove a purchase refund; retain gross spending.'},
 'cards:C31':{minor:240000,rows:['r1','r2'],why:'Bare balance-transfer labels and equal amounts do not prove owned endpoints.'},
 'cards:C35':{minor:90000,rows:['r1','r2'],why:'A balance-transfer destination and a generic credit do not prove the reciprocal source.'},
 'cards:C36':{minor:127500,rows:['r1'],why:'A generic payment acknowledgement does not prove the source of a balance-transfer debit.'},
 'cards:C59':{minor:1000000,rows:['r1'],why:'A confirmed receiving proceeds code does not establish the loan debit destination.'},
 // These old loan-spending expectations removed an unproved debit on lender
 // wording alone. Retain each complete debit, plus separately recorded costs.
 'cards:C41':{minor:125000+30000,rows:['r1'],why:'A lender name and LOAN PAYMENT do not prove an owned repayment endpoint.'},
 'cards:C44':{minor:125000+35000,rows:['r1'],why:'Principal and interest receipts do not prove which debit funded them; retain the unproved debit and the recorded interest.'},
 'cards:C46':{minor:125000+31000,rows:['r1'],why:'A generic receiving acknowledgement does not prove the debit destination; the separate interest charge remains spending.'},
 'cards:C47':{minor:240000+60000,rows:['r1'],why:'Mortgage wording without an owned endpoint cannot remove the debit from spending.'},
 'cards:C48':{minor:45000+30000,rows:['r1'],why:'Auto-loan wording without an owned endpoint cannot remove the debit from spending.'},
 'cards:C49':{minor:80000+20000,rows:['r1'],why:'SBA-loan wording without an owned endpoint cannot remove the debit from spending.'},
 'cards:C50':{minor:80000+20000,rows:['r1'],why:'A generic loan-payment memo cannot remove the debit from spending.'},
 'cards:C56':{minor:90000+35000,rows:['r1'],why:'Separate principal/interest memo labels do not prove the principal destination; both debits remain counted.'},
 'cards:C67':{minor:45000+15000,rows:['r1'],why:'An outside auto lender is not a proved owned liability; retain the complete debit.'},
 'cards:C65':{minor:61000,rows:['r1'],why:'Retain the 52000 coded payment without an owned destination plus 9000 of purchases; disclose may be a card payment: $520.00.'},
 // Candidate 4 fix steps 6-7 (platforms and transfer proof) retired P25 and
 // P29-P32 here. P25 is now a proved processor sweep: the owned Stripe merchant
 // account's same-day payout debit and the equal Stripe-named bank deposit share
 // one platform identity, so the finder's 10000 is certified. P29-P32 moved to
 // likelyExclusions below: their figure is the finder's, left out and flagged.
 'payouts:P58':{minor:0,rows:[],why:'The founder requires a numeric visible amount, with the processor reserve balance explicitly unknown.'},
};
// Fix steps 6-7: likely exclusions. Founder option (b) (11-12) lets money with
// contrary evidence be "excluded or flagged with a lowered confidence". These
// rows are left out of the figure, stay estimated, keep the answer below High
// and disclose their exact left-out dollars. A minor value marks a figure that
// differs from the finder JSON, with the reason it is the independent truth.
export const likelyExclusions={
 'cards:C16':{rows:['r1'],why:'A cash advance is likely loan proceeds: left out, still estimated and disclosed below High.'},
 'payouts:P29':{rows:['out','in'],why:'Connected merchant sales already cover the five-day-later bank payout; both legs are a likely sweep, left out and flagged.'},
 'payouts:P30':{rows:['out','in'],why:'A five-day transfer-coded payout covered by merchant sales is a likely sweep, left out and flagged.'},
 'payouts:P31':{rows:['out','in1','in2'],why:'Split bank payouts covered by merchant sales are a likely sweep, left out and flagged.'},
 'payouts:P32':{rows:['out1','out2','in1','in2'],why:'Repeated payouts covered by merchant sales are likely sweeps, left out and flagged; no FIFO pair is certified.'},
 'payouts:P57':{minor:0,rows:['hold'],why:'Audit root cause B3: a processor reserve hold is the owner\'s money held by the processor, not spending; it is left out and flagged until the processor reserve statement confirms it.'},
};
// Selection quality uses the worst currency/direction ratio, not the
// R1 reports' pooled gross denominator. Unseparated proved loan interest costs 25;
// gross-sales evidence costs 25, and an absent reserve statement costs 60.
// Unproved loan debits instead incur ceil(35 * unproved / directional total).
export const scoreAdjudications={
 cards:{C11:71,C16:66,C19:86,C20:86,C25:65,C31:65,C32:65,C33:66,C35:65,C36:67,
   C41:71,C42:71,C43:65,C44:65,C45:65,C46:71,C47:72,C48:79,C49:72,C50:72,
   C53:75,C56:74,C57:74,C59:65,C67:73,
   // Candidate 4 fix steps 2-4 (reversals): a "PAYMENT RETURNED" debit stays
   // an estimated payment_reversal until reconciled (20 + 10), so selection
   // quality is 70. Both figures are unchanged and independently right.
   C68:70,C69:70},
 payouts:{P22:75,P23:75,P25:100,P29:66,P30:66,P31:66,P32:66,P36:65,P42:65,P46:66,P48:65,P57:65,P58:25,
   // Fix steps 6-7: a bank-memo platform descriptor with no recorded payer and
   // no provider income category gives attribution, not transaction-type proof:
   // the whole deposit stays counted but estimated (35). Figures unchanged.
   P02:65,P04:65,P12:65,P13:65,P38:65,P67:65},
 // Different-provider amount matches are guesses, so the pending hold remains
 // visible with a possible-match note and its original 15-point penalty.
 periods:{P28:85},
};
export function expectedScore(kind,c){
 return reviewedSelectionScores[kind]?.[c.id] ?? scoreAdjudications[kind]?.[c.id] ?? (kind==='cards'?Number(c.expected.confidence.match(/\((\d+)%\)/)[1]):kind==='payouts'?c.expected.score:c.exp.score);
}

// Independent combined-contract ceilings for these synthetic books. An exact
// selected interval cannot certify an undeclared account inventory (95).
// Static uncertain membership costs 20, unproved opposite legs cost 10,
// and duplicate/unreadable history costs 15. Opaque period evidence caps at 89.
// These are fixture expectations, never read from the production score.
// Candidate 4 fix step 1 (dates and scoring): literal SQL dates prove the
// period without period arguments (95), and period arguments no longer
// replace SQL proof (89). An OR/subquery selection stays outside the proved
// grammar (89); an unresolved payment-return posting caps at 89. Only the
// score ceiling moves; every figure assertion below is unchanged.
const evidenceCeilings={
 cards:{C08:89,C16:65,C19:75,C20:75,C33:65,C36:65,C46:65,C48:75,C58:89,C62:85,C64:89,C69:89,C70:89},
 payouts:{P02:95,P13:95,P20:95,P25:95,P32:65,P38:95,P43:95,P45:95,P47:95,P59:95,P60:95},
 // Candidate 4 review fix R2: P06/P56/P57 send from/to, so the read starts
 // inside the refund horizon and payee deposits stay below High (89).
 periods:{P05:89,P06:89,P07:89,P08:89,P09:89,P10:89,P12:95,
   P18:89,P19:89,P20:89,
   // Live-mode rows have no connection or successful sync receipts: 100-40.
   // The unresolved private hold costs ceil(45*2500/14500)=8 or /17000=7.
   // Fix step 8: P26's hold has an exact provider-linked posted twin (11-02),
   // so the independent scorer no longer charges it (100-40). Figures unchanged.
   P26:60,P27:52,P28:53,P31:89,P36:80,P39:95,P40:89,P45:95,
   // The February same-day pair lies outside the October read (P65).
   P52:89,P53:89,P56:89,P57:89,P61:95,P62:95,P65:95},
};
export function expectedAnswerScore(kind,c){
 const ceiling=evidenceCeilings[kind]?.[c.id] ?? (kind==='payouts'?89:95);
 return reviewedAnswerScores[kind]?.[c.id] ?? Math.min(expectedScore(kind,c),ceiling);
}
// Step 5 name for the same selected-account/date quality oracle.
export const expectedSelectionScore=expectedScore;
