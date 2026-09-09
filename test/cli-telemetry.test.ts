import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createCliTelemetry, isTelemetryExemptCommand } from "../src/cli-telemetry.js";

describe("CLI invocation telemetry", () => {
  it("uses the registered namespaced command and excludes input and output", async () => {
    const capture = vi.fn();
    const flush = vi.fn(async () => {});
    let now = 100;
    const telemetry = createCliTelemetry(capture, flush, () => now);
    const root = new Command("mex");
    const command = root.command("wiki").command("query <text>").option("--json").action(() => { now = 137.9; });
    root.hook("preAction", (_, action) => telemetry.start(action));
    root.hook("postAction", () => telemetry.finish(0));
    await root.parseAsync(["wiki", "query", "private customer@example.com query", "--json"], { from: "user" });
    expect(command.args).toHaveLength(1);
    expect(capture.mock.calls).toEqual([
      ["cli.command_started", { command: "wiki.query", stage: "direct" }],
      ["cli.command_completed", { command: "wiki.query", stage: "direct", outcome: "success", duration_ms: 37 }],
    ]);
    await telemetry.finish(0);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("records a thrown action once during cleanup without capturing the error", async () => {
    const capture = vi.fn();
    const telemetry = createCliTelemetry(capture, async () => {}, () => 0);
    const root = new Command("mex");
    root.command("check").action(() => { throw new Error("secret path /Users/private"); });
    root.hook("preAction", (_, action) => telemetry.start(action));
    root.hook("postAction", () => telemetry.finish(0));
    await expect(root.parseAsync(["check"], { from: "user" })).rejects.toThrow();
    await telemetry.finish(1);
    await telemetry.finish(1);
    expect(capture.mock.calls).toEqual([
      ["cli.command_started", { command: "check", stage: "direct" }],
      ["cli.command_completed", { command: "check", stage: "direct", outcome: "failure", duration_ms: 0 }],
    ]);
  });

  it.each([
    [[], "preview"],
    [["--apply", "/private/receipt.json"], "apply"],
    [["--from", "/private/draft.json"], "direct"],
  ])("distinguishes Relay preview, approved apply, and quick local save: %j", async (args, stage) => {
    const capture = vi.fn();
    const telemetry = createCliTelemetry(capture, async () => {}, () => 0);
    const root = new Command("mex");
    root.command("relay").command("draft").command("save")
      .option("--apply <receipt>").option("--from <draft>").action(() => {});
    root.hook("preAction", (_, action) => telemetry.start(action));
    root.hook("postAction", () => telemetry.finish(0));
    await root.parseAsync(["relay", "draft", "save", ...args], { from: "user" });
    expect(capture.mock.calls[1]).toEqual(["cli.command_completed", {
      command: "relay.draft.save", stage, outcome: "success", duration_ms: 0,
    }]);
  });

  it.each(["capabilities", "logging", "timeline", "hub", "telemetry.inspect", "member.list", "inbox.contract", "relay.draft.show", "new-private-command"])(
    "keeps pure discovery, Hub bootstrap, meta and unknown commands silent: %s", async (path) => {
      const root = new Command("mex");
      const command = path.split(".").reduce((parent, name) => parent.command(name), root);
      const capture = vi.fn();
      const flush = vi.fn(async () => {});
      const telemetry = createCliTelemetry(capture, flush);
      telemetry.start(command);
      await telemetry.finish(0);
      expect(capture).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(isTelemetryExemptCommand(command.name(), command.parent?.name(), path)).toBe(true);
    },
  );

  it("preserves command behavior if capture or delivery fails", async () => {
    const root = new Command("mex");
    const command = root.command("commands");
    const telemetry = createCliTelemetry(() => { throw new Error("disk full"); }, async () => { throw new Error("offline"); });
    expect(() => telemetry.start(command)).not.toThrow();
    await expect(telemetry.finish(0)).resolves.toBeUndefined();
  });
});
