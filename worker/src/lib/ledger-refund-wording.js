// Missing refund authority changes the stated basis, never erases the recorded
// gross amount or invents a net figure. Keep the supported reading first.
export function refundBasisAnswer(answer, detail =
  'The amounts are before subtracting refunds. The bank feed does not supply a refund or reversal type, so the net amount is unknown.') {
  const [lead, ...rest] = answer.split('\n');
  return [lead, detail, ...rest].join('\n');
}
