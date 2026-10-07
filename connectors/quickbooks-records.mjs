/** Readable provider observations. Never infer a balance from transaction totals. */
import { createHash } from "node:crypto";

const text = (value) => typeof value === "string" || typeof value === "number"
  ? String(value).replace(/\s+/g, " ").trim() : "";
const short = (value, limit = 180) => {
  const valueText = text(value);
  return valueText.length > limit ? `${valueText.slice(0, limit - 1)}…` : valueText;
};
const ref = (value) => short(value?.name || value?.value) || "not provided";
const decimal = (value) => /^-?\d{1,24}(?:\.\d{1,6})?$/.test(text(value)) ? text(value) : null;
const exactUnits = (value) => {
  const amount = decimal(value);
  if (amount === null) return null;
  const [whole, fraction = ""] = amount.replace(/^-/, "").split(".");
  return (amount.startsWith("-") ? -1n : 1n) * BigInt(`${whole}${fraction.padEnd(6, "0")}`);
};
export function quickBooksMoney(value, currencyRef) {
  const amount = decimal(value);
  if (amount === null) return "amount not provided";
  const currency = /^[A-Z]{3}$/.test(text(currencyRef?.value)) ? currencyRef.value : "currency unspecified";
  const [whole, fraction = ""] = amount.split(".");
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}

export function quickBooksBalanceField(entity, row) {
  const field = entity === "Account" ? "CurrentBalance"
    : ["Customer", "Vendor", "Invoice", "Bill"].includes(entity) ? "Balance"
      : entity === "CreditMemo" ? "RemainingCredit" : null;
  return field && decimal(row[field]) !== null ? field : null;
}

const friendly = (key) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
const paymentType = (value) => ({ CreditCard: "credit card", Cash: "cash", Check: "check" })[value] || short(value) || "method not provided";
const DROP = new Set(["Id", "SyncToken", "domain", "sparse", "Lat", "Long", "Latitude", "Longitude", "MetaData"]);

// Preserve unknown meaningful fields without exposing transport bookkeeping.
// Truncation is explicit and occurs only after the leading owner facts.
function detailLines(value, path = "", depth = 0, output = []) {
  if (output.length >= 300 || depth > 8) { output.omitted = true; return output; }
  if (value === null || value === undefined || value === "") return output;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      detailLines(value[i], `${path} ${i + 1}`, depth + 1, output);
      if (output.length >= 300) { output.omitted ||= i + 1 < value.length; break; }
    }
  } else if (typeof value === "object") {
    for (const key of Object.keys(value).sort()) {
      if (DROP.has(key)) continue;
      detailLines(value[key], `${path ? `${path} / ` : ""}${friendly(key)}`, depth + 1, output);
    }
  } else {
    const raw = typeof value === "boolean" ? String(value) : text(value);
    if (raw) {
      output.push(`${path}: ${short(raw, 600)}`);
      if (raw.length > 600) output.omitted = true;
    }
  }
  return output;
}

function linkedTransactions(row) {
  const links = [...(row.LinkedTxn || []), ...(row.Line || []).flatMap((line) => line.LinkedTxn || [])];
  return [...new Set(links.map((link) => `${text(link.TxnType).toLowerCase() || "transaction"} ${short(link.TxnId)}`))].sort();
}

export function renderQuickBooksRecord(entity, row, snapshotAt) {
  const money = (value) => quickBooksMoney(value, row.CurrencyRef);
  const total = money(row.TotalAmt);
  const date = short(row.TxnDate) || "date not provided";
  const number = short(row.DocNumber || row.Name || row.DisplayName || row.Id);
  const customer = ref(row.CustomerRef);
  const vendor = ref(row.VendorRef || row.EntityRef);
  const lines = Array.isArray(row.Line) ? row.Line : [];
  const description = short(lines.map((line) => text(line.Description)).filter(Boolean).join("; "), 300);
  const links = linkedTransactions(row);
  const linked = links.length ? `, for ${short(links.join(", "), 240)}` : "";
  const balanceField = quickBooksBalanceField(entity, row);
  const balance = balanceField ? money(row[balanceField]) : "balance not provided";
  const balanceUnits = balanceField ? exactUnits(row[balanceField]) : null;
  const totalUnits = exactUnits(row.TotalAmt);
  const balanceState = !balanceField ? "" : balanceUnits < 0n ? "credit balance"
    : balanceUnits === 0n ? "paid"
      : totalUnits !== null && balanceUnits < totalUnits ? "partially paid" : "unpaid";
  const observedBalance = balanceField ? `open balance ${balance} (${balanceState}) as of ${snapshotAt}` : balance;
  const due = row.DueDate ? `, due ${short(row.DueDate)}` : "";
  const terms = row.SalesTermRef ? `, terms ${ref(row.SalesTermRef)}` : "";
  let opening;
  switch (entity) {
    case "Account": {
      // Keep the provider's signed value and explain a card liability without
      // describing the absolute amount as money available to the owner.
      const owed = row.AccountType === "Credit Card" && balanceUnits < 0n
        ? ` (owes ${money(decimal(row[balanceField]).slice(1))})` : "";
      opening = `${short(row.AccountType) || "Financial"} account ${ref({ name: row.Name || row.FullyQualifiedName })}: ${balanceField ? `balance ${balance}${owed} as of ${snapshotAt}` : balance}.`;
      break;
    }
    case "Customer": case "Vendor":
      opening = `${short(row.DisplayName || row.CompanyName || row.Name) || entity}: ${balanceField ? `open balance ${balance} as of ${snapshotAt}` : balance}.`;
      break;
    case "Invoice": case "Bill":
      opening = `${entity} ${number} ${entity === "Invoice" ? `to ${customer}` : `from ${vendor}`}: total ${total}, ${observedBalance}; dated ${date}${due}${terms}.`;
      break;
    case "Payment":
      opening = `Payment from ${customer} on ${date}: ${total} to ${ref(row.DepositToAccountRef)}${linked}.`;
      break;
    case "Purchase":
      opening = `Purchase from ${vendor} on ${date}: ${total} by ${paymentType(row.PaymentType)}, ${ref(row.AccountRef)}${description ? `; ${description}` : ""}.`;
      break;
    case "JournalEntry": {
      const postings = lines.slice(0, 4).map((line) => `${text(line.JournalEntryLineDetail?.PostingType).toLowerCase() || "posting"} ${ref(line.JournalEntryLineDetail?.AccountRef)} ${money(line.Amount)}`);
      opening = `Journal entry ${number} on ${date}: ${postings.join("; ") || "postings not provided"}${lines.length > 4 ? "; additional postings below" : ""}.`;
      break;
    }
    case "Deposit": {
      const parties = [...new Set(lines.map((line) => line.DepositLineDetail?.Entity).filter(Boolean).map(ref))];
      opening = `Deposit on ${date}: ${total} to ${ref(row.DepositToAccountRef)}${parties.length || description ? `; ${short([...parties, description].filter(Boolean).join(", "), 300)}` : ""}.`;
      break;
    }
    case "Transfer":
      opening = `Transfer on ${date}: ${total} from ${ref(row.FromAccountRef)} to ${ref(row.ToAccountRef)}.`;
      break;
    case "CreditMemo":
      opening = `Credit memo ${number} for ${customer} on ${date}: total ${total}${balanceField ? `, remaining credit ${balance} as of ${snapshotAt}` : ", remaining credit not provided"}.`;
      break;
    case "BillPayment": {
      const account = row.CreditCardPayment?.CCAccountRef || row.CheckPayment?.BankAccountRef;
      opening = `Bill payment to ${vendor} on ${date}: ${total} by ${paymentType(row.PayType)} (${ref(account)})${linked}.`;
      break;
    }
    case "Estimate":
      opening = `Estimate ${number} for ${customer} on ${date}: ${total}${row.TxnStatus ? `, ${short(row.TxnStatus).toLowerCase()}` : ""}${row.ExpirationDate ? `, expires ${short(row.ExpirationDate)}` : ""}; not an invoice or an amount owed.`;
      break;
    case "SalesReceipt": case "RefundReceipt":
      opening = `${entity === "SalesReceipt" ? "Sales receipt" : "Refund receipt"} ${number} ${entity === "SalesReceipt" ? "for" : "to"} ${customer} on ${date}: ${total} ${entity === "SalesReceipt" ? "to" : "from"} ${ref(row.DepositToAccountRef)}${description ? `; ${description}` : ""}.`;
      break;
    default:
      opening = `QuickBooks ${entity} ${number}: ${total}, dated ${date}.`;
  }
  const priority = [
    opening,
    `QuickBooks ${entity}. ${balanceField ? "Balance observed during this sync; the provider queries are not an atomic ledger snapshot." : "Historical provider record."}`,
    row.PrivateNote || row.CustomerMemo?.value ? `Memo: ${short(row.PrivateNote || row.CustomerMemo.value, 600)}` : "",
    row.TxnDate ? `Transaction date: ${short(row.TxnDate)}.` : "",
    row.MetaData?.LastUpdatedTime ? `Provider last changed: ${short(row.MetaData.LastUpdatedTime)}.` : "",
  ].filter(Boolean);
  const renderedLines = lines.slice(0, 30).map((line, index) => {
    const detail = line.AccountBasedExpenseLineDetail || line.JournalEntryLineDetail || line.DepositLineDetail || line.SalesItemLineDetail || line.ItemBasedExpenseLineDetail || {};
    const fields = [
      money(line.Amount),
      detail.PostingType ? text(detail.PostingType).toLowerCase() : "",
      detail.AccountRef ? `account ${ref(detail.AccountRef)}` : "",
      detail.ItemRef ? `item ${ref(detail.ItemRef)}` : "",
      detail.Entity || detail.CustomerRef ? `party ${ref(detail.Entity || detail.CustomerRef)}` : "",
      short(line.Description, 300),
      linkedTransactions({ Line: [line] }).join(", "),
    ].filter(Boolean);
    return `Line ${index + 1}: ${fields.join("; ")}`;
  });
  const lineText = renderedLines.join("\n");
  if (lineText) priority.push(lineText.slice(0, 6000));
  if (lines.length > 30 || lineText.length > 6000) priority.push("Additional line descriptions omitted from this bounded opening; see Details or the provider record.");
  const details = detailLines(row);
  let detailText = details.join("\n");
  const omitted = details.omitted || detailText.length > 18000;
  detailText = detailText.slice(0, 18000);
  const content = [...priority, "", "Details", detailText, ...(omitted ? ["Additional details omitted from this bounded view; consult the provider record."] : [])].join("\n");
  const party = row.CustomerRef || row.VendorRef || row.EntityRef;
  // Reserve the tie breaker before truncation. Two payments may share every
  // human field, including DocNumber, while still being distinct records.
  const suffix = createHash("sha256").update(`${entity}:${row.Id}`).digest("hex").slice(0, 12);
  const title = [
    `${entity} ${short(row.DocNumber || row.Name || row.DisplayName || row.CompanyName || row.Id, 45)}`,
    ...(party ? [short(ref(party), 38)] : []),
    short(row.TxnDate || (balanceField ? snapshotAt.slice(0, 10) : row.MetaData?.LastUpdatedTime?.slice(0, 10)), 10) || "undated",
    short(balanceField && ["Account", "Customer", "Vendor"].includes(entity) ? balance : total, 32),
  ].join(" | ");
  return { content, title: `${title.slice(0, 184)} | ${suffix}`, balanceField, detailsOmitted: Boolean(omitted) };
}
