import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { HubApiError, type HubApi } from "../api/client";
import type { SetupCommitPreview, SetupCommitResponse } from "../api/types";
import { Button } from "../components/primitives/button";
import { Textarea } from "../components/primitives/textarea";
import { SetupCommitDiff } from "./SetupCommitDiff";
import { MAX_FORMATTED_DIFF_LINES, MAX_FORMATTED_REVIEW_LINES, parseSetupDiff } from "./setup-commit-diff";
import styles from "../styles/setup.module.css";

type CommitApi = Pick<HubApi, "previewSetupCommit" | "commitSetup">;

export function SetupCommitReview({ api, onCommitted, onReviewInvalid, onOpenHub, opening = false }: {
  api: CommitApi;
  onCommitted: (response: SetupCommitResponse) => void;
  onReviewInvalid: () => void;
  onOpenHub: () => void;
  opening?: boolean;
}) {
  const [preview, setPreview] = useState<SetupCommitPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [expired, setExpired] = useState(false);
  const [committed, setCommitted] = useState<SetupCommitResponse | null>(null);
  const inFlight = useRef(false);

  const review = useMutation({
    mutationFn: () => {
      if (!api.previewSetupCommit) throw new Error("Setup review is unavailable.");
      return api.previewSetupCommit();
    },
    onMutate: () => { setAttempted(true); setPreview(null); },
    onSuccess: (next) => {
      setPreview(next);
      setMessage((current) => current ?? next.defaultMessage);
      setViewed(new Set());
      setExpanded(new Set());
      setExpired(Date.parse(next.expiresAt) <= Date.now());
      commit.reset();
    },
  });
  const commit = useMutation({
    mutationFn: ({ revision, message: commitMessage }: { revision: string; message: string }) => {
      if (!api.commitSetup) throw new Error("Setup commit is unavailable.");
      return api.commitSetup({ revision, message: commitMessage });
    },
    onSuccess: (response) => {
      setCommitted(response);
      setPreview(null);
      onCommitted(response);
    },
    onError: () => {
      setPreview(null);
      onReviewInvalid();
    },
    onSettled: () => { inFlight.current = false; },
  });

  useEffect(() => {
    if (!preview) return;
    const delay = Math.max(0, Date.parse(preview.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setExpired(true), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [preview]);

  const files = useMemo(() => {
    let remaining = MAX_FORMATTED_REVIEW_LINES;
    return preview?.files.map((file) => {
      const parsed = parseSetupDiff(file.diff, file.truncated, Math.min(remaining, MAX_FORMATTED_DIFF_LINES));
      if (parsed.formatted) remaining -= parsed.rows.length;
      return { ...file, parsed };
    }) ?? [];
  }, [preview]);

  if (committed) return (
    <div className={styles.notice} data-tone={committed.recoveryRequired ? "danger" : undefined} role={committed.recoveryRequired ? "alert" : "status"}>
      <strong>{committed.recoveryRequired ? "Setup committed; Git needs attention" : "Setup committed locally"}</strong>
      {committed.recoveryRequired ? committed.run.error ?? committed.message : committed.run.status === "failed" ? "Your commit is saved. Retry opening the Hub." : "Opening the Project Hub…"}
      {committed.run.status === "failed" || committed.recoveryRequired ? <Button type="button" size="sm" disabled={opening} onClick={onOpenHub}>{opening ? "Opening…" : committed.recoveryRequired ? "Check recovery and open Hub" : "Retry opening Hub"}</Button> : null}
    </div>
  );

  const trimmedMessage = (message ?? "").trim();
  const validMessage = trimmedMessage.length > 0 && trimmedMessage.length <= 2_000 && !trimmedMessage.includes("\0");
  const ready = Boolean(preview?.canCommit && !expired && validMessage && !review.isPending && !commit.isPending);

  return (
    <div className={styles.commitReview}>
      <div className={styles.commitReviewIntro}>
        <div>
          <h3>Review and commit setup</h3>
          <p>Review the generated changes, then save a local commit and open the Hub.</p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={review.isPending || commit.isPending} onClick={() => review.mutate()}>
          {review.isPending ? "Loading changes…" : attempted ? "Refresh review" : "Review setup changes"}
        </Button>
      </div>
      {review.isError ? <p className={styles.notice} data-tone="danger" role="alert">{problemDetail(review.error, "The setup changes could not be loaded. Refresh the review to try again.")}</p> : null}
      {commit.isError ? <p className={styles.notice} data-tone="danger" role="alert">{problemDetail(commit.error, "The commit could not be confirmed.")} Refresh the review before trying again.</p> : null}
      {preview ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (inFlight.current || !ready) return;
          if (Date.parse(preview.expiresAt) <= Date.now()) { setExpired(true); return; }
          inFlight.current = true;
          commit.mutate({ revision: preview.revision, message: trimmedMessage });
        }}>
          <div className={styles.commitScope}>
            <strong>{preview.files.length} {preview.files.length === 1 ? "file" : "files"} in this commit</strong>
            <span>{preview.branch ? `Branch: ${preview.branch}` : preview.head ? "Detached HEAD" : "First commit"}</span>
          </div>
          <p className={styles.commitScopeNote}>Only the files listed below will be committed. Nothing is pushed.</p>
          <div className={styles.commitFiles} key={preview.revision}>
            {files.map((file) => (
              <details key={file.path} className={styles.commitFile} onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpanded((current) => {
                  const next = new Set(current);
                  if (open) next.add(file.path); else next.delete(file.path);
                  return next;
                });
                if (open) setViewed((current) => new Set(current).add(file.path));
              }}>
                <summary>
                  <span className={styles.commitFilePath}>{file.path}</span>
                  <span className={styles.commitFileStatus} data-status={file.status}>{file.status}</span>
                  {file.parsed.formatted ? <span className={styles.commitDiffCounts} aria-label={`${file.parsed.added} added lines, ${file.parsed.deleted} deleted lines`}>
                    <span data-change="added">+{file.parsed.added}</span><span data-change="deleted">−{file.parsed.deleted}</span>
                  </span> : null}
                  {viewed.has(file.path) ? <span className={styles.commitViewed}><Check aria-hidden="true" />Viewed</span> : null}
                </summary>
                <SetupCommitDiff path={file.path} diff={file.diff} parsed={file.parsed} expanded={expanded.has(file.path)} />
              </details>
            ))}
          </div>
          <p className={styles.commitViewedCount}>Viewed {viewed.size} of {preview.files.length} files</p>
          {!preview.canCommit ? <p className={styles.notice} data-tone="warning" role="status">{preview.blockedReason ?? "These changes cannot be committed yet. Refresh the review after resolving the project state."}</p> : null}
          {expired ? <p className={styles.notice} data-tone="warning" role="status">This review expired. Refresh it before committing.</p> : null}
          <label className={styles.commitMessage}>
            <span>Commit message</span>
            <Textarea aria-label="Commit message" rows={3} maxLength={2_000} value={message ?? ""} disabled={commit.isPending} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <div className={styles.footer}>
            <p>The reviewed setup files will be committed locally. You can push them later.</p>
            <Button type="submit" size="sm" disabled={!ready}>{commit.isPending ? "Committing…" : "Commit setup and open Hub"}</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function problemDetail(error: unknown, fallback: string): string {
  return error instanceof HubApiError ? error.problem.detail : fallback;
}
