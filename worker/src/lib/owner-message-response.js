import { ownerMessagePage } from "./owner-page-style.js";

// Negotiate only explicit browser GETs. API requests retain their original
// bytes, status and authentication challenge, even when POST advertises HTML.
export function acceptsOwnerHtml(request) {
  return request?.method === "GET" &&
    (request.headers.get("Accept") || "").toLowerCase().includes("text/html");
}

/** Render fixed owner copy through the escaped shared page, without scripts,
 * external assets or cacheable state. Callers supply the original HTTP status
 * and may retain protocol headers such as the MCP authentication challenge. */
export function ownerMessageResponse(message, status, extraHeaders = {}) {
  return new Response(ownerMessagePage(message), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Vary": "Accept",
      ...extraHeaders,
    },
  });
}
