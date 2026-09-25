/** Collapse ingest refusals into aggregate-safe classes that cannot expose a locator. */
export function refusalReasonCategory(reason) {
  const value = String(reason || "").toLowerCase();
  if (/over the \d+(?:\.\d+)?\s*(?:mb|gb|byte)|too large|exceeds?.*limit/.test(value)) return "too large";
  if (/mostly symbols|symbol soup/.test(value)) return "mostly symbols with too little readable text";
  if (/binary.*text|control character/.test(value)) return "binary data presented as text";
  if (/ocr|dictionary-word|word-like/.test(value)) return "OCR output has too few recognizable words";
  if (/repeated line|boilerplate/.test(value)) return "repeated-line boilerplate";
  if (/templated mail|template-only|near-empty/.test(value)) return "near-empty templated mail";
  if (/base64|hex-encoded|encoded blob/.test(value)) return "encoded data with too little readable text";
  if (/replacement character|decoded into mostly unreadable/.test(value)) return "damaged text encoding";
  if (/too short|too little to answer/.test(value)) return "too little text";
  if (/\bempty\b|no text/.test(value)) return "empty extraction";
  if (/unsupported|no extractor/.test(value)) return "unsupported file type";
  if (/credential|secret|private key|recovery code|carries/.test(value)) return "credential-like content";
  if (/^failed:/.test(value)) return "ingest failed";
  if (/extract|parse|corrupt|unreadable/.test(value)) return "extraction failed";
  return "other refusal";
}
