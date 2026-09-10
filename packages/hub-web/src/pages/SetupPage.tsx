import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenText,
  Braces,
  Check,
  Copy,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
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
import { Progress, ProgressLabel, ProgressValue } from "../components/primitives/progress";
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
            <small>Project Hub</small>
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
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);

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
      if (next.ready) {
        await queryClient.invalidateQueries({ queryKey: ["capabilities"] });
      }
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
  const resume = status.hasScaffold
    || status.stage === "needs_finalize"
    || currentRun.status !== "idle";
  const showWelcome = !welcomeDismissed && !resume && (view === "configure" || view === "git");

  if (showWelcome) {
    return <WelcomeScreen status={status} onContinue={() => setWelcomeDismissed(true)} />;
  }

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Project Hub"
        title="Set up MEX"
        description="Create the local scaffold, link your AI tools, then open Graph, Wiki, and team memory for this checkout."
      />
      <section className={styles.surface} aria-labelledby="setup-title">
        <div className={styles.intro}>
          <span className={styles.icon}><Sparkles aria-hidden="true" /></span>
          <div>
            <h2 id="setup-title">{headingFor(view, status)}</h2>
            <p>{status.projectName}</p>
          </div>
        </div>
        <div className={styles.body}>
          {view === "git" ? <GitRequiredNotice onCopy={copy} copied={copied} /> : null}
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
              showWelcomeBack={!resume}
              onBack={() => setWelcomeDismissed(false)}
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
            <StatePanel
              state="loading"
              title="Opening the Project Hub"
              detail="Setup finished. Switching this session to the Project Hub."
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

function WelcomeScreen({
  status,
  onContinue,
}: {
  status: SetupStatus;
  onContinue: () => void;
}) {
  return (
    <div className={styles.welcome}>
      <section className={styles.stage} aria-labelledby="welcome-title">
        <div className={styles.stageCopy}>
          <img alt="" className={styles.mascot} height="128" src={mexMascot} width="128" />
          <p className={styles.eyebrow}>Local Project Hub</p>
          <h1 id="welcome-title">Build a Hub for this checkout</h1>
          <p className={styles.lead}>
            Setup gives <strong>{status.projectName}</strong> a Graph, a Wiki, and team memory that stay on this device.
          </p>
          <div className={styles.stageActions}>
            <Button size="lg" type="button" onClick={onContinue}>
              Set up this project
            </Button>
            <p className={styles.heroNote}>MEX never runs git init, commit, or push.</p>
          </div>
        </div>
        <div className={styles.motion} aria-hidden="true">
          <GraphMotion />
        </div>
      </section>
    </div>
  );
}

function GraphMotion() {
  return (
    <svg className={styles.constellation} viewBox="0 0 520 480" role="presentation">
      <defs>
        <radialGradient id="mex-setup-glow" cx="46%" cy="44%" r="54%">
          <stop offset="0%" stopColor="oklch(0.73 0.17 55)" stopOpacity="0.34" />
          <stop offset="55%" stopColor="oklch(0.73 0.17 55)" stopOpacity="0.08" />
          <stop offset="100%" stopColor="oklch(0.73 0.17 55)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect fill="url(#mex-setup-glow)" height="480" width="520" />
      <g className={styles.constellationHalo}>
        <circle cx="268" cy="196" r="78" />
        <circle cx="268" cy="196" r="122" />
      </g>
      <g className={styles.constellationLinks} fill="none" strokeLinecap="round">
        <path d="M92 302 C138 248, 168 232, 176 214" />
        <path d="M176 214 C214 168, 238 128, 228 108" />
        <path d="M176 214 C214 236, 248 252, 268 196" />
        <path d="M268 196 C312 154, 338 118, 352 92" />
        <path d="M268 196 C318 218, 358 228, 392 214" />
        <path d="M392 214 C428 178, 452 142, 468 126" />
        <path d="M176 214 C198 268, 228 312, 252 338" />
        <path d="M268 196 C292 268, 322 318, 348 336" />
        <path d="M92 302 C128 338, 168 356, 188 368" />
      </g>
      <g className={styles.constellationNodes}>
        <circle cx="92" cy="302" r="5" />
        <circle cx="176" cy="214" r="7" />
        <circle cx="228" cy="108" r="4.5" />
        <circle className={styles.constellationFocus} cx="268" cy="196" r="8.5" />
        <circle cx="352" cy="92" r="5" />
        <circle cx="392" cy="214" r="6.5" />
        <circle cx="468" cy="126" r="4.5" />
        <circle cx="252" cy="338" r="5" />
        <circle cx="348" cy="336" r="4.5" />
        <circle cx="188" cy="368" r="4" />
      </g>
    </svg>
  );
}

function ConfigureForm({
  mode,
  tools,
  status,
  gitBlocked,
  pending,
  startLabel,
  showWelcomeBack,
  onBack,
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
  showWelcomeBack: boolean;
  onBack: () => void;
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
        <div className={styles.modes}>
          <label className={styles.choice} data-selected={mode === "code-repo"}>
            <input
              type="radio"
              name="setup-mode"
              value="code-repo"
              checked={mode === "code-repo"}
              onChange={() => onMode("code-repo")}
            />
            <span>
              <strong><Braces aria-hidden="true" /> Code repository</strong>
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
              <strong><BookOpenText aria-hidden="true" /> Agent memory</strong>
              <span>Persistent-agent operational memory. Git is not required.</span>
            </span>
          </label>
        </div>
      </fieldset>
      <fieldset className={`${styles.choices} ${styles.toolset}`}>
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
          {showWelcomeBack ? (
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onBack}>
              Back
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={gitBlocked || pending}>
            {pending ? "Starting…" : startLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

function GitRequiredNotice({
  copied,
  onCopy,
}: {
  copied: string | null;
  onCopy: (value: string) => Promise<void>;
}) {
  return (
    <div className={styles.notice} data-tone="warning">
      <strong>Initialize git first</strong>
      Code-repo setup needs a git repository. MEX does not run <code>git init</code>. Run it in this folder, then continue.
      <div className={styles.footer} style={{ marginTop: 12 }}>
        <code>git init</code>
        <Button type="button" size="xs" variant="outline" onClick={() => void onCopy("git init")}>
          {copied === "git init" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied === "git init" ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function ProgressPanel({ run, mode, tools }: { run: SetupRun; mode: SetupMode; tools: string[] }) {
  const steps = visibleSteps(mode, tools);
  const current = run.progress?.step ?? "detect";
  const currentIndex = Math.max(0, steps.indexOf(current));
  const percent = steps.length === 0
    ? 0
    : Math.round(((currentIndex + (run.status === "running" ? 0.35 : 1)) / steps.length) * 100);
  return (
    <>
      <div className={styles.currentStep}>
        <strong>
          <LoaderCircle className={styles.spin} aria-hidden="true" />
          {run.progress?.label ?? "Running setup"}
        </strong>
        <p>{run.message}</p>
        <Progress value={Math.min(100, percent)}>
          <ProgressLabel>Setup progress</ProgressLabel>
          <ProgressValue />
        </Progress>
      </div>
      <ol className={styles.steps}>
        {steps.map((step, index) => {
          const orderIndex = STEP_ORDER.indexOf(step);
          const state = run.status === "failed" && step === current
            ? "blocked"
            : index < currentIndex
              ? "complete"
              : index === currentIndex
                ? "current"
                : "pending";
          return (
            <li key={step} data-state={state}>
              <span className={styles.mark}>
                {state === "current"
                  ? <LoaderCircle className={styles.spin} aria-hidden="true" />
                  : state === "complete"
                    ? <Check aria-hidden="true" />
                    : orderIndex + 1}
              </span>
              <span>{STEP_LABELS[step]}</span>
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
        <div className={styles.promptFrame}>
          <div className={styles.promptHeader}>
            <span>Population prompt</span>
            <Button type="button" size="xs" variant="outline" onClick={() => void onCopy(run.prompt!)}>
              {copied === run.prompt ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === run.prompt ? "Copied" : "Copy prompt"}
            </Button>
          </div>
          <Textarea className={styles.prompt} readOnly value={run.prompt} aria-label="Population prompt" />
        </div>
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
  if (view === "done") return "Opening the Project Hub";
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
