import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../engine-impl.js";
import type { GraphEngine } from "../engine.js";

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-csharp-graph-"));
  writeFileSync(join(root, "sample.cs"), `
namespace Example;
class A : B {
  void Start(B other) { other.Run(); base.Run(); StaticB.Run(); GetOther().Run(); }
  B GetOther() => new B();
  void Local() { Run(); this.Run(); this . Run(); this /* comment */.Run(); }
  void Run() {}
  static int Init() => 1;
  int value = Init();
  public int this[int index] => Init();
}
class B { public void Run() {} }
class StaticB { public static void Run() {} }
class C : B { void LocalShadow() { void Run() {} this.Run(); } }
interface IRoot {}
interface IChild : IRoot {}
`);
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

function symbol(qualifiedName: string) {
  const matches = engine.searchNodes(qualifiedName).filter((node) => node.qualifiedName === qualifiedName);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("C# graph persistence and resolution", () => {
  it("indexes file-scoped declarations once with their namespace", () => {
    expect(engine.searchNodes("Run").filter((node) => node.name === "Run")
      .map((node) => node.qualifiedName).sort())
      .toEqual(["Example.A.Run", "Example.B.Run", "Example.C.LocalShadow.Run", "Example.StaticB.Run"]);
  });

  it("keeps unproven receivers unresolved despite same-named lexical methods", () => {
    const caller = symbol("Example.A.Start");
    expect(engine.getCallees(caller.id).map((node) => node.qualifiedName))
      .toEqual(["Example.A.GetOther"]);
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(db.prepare(`
        SELECT reference_name, receiver, status, target_id, confidence
        FROM unresolved_refs WHERE from_node_id = ? AND reference_name LIKE '%.Run'
        ORDER BY reference_name
      `).all(caller.id)).toEqual([
        { reference_name: "GetOther().Run", receiver: "GetOther()", status: "unresolved", target_id: null, confidence: 0 },
        { reference_name: "StaticB.Run", receiver: "StaticB", status: "unresolved", target_id: null, confidence: 0 },
        { reference_name: "base.Run", receiver: "base", status: "unresolved", target_id: null, confidence: 0 },
        { reference_name: "other.Run", receiver: "other", status: "unresolved", target_id: null, confidence: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("still resolves unqualified and this calls in the lexical type", () => {
    const target = symbol("Example.A.Run");
    const calls = engine.getOutgoing(symbol("Example.A.Local").id, ["calls"]);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.node.id).toBe(target.id);
      expect(call.edge).toMatchObject({ resolutionMethod: "lexical-scope", confidence: 1 });
    }
  });

  it("does not bind an explicit this receiver to a shadowing local function", () => {
    expect(engine.getCallees(symbol("Example.C.LocalShadow").id)).toEqual([]);
  });

  it("resolves field initializer and indexer calls from their owning symbols", () => {
    for (const owner of ["Example.A.value", "Example.A.this"]) {
      expect(engine.getCallees(symbol(owner).id).map((node) => node.qualifiedName))
        .toEqual(["Example.A.Init"]);
    }
  });

  it("persists interface inheritance as extends", () => {
    const child = symbol("Example.IChild");
    expect(engine.getOutgoing(child.id, ["extends"]).map((neighbor) => neighbor.node.id))
      .toEqual([symbol("Example.IRoot").id]);
    expect(engine.getOutgoing(child.id, ["implements"])).toEqual([]);
  });
});
