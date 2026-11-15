import { normalizeLedgerText, EXPENSE_CATEGORY_WORDS } from './money-analysis.js';

// Shared with the existing early code-proof reader. Moving these exact lists
// does not expand which source codes can promote a transaction's money kind.
export const MONEY_CATEGORY_CLASSES = Object.freeze({
  expense:Object.freeze([...EXPENSE_CATEGORY_WORDS,'operating expense','operating expenses','office supplies','supplies','payroll','wages',
    'advertising','marketing','software','insurance','meals','repairs','cost of goods','cogs','professional services','subscriptions',
    'payroll taxes','sales tax','sales taxes','taxes and licences','taxes and licenses','bank fees','interest expense','processor fees']),
  refund:Object.freeze(['refund','refunds','purchase refund','purchase refunds','merchant refund','merchant refunds','customer refund','customer refunds',
    'client refund','client refunds','expense refund','expense refunds','fee refund','fee refunds','interest refund','interest refunds']),
  returned:Object.freeze(['refund','refunds','customer refund','customer refunds','client refund','client refunds','chargeback','chargebacks','dispute','disputes','refund debit','refund debits','chargeback debit','chargeback debits','dispute debit','dispute debits']),
  ownerIn:Object.freeze(['owner contribution','owner contributions','capital contribution','capital contributions','shareholder contribution','shareholder contributions']),
  ownerOut:Object.freeze(['owner draw','owner draws','owners draw','owners draws','owner distribution','owner distributions','owners distribution','owners distributions','shareholder distribution','shareholder distributions']),
  loan:Object.freeze(['loan proceeds','loan disbursement','loan disbursements','line of credit advance']),
  interest:Object.freeze(['interest','interest expense']),
});

// Provider primary categories and their exact detailed codes are interpreted
// here, never arbitrary suffixes under a familiar primary. In particular, a
// transfer, debt payment or custom chart-of-accounts label is not expense proof.
// Legacy OTHER/HARDWARE codes already present in product fixtures stay valid.
const personalFinanceCategories = {
  INCOME:['DIVIDENDS','INTEREST_EARNED','RETIREMENT_PENSION','UNEMPLOYMENT','WAGES','OTHER_INCOME'],
  BANK_FEES:['ATM_FEES','FOREIGN_TRANSACTION_FEES','INSUFFICIENT_FUNDS','INTEREST_CHARGE','OVERDRAFT_FEES','OTHER_BANK_FEES'],
  ENTERTAINMENT:['CASINOS_AND_GAMBLING','MUSIC_AND_AUDIO','SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS','TV_AND_MOVIES','VIDEO_GAMES','OTHER_ENTERTAINMENT'],
  FOOD_AND_DRINK:['BEER_WINE_AND_LIQUOR','COFFEE','FAST_FOOD','GROCERIES','RESTAURANTS','VENDING_MACHINES','OTHER_FOOD_AND_DRINK','OTHER'],
  GENERAL_MERCHANDISE:['BOOKSTORES_AND_NEWSSTANDS','CLOTHING_AND_ACCESSORIES','CONVENIENCE_STORES','DEPARTMENT_STORES','DISCOUNT_STORES','ELECTRONICS','GIFTS_AND_NOVELTIES','OFFICE_SUPPLIES','ONLINE_MARKETPLACES','PET_SUPPLIES','SPORTING_GOODS','SUPERSTORES','TOBACCO_AND_VAPE','OTHER_GENERAL_MERCHANDISE','HARDWARE','OTHER'],
  GENERAL_SERVICES:['ACCOUNTING_AND_FINANCIAL_PLANNING','AUTOMOTIVE','CHILDCARE','CONSULTING_AND_LEGAL','EDUCATION','INSURANCE','POSTAGE_AND_SHIPPING','STORAGE','OTHER_GENERAL_SERVICES','OTHER'],
  GOVERNMENT_AND_NON_PROFIT:['DONATIONS','GOVERNMENT_DEPARTMENTS_AND_AGENCIES','TAX_PAYMENT','OTHER_GOVERNMENT_AND_NON_PROFIT_SERVICES'],
  HOME_IMPROVEMENT:['FURNITURE','HARDWARE','REPAIR_AND_MAINTENANCE','SECURITY','OTHER_HOME_IMPROVEMENT'],
  MEDICAL:['DENTAL_CARE','EYECARE','NURSING_CARE','PHARMACIES_AND_SUPPLEMENTS','PRIMARY_CARE','VETERINARY_SERVICES','OTHER_MEDICAL'],
  PERSONAL_CARE:['GYMS_AND_FITNESS_CENTERS','HAIR_AND_BEAUTY','LAUNDRY_AND_DRY_CLEANING','OTHER_PERSONAL_CARE'],
  RENT_AND_UTILITIES:['GAS_AND_ELECTRICITY','INTERNET_AND_CABLE','RENT','SEWAGE_AND_WASTE_MANAGEMENT','TELEPHONE','WATER','OTHER_UTILITIES'],
  TRANSPORTATION:['BIKES_AND_SCOOTERS','GAS','PARKING','PUBLIC_TRANSIT','TAXIS_AND_RIDE_SHARES','TOLLS','OTHER_TRANSPORTATION'],
  TRAVEL:['FLIGHTS','LODGING','RENTAL_CARS','OTHER_TRAVEL'],
};
const ordinaryCategories = [
  ...MONEY_CATEGORY_CLASSES.expense,...MONEY_CATEGORY_CLASSES.refund,...MONEY_CATEGORY_CLASSES.returned,...MONEY_CATEGORY_CLASSES.interest,
  'income','sales','revenue','payout','settlement','client income','customer income','service income','rental income',
  'operating income','business income','sales income','earned income','gross sales','net sales','product sales',
  'service revenue','sales revenue','commission income','interest income','dividend income','asset management fees',
  // A posted tax payment is a recognised cash-spending type. Its existing
  // attribution/source-risk check still governs tax-population questions.
  'tax','taxes',
  'charitable contributions','401k employer contributions','freight distribution','partner marketing','sales deposits',
  // Existing cash-basis purchase categories retain their prior interpretation.
  'inventory','equipment','vehicles',
];

// Normalize only complete category labels. Camel-case boundaries are split
// before lowercasing; compact aliases cover joined source codes. Generate the
// singular forms from this closed vocabulary so plural handling cannot admit
// an unknown label merely because it contains a recognised operating word.
const categoryWords = value => normalizeLedgerText(String(value ?? '').normalize('NFKC')
  .replace(/([a-z])([A-Z])/g,'$1 $2').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2')).split(' ');
const singular = word => ({supplies:'supply',utilities:'utility',taxes:'tax',wages:'wage',services:'service',
  purchases:'purchase',fees:'fee',sales:'sale',expenses:'expense',goods:'good',categories:'category'}[word] ||
  (/ies$/.test(word)?word.slice(0,-3)+'y':/s$/.test(word)&&!/(?:ss|us)$/.test(word)&&!['gas','news'].includes(word)?word.slice(0,-1):word));
const recognised = new Set();
for(const label of [...ordinaryCategories,...Object.entries(personalFinanceCategories).flatMap(([primary,details])=>
  [primary,...details.map(detail=>`${primary}_${detail}`)])]) {
  let aliases=[''];
  for(const word of categoryWords(label))aliases=aliases.flatMap(prefix=>[...new Set([word,singular(word)])].map(part=>prefix+part));
  for(const alias of aliases)recognised.add(alias);
}
export function isRecognisedOperatingCategory(category) {
  const words=categoryWords(category);
  return recognised.has(words.join('')) || recognised.has(words.map(singular).join(''));
}
