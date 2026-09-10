import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HubApiError } from "../api/client";
import type { SetupCommitPreview, SetupCommitResponse } from "../api/types";
import { SetupCommitReview } from "./SetupCommitReview";

const revision = "a944e8d9-7e02-4d04-9a62-d8b347b8e7dc";
const renewedRevision = "75eff665-7fbe-4b1b-9bf8-9ab33e6f3739";
const makePreview = (update: Partial<SetupCommitPreview> = {}): SetupCommitPreview => ({
  revision, expiresAt: new Date(Date.now() + 600_000).toISOString(), branch: "feature/setup", head: null,
  defaultMessage: "chore: initialize MEX", canCommit: true, blockedReason: null,
  files: [
    { path: ".mex/config.json", status: "added", diff: "diff --git a/.mex/config.json b/.mex/config.json\n+{\"scaffold_id\":\"example\"}", truncated: false },
    { path: ".mex/AGENTS.md", status: "modified", diff: "-old instructions\n+<img src=x onerror=alert(1)>", truncated: false },
  ], ...update,
});
const result: SetupCommitResponse = {
  commit: "a".repeat(40), files: [".mex/config.json", ".mex/AGENTS.md"], message: "Setup committed locally.",
  run: {
    status: "running", mode: "code-repo", stage: "ready", ready: false, populated: true,
    selectedTools: ["codex"], prompt: null, populationTool: "codex", populationCompleted: true,
    commitCommands: [], anchorNotes: [], message: "Opening the Hub…", progress: null,
    error: null, startedAt: new Date().toISOString(), finishedAt: null,
  },
};

function harness(preview = makePreview()) {
  const api = { previewSetupCommit: vi.fn(async () => preview), commitSetup: vi.fn(async () => result) };
  const onCommitted = vi.fn();
  const onReviewInvalid = vi.fn();
  const onOpenHub = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><SetupCommitReview api={api} onCommitted={onCommitted} onReviewInvalid={onReviewInvalid} onOpenHub={onOpenHub} /></QueryClientProvider>);
  return { api, onCommitted, onReviewInvalid, onOpenHub, ...view };
}

async function review(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review setup changes" }));
  return await screen.findByRole("button", { name: "Commit setup and open Hub" });
}

describe("setup commit review", () => {
  it("loads only on request, displays exact escaped diffs, and submits the displayed revision and edited message once", async () => {
    const user = userEvent.setup();
    const h = harness();
    expect(h.api.previewSetupCommit).not.toHaveBeenCalled();
    expect(h.api.commitSetup).not.toHaveBeenCalled();
    const submit = await review(user);
    expect(screen.getByText("2 files in this commit")).toBeVisible();
    expect(screen.getByText("Branch: feature/setup")).toBeVisible();
    expect(screen.getByText(/Only the files listed below will be committed/)).toBeVisible();
    const files = h.container.querySelectorAll("details");
    fireEvent.click(files[1]!.querySelector("summary")!);
    await waitFor(() => expect(screen.getByText("Viewed 1 of 2 files")).toBeVisible());
    expect(screen.getByLabelText("Diff for .mex/AGENTS.md")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(h.container.querySelector("img")).toBeNull();
    await user.clear(screen.getByRole("textbox", { name: "Commit message" }));
    await user.type(screen.getByRole("textbox", { name: "Commit message" }), "  chore: add project memory  ");
    let resolveCommit!: (value: SetupCommitResponse) => void;
    h.api.commitSetup.mockImplementationOnce(() => new Promise((resolve) => { resolveCommit = resolve; }));
    await user.dblClick(submit);
    expect(h.api.commitSetup).toHaveBeenCalledExactlyOnceWith({ revision, message: "chore: add project memory" });
    expect(screen.getByRole("button", { name: "Committing…" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeDisabled();
    await act(async () => { resolveCommit(result); });
    await waitFor(() => expect(h.onCommitted).toHaveBeenCalledExactlyOnceWith(result));
    expect(screen.queryByRole("button", { name: "Commit setup and open Hub" })).toBeNull();
  });

  it("invalidates a stale review and requires a fresh revision before another commit", async () => {
    const user = userEvent.setup();
    const h = harness();
    h.api.commitSetup.mockRejectedValueOnce(new HubApiError({
      type: "about:blank", title: "Review changed", status: 409, code: "REVISION_CONFLICT", detail: "The setup files changed after review.", requestId: "commit-test",
    }));
    h.api.previewSetupCommit.mockResolvedValueOnce(makePreview()).mockResolvedValueOnce(makePreview({ revision: renewedRevision }));
    await user.click(await review(user));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh the review before trying again");
    expect(h.onReviewInvalid).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Commit setup and open Hub" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Refresh review" }));
    await user.click(await screen.findByRole("button", { name: "Commit setup and open Hub" }));
    expect(h.api.commitSetup).toHaveBeenLastCalledWith({ revision: renewedRevision, message: "chore: initialize MEX" });
  });

  it("shows a blocked or truncated review without allowing a commit", async () => {
    const user = userEvent.setup();
    const h = harness(makePreview({ canCommit: false, blockedReason: "A Git hook requires a manual commit.", files: [{ path: ".mex/AGENTS.md", status: "modified", diff: "large diff", truncated: true }] }));
    expect(await review(user)).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("A Git hook requires a manual commit.");
    fireEvent.click(h.container.querySelector("summary")!);
    expect(await screen.findByText(/This diff was shortened/)).toBeVisible();
    expect(h.api.commitSetup).not.toHaveBeenCalled();
  });

  it("shows per-file change counts and preserves viewed state while releasing closed diff rows", async () => {
    const user = userEvent.setup();
    const h = harness(makePreview({ files: [{ path: "AGENTS.md", status: "modified", truncated: false, diff: "diff --git a/AGENTS.md b/AGENTS.md\nindex abcd123..def4567 100644\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n" }] }));
    await review(user);
    expect(screen.getByLabelText("2 added lines, 1 deleted lines")).toBeVisible();
    expect(h.container.querySelector("table")).toBeNull();
    await user.click(h.container.querySelector("summary")!);
    await waitFor(() => expect(h.container.querySelector("table")).not.toBeNull());
    expect(screen.getByText("Viewed 1 of 1 files")).toBeVisible();
    await user.click(h.container.querySelector("summary")!);
    await waitFor(() => expect(h.container.querySelector("table")).toBeNull());
    expect(screen.getByText("Viewed 1 of 1 files")).toBeVisible();
  });

  it("rechecks expiry at the explicit commit action and disables empty messages", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const h = harness(makePreview({ expiresAt: new Date(now + 60_000).toISOString() }));
    const submit = await review(user);
    await user.clear(screen.getByRole("textbox", { name: "Commit message" }));
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Commit message" }), "Review setup");
    clock.mockReturnValue(now + 60_001);
    await user.click(submit);
    expect(screen.getByRole("status")).toHaveTextContent("This review expired");
    expect(submit).toBeDisabled();
    expect(h.api.commitSetup).not.toHaveBeenCalled();
  });

  it("keeps a successful commit separate from a failed Hub opening and offers only an open retry", async () => {
    const user = userEvent.setup();
    const h = harness();
    h.api.commitSetup.mockResolvedValueOnce({ ...result, run: { ...result.run, status: "failed", error: "The Hub could not open." } });
    await user.click(await review(user));
    expect(await screen.findByText("Setup committed locally")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Commit setup and open Hub" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry opening Hub" }));
    expect(h.onOpenHub).toHaveBeenCalledOnce();
    expect(h.api.commitSetup).toHaveBeenCalledOnce();
  });
});
