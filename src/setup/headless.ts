import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isCliAvailable } from "../cli-tools.js";
import {
  ensureScaffoldIdentity,
  loadConfiguredAiTools,
  readScaffoldId,
  saveAiTools,
} from "../config.js";
import { AI_TOOLS, type AiTool } from "../types.js";
import { launchHeadlessSetupPopulation } from "./headless-population.js";
import {
  AGENT_MEMORY_FILES,
  SCAFFOLD_FILES,
  detectProjectState,
  ensureScaffoldFile,
  ensureToolAnchors,
  finalizeCodeRepoSetup,
  installSetupAgentAssets,
  isScaffoldPopulated,
  normalizeSetupMode,
  setupCommitCheckpointCommands,
  setupTemplatesDirectory,
  verifyExistingSetupConfig,
  type ProjectState,
  type SetupMode,
} from "./index.js";
import {
  ensureSetupIgnoreProtection,
  renderSetupIgnoreProtection,
  verifySetupIgnoreProtection,
} from "./ignore.js";

export const SETUP_PROGRESS_STEPS = [
  "detect",
  "scaffold",
  "tools",
  "skills",
  "identity",
  "scan",
  "graph",
  "population",
  "finalize",
] as const;

export type SetupProgressStep = (typeof SETUP_PROGRESS_STEPS)[number];

export type SetupStage =
  | "needs_git"
  | "needs_setup"
  | "needs_population"
  | "needs_finalize"
  | "ready";

export interface SetupToolStatus {
  readonly id: AiTool;
  readonly name: string;
  readonly selected: boolean;
  readonly cliAvailable: boolean;
}

export interface SetupStatus {
  readonly projectRoot: string;
  readonly projectName: string;
  readonly hasGit: boolean;
  readonly hasScaffold: boolean;
  readonly populated: boolean;
  readonly graphReady: boolean;
  readonly wikiReady: boolean;
  readonly state: ProjectState;
  readonly stage: SetupStage;
  readonly configuredTools: AiTool[];
  readonly tools: readonly SetupToolStatus[];
  readonly ready: boolean;
}

export interface HeadlessSetupOptions {
  readonly projectRoot: string;
  readonly mode?: SetupMode | string;
  readonly tools?: readonly AiTool[];
  readonly confirmPopulation?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: HeadlessSetupProgress) => void;
}

export interface HeadlessSetupProgress {
  readonly step: SetupProgressStep;
  readonly label: string;
  readonly detail?: string;
}

export interface HeadlessSetupResult {
  readonly stage: SetupStage;
  readonly populated: boolean;
  readonly ready: boolean;
  readonly selectedTools: AiTool[];
  readonly prompt: string | null;
  readonly populationTool: "claude" | "codex" | null;
  readonly populationCompleted: boolean;
  readonly commitCommands: string[];
  readonly anchorNotes: string[];
  readonly message: string;
}

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

const EMPTY_REVISION_REASON = "Setup has not finished in this checkout.";

export function inspectSetupStatus(projectRoot: string): SetupStatus {
  const root = resolve(projectRoot);
  const mexDir = resolve(root, ".mex");
  const hasGit = existsSync(resolve(root, ".git"));
  const hasScaffold = existsSync(resolve(mexDir, "ROUTER.md"));
  const populated = isScaffoldPopulated(mexDir);
  const graphReady = existsSync(resolve(mexDir, "graph.db"));
  const wikiReady = existsSync(resolve(mexDir, "wiki.db"));
  const configuredTools = hasScaffold || existsSync(resolve(mexDir, "config.json"))
    ? loadConfiguredAiTools(mexDir)
    : [];
  const state = detectProjectState(root, mexDir);
  const stage = resolveSetupStage({ hasGit, hasScaffold, populated, graphReady, wikiReady });
  return {
    projectRoot: root,
    projectName: basename(root),
    hasGit,
    hasScaffold,
    populated,
    graphReady,
    wikiReady,
    state,
    stage,
    configuredTools,
    tools: (Object.keys(AI_TOOLS) as AiTool[]).map((id) => ({
      id,
      name: AI_TOOLS[id].name,
      selected: configuredTools.includes(id),
      cliAvailable: AI_TOOLS[id].cli !== null && isCliAvailable(AI_TOOLS[id].cli),
    })),
    ready: stage === "ready",
  };
}

export function setupUnavailableReason(): string {
  return EMPTY_REVISION_REASON;
}

/**
 * Run the same ordered setup path as `mex setup`, without readline or a TTY.
 *
 * Tool choice arrives from the Hub form. Population uses a headless Claude or
 * Codex session when one is installed; otherwise the prompt is returned for
 * the user to paste. Finalize only runs after `isScaffoldPopulated`.
 */
export async function runHeadlessSetup(
  options: HeadlessSetupOptions,
): Promise<HeadlessSetupResult> {
  const projectRoot = resolve(options.projectRoot);
  const mode = normalizeSetupMode(typeof options.mode === "string" ? options.mode : options.mode);
  const mexDir = resolve(projectRoot, ".mex");
  const templatesDir = setupTemplatesDirectory();
  const report = (step: SetupProgressStep, detail?: string) => {
    options.onProgress?.({
      step,
      label: STEP_LABELS[step],
      ...(detail === undefined ? {} : { detail }),
    });
  };

  throwIfAborted(options.signal);

  if (mode === "code-repo" && !existsSync(resolve(projectRoot, ".git"))) {
    throw new Error("No Git repository found. Run `git init` first, then rerun setup.");
  }

  const scaffoldPopulatedAtStart = isScaffoldPopulated(mexDir);
  const state = detectProjectState(projectRoot, mexDir);
  report("detect", describeDetectedState(mode, state));

  report("scaffold");
  const ignoreProtection = ensureSetupIgnoreProtection({ projectRoot, dryRun: false });
  renderSetupIgnoreProtection(ignoreProtection);
  if (mode === "code-repo") verifySetupIgnoreProtection(projectRoot);
  verifyExistingSetupConfig(mexDir);

  const scaffoldFiles = mode === "agent-memory" ? AGENT_MEMORY_FILES : SCAFFOLD_FILES;
  for (const file of scaffoldFiles) {
    throwIfAborted(options.signal);
    const agentMemorySrc = resolve(templatesDir, "agent-memory", file);
    const src = mode === "agent-memory" && existsSync(agentMemorySrc)
      ? agentMemorySrc
      : resolve(templatesDir, file);
    ensureScaffoldFile(src, resolve(mexDir, file), false);
  }

  report("tools");
  const requestedTools = uniqueTools(options.tools ?? loadConfiguredAiTools(mexDir));
  const selectedTools = requestedTools;
  const anchorNotes = ensureToolAnchors(projectRoot, templatesDir, selectedTools, false);
  if (selectedTools.length > 0) {
    saveAiTools(mexDir, selectedTools);
  }

  const selectedAgentClients = selectedTools.filter((tool) => tool === "claude" || tool === "codex");
  if (selectedAgentClients.length > 0) {
    report("skills");
    const agentAssets = installSetupAgentAssets({
      projectRoot,
      selectedTools,
      dryRun: false,
      checkIgnored: mode === "code-repo",
    });
    if (agentAssets?.conflicted) {
      throw new Error("Official MEX agent assets have conflicts. Resolve them and rerun setup or mex skills sync.");
    }
  }

  report("identity");
  const identity = ensureScaffoldIdentity(mexDir, projectRoot);
  if (readScaffoldId(mexDir) !== identity.scaffold_id) {
    throw new Error("Could not persist .mex/config.json. Fix its permissions or contents and rerun setup.");
  }

  let scannerBrief: string | null = null;
  if (mode !== "agent-memory" && state !== "fresh") {
    report("scan");
    try {
      const { runScan } = await import("../scanner/index.js");
      const result = await runScan(
        { projectRoot, scaffoldRoot: mexDir, aiTools: [] },
        { jsonOnly: true },
      );
      scannerBrief = JSON.stringify(result, null, 2);
    } catch {
      scannerBrief = null;
    }
  }

  if (mode === "code-repo") {
    report("graph");
    throwIfAborted(options.signal);
    try {
      const { rebuildGraph } = await import("../graph/maintenance.js");
      await rebuildGraph(projectRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Code graph setup failed: ${message}. Fix the problem and rerun setup.`);
    }
  }

  const prompt = await buildPopulationPrompt(mode, state, scannerBrief);
  report("population");

  let populationFinished = scaffoldPopulatedAtStart;
  let populationTool: "claude" | "codex" | null = null;
  let populationCompleted = false;

  if (!populationFinished) {
    throwIfAborted(options.signal);
    const launched = launchHeadlessSetupPopulation({
      selectedTools,
      prompt,
      projectRoot,
    });
    populationTool = launched.tool;
    populationCompleted = launched.completed;
    if (launched.completed) {
      populationFinished = isScaffoldPopulated(mexDir);
    }
  }

  if (!populationFinished && options.confirmPopulation === true) {
    populationFinished = isScaffoldPopulated(mexDir);
  }

  if (!populationFinished || !isScaffoldPopulated(mexDir)) {
    return {
      stage: "needs_population",
      populated: false,
      ready: false,
      selectedTools,
      prompt,
      populationTool,
      populationCompleted,
      commitCommands: setupCommitCheckpointCommands(selectedTools),
      anchorNotes,
      message: populationCompleted
        ? "The agent exited successfully, but required scaffold placeholders remain."
        : "Setup paused at population. After the agent finishes, continue setup to finalize Graph and Wiki readiness.",
    };
  }

  if (mode === "code-repo") {
    report("finalize");
    throwIfAborted(options.signal);
    await finalizeCodeRepoSetup(projectRoot, mexDir);
  }

  const status = inspectSetupStatus(projectRoot);
  return {
    stage: status.stage,
    populated: true,
    ready: status.ready,
    selectedTools,
    prompt: null,
    populationTool,
    populationCompleted: populationFinished,
    commitCommands: setupCommitCheckpointCommands(selectedTools),
    anchorNotes,
    message: mode === "code-repo"
      ? "Graph and Wiki are ready. Review and commit the canonical MEX setup."
      : "Setup complete.",
  };
}

function resolveSetupStage(input: {
  hasGit: boolean;
  hasScaffold: boolean;
  populated: boolean;
  graphReady: boolean;
  wikiReady: boolean;
}): SetupStage {
  if (input.populated && input.graphReady && input.wikiReady) return "ready";
  if (input.populated && !input.hasGit) return "ready";
  if (!input.hasGit) return "needs_git";
  if (!input.hasScaffold) return "needs_setup";
  if (!input.populated) return "needs_population";
  return "needs_finalize";
}

function describeDetectedState(mode: SetupMode, state: ProjectState): string {
  if (mode === "agent-memory") return "Detected: agent-memory workspace";
  if (state === "existing") return "Detected: existing codebase with source files";
  if (state === "fresh") return "Detected: fresh project (no source files yet)";
  return "Detected: existing codebase with a populated scaffold";
}

function uniqueTools(tools: readonly AiTool[]): AiTool[] {
  return [...new Set(tools)];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Setup was cancelled.");
}

async function buildPopulationPrompt(
  mode: SetupMode,
  state: ProjectState,
  scannerBrief: string | null,
): Promise<string> {
  if (mode === "agent-memory") {
    const { buildAgentMemoryPrompt } = await import("./prompts.js");
    return buildAgentMemoryPrompt();
  }
  const {
    buildFreshPrompt,
    buildExistingWithBriefPrompt,
    buildExistingNoBriefPrompt,
  } = await import("./prompts.js");
  if (state === "fresh") return buildFreshPrompt();
  if (scannerBrief) return buildExistingWithBriefPrompt(scannerBrief);
  return buildExistingNoBriefPrompt();
}
