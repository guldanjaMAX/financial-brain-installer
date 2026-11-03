// Provider replies supplied with the repair packet. Keep their wire format.
export const RECORDED_REPLIES = [
  { question: 'What were our five biggest expenses last month?', kind: 'largest',
    text: '```json\n{"intents":[{"kind":"largest","direction":"outflow","count":5,"vendor_text":null,"amount_text":null,"date_text":null,"period":{"type":"last_month"}}]}\n```' },
  { question: 'What were the last ten transactions?', kind: 'transactions',
    text: '```json\n{"intents":[{"kind":"transactions","direction":null,"count":10,"vendor_text":null,"amount_text":null,"date_text":null,"period":{"type":"none"}}]}\n```' },
  { question: 'How much money is in the business accounts right now?', kind: 'balance',
    text: '```json\n{"intents":[{"kind":"balance","direction":null,"count":null,"vendor_text":null,"amount_text":null,"date_text":null,"period":{"type":"none"}}]}\n```' },
];
