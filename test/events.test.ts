import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, runLog, readEvents, runTimeline } from "../src/events.js";
import type { MexConfig } from "../src/types.js";

let tmpDir: string;
let config: MexConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-events-"));
  mkdirSync(join(tmpDir, ".mex"), { recursive: true });
  config = { projectRoot: tmpDir, scaffoldRoot: join(tmpDir, ".mex"), aiTools: [] };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("events", () => {
  it("appends log entries as JSONL", async () => {
    await runLog(config, "captured a decision", { kind: "decision", files: ["ROUTER.md"] });
    const raw = readFileSync(join(tmpDir, ".mex/events/decisions.jsonl"), "utf-8").trim();
    const entry = JSON.parse(raw);
    expect(entry).toMatchObject({
      kind: "decision",
      message: "captured a decision",
      files: ["ROUTER.md"],
    });
  });

  it("round-trips source and status through appendEvent -> readEvents", () => {
    const written = appendEvent(config, "captured a call decision", {
      kind: "decision",
      source: "meeting",
      status: "decided",
    });
    expect(written).toMatchObject({ source: "meeting", status: "decided" });

    const [entry] = readEvents(config);
    expect(entry).toMatchObject({
      kind: "decision",
      message: "captured a call decision",
      source: "meeting",
      status: "decided",
    });
  });

  it("omits source and status when not provided (backward compatible)", () => {
    appendEvent(config, "plain note", {});
    const [entry] = readEvents(config);
    expect(entry).not.toHaveProperty("source");
    expect(entry).not.toHaveProperty("status");
  });

  it("reads valid events and skips malformed lines", () => {
    mkdirSync(join(tmpDir, ".mex/events"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".mex/events/decisions.jsonl"),
      `${JSON.stringify({ timestamp: "2026-05-14T00:00:00.000Z", kind: "note", message: "ok", files: [] })}\nnot-json\n`,
    );
    expect(readEvents(config)).toHaveLength(1);
  });

  it("bounds legacy timeline projection to the newest 10,000 records", () => {
    mkdirSync(join(tmpDir, ".mex/events"), { recursive: true });
    const lines = Array.from({ length: 10_001 }, (_, index) => JSON.stringify({
      timestamp: "2026-05-14T00:00:00.000Z",
      kind: "note",
      message: String(index),
      files: [],
    }));
    writeFileSync(join(tmpDir, ".mex/events/decisions.jsonl"), `${lines.join("\n")}\n`);

    const events = readEvents(config);
    expect(events).toHaveLength(10_000);
    expect(events[0]?.message).toBe("1");
    expect(events.at(-1)?.message).toBe("10000");
  });

  it("timeline can emit JSON", async () => {
    await runLog(config, "hello", {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, { json: true });
    expect(spy.mock.calls.at(-1)?.[0]).toContain('"events"');
  });

  it("timeline --format md emits a valid Markdown table (#55)", async () => {
    await runLog(config, "chose | the | bounded resolver", { kind: "decision", files: ["ROUTER.md"] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, { format: "md" });
    const lines = spy.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toBe("| Date | Type | Event | Files |");
    expect(lines[1]).toBe("|---|---|---|---|");
    const row = lines[2]!;
    expect(row).toMatch(/^\| \d{4}-\d{2}-\d{2} \| decision \| /);
    expect(row).toContain("chose \\| the \\| bounded resolver");
    expect(row).toContain("`ROUTER.md`");
  });

  it("timeline --format md emits a placeholder for an empty log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, { format: "md" });
    expect(spy.mock.calls.at(-1)?.[0]).toBe("_No events found._");
  });

  it("timeline default output is unchanged when --format is absent", async () => {
    await runLog(config, "plain note", { kind: "note" });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, {});
    const rendered = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(rendered).toContain("plain note");
    expect(rendered).not.toContain("|---");
  });
});
