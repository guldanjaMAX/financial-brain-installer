import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { reconciliationSaveFailure } from "./AddReview";

describe("conflicting-record recovery", () => {
  it("turns a stale ruling into an explicit safe refresh path", () => {
    const failure = reconciliationSaveFailure(new ApiError(409, { code: "decision_changed" }, "HTTP 409"));
    expect(failure.refreshRequired).toBe(true);
    expect(failure.message).toContain("Nothing was changed");
    expect(failure.message).toContain("Refresh the current records below");
    expect(failure.message).not.toMatch(/HTTP|409|exception/i);
  });

  it("does not mislabel an unrelated failure as stale data", () => {
    const failure = reconciliationSaveFailure(new Error("Network unavailable"));
    expect(failure).toEqual({ message: "Network unavailable", refreshRequired: false });
  });
});
