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

// Independent expected grammar: do not derive the oracle from the tokenizer.
export const lineSeparators = ['\n', '\r', '\r\n', '\u2028', '\u2029', '\u0085'];
export const expandedMetadataLabels = [
  'TRACE NUMBER:', 'TRACE NO:', 'TRACE #', 'EFFECTIVE DATE:', 'EFF DATE:',
  'ENTRY DATE:', 'SETTLEMENT DATE:', 'COMPANY ID:', 'CO ID:', 'ORIG ID:',
  'INDIVIDUAL ID:', 'INDIVIDUAL NAME:', 'INDIVIDUAL ID/NAME:',
];

export function* boundaryReadingCases() {
  const identities = [
    { entity_slug: 'shorter', legal_name: 'Payer One', display_label: 'Short Supplier' },
    { entity_slug: 'longer', legal_name: 'Payer Two', display_label: 'Long Supplier' },
  ];
  for (const separator of lineSeparators) for (const clause of ['FROM', 'BY', 'FROM:', 'SENDER:']) {
    for (const same of [false, true]) yield {
      family: 'line-separator', identities, state: same ? 'confirmed' : 'unknown',
      description: `WIRE FROM: Payer One; REF: 48261703${separator}${clause} Payer ${same ? 'One' : 'Two'}`,
      candidates: same ? ['Payer One'] : ['Payer One', 'Payer Two'],
    };
  }
  for (const label of expandedMetadataLabels) for (const separator of lineSeparators) {
    const description = `ACH CREDIT ORIG CO NAME: Payer One; ${label} 48261703`;
    yield { family: 'expanded-label', identities, description, state: /DATE/.test(label) ? 'unknown' : 'confirmed' };
    yield { family: 'expanded-label', identities, description: `${description}${separator}FROM Payer Two`, state: 'unknown', candidates: /DATE/.test(label) ? [] : ['Payer One', 'Payer Two'] };
    yield { family: 'unknown-prose', identities, description: `FROM: Payer One${separator}UNLISTED FIELD: 48261703`, state: 'unknown' };
  }
  for (const label of ['REFERENCE:', ...expandedMetadataLabels]) {
    const whole = `Payer One ${label} Services`;
    for (const prefix of ['FROM:', 'WIRE FROM']) for (const tail of ['', '; REF: 48261703']) {
      for (const registration of ['shorter', 'both', 'longer', 'aliases']) {
        const registered = registration === 'aliases'
          ? [{ entity_slug: 'shorter', legal_name: 'Payer One', display_label: whole }]
          : [
            ...(registration === 'longer' ? [] : [identities[0]]),
            ...(registration === 'shorter' ? [] : [{ entity_slug: 'longer', legal_name: whole, display_label: 'Long Supplier' }]),
          ];
        // Services is a valid reference/ID/name, but never a trace number or
        // date. Those invalid metadata alternatives are not complete readings.
        const validMetadata = !/TRACE|DATE/.test(label);
        const longerWins = registration === 'longer' || (registration === 'both' && !validMetadata);
        yield { family: 'registered-whole', identities: registered,
          description: `${prefix} ${whole}${tail}`,
          state: (registration === 'both' && validMetadata) || (registration === 'shorter' && !validMetadata) ? 'unknown' : 'confirmed',
          selector: longerWins ? 'Long Supplier' : registration === 'aliases' ? 'Payer One' : 'Short Supplier',
          slug: longerWins ? 'longer' : 'shorter',
          candidates: validMetadata && (registration === 'both' || registration === 'aliases') ? ['Payer One', whole] : undefined,
        };
      }
    }
  }
}
