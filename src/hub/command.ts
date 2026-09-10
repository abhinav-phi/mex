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
 * Full Hub still requires a tracked `.mex/config.json`. Until that commit
 * exists, Hub stays on the setup-only process even after local indexes exist.
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
  // Bind and verify the tracked scaffold identity before the explicit Hub
  // startup boundary creates or migrates any local state.
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
    telemetry: captureEvent,
  });
  jobs.initialize();
  let server: Awaited<ReturnType<typeof startHubNodeServer>> | undefined;
  let stopTelemetry: (() => Promise<void>) | undefined;
  try {
    const bootstrapToken = createBootstrapToken();
    let expectedOrigin: string | null = null;
    const security = new HubSessionManager({
      bootstrapToken,
      expectedOrigin: () => expectedOrigin,
    });
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
    const assets = new HubAssetManifest(resolveHubAssetRoot());
    const app = createHubApp({ security, services, jobs, assets, telemetry: captureEvent });

    server = await startHubNodeServer({ app, port: options.port });
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
        await jobs.shutdown();
      } finally {
        await stopTelemetry?.();
      }
    }
  }
}

/** Setup-only Hub: same session/assets/server, no Team/Graph/Wiki jobs. */
export async function runSetupHubCommand(options: RunSetupHubCommandOptions): Promise<void> {
  const captureEvent = createProjectTelemetryCapture(options.projectRoot);
  const { services, setup } = createSetupHubServices(options.projectRoot);
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
    await waitForShutdownSignal();
  } finally {
    try {
      await server?.close();
    } finally {
      await stopTelemetry?.();
    }
  }
}

export function resolveHubAssetRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "hub");
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
