import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiGet, ownerError } from "./api";

const safeFallback = "Your Brain could not confirm what happened. Refresh this page to check the current state before trying again.";

afterEach(() => vi.unstubAllGlobals());

async function rejectedApiError(request: Promise<unknown>): Promise<ApiError> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("Expected the API request to fail");
}

describe("owner API response decoding", () => {
  it("keeps successful POST and GET JSON unchanged", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ready: true, count: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(["one", "two"]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(api("/api/owner/action", { approved: true })).resolves.toEqual({ ready: true, count: 2 });
    await expect(apiGet("/api/owner/status")).resolves.toEqual(["one", "two"]);
  });

  it("preserves structured error fields and their existing presentation rules", async () => {
    const body = {
      error: "structured refusal",
      detail: "Please choose a current record and try again.",
      reason: "current_record_required",
      recovery: "Reload the current records.",
      status: "conflict",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })));

    const error = await rejectedApiError(api("/api/owner/action"));
    expect(error.message).toBe(body.error);
    expect(error.body).toEqual(body);
    expect(ownerError(error)).toEqual({ status: 400, message: body.detail });
  });

  it("normalizes malformed JSON error bodies without exposing their values", async () => {
    const malformedBodies = [null, ["private upstream detail"], "private upstream detail"];

    for (const body of malformedBodies) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })));

      const error = await rejectedApiError(api("/api/owner/action"));
      expect(error.body).toEqual({});
      expect(ownerError(error)).toEqual({ status: 500, message: safeFallback });
      expect(ownerError(error).message).not.toContain("private upstream detail");
    }
  });

  it("uses the same safe fallback for a non-JSON GET error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream proxy failed with private detail", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    })));

    const error = await rejectedApiError(apiGet("/api/owner/status"));
    expect(error.body).toEqual({});
    expect(ownerError(error)).toEqual({ status: 502, message: safeFallback });
    expect(error.message).not.toContain("502");
    expect(error.message).not.toContain("private detail");
  });

  it("does not expose a legacy bare HTTP fallback through ownerError", () => {
    const error = new ApiError(404, {}, "HTTP 404");
    expect(error.message).toBe(safeFallback);
    expect(ownerError(error)).toEqual({ status: 404, message: safeFallback });

    const structuredError = new ApiError(500, { error: "HTTP 500" });
    expect(structuredError.message).toBe(safeFallback);
    expect(structuredError.body.error).toBe(safeFallback);
    expect(ownerError(structuredError)).toEqual({ status: 500, message: safeFallback });

    const structuredDetail = new ApiError(404, { detail: "HTTP 404" });
    expect(structuredDetail.body.detail).toBe(safeFallback);
    expect(ownerError(structuredDetail)).toEqual({ status: 404, message: safeFallback });

    const structuredReason = new ApiError(415, { reason: "HTTP 415" });
    expect(structuredReason.body.reason).toBe("This file type is not supported for owner upload.");
    expect(ownerError(structuredReason)).toEqual({
      status: 415,
      message: "This file type is not supported for owner upload.",
    });

    const structuredRecovery = new ApiError(403, { recovery: "HTTP 403" });
    expect(structuredRecovery.body.recovery).toBe(safeFallback);

    expect(ownerError(new Error("HTTP 502"))).toEqual({ status: null, message: safeFallback });
  });

  it("turns reviewed conflict and validation codes into explicit recovery guidance", () => {
    expect(ownerError(new ApiError(409, {
      code: "idempotency_conflict",
      detail: "request_id was already used for a different document access change",
    }))).toEqual({
      status: 409,
      message: "This save was already used for a different choice. Nothing changed. Refresh this page, review the current information, and try again.",
    });
    expect(ownerError(new ApiError(422, { code: "owner_upload_pdf_needs_ocr" }))).toEqual({
      status: 422,
      message: "This PDF appears to be scanned, but text recognition is not available. Nothing was added. Upload a searchable copy or ask your installer for help.",
    });
  });

  it("replaces technical conflict details with a clear no-change recovery action", () => {
    const conflict = ownerError(new ApiError(409, {
      code: "idempotency_conflict",
      detail: "request_id was already used for a different document access change",
    }));
    const unknownConflict = ownerError(new ApiError(409, { detail: "request id conflict in upstream worker" }));
    const validation = ownerError(new ApiError(422, { detail: "schema validation failed" }));

    expect(conflict.status).toBe(409);
    expect(conflict.message).toContain("Nothing changed");
    expect(conflict.message).toContain("Refresh this page");
    expect(conflict.message).not.toMatch(/request id|upstream|worker/i);
    expect(unknownConflict.message).toContain("Nothing changed");
    expect(unknownConflict.message).not.toMatch(/request id|upstream|worker/i);
    expect(validation.status).toBe(422);
    expect(validation.message).toContain("Nothing was added or changed");
    expect(validation.message).toContain("Review the fields");
    expect(validation.message).not.toContain("schema validation");
  });

  it("never renders arbitrary conflict or validation detail", () => {
    const privateDetails = [
      "Nothing was saved. Refresh this page. Debug bearer token secret-example and C:\\Users\\Owner\\tax.pdf",
      "Nothing was added. Try again at https://internal.example/private?id=document_123 for Morgan Private LLC.",
      "Nothing changed. Reload after reading /Users/owner/Records/account-9988.csv.",
    ];

    for (const detail of privateDetails) {
      for (const status of [409, 422]) {
        const result = ownerError(new ApiError(status, { code: "unknown_private_failure", detail }));
        expect(result.message).not.toContain(detail);
        expect(result.message).not.toMatch(/secret-example|Users|internal\.example|document_123|Morgan Private|account-9988/i);
      }
    }

    const reviewedCodeWithPrivateDetail = ownerError(new ApiError(409, {
      code: "idempotency_conflict",
      detail: privateDetails[0],
    }));
    expect(reviewedCodeWithPrivateDetail.message).toContain("Nothing changed");
    expect(reviewedCodeWithPrivateDetail.message).not.toMatch(/secret-example|Users|tax\.pdf/i);

    for (const inheritedKey of ["constructor", "toString", "__proto__"]) {
      const result = ownerError(new ApiError(409, { code: inheritedKey, detail: privateDetails[0] }));
      expect(typeof result.message).toBe("string");
      expect(result.message).toContain("Nothing changed");
      expect(result.message).not.toMatch(/secret-example|Users|tax\.pdf/i);
    }
  });
});
