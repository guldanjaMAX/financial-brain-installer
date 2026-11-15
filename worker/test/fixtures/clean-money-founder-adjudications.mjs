// Independent finder figures remain in the JSON. These are explicit opposing
// assertions required by the founder's "unproved stays counted and flagged" rule.
// Each entry requires the exact retained figure AND disclosure of the named row.
export const founderAdjudications={
  // income:C10 retired by candidate 4 fix steps 6-7: the owned Stripe merchant
  // account's payout debit and the equal Stripe-paid bank deposit share one
  // platform identity, so the sweep is proved and the finder's 102000 is right.
  'income:C31':{minor:5300000,rows:['r1'],why:'Imported loan-disbursement wording is unproved; retain the 5000000 minor units and flag them.'},
  'income:C34':{minor:1200000,rows:['r1'],why:'Loan from owner has no confirmed code or owned endpoint.'},
  'income:C35':{minor:900000,rows:['r1'],why:'Credit-line draw wording has no confirmed code or owned endpoint.'},
  'income:C38':{minor:650000,rows:['r1'],why:'An owner-contribution memo alone is unproved.'},
  'income:C40':{minor:500000,rows:['r1'],why:'The personal checking source is unconnected.'},
  'income:C41':{minor:350000,rows:['r1'],why:'The word personal does not identify an owned source account.'},
  'income:C42':{minor:210000,rows:['r1'],why:'Self-directed Zelle wording has no confirmed endpoint.'},
  'income:C53':{minor:180000,duplicate:true,why:'Two unlinked imports remain counted until the owner approves identity.'},
  'income:C61':{minor:150000,rows:['r2'],why:'The purported source has no confirmed owned entity.'},
  'credits:C03':{minor:0,rows:['r2'],why:'A same-merchant liability credit nominates a refund; it does not prove one.'},
  'credits:C16':{minor:500000,rows:['r2'],why:'A person-to-person memo mentioning a refund is unproved customer-refund membership.'},
  'credits:C26':{minor:200000,rows:['r2'],why:'A bank payment category without a resolved owned destination does not prove the unconnected card repayment; retain and flag 80000 minor units.'},
  'credits:C27':{minor:200000,rows:['r2'],why:'An EPAY descriptor and last four do not establish an unconnected owned card.'},
  'credits:C33':{minor:206000,rows:['r1'],why:'Equal balance-transfer amounts with no bank code or directed endpoint remain counted.'},
  'credits:C35':{minor:100000,rows:['r2'],why:'Cash-advance wording without a code or resolved endpoint remains counted.'},
  // 0.4.28 loan-proceeds rule returns C37 to its independent finder figure; its exclusion stays flagged below.
  'credits:C39':{minor:2900000,rows:['r1'],why:'Loan-proceeds wording without a code or endpoint remains counted.'},
  'credits:C41':{minor:900000,rows:['r2'],why:'Equal ADVANCE and DEPOSIT amounts do not prove a transfer.'},
  'credits:C46':{minor:245000,rows:['r2'],why:'An unconnected lender in a memo is not a separately recorded repayment party.'},
  'credits:C47':{minor:1800000,rows:['r1'],why:'Uncoded disbursement/payoff labels do not establish reciprocal ownership.'},
  'credits:C49':{minor:2500000,rows:['r1'],why:'A 50000-minor-unit funding difference does not prove a fee; retain and flag the uncoded advance.'},
  'credits:C53':{minor:108500,rows:['r2'],why:'A principal memo alone does not prove repayment membership; separately posted interest remains spending.'},
  'credits:C66':{minor:12000,duplicate:true,why:'An unlinked live/import collision stays counted with duplicate dollars disclosed.'},
  'credits:C69':{minor:170000,rows:['r1'],why:'Two owned cards share the locator; the payment endpoint is ambiguous.'},
};
// Fix steps 6-7: likely exclusions. Founder option (b) (11-12) lets money with
// contrary evidence be "excluded or flagged with a lowered confidence". The
// finder figure is kept; each row is left out, stays estimated, keeps the
// answer below High and discloses its exact left-out dollars.
export const likelyExclusions={
  'credits:C37':{rows:['r1'],why:'A card cash advance is likely loan proceeds, left out of spending with its dollars disclosed.'},
  'income:C43':{rows:['r1','r2'],why:'Reciprocal account-kind words with the only checking and only savings account make the transfer likely, not proved: left out and flagged.'},
};
