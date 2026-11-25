// Public pricing checked on 2026-11-24. Labels come from the owner, never a
// billing API. Product pricing cannot establish this account's actual charges,
// other projects' dependencies, negotiated terms, or cancellation safety.
const AS_OF = "as of 2026-11-24";
const source = (url, page_updated) => Object.freeze({ url, page_updated });
const SOURCES = Object.freeze({
  workers: source("https://developers.cloudflare.com/workers/platform/pricing/", "2026-11-18"),
  d1: source("https://developers.cloudflare.com/d1/platform/pricing/", "2026-10-30"),
  vectorize: source("https://developers.cloudflare.com/vectorize/platform/pricing/", "2026-10-30"),
  ai: source("https://developers.cloudflare.com/workers-ai/platform/pricing/", "2026-11-18"),
  r2: source("https://developers.cloudflare.com/r2/pricing/", "2026-10-30"),
  images: source("https://developers.cloudflare.com/images/pricing/", "2026-10-19"),
  stream: source("https://developers.cloudflare.com/stream/pricing/", "2026-10-27"),
  logs: source("https://developers.cloudflare.com/workers/observability/logs/workers-logs/", "2026-11-18"),
  observability: source("https://developers.cloudflare.com/observability/pricing/", "2026-11-11"),
  billing: source("https://developers.cloudflare.com/billing/manage/cancel-subscription/", "2026-05-29"),
});

// https://developers.cloudflare.com/workers/platform/pricing/
// This is an account minimum, never an invoice quote.
export const WORKERS_PAID_SETUP_NOTICE = `Financial Brain needs Workers Paid on this exact account: $5 USD per month minimum ${AS_OF}. Usage beyond included amounts can cost more.`;
export const WORKERS_PAID_BUNDLE_WARNING = "Choose Workers Paid for setup. Do not add Images or Stream for the Brain; it does not use those services.";

const entry = (row, sources) => Object.freeze({ ...row, sources: Object.freeze(sources) });
export const SUBSCRIPTION_GUIDE = Object.freeze([
  entry({ dashboard_name_pattern: /^Workers Paid$/i,
    plain_name: "Workers Paid", brain_uses: true,
    note: "The plan required to run your Brain. Keep this subscription.",
    pricing: `Public Standard pricing ${AS_OF}: $5 USD per month minimum for the account, including 10 million requests and 30 million CPU milliseconds per month. Extra requests cost $0.30 per million; extra CPU time costs $0.02 per million milliseconds. Other products can add charges.`,
  }, [SOURCES.workers]),
  entry({ dashboard_name_pattern: /^(?:Cloudflare )?D1$/i,
    plain_name: "D1 database", brain_uses: true,
    note: "Stores the Brain's text and records. Keep this service.",
    pricing: `Workers Paid pricing ${AS_OF}: 25 billion rows read and 50 million rows written per month, plus 5 GB storage, are included. Extra reads cost $0.001 per million rows, writes $1 per million rows, storage $0.75 per GB-month. Database count can also add charges.`,
  }, [SOURCES.d1]),
  entry({ dashboard_name_pattern: /^(?:Cloudflare )?Vectorize$/i,
    plain_name: "Vectorize meaning search", brain_uses: true,
    note: "Helps the Brain find related information. Keep this service.",
    pricing: `Workers Paid pricing ${AS_OF}: 50 million queried dimensions per month and 10 million stored dimensions are included. Extra queried dimensions cost $0.01 per million; extra stored dimensions cost $0.05 per 100 million. Index count can also add charges.`,
  }, [SOURCES.vectorize]),
  entry({ dashboard_name_pattern: /^(?:Cloudflare )?Workers AI$/i,
    plain_name: "Workers AI", brain_uses: true,
    note: "Runs the Brain's AI models. Keep this service.",
    pricing: `Workers Paid pricing ${AS_OF}: 10,000 Neurons per day are included; usage above that costs $0.011 per 1,000 Neurons. Neurons measure model usage.`,
  }, [SOURCES.ai]),
  entry({ dashboard_name_pattern: /^(?:Cloudflare )?Images(?: Basic| Bundle| Bundles| Paid| Free)?$/i,
    plain_name: "Images service", brain_uses: false,
    note: "This Brain does not use the Images service. Other projects in this account may use it.",
    pricing: `Images Paid pricing ${AS_OF}: 5,000 unique transformations per month are included, then $0.50 per 1,000. Images storage costs $5 per 100,000 images per month and delivery $1 per 100,000 images. Charges depend on the features used.`,
  }, [SOURCES.images]),
  entry({ dashboard_name_pattern: /^(?:Cloudflare )?Stream(?: Basic| Bundle| Bundles| Paid)?$/i,
    plain_name: "Stream video service", brain_uses: false,
    note: "This Brain does not use the Stream video service. Other projects in this account may use it.",
    pricing: `Stream pricing ${AS_OF}: storage capacity is prepaid at $5 per 1,000 minutes per month; delivery costs $1 per 1,000 minutes delivered. Unused prepaid capacity does not prove a zero bill.`,
  }, [SOURCES.stream]),
  entry({ dashboard_name_pattern: /^(?:Workers )?Logs$/i,
    plain_name: "Worker activity logs", brain_uses: "unknown",
    note: "Records of Worker activity. Enabled settings and account usage are not checked; ask your installer before cancelling.",
    pricing: `Workers Paid Logs pricing ${AS_OF}: 20 million log events per month are included, then $0.60 per million. Cloudflare says pricing changes on December 1, 2026; check its Observability pricing for that date onward.`,
  }, [SOURCES.logs, SOURCES.observability]),
  entry({ dashboard_name_pattern: /^(?:(?:Cloudflare|Workers) )?Observability$/i,
    plain_name: "Worker activity logs and diagnostics", brain_uses: "unknown",
    note: "Can include several services. The exact subscription, enabled settings and account usage are not checked; ask your installer before cancelling.",
    pricing: `Published ${AS_OF}, effective December 1, 2026: Paid includes 50 GB ingestion and 10 GB-month storage per billing cycle, then $0.25 per GB ingestion and $0.10 per GB-month storage. Enterprise transition dates and legacy Log Explorer terms differ. These are upcoming rates, not a verified current charge.`,
  }, [SOURCES.observability, SOURCES.logs]),
  entry({ dashboard_name_pattern: /^(?:Cloudflare )?R2(?: Storage| Object Storage)?$/i,
    plain_name: "R2 file storage", brain_uses: "unknown",
    note: "Used only when this Brain's manifest requests an R2 bucket. Other projects in this account may use R2.",
    pricing: `R2 Standard pricing ${AS_OF}: 10 GB-month storage, 1 million Class A operations and 10 million Class B operations per month are included. Extra storage costs $0.015 per GB-month, Class A $4.50 per million and Class B $0.36 per million, with billing-unit rounding. Infrequent Access has different rates and no such free tier; bucket count can also add charges.`,
  }, [SOURCES.r2]),
  // Match only reviewed whole labels. A combined bundle has no verified
  // standalone tariff here, even when both component products are familiar.
  entry({ dashboard_name_pattern: /^.*$/,
    plain_name: "Unrecognised subscription", brain_uses: "unknown",
    note: "not sure; ask your installer. The exact product or bundle terms are missing; ask your installer before cancelling.",
    pricing: `Specific charges are unknown ${AS_OF}. Check the exact subscription and invoice in the owner's account.`,
  }, [SOURCES.billing]),
]);

export function parseSubscriptionNames(value) {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new TypeError("--subscriptions needs a value");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError("Subscription names must be plain text on one line.");
  }
  return value.split(";").map((name) => name.trim()).filter(Boolean);
}

export function classifySubscriptions(names, { r2BucketRequested = null } = {}) {
  return names.map((name) => {
    if (typeof name !== "string" || !name.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
      throw new TypeError("Subscription names must be non-empty plain text.");
    }
    name = name.trim();
    const row = SUBSCRIPTION_GUIDE.find((candidate) => candidate.dashboard_name_pattern.test(name));
    // No valid manifest means no evidence about this Brain's R2 dependency.
    const isR2 = row.plain_name === "R2 file storage";
    const brain_uses = isR2
      ? (typeof r2BucketRequested === "boolean" ? r2BucketRequested : "unknown")
      : row.brain_uses;
    const note = isR2 && brain_uses === "unknown"
      ? `${row.note} Manifest usage is not known: not sure; ask your installer before cancelling.`
      : row.note;
    return { name, plain_name: row.plain_name, brain_uses, note, pricing: row.pricing, sources: row.sources };
  });
}

export function renderSubscriptionSection(names, options = {}) {
  const rows = classifySubscriptions(names, options);
  return [
    "Cloudflare subscriptions",
    "The sign-in cannot read billing. These are owner-supplied names, not verified billing status or charges.",
    "Read the names at Manage Account > Billing > Subscriptions in the exact Cloudflare account, with your assistant's browser help if needed.",
    "The Brain never cancels or changes any subscription. Billing actions belong to the owner.",
    "Check other projects and product-specific terms with your installer before cancelling. An unused service does not prove a zero bill.",
    `Cloudflare's cancellation guide ${AS_OF}: cancellation takes effect at the billing period's end; unused time is not refunded. Source: ${SOURCES.billing.url}`,
    ...(!rows.length ? ["Subscription usage is not checked until you supply the names."] : []),
    ...rows.map((row) => `${row.name} (${row.plain_name}): ${row.brain_uses === true
      ? "the Brain uses this" : row.brain_uses === false
        ? "the Brain does not use this" : "not sure; ask your installer"}. ${row.note} ${row.pricing} Sources: ${row.sources.map(source => source.url).join(", ")}`),
  ];
}
