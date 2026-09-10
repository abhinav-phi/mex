import { describe, expect, it } from "vitest";
import { SetupCommitPreviewSchema, SetupCommitRequestSchema, SETUP_COMMIT_MAX_TOTAL_DIFF_CHARACTERS } from "./setup.js";

const preview = {
  revision: "00000000-0000-4000-8000-000000000192", expiresAt: "2026-09-10T12:00:00.000Z",
  branch: "main", head: null, defaultMessage: "chore: initialize MEX",
  files: [{ path: ".mex/config.json", status: "added", diff: "+{}\n", truncated: false }],
  canCommit: true, blockedReason: null,
};

describe("setup commit review contract", () => {
  it("accepts a complete exact-path review and rejects partial or contradictory approvals", () => {
    expect(SetupCommitPreviewSchema.parse(preview)).toEqual(preview);
    for (const value of [
      { ...preview, files: [] },
      { ...preview, blockedReason: "Requires manual Git" },
      { ...preview, files: [{ ...preview.files[0], truncated: true }] },
      { ...preview, files: [...preview.files, ...preview.files] },
      { ...preview, arbitrary: true },
    ]) expect(SetupCommitPreviewSchema.safeParse(value).success).toBe(false);
    expect(SetupCommitPreviewSchema.safeParse({ ...preview, canCommit: false, blockedReason: "Diff exceeds review limit", files: [{ ...preview.files[0], truncated: true }] }).success).toBe(true);
  });

  it("bounds review bytes and rejects unsafe paths", () => {
    for (const path of ["../config.json", "/config.json", "C:/config.json", ".mex/../config.json", ".mex\\config.json", "a\0b", "a//b"]) {
      expect(SetupCommitPreviewSchema.safeParse({ ...preview, files: [{ ...preview.files[0], path }] }).success).toBe(false);
    }
    const files = Array.from({ length: 5 }, (_, index) => ({ ...preview.files[0], path: `.mex/context/${index}.md`, diff: "x".repeat(SETUP_COMMIT_MAX_TOTAL_DIFF_CHARACTERS / 4) }));
    expect(SetupCommitPreviewSchema.safeParse({ ...preview, files }).success).toBe(false);
  });

  it("accepts only a revision and bounded message, with no client-selected paths or Git arguments", () => {
    const request = { revision: preview.revision, message: "  Initialize MEX\n\nReviewed project knowledge.  " };
    expect(SetupCommitRequestSchema.parse(request).message).toBe("Initialize MEX\n\nReviewed project knowledge.");
    for (const value of [
      { ...request, files: ["README.md"] }, { ...request, force: true },
      { ...request, revision: "old" }, { ...request, message: " " },
      { ...request, message: "x".repeat(2001) }, { ...request, message: "a\0b" },
    ]) expect(SetupCommitRequestSchema.safeParse(value).success).toBe(false);
  });
});
