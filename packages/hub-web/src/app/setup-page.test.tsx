import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import type { SetupRun, SetupStartRequest, SetupStatus } from "../api/types";
import { AppRoutes } from "./App";

const status: SetupStatus = {
  projectName: "demo",
  hasGit: true,
  hasScaffold: false,
  populated: false,
  graphReady: false,
  wikiReady: false,
  state: "existing",
  stage: "needs_setup",
  configuredTools: [],
  tools: [
    { id: "claude", name: "Claude Code", selected: false, cliAvailable: false },
    { id: "cursor", name: "Cursor", selected: false, cliAvailable: false },
    { id: "codex", name: "Codex", selected: false, cliAvailable: false },
    { id: "windsurf", name: "Windsurf", selected: false, cliAvailable: false },
    { id: "copilot", name: "Copilot", selected: false, cliAvailable: false },
    { id: "opencode", name: "OpenCode", selected: false, cliAvailable: false },
  ],
  ready: false,
};

const idleRun: SetupRun = {
  status: "idle",
  stage: "needs_setup",
  populated: false,
  ready: false,
  selectedTools: [],
  prompt: null,
  populationTool: null,
  populationCompleted: false,
  commitCommands: [],
  anchorNotes: [],
  message: "MEX is not set up in this checkout yet.",
  progress: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

function renderSetup(api: HubApi) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={["/"]}>
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
}

describe("Hub setup wizard", () => {
  it("keeps the populated fixture on the ordinary Hub shell", async () => {
    renderSetup(createFixtureApi());
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1, name: "Set up MEX" })).toBeNull();
  });

  it("walks detect, tool choice, start, population, then opens the Project Hub", async () => {
    const user = userEvent.setup();
    let currentStatus: SetupStatus = status;
    let run: SetupRun = idleRun;
    const startSetup = vi.fn(async (request: SetupStartRequest) => {
      if (request.confirmPopulation) {
        currentStatus = {
          ...currentStatus,
          hasScaffold: true,
          populated: true,
          graphReady: true,
          wikiReady: true,
          stage: "ready",
          ready: true,
        };
        run = {
          ...run,
          status: "succeeded",
          stage: "ready",
          populated: true,
          ready: true,
          prompt: null,
          commitCommands: ["git add .mex", 'git commit -m "chore: initialize MEX"'],
          message: "Graph and Wiki are ready. Review and commit the canonical MEX setup.",
        };
        return run;
      }
      run = {
        ...idleRun,
        status: "running",
        selectedTools: request.tools,
        message: "Starting MEX setup…",
        progress: { step: "detect", label: "Detect project state" },
        startedAt: "2026-09-10T10:00:00.000Z",
      };
      return run;
    });
    const api = Object.assign(createFixtureApi(), {
      getSetupStatus: async () => currentStatus,
      getSetupRun: async () => run,
      startSetup,
      subscribeToSetup(onSnapshot: (next: SetupRun) => void) {
        run = {
          ...run,
          status: "paused",
          stage: "needs_population",
          prompt: "Populate ROUTER.md and AGENTS.md from this repository.",
          message: "Setup paused at population.",
          progress: { step: "population", label: "Populate the scaffold" },
          finishedAt: "2026-09-10T10:00:01.000Z",
        };
        onSnapshot(run);
        return { close() {} };
      },
    });

    renderSetup(api);
    expect(await screen.findByRole("heading", { level: 1, name: "Build a Hub for this checkout" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.getByText(/Setup gives/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Set up this project" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Set up MEX" })).toBeVisible();

    await user.click(screen.getByRole("checkbox", { name: /Cursor/ }));
    await user.click(screen.getByRole("button", { name: "Start setup" }));
    expect(startSetup).toHaveBeenCalledWith({ mode: "code-repo", tools: ["cursor"] });
    expect(await screen.findByText("Populate the scaffold")).toBeVisible();
    expect(screen.getByLabelText("Population prompt")).toHaveValue(
      "Populate ROUTER.md and AGENTS.md from this repository.",
    );

    await user.click(screen.getByRole("button", { name: "I've populated the scaffold" }));
    expect(startSetup).toHaveBeenLastCalledWith({
      mode: "code-repo",
      tools: ["cursor"],
      confirmPopulation: true,
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1, name: "Set up MEX" })).toBeNull();
    expect(screen.queryByText("Restart")).toBeNull();
  });

  it("opens the Project Hub when setup is already ready", async () => {
    const api = Object.assign(createFixtureApi(), {
      getSetupStatus: async () => ({
        ...status,
        hasScaffold: true,
        populated: true,
        graphReady: true,
        wikiReady: true,
        stage: "ready" as const,
        ready: true,
      }),
    });
    renderSetup(api);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1, name: "Set up MEX" })).toBeNull();
  });

  it("waits to open the Project Hub until Graph workbenches are available", async () => {
    const fixture = createFixtureApi();
    const getCapabilities = fixture.getCapabilities.bind(fixture);
    const unavailable = { availability: "unavailable" as const, reason: "Finish MEX setup before using this Hub workbench." };
    const api = Object.assign(fixture, {
      getSetupStatus: async () => ({
        ...status,
        hasScaffold: true,
        populated: true,
        graphReady: true,
        wikiReady: true,
        stage: "ready" as const,
        ready: true,
      }),
      async getCapabilities() {
        const caps = await getCapabilities();
        return {
          ...caps,
          graph: { read: unavailable, refresh: unavailable, rebuild: unavailable },
          wiki: { read: unavailable, refresh: unavailable, rebuild: unavailable },
        };
      },
    });
    renderSetup(api);
    expect(await screen.findByText("Setup finished. Switching this session to the Project Hub.", undefined, { timeout: 5_000 })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Opening the Project Hub" })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1, name: "Overview" })).toBeNull();
  });

  it("asks for git init on code-repo setup and does not start without a repository", async () => {
    const user = userEvent.setup();
    const startSetup = vi.fn(async () => idleRun);
    const api = Object.assign(createFixtureApi(), {
      getSetupStatus: async () => ({ ...status, hasGit: false, stage: "needs_git" as const }),
      getSetupRun: async () => idleRun,
      startSetup,
    });
    renderSetup(api);
    expect(await screen.findByRole("heading", { level: 1, name: "Build a Hub for this checkout" }, { timeout: 5_000 })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Set up this project" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Git repository required" })).toBeVisible();
    expect(screen.getAllByText("git init").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Start setup" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Agent memory/ }));
    expect(screen.getByRole("button", { name: "Start setup" })).toBeEnabled();
    expect(startSetup).not.toHaveBeenCalled();
  });
});
