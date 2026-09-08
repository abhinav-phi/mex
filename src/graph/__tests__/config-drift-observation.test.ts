import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../engine-impl.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  serializeGraphSnapshot,
  type GraphSnapshot,
} from "../snapshot.js";
import { inspectGraphStatusWithFreshObservation } from "../status.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-config-drift-"));
  roots.push(root);
  write(root, "package.json", JSON.stringify({ name: "fixture", dependencies: { dep: "1.0.0" } }));
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
  write(root, "src/a.ts", "export function alpha(): number {\n  return beta();\n}\n"
    + "export function beta(): number {\n  return 1;\n}\n");
  const engine = createGraphEngine({ rootDir: root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
  return root;
}

async function inspect(root: string) {
  return inspectGraphStatusWithFreshObservation({ projectRoot: root, now: NOW });
}

function bumpDependency(root: string): void {
  write(root, "package.json", JSON.stringify({ name: "fixture", dependencies: { dep: "1.0.1" } }));
}

function updateSnapshot(root: string, update: (snapshot: GraphSnapshot) => GraphSnapshot): void {
  const db = openSqlite(join(root, ".mex", "graph.db"));
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = ?")
      .get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
    const snapshot = parseGraphSnapshot(row.value);
    if (!snapshot) throw new Error("test fixture has no valid graph snapshot");
    db.prepare("UPDATE project_metadata SET value = ?, updated_at = ? WHERE key = ?")
      .run(serializeGraphSnapshot(update(snapshot)), NOW.getTime(), GRAPH_SNAPSHOT_METADATA_KEY);
  } finally {
    db.close();
  }
}

describe("config-drift read observation", () => {
  it("binds a fresh store as fresh and never as drifted", async () => {
    const root = await project();
    const inspection = await inspect(root);
    expect(inspection.graphStatus.status).toBe("fresh");
    expect(inspection.freshObservation).not.toBeNull();
    expect(inspection.configDriftObservation ?? null).toBeNull();
  });

  it("binds a store whose only drift is config content", async () => {
    const root = await project();
    bumpDependency(root);
    const inspection = await inspect(root);
    expect(inspection.graphStatus.status).toBe("stale");
    expect(inspection.graphStatus.changes).toMatchObject({
      total: 0,
      configChanged: true,
      manifestChanged: true,
      grammarChanged: false,
      branchChanged: false,
    });
    expect(inspection.freshObservation).toBeNull();
    const token = inspection.configDriftObservation;
    expect(token).not.toBeNull();
    expect(token!.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseGraphSnapshot(token!.snapshotRaw)).not.toBeNull();
  });

  it("is deterministic across repeated inspections of one drifted store", async () => {
    const root = await project();
    bumpDependency(root);
    const first = await inspect(root);
    const second = await inspect(root);
    expect(second.configDriftObservation).toEqual(first.configDriftObservation);
  });

  it("refuses to bind when engine identity cannot be reproduced", async () => {
    const root = await project();
    bumpDependency(root);
    updateSnapshot(root, (snapshot) => ({ ...snapshot, manifestHash: "0".repeat(64) }));
    const inspection = await inspect(root);
    expect(inspection.graphStatus.status).toBe("stale");
    expect(inspection.graphStatus.changes.configChanged).toBe(true);
    expect(inspection.freshObservation).toBeNull();
    expect(inspection.configDriftObservation ?? null).toBeNull();
  });

  it("refuses to bind when the grammar also moved", async () => {
    const root = await project();
    bumpDependency(root);
    updateSnapshot(root, (snapshot) => ({ ...snapshot, grammarHash: "0".repeat(64) }));
    const inspection = await inspect(root);
    expect(inspection.graphStatus.changes.grammarChanged).toBe(true);
    expect(inspection.configDriftObservation ?? null).toBeNull();
  });

  it("refuses to bind when indexed source also drifted", async () => {
    const root = await project();
    bumpDependency(root);
    write(root, "src/a.ts", "export function alpha(): number {\n  return 2;\n}\n");
    const inspection = await inspect(root);
    expect(inspection.graphStatus.status).toBe("stale");
    expect(inspection.graphStatus.changes.total).toBeGreaterThan(0);
    expect(inspection.configDriftObservation ?? null).toBeNull();
  });

  it("refuses to bind when a new source file is not indexed", async () => {
    const root = await project();
    bumpDependency(root);
    write(root, "src/b.ts", "export const b = 1;\n");
    const inspection = await inspect(root);
    expect(inspection.configDriftObservation ?? null).toBeNull();
  });
});
