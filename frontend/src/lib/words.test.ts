import { beforeEach, describe, expect, it } from "vitest";
import { sourceLabel, unmappedWords } from "./words";

describe("source provenance labels", () => {
  beforeEach(() => unmappedWords.clear());

  it("has reviewed labels for every advertised canonical connector kind", () => {
    const kinds = [
      "gmail", "imap", "imessage", "whatsapp", "iphone-backup", "zoom",
      "drive", "dropbox", "box", "microsoft", "notion", "slack",
      "hubspot", "quickbooks", "plaid", "upload",
    ];
    for (const kind of kinds) expect(sourceLabel(kind, kind)).not.toBe("Another source");
    expect(unmappedWords.size).toBe(0);
  });

  it("uses exact connector kind when a custom source name collides with a provider slug", () => {
    expect(sourceLabel("drive", "upload")).toBe("Files you uploaded");
    expect(sourceLabel("client-mail", "gmail")).toBe("Email");
  });

  it("does not guess provenance from a familiar name when an unknown kind is present", () => {
    expect(sourceLabel("drive", "future-provider")).toBe("Another source");
    expect(unmappedWords.has("source-kind:future-provider")).toBe(true);
  });
});
