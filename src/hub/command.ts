import { HubAssetManifest } from "./static/assets.js";
import { createBootstrapToken, HubSessionManager } from "./security/session.js";
import { createHubApp } from "./app.js";
import { openHubBrowser } from "./browser.js";
import { HubJobManager } from "./jobs/index.js";
import { createGraphJobExecutors } from "./jobs/graph.js";
import { createWikiJobExecutors } from "./jobs/wiki.js";
import { startHubNodeServer } from "./node-server.js";
import { createLocalHubReadServices } from "./services.js";
import { createSetupHubServices } from "./setup/services.js";
import { TeamLocalState } from "../team/local-state/index.js";
import { createRepositoryGraphPort } from "../graph/application-adapter.js";
import { createRepositoryWikiPort } from "../wiki/application-adapter.js";
import { createRepositoryTeamWorkflowPort } from "../team/workflow/repository-team-workflow-port.js";
import { createSpecReadService } from "../team/specs/index.js";
import { findConfig, getScaffoldIdentity } from "../config.js";
import { inspectSetupStatus } from "../setup/headless.js";
import { findSetupProjectRoot } from "../setup/index.js";
import { createProjectTelemetryCapture, startHubTelemetry } from "../telemetry/index.js";
import { emitHubTelemetry } from "./telemetry.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RunHubCommandOptions {
  readonly projectRoot: string;
  readonly scaffoldId: string;
  readonly port?: number;
  readonly openBrowser: boolean;
  readonly wikiExclude?: readonly string[];
  readonly wikiReadOnly?: readonly string[];
}

export interface LaunchHubOptions {
  readonly port?: number;
  readonly openBrowser: boolean;
}

export interface RunSetupHubCommandOptions {
  readonly projectRoot: string;
  readonly port?: number;
  readonly openBrowser: boolean;
}

/**
 * Open the Project Hub, or the setup wizard when this checkout is not ready.
 *
 * A working-tree scaffold with Graph and Wiki indexes is enough to open the
 * dashboard. The setup process promotes that same listener in place when the
 * wizard finishes, so the browser session does not wait for a restart or commit.
 */
export async function launchHub(options: LaunchHubOptions): Promise<void> {
  const projectRoot = findSetupProjectRoot();
  const status = inspectSetupStatus(projectRoot);
  if (status.ready) {
    try {
      const config = findConfig(projectRoot);
      const identity = getScaffoldIdentity(config);
      await runHubCommand({
        projectRoot: config.projectRoot,
        scaffoldId: identity.scaffold_id,
        port: options.port,
        openBrowser: options.openBrowser,
        ...(config.wiki?.exclude === undefined ? {} : { wikiExclude: config.wiki.exclude }),
        ...(config.wiki?.readOnly === undefined ? {} : { wikiReadOnly: config.wiki.readOnly }),
      });
      return;
    } catch {
      // Untracked or incomplete identity: keep serving the setup wizard.
    }
  }
  await runSetupHubCommand({
    projectRoot,
    port: options.port,
    openBrowser: options.openBrowser,
  });
}

/**
 * Launch the local Hub in the foreground. Startup is the explicit write-side
 * boundary for local schema migration and interrupted-job reconciliation.
 */
export async function runHubCommand(options: RunHubCommandOptions): Promise<void> {
  const captureEvent = createProjectTelemetryCapture(options.projectRoot);
  let jobs: HubJobManager | undefined;
  let server: Awaited<ReturnType<typeof startHubNodeServer>> | undefined;
  let stopTelemetry: (() => Promise<void>) | undefined;
  try {
    const bootstrapToken = createBootstrapToken();
    let expectedOrigin: string | null = null;
    const security = new HubSessionManager({
      bootstrapToken,
      expectedOrigin: () => expectedOrigin,
    });
    const assets = new HubAssetManifest(resolveHubAssetRoot());
    // Bind and verify the tracked scaffold identity before the explicit Hub
    // startup boundary creates or migrates any local state.
    const composed = await composeProductionHub({
      projectRoot: options.projectRoot,
      scaffoldId: options.scaffoldId,
      security,
      assets,
      telemetry: captureEvent,
      ...(options.wikiExclude === undefined ? {} : { wikiExclude: options.wikiExclude }),
      ...(options.wikiReadOnly === undefined ? {} : { wikiReadOnly: options.wikiReadOnly }),
    });
    jobs = composed.jobs;
    server = await startHubNodeServer({ app: composed.app, port: options.port });
    expectedOrigin = server.origin;
    stopTelemetry = startHubTelemetry();
    emitHubTelemetry(captureEvent, "hub.session_started", {});
    const bootstrapUrl = `${server.origin}/#token=${encodeURIComponent(bootstrapToken)}`;

    process.stdout.write(`\nProject Hub running at ${server.origin}\n`);
    process.stdout.write(`One-time bootstrap link (valid for 5 minutes):\n${bootstrapUrl}\n`);
    process.stdout.write("Press Ctrl+C to stop.\n\n");
    if (options.openBrowser) openHubBrowser(bootstrapUrl);
    await waitForShutdownSignal();
  } finally {
    // Stop accepting requests before aborting or reconciling any executors.
    try {
      await server?.close();
    } finally {
      try {
        await jobs?.shutdown();
      } finally {
        await stopTelemetry?.();
      }
    }
  }
}

/** Setup-only Hub: same session/assets/server, no Team/Graph/Wiki jobs until ready. */
export async function runSetupHubCommand(options: RunSetupHubCommandOptions): Promise<void> {
  const captureEvent = createProjectTelemetryCapture(options.projectRoot);
  let server: Awaited<ReturnType<typeof startHubNodeServer>> | undefined;
  let stopTelemetry: (() => Promise<void>) | undefined;
  let jobs: HubJobManager | undefined;
  let security: HubSessionManager | undefined;
  let assets: HubAssetManifest | undefined;
  let promoting = false;

  const promoteToProjectHub = async (): Promise<void> => {
    const listener = server;
    const session = security;
    const manifest = assets;
    if (promoting || jobs || !listener || !session || !manifest) return;
    promoting = true;
    try {
      const config = findConfig(options.projectRoot);
      const identity = getScaffoldIdentity(config);
      const composed = await composeProductionHub({
        projectRoot: config.projectRoot,
        scaffoldId: identity.scaffold_id,
        security: session,
        assets: manifest,
        telemetry: captureEvent,
        ...(config.wiki?.exclude === undefined ? {} : { wikiExclude: config.wiki.exclude }),
        ...(config.wiki?.readOnly === undefined ? {} : { wikiReadOnly: config.wiki.readOnly }),
      });
      jobs = composed.jobs;
      listener.replaceApp(composed.app);
      process.stdout.write(`\nProject Hub is ready at ${listener.origin}\n`);
    } catch (error) {
      promoting = false;
      const detail = error instanceof Error ? error.message : String(error);
      process.stdout.write(
        `\nProject Hub could not open after setup: ${detail}\nRestart mex hub to open the dashboard.\n`,
      );
    }
  };

  const { services, setup } = createSetupHubServices(options.projectRoot, {
    onReady: promoteToProjectHub,
  });
  try {
    const bootstrapToken = createBootstrapToken();
    let expectedOrigin: string | null = null;
    security = new HubSessionManager({
      bootstrapToken,
      expectedOrigin: () => expectedOrigin,
    });
    assets = new HubAssetManifest(resolveHubAssetRoot());
    const app = createHubApp({
      security,
      services,
      setup,
      assets,
      telemetry: captureEvent,
    });

    server = await startHubNodeServer({ app, port: options.port });
    expectedOrigin = server.origin;
    stopTelemetry = startHubTelemetry();
    emitHubTelemetry(captureEvent, "hub.session_started", {});
    const bootstrapUrl = `${server.origin}/#token=${encodeURIComponent(bootstrapToken)}`;

    process.stdout.write(`\nProject Hub setup wizard running at ${server.origin}\n`);
    process.stdout.write(`One-time bootstrap link (valid for 5 minutes):\n${bootstrapUrl}\n`);
    process.stdout.write("Press Ctrl+C to stop.\n\n");
    if (options.openBrowser) openHubBrowser(bootstrapUrl);
    if (setup.status().ready) await promoteToProjectHub();
    await waitForShutdownSignal();
  } finally {
    try {
      await server?.close();
    } finally {
      try {
        await jobs?.shutdown();
      } finally {
        await stopTelemetry?.();
      }
    }
  }
}

export function resolveHubAssetRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "hub");
}

interface ComposeProductionHubOptions {
  readonly projectRoot: string;
  readonly scaffoldId: string;
  readonly security: HubSessionManager;
  readonly assets: HubAssetManifest;
  readonly telemetry: ReturnType<typeof createProjectTelemetryCapture>;
  readonly wikiExclude?: readonly string[];
  readonly wikiReadOnly?: readonly string[];
}

async function composeProductionHub(
  options: ComposeProductionHubOptions,
): Promise<{ app: ReturnType<typeof createHubApp>; jobs: HubJobManager }> {
  const team = await createRepositoryTeamWorkflowPort(options.projectRoot);
  const localState = new TeamLocalState({
    projectRoot: options.projectRoot,
    scaffoldId: options.scaffoldId,
  });
  const graph = createRepositoryGraphPort(options.projectRoot, { candidateExecution: "process" });
  const wiki = createRepositoryWikiPort(options.projectRoot, {
    groundingBridge: graph,
    ...(options.wikiExclude === undefined ? {} : { exclude: options.wikiExclude }),
    ...(options.wikiReadOnly === undefined ? {} : { readOnly: options.wikiReadOnly }),
  });
  const jobs = new HubJobManager({
    localState,
    executors: {
      ...createGraphJobExecutors(graph),
      ...createWikiJobExecutors(wiki),
    },
    shutdownTimeoutMs: 60_000,
    telemetry: options.telemetry,
  });
  jobs.initialize();
  try {
    team.initializeIdentityActivitySigner();
    const services = createLocalHubReadServices({
      projectRoot: options.projectRoot,
      scaffoldId: options.scaffoldId,
      jobs,
      team,
      workstreams: team,
      inbox: team,
      relays: team,
      specs: createSpecReadService(wiki),
      graph,
      wiki,
    });
    return {
      app: createHubApp({
        security: options.security,
        services,
        jobs,
        assets: options.assets,
        telemetry: options.telemetry,
      }),
      jobs,
    };
  } catch (error) {
    await jobs.shutdown();
    throw error;
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      process.off("SIGINT", complete);
      process.off("SIGTERM", complete);
      resolve();
    };
    process.once("SIGINT", complete);
    process.once("SIGTERM", complete);
  });
}
