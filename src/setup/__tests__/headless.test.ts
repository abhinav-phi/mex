import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectSetupStatus, runHeadlessSetup } from "../headless.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { /* Windows can hold a sqlite handle briefly. */ }
  }
});

describe("headless setup status", () => {
  it("asks for git before code-repo setup in a folder with no repository", () => {
    const root = fixture();
    expect(inspectSetupStatus(root).stage).toBe("needs_git");
    expect(inspectSetupStatus(root).ready).toBe(false);
  });

  it("asks for setup in a git repo without a scaffold", () => {
    const root = gitRepo();
    expect(inspectSetupStatus(root)).toMatchObject({
      hasGit: true,
      hasScaffold: false,
      stage: "needs_setup",
      ready: false,
    });
  });
});

describe("headless setup run", () => {
  it("writes the same scaffold files as CLI setup and pauses at population", async () => {
    const root = fixture();
    const result = await runHeadlessSetup({
      projectRoot: root,
      mode: "agent-memory",
      tools: ["cursor"],
    });

    expect(result.stage).toBe("needs_population");
    expect(result.populated).toBe(false);
    expect(result.prompt).toEqual(expect.any(String));
    expect(result.prompt?.length).toBeGreaterThan(20);
    expect(existsSync(join(root, ".mex", "ROUTER.md"))).toBe(true);
    expect(existsSync(join(root, ".mex", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(root, ".mex", "HEARTBEAT.md"))).toBe(true);
    expect(existsSync(join(root, ".cursorrules"))).toBe(true);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-headless-setup-"));
  roots.push(root);
  return root;
}

function gitRepo(): string {
  const root = fixture();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "setup@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Setup"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const ready = true;\n");
  return root;
}
