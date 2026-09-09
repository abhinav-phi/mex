import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GRAPH_CORPUS_LIMITS } from "../corpus-policy.js";
import { rebuildGraph } from "../maintenance.js";
import { inspectGraphStatus } from "../status.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-publish-gaps-"));
  roots.push(root);
  return root;
}

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, "utf8");
}

/** A syntactically valid module far above the per-file ceiling. */
function oversizedModule(): string {
  const filler = `// ${"x".repeat(120)}\n`;
  return "export const oversized = true;\n"
    + filler.repeat(Math.ceil(GRAPH_CORPUS_LIMITS.maxSourceFileBytes / filler.length) + 1);
}

describe("publishing a candidate with known gaps", () => {
  it("publishes a graph when one file was skipped by the corpus policy", async () => {
    const root = temporaryRoot();
    write(root, "src/alpha.ts", "export function alpha(): number {\n  return beta();\n}\n");
    write(root, "src/beta.ts", "export function beta(): number {\n  return 1;\n}\n");
    write(root, "src/generated.ts", oversizedModule());

    const result = await rebuildGraph(root, {});

    // The gap is real and reported, and every other file still reaches a graph.
    expect(result.filesIndexed).toBe(2);
    expect(result.skipped).toEqual([expect.objectContaining({
      filePath: "src/generated.ts",
      reason: "corpus-limit",
      limit: "maxSourceFileBytes",
    })]);
    const status = await inspectGraphStatus({ projectRoot: root });
    expect(status.status).not.toBe("missing");
    expect(status.changes.total).toBe(0);
  }, 60_000);

});
