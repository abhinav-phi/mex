import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, LoaderCircle, Sparkles, Terminal } from "lucide-react";
import { Navigate, useLocation } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type {
  SessionResponse,
  SetupProgressStep,
  SetupRun,
  SetupStartRequest,
  SetupStatus,
} from "../api/types";
import { Button } from "../components/primitives/button";
import { Textarea } from "../components/primitives/textarea";
import { PageHeader, StatePanel } from "../components/ui";
import { PageViewObserver } from "../app/PageViewObserver";
import mexMascot from "../../../../mascot/mex-mascot.svg?no-inline";
import styles from "../styles/setup.module.css";

const STEP_ORDER: SetupProgressStep[] = [
  "detect",
  "scaffold",
  "tools",
  "skills",
  "identity",
  "scan",
  "graph",
  "population",
  "finalize",
];

const STEP_LABELS: Record<SetupProgressStep, string> = {
  detect: "Detect project state",
  scaffold: "Create .mex/ scaffold",
  tools: "Link AI tool instructions",
  skills: "Install official MEX agent skills",
  identity: "Assign project identity",
  scan: "Pre-analyze codebase",
  graph: "Build code graph",
  population: "Populate the scaffold",
  finalize: "Capture grounding and Wiki",
};

const STATE_LABEL: Record<SetupStatus["state"], string> = {
  existing: "Existing codebase",
  fresh: "Fresh project",
  partial: "Partly documented",
};

type SetupMode = SetupStartRequest["mode"];

export function SetupLayout({ session }: { session: SessionResponse }) {
  const location = useLocation();
  if (location.pathname !== "/setup") return <Navigate to="/setup" replace />;

  return (
    <div className={styles.viewport}>
      <PageViewObserver />
      <a className={styles.skipLink} href="#setup-main">Skip to setup</a>
      <header className={styles.topBar}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <img alt="" height="32" src={mexMascot} width="32" />
          </span>
          <span>
            <strong>MEX</strong>
            <small>Setup</small>
          </span>
        </div>
        <span className={styles.locality}>This checkout · session until {formatExpiry(session.expiresAt)}</span>
      </header>
      <main className={styles.workspace} id="setup-main" tabIndex={-1}>
        <SetupPage />
      </main>
    </div>
  );
}

export function SetupPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => {
      if (!api.getSetupStatus) throw new Error("Setup status is unavailable.");
      return api.getSetupStatus();
    },
    retry: false,
  });
  const runQuery = useQuery({
    queryKey: ["setup", "run"],
    queryFn: () => {
      if (!api.getSetupRun) throw new Error("Setup run is unavailable.");
      return api.getSetupRun();
    },
    retry: false,
  });
  const [mode, setMode] = useState<SetupMode>("code-repo");
  const [toolSelection, setToolSelection] = useState<string[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const status = statusQuery.data;
  const run = runQuery.data;
  const tools = toolSelection ?? status?.configuredTools ?? [];

  useEffect(() => {
    if (!run || run.status !== "running" || !api.subscribeToSetup) return;
    const subscription = api.subscribeToSetup((next) => {
      queryClient.setQueryData(["setup", "run"], next);
    });
    return () => subscription.close();
  }, [api, queryClient, run?.status]);

  const start = useMutation({
    mutationFn: (request: SetupStartRequest) => {
      if (!api.startSetup) throw new Error("Setup start is unavailable.");
      return api.startSetup(request);
    },
    onSuccess: async (next) => {
      queryClient.setQueryData(["setup", "run"], next);
      await queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
    },
  });

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      setCopied(null);
    }
  };

  if (statusQuery.isPending) {
    return <StatePanel state="loading" title="Inspecting this checkout" detail="Checking whether MEX is already set up." />;
  }
  if (statusQuery.isError || !status) {
    return (
      <StatePanel
        state="error"
        title="Setup status could not be loaded"
        detail="The Hub could not inspect this checkout. Try again before continuing."
        action={(
          <Button size="sm" type="button" variant="outline" onClick={() => void statusQuery.refetch()}>
            Try again
          </Button>
        )}
      />
    );
  }

  const currentRun = run ?? idleRunFromStatus(status);
  const gitBlocked = mode === "code-repo" && !status.hasGit;
  const view = resolveView(status, currentRun, mode);

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Project Hub"
        title="Set up MEX"
        description="The same ordered path as `mex setup`: detect, scaffold, tools, skills, identity, scan, graph, populate, then ground and index Wiki."
      />
      <section className={styles.surface} aria-labelledby="setup-title">
        <div className={styles.intro}>
          <span className={styles.icon}><Sparkles aria-hidden="true" /></span>
          <div>
            <h2 id="setup-title">{headingFor(view, status)}</h2>
            <p>{status.projectName}</p>
          </div>
        </div>
        <dl className={styles.facts}>
          <div><dt>Detected</dt><dd>{STATE_LABEL[status.state]}</dd></div>
          <div><dt>Git</dt><dd>{status.hasGit ? "Repository found" : "Not initialized"}</dd></div>
          <div><dt>Scaffold</dt><dd>{status.hasScaffold ? (status.populated ? "Populated" : "Templates present") : "Missing"}</dd></div>
        </dl>
        <div className={styles.body}>
          {view === "git" ? (
            <GitRequiredNotice />
          ) : null}
          {view === "failed" ? (
            <p className={styles.notice} data-tone="danger" role="alert">
              <strong>Setup did not finish</strong>
              {currentRun.error ?? currentRun.message}
            </p>
          ) : null}
          {view === "configure" || view === "git" || view === "failed" ? (
            <ConfigureForm
              mode={mode}
              tools={tools}
              status={status}
              gitBlocked={gitBlocked}
              pending={start.isPending}
              startLabel={status.stage === "needs_finalize" ? "Finish setup" : "Start setup"}
              onMode={setMode}
              onToggleTool={(id) => setToolSelection((current) => {
                const selected = current ?? status.configuredTools;
                return selected.includes(id) ? selected.filter((tool) => tool !== id) : [...selected, id];
              })}
              onStart={() => start.mutate({
                mode,
                tools: tools as SetupStartRequest["tools"],
                ...(status.stage === "needs_finalize" ? { confirmPopulation: true } : {}),
              })}
            />
          ) : null}
          {view === "progress" ? (
            <ProgressPanel run={currentRun} mode={mode} tools={tools} />
          ) : null}
          {view === "population" ? (
            <PopulationPanel
              run={currentRun}
              copied={copied}
              pending={start.isPending}
              onCopy={copy}
              onContinue={() => start.mutate({
                mode,
                tools: (currentRun.selectedTools.length > 0 ? currentRun.selectedTools : tools) as SetupStartRequest["tools"],
                confirmPopulation: true,
              })}
              onRetry={() => start.mutate({
                mode,
                tools: (currentRun.selectedTools.length > 0 ? currentRun.selectedTools : tools) as SetupStartRequest["tools"],
              })}
            />
          ) : null}
          {view === "done" ? (
            <DonePanel
              run={currentRun}
              copied={copied}
              onCopy={copy}
            />
          ) : null}
          {start.isError ? (
            <p className={styles.notice} data-tone="danger" role="alert">
              {start.error instanceof HubApiError ? start.error.problem.detail : "Setup could not start."}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ConfigureForm({
  mode,
  tools,
  status,
  gitBlocked,
  pending,
  startLabel,
  onMode,
  onToggleTool,
  onStart,
}: {
  mode: SetupMode;
  tools: string[];
  status: SetupStatus;
  gitBlocked: boolean;
  pending: boolean;
  startLabel: string;
  onMode: (mode: SetupMode) => void;
  onToggleTool: (id: string) => void;
  onStart: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!gitBlocked && !pending) onStart();
      }}
    >
      <fieldset className={styles.choices}>
        <legend>Project mode</legend>
        <label className={styles.choice} data-selected={mode === "code-repo"}>
          <input
            type="radio"
            name="setup-mode"
            value="code-repo"
            checked={mode === "code-repo"}
            onChange={() => onMode("code-repo")}
          />
          <span>
            <strong>Code repository</strong>
            <span>Populate the scaffold from this codebase, then build Graph and Wiki.</span>
          </span>
        </label>
        <label className={styles.choice} data-selected={mode === "agent-memory"}>
          <input
            type="radio"
            name="setup-mode"
            value="agent-memory"
            checked={mode === "agent-memory"}
            onChange={() => onMode("agent-memory")}
          />
          <span>
            <strong>Agent memory</strong>
            <span>Persistent-agent operational memory. Git is not required.</span>
          </span>
        </label>
      </fieldset>
      <fieldset className={styles.choices}>
        <legend>AI tools</legend>
        <div className={styles.tools}>
          {status.tools.map((tool) => (
            <label key={tool.id} className={styles.choice} data-selected={tools.includes(tool.id)}>
              <input
                type="checkbox"
                name="setup-tools"
                value={tool.id}
                checked={tools.includes(tool.id)}
                onChange={() => onToggleTool(tool.id)}
              />
              <span>
                <strong>{tool.name}{tool.cliAvailable ? <small>CLI available</small> : null}</strong>
                <span>{tool.cliAvailable ? "Headless population can use this CLI when selected." : "Instructions are linked; paste the prompt if no CLI is installed."}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className={styles.footer}>
        <p>MEX never runs git init, commit, or push. After setup, commit the canonical files yourself.</p>
        <div className={styles.actions}>
          <Button type="submit" size="sm" disabled={gitBlocked || pending}>
            {pending ? "Starting…" : startLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

function GitRequiredNotice() {
  return (
    <div className={styles.notice} data-tone="warning">
      <strong>Initialize git first</strong>
      Code-repo setup needs a git repository. MEX does not run <code>git init</code>. Run it in this folder, then continue.
      <div className={styles.footer} style={{ marginTop: 12 }}>
        <code>git init</code>
      </div>
    </div>
  );
}

function ProgressPanel({ run, mode, tools }: { run: SetupRun; mode: SetupMode; tools: string[] }) {
  const current = run.progress?.step ?? "detect";
  const currentIndex = STEP_ORDER.indexOf(current);
  return (
    <>
      <p className={styles.notice}>
        <strong>{run.progress?.label ?? "Running setup"}</strong>
        {run.message}
      </p>
      <ol className={styles.steps}>
        {visibleSteps(mode, tools).map((step) => {
          const index = STEP_ORDER.indexOf(step);
          const state = run.status === "failed" && index === currentIndex
            ? "blocked"
            : index < currentIndex
              ? "complete"
              : index === currentIndex
                ? "current"
                : "pending";
          return (
            <li key={step} data-state={state}>
              <span className={styles.mark}>{state === "current" ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : index + 1}</span>
              <span>
                {STEP_LABELS[step]}
                {state === "current" && run.progress?.detail ? ` — ${run.progress.detail}` : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function PopulationPanel({
  run,
  copied,
  pending,
  onCopy,
  onContinue,
  onRetry,
}: {
  run: SetupRun;
  copied: string | null;
  pending: boolean;
  onCopy: (value: string) => Promise<void>;
  onContinue: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <p className={styles.notice} data-tone="warning">
        <strong>Populate the scaffold</strong>
        {run.message}
        {run.populationTool
          ? ` Headless ${run.populationTool === "claude" ? "Claude Code" : "Codex"} ${run.populationCompleted ? "exited." : "was launched."}`
          : " Paste this prompt into your selected agent if no CLI is available."}
      </p>
      {run.prompt ? (
        <>
          <Textarea className={styles.prompt} readOnly value={run.prompt} aria-label="Population prompt" />
          <div className={styles.actions} style={{ marginBottom: 16 }}>
            <Button type="button" size="sm" variant="outline" onClick={() => void onCopy(run.prompt!)}>
              {copied === run.prompt ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === run.prompt ? "Copied" : "Copy prompt"}
            </Button>
          </div>
        </>
      ) : null}
      <div className={styles.footer}>
        <p>After the agent finishes, continue to capture grounding and Wiki. Placeholders must be gone.</p>
        <div className={styles.actions}>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onRetry}>Retry population</Button>
          <Button type="button" size="sm" disabled={pending} onClick={onContinue}>
            {pending ? "Continuing…" : "I've populated the scaffold"}
          </Button>
        </div>
      </div>
    </>
  );
}

function DonePanel({
  run,
  copied,
  onCopy,
}: {
  run: SetupRun;
  copied: string | null;
  onCopy: (value: string) => Promise<void>;
}) {
  return (
    <>
      <p className={styles.notice} data-tone="success">
        <strong>Setup is ready to commit</strong>
        {run.message} Restart <code>mex hub</code> after the commit to open the Project Hub.
      </p>
      {run.anchorNotes.length > 0 ? (
        <ul className={styles.commands}>
          {run.anchorNotes.map((note) => <li key={note}><span>{note}</span></li>)}
        </ul>
      ) : null}
      <ol className={styles.commands}>
        {run.commitCommands.map((command) => (
          <li key={command}>
            <code>{command}</code>
            <Button type="button" size="xs" variant="ghost" onClick={() => void onCopy(command)}>
              {copied === command ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === command ? "Copied" : "Copy"}
            </Button>
          </li>
        ))}
      </ol>
      <p className={styles.footer}>
        <span><Terminal aria-hidden="true" /> MEX never stages, commits, or pushes on your behalf.</span>
      </p>
    </>
  );
}

function resolveView(
  status: SetupStatus,
  run: SetupRun,
  mode: SetupMode,
): "git" | "configure" | "progress" | "population" | "done" | "failed" {
  if (status.ready || run.ready) return "done";
  if (run.status === "running") return "progress";
  if (run.status === "paused" || (run.prompt && !run.populated)) return "population";
  if (run.status === "failed") return "failed";
  if (!status.hasGit && mode === "code-repo") return "git";
  return "configure";
}

function headingFor(view: ReturnType<typeof resolveView>, status: SetupStatus): string {
  if (view === "done") return "Review and commit";
  if (view === "progress") return "Running setup";
  if (view === "population") return "Populate scaffold";
  if (view === "failed") return "Setup stopped";
  if (view === "git") return "Git repository required";
  if (status.stage === "needs_finalize") return "Finish Graph and Wiki";
  if (status.hasScaffold) return "Continue setup";
  return "Create the MEX scaffold";
}

function visibleSteps(mode: SetupMode, tools: string[]): SetupProgressStep[] {
  return STEP_ORDER.filter((step) => {
    if (step === "scan" || step === "graph" || step === "finalize") return mode === "code-repo";
    if (step === "skills") return tools.includes("claude") || tools.includes("codex");
    return true;
  });
}

function idleRunFromStatus(status: SetupStatus): SetupRun {
  return {
    status: "idle",
    stage: status.stage,
    populated: status.populated,
    ready: status.ready,
    selectedTools: status.configuredTools,
    prompt: null,
    populationTool: null,
    populationCompleted: false,
    commitCommands: [],
    anchorNotes: [],
    message: status.ready ? "MEX setup is complete for this checkout." : "MEX is not set up in this checkout yet.",
    progress: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "this session";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
