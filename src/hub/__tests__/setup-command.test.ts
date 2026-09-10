import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: vi.fn(),
  createCapture: vi.fn(),
  startTelemetry: vi.fn(),
  stopTelemetry: vi.fn(async () => undefined),
  startServer: vi.fn(),
  closeServer: vi.fn(async () => undefined),
  createApp: vi.fn(),
  createSetup: vi.fn(),
  inspect: vi.fn(),
  findRoot: vi.fn(),
  findConfig: vi.fn(),
  identity: vi.fn(),
  order: [] as string[],
}));

vi.mock("../../telemetry/index.js", () => ({
  createProjectTelemetryCapture: mocks.createCapture,
  startHubTelemetry: mocks.startTelemetry,
}));
vi.mock("../static/assets.js", () => ({ HubAssetManifest: class {} }));
vi.mock("../security/session.js", () => ({
  createBootstrapToken: () => "private-bootstrap-token",
  HubSessionManager: class {},
}));
vi.mock("../app.js", () => ({ createHubApp: mocks.createApp }));
vi.mock("../node-server.js", () => ({ startHubNodeServer: mocks.startServer }));
vi.mock("../setup/services.js", () => ({ createSetupHubServices: mocks.createSetup }));
vi.mock("../../setup/headless.js", () => ({ inspectSetupStatus: mocks.inspect }));
vi.mock("../../setup/index.js", () => ({ findSetupProjectRoot: mocks.findRoot }));
vi.mock("../../config.js", () => ({
  findConfig: mocks.findConfig,
  getScaffoldIdentity: mocks.identity,
}));
vi.mock("../jobs/index.js", () => ({ HubJobManager: class {
  initialize() {}
  shutdown = async () => undefined;
} }));
vi.mock("../jobs/graph.js", () => ({ createGraphJobExecutors: () => ({}) }));
vi.mock("../jobs/wiki.js", () => ({ createWikiJobExecutors: () => ({}) }));
vi.mock("../services.js", () => ({ createLocalHubReadServices: () => ({}) }));
vi.mock("../../team/local-state/index.js", () => ({ TeamLocalState: class {} }));
vi.mock("../../graph/application-adapter.js", () => ({ createRepositoryGraphPort: () => ({}) }));
vi.mock("../../wiki/application-adapter.js", () => ({ createRepositoryWikiPort: () => ({}) }));
vi.mock("../../team/workflow/repository-team-workflow-port.js", () => ({
  createRepositoryTeamWorkflowPort: async () => ({ initializeIdentityActivitySigner() {} }),
}));
vi.mock("../../team/specs/index.js", () => ({ createSpecReadService: () => ({}) }));

import { launchHub, runSetupHubCommand } from "../command.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.closeServer.mockImplementation(async () => { mocks.order.push("http"); });
  mocks.stopTelemetry.mockImplementation(async () => { mocks.order.push("telemetry"); });
  mocks.startTelemetry.mockReturnValue(mocks.stopTelemetry);
  mocks.createCapture.mockReturnValue(mocks.events);
  mocks.createSetup.mockReturnValue({ services: { tag: "setup-services" }, setup: { tag: "setup-runner" } });
  mocks.findRoot.mockReturnValue("/Users/private/project");
  mocks.inspect.mockReturnValue({ ready: false, stage: "needs_setup" });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("Hub setup process", () => {
  it("starts the setup Hub without jobs when the checkout is not ready", async () => {
    let ready!: (server: { origin: string; close: typeof mocks.closeServer }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = runSetupHubCommand({ projectRoot: "/Users/private/project", openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    expect(mocks.createSetup).toHaveBeenCalledWith("/Users/private/project");
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      setup: { tag: "setup-runner" },
      services: { tag: "setup-services" },
      telemetry: mocks.events,
    }));
    expect(mocks.createApp.mock.calls[0][0].jobs).toBeUndefined();
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
    expect(mocks.events.mock.calls).toEqual([["hub.session_started", {}]]);
    expect(mocks.order).toEqual(["http", "telemetry"]);
  });

  it("opens the setup wizard from launchHub when setup is incomplete", async () => {
    let ready!: (server: { origin: string; close: typeof mocks.closeServer }) => void;
    mocks.startServer.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
    const priorListeners = new Set(process.listeners("SIGTERM"));
    const running = launchHub({ openBrowser: false });
    await vi.waitFor(() => expect(mocks.startServer).toHaveBeenCalledOnce());
    expect(mocks.findConfig).not.toHaveBeenCalled();
    expect(mocks.createSetup).toHaveBeenCalledWith("/Users/private/project");
    ready({ origin: "http://127.0.0.1:48123", close: mocks.closeServer });
    await vi.waitFor(() => expect(mocks.events).toHaveBeenCalledOnce());
    const stop = process.listeners("SIGTERM").find((listener) => !priorListeners.has(listener));
    if (!stop) throw new Error("Hub did not install its shutdown handler.");
    stop("SIGTERM");
    await running;
  });
});
