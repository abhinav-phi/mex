import { createHash } from "node:crypto";
import type {
  SetupProgress,
  SetupRun,
  SetupStartRequest,
  SetupStatus,
} from "@mex/hub-contracts/setup";
import {
  inspectSetupStatus,
  runHeadlessSetup,
  type HeadlessSetupResult,
} from "../../setup/headless.js";
import { HubHttpError } from "../http/errors.js";

const SETUP_UNAVAILABLE = "Finish MEX setup before using this Hub workbench.";

export interface HubSetupRunnerOptions {
  readonly projectRoot: string;
  readonly now?: () => Date;
  readonly onReady?: () => void | Promise<void>;
}

export type HubSetupListener = (run: SetupRun) => void;

export class HubSetupRunner {
  private readonly projectRoot: string;
  private readonly now: () => Date;
  private readonly onReady?: () => void | Promise<void>;
  private readonly listeners = new Set<HubSetupListener>();
  private run: SetupRun;
  private controller: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HubSetupRunnerOptions) {
    this.projectRoot = options.projectRoot;
    this.now = options.now ?? (() => new Date());
    this.onReady = options.onReady;
    this.run = idleRun(projectSetupStatus(this.projectRoot), this.now());
  }

  status(): SetupStatus {
    return projectSetupStatus(this.projectRoot);
  }

  snapshot(): SetupRun {
    return this.run;
  }

  subscribe(listener: HubSetupListener): () => void {
    this.listeners.add(listener);
    listener(this.run);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(request: SetupStartRequest): SetupRun {
    if (this.run.status === "running") {
      throw new HubHttpError(
        409,
        "JOB_ALREADY_RUNNING",
        "Setup already running",
        "A setup run is already in progress for this checkout.",
      );
    }
    const status = this.status();
    if (request.mode === "code-repo" && !status.hasGit) {
      throw new HubHttpError(
        400,
        "VALIDATION_FAILED",
        "Git repository required",
        "Initialize git first, then start setup. MEX does not run git init.",
      );
    }

    const startedAt = this.now().toISOString();
    this.controller = new AbortController();
    this.run = {
      status: "running",
      stage: status.stage,
      populated: status.populated,
      ready: false,
      selectedTools: request.tools,
      prompt: null,
      populationTool: null,
      populationCompleted: false,
      commitCommands: [],
      anchorNotes: [],
      message: "Starting MEX setup…",
      progress: { step: "detect", label: "Detect project state" },
      error: null,
      startedAt,
      finishedAt: null,
    };
    this.emit();
    const signal = this.controller.signal;
    this.queue = this.queue.then(() => this.execute(request, signal));
    return this.run;
  }

  private async execute(request: SetupStartRequest, signal: AbortSignal): Promise<void> {
    try {
      const result = await runHeadlessSetup({
        projectRoot: this.projectRoot,
        mode: request.mode,
        tools: request.tools,
        ...(request.confirmPopulation === undefined ? {} : { confirmPopulation: request.confirmPopulation }),
        signal,
        onProgress: (update) => {
          this.run = {
            ...this.run,
            progress: {
              step: update.step,
              label: update.label,
              ...(update.detail === undefined ? {} : { detail: update.detail }),
            },
            message: update.detail ?? update.label,
          };
          this.emit();
        },
      });
      this.finishFromResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Setup failed.";
      this.run = {
        ...this.run,
        status: signal.aborted ? "failed" : "failed",
        message,
        error: message.slice(0, 512),
        finishedAt: this.now().toISOString(),
        progress: this.run.progress,
      };
      this.emit();
    } finally {
      this.controller = null;
    }
  }

  private finishFromResult(result: HeadlessSetupResult): void {
    const paused = result.stage === "needs_population" && !result.ready;
    this.run = {
      status: paused ? "paused" : result.ready || result.populated ? "succeeded" : "paused",
      stage: result.stage,
      populated: result.populated,
      ready: result.ready,
      selectedTools: result.selectedTools,
      prompt: result.prompt,
      populationTool: result.populationTool,
      populationCompleted: result.populationCompleted,
      commitCommands: result.commitCommands,
      anchorNotes: result.anchorNotes,
      message: result.message,
      progress: this.run.progress,
      error: null,
      startedAt: this.run.startedAt,
      finishedAt: this.now().toISOString(),
    };
    this.emit();
    if (result.ready) this.notifyReady();
  }

  private notifyReady(): void {
    if (!this.onReady) return;
    void Promise.resolve()
      .then(() => this.onReady?.())
      .catch(() => {
        // Promotion failures stay on the setup listener; the command layer reports them.
      });
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.run);
  }
}

export function projectSetupStatus(projectRoot: string): SetupStatus {
  const status = inspectSetupStatus(projectRoot);
  return {
    projectName: status.projectName,
    hasGit: status.hasGit,
    hasScaffold: status.hasScaffold,
    populated: status.populated,
    graphReady: status.graphReady,
    wikiReady: status.wikiReady,
    state: status.state,
    stage: status.stage,
    configuredTools: status.configuredTools,
    tools: [...status.tools],
    ready: status.ready,
  };
}

export function setupWorkbenchReason(): string {
  return SETUP_UNAVAILABLE;
}

export function setupSnapshotRevision(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function idleRun(status: SetupStatus, now: Date): SetupRun {
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
    message: status.ready
      ? "MEX setup is complete for this checkout."
      : "MEX is not set up in this checkout yet.",
    progress: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}
