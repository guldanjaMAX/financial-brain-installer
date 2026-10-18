// Synthetic grammar data shared by the identity and every-path matrices.
export const explicitStatements = [
  'Payer One', 'Payer One payment', 'Payer One ACH deposit', 'Payer One payroll',
  'WIRE FROM Payer One', 'WIRE TRANSFER FROM Payer One', 'ACH PAYMENT FROM Payer One',
  'BANK TRANSFER FROM Payer One', 'ACH CREDIT FROM: Payer One', 'FROM: Payer One',
  'EFT CREDIT BY Payer One', 'ZELLE PAYMENT FROM Payer One',
  'ORIG CO NAME: Payer One', 'ORIGINATOR: Payer One', 'ORIGINATOR NAME: Payer One',
  'WIRE ORIGINATOR: Payer One', 'WIRE TRANSFER ORIGINATOR NAME: Payer One',
  'ACH CREDIT ORIG CO NAME: Payer One ORIG ID: 4826170392 DESC DATE: 261005 CO ENTRY DESCR: PAYMENT SEC: CCD TRACE#: 482617039258001',
  'ORIG CO NAME:Payer One ORIG ID:4826170392 DESC DATE:261005 CO ENTRY DESCR:PAYMENT SEC:CCD TRACE#:482617039258001',
  'WIRE TRANSFER FROM: Payer One REF: 482617039258',
  'WIRE ORIGINATOR: Payer One; BENEFICIARY: Operating Company; REFERENCE: 482617039258',
  'ACH CREDIT ORIGINATOR: Payer One\nTRACE: 482617039258001',
  'ACH PAYMENT FROM Payer One for invoice 48261703',
  'BANK TRANSFER FROM Supplier Alias reference 48261703',
];

export const originatorWords = [
  'from', 'by', 'sender', 'originator', 'orig', 'co', 'name', 'id', 'ref',
  'reference', 'trace', 'memo', 'ach', 'wire', 'credit', 'deposit', 'payment',
  'eft', 'zelle', 'bank', 'transfer', 'receipt', 'payroll', 'settlement',
  'company', 'desc', 'date', 'entry', 'descr', 'sec', 'beneficiary', 'for', 'invoice',
  'orig co name', 'originator name', 'sender name', 'orig id', 'co id',
  'company id', 'desc date', 'co entry descr', 'entry descr', 'wire from',
];
export const originatorFormats = [...explicitStatements,
  'WIRE FROM: Payer One; REF: 48261703',
  'ACH CREDIT ORIG CO NAME: Payer One ORIG ID: 4826170392',
  'SENDER: Payer One', 'SENDER NAME: Payer One',
  'BY: Payer One', 'WIRE FROM: Payer One | MEMO: 48261703',
];
