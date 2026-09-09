import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspectQueue, runBoundedProcess, startLocalIngestion, summarizeSamples, telemetryPreloadSource } from "./benchmark-telemetry.mjs";

const requestFixture = `
import { request } from 'node:https';
const req = request('https://us.i.posthog.com/batch/', {method:'POST',agent:false,headers:{'content-type':'application/json'}}, (response) => response.resume());
req.on('error', () => {});
req.setTimeout(500, () => req.destroy(new Error('Fixture request timeout')));
req.end(JSON.stringify({batch:[{event:'command_finished',properties:{command:'commands',outcome:'success'}}]}));
`;
const fetchFixture = `
try {
  await fetch('https://us.i.posthog.com/batch/', {method:'POST',signal:AbortSignal.timeout(500),headers:{'content-type':'application/json'},body:JSON.stringify({batch:[{event:'command_run',properties:{command:'commands'}}]})});
} catch {}
`;

describe("isolated telemetry benchmark", () => {
  it("counts a received but unacknowledged queued UUID only once", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-harness-test-"));
    try {
      const directory = join(workspace, ".mex", "telemetry");
      mkdirSync(directory, { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(join(directory, "outbox.db"));
      const uuid = "9fef46b1-cb38-4fda-a166-a6f2395d4c14";
      try {
        database.exec("CREATE TABLE events(uuid TEXT,payload TEXT,lease_until INTEGER)");
        database.prepare("INSERT INTO events VALUES(?,?,0)").run(uuid, JSON.stringify({ uuid, event: "cli.command_completed", properties: { outcome: "success" } }));
      } finally { database.close(); }
      const state = await inspectQueue(workspace, new Map([[uuid, "cli.command_completed:success"]]));
      assert.equal(state.events, 1);
      assert.deepEqual(state.eventCounts, { "cli.command_completed:success": 1 });
      assert.deepEqual(state.receivedOrQueuedEventCounts, { "cli.command_completed:success": 1 });
      assert.equal(JSON.stringify(state).includes(uuid), false);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it("redirects real HTTPS requests to loopback and leaves no socket after healthy, refused or hanging runs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-harness-test-"));
    const ingestion = await startLocalIngestion();
    try {
      const fixture = join(workspace, "fixture.mjs");
      const preload = join(workspace, "preload.mjs");
      const refused = await startLocalIngestion();
      const refusedEndpoint = refused.endpoint;
      await refused.close();
      for (const source of [requestFixture, fetchFixture]) for (const mode of ["healthy", "refused", "hanging"]) {
        writeFileSync(fixture, source);
        writeFileSync(preload, telemetryPreloadSource(mode === "refused" ? refusedEndpoint : ingestion.endpoint));
        const received = ingestion.begin(mode);
        const result = await runBoundedProcess({ cli: fixture, args: [], preload, cwd: workspace, env: { ...process.env, NODE_OPTIONS: "" } });
        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
        assert.equal(result.diagnostics.redirected, 1);
        assert.equal(result.diagnostics.blocked, 0);
        assert.equal(result.diagnostics.requestErrors, mode === "healthy" ? 0 : 1);
        assert.equal(received.requests, mode === "refused" ? 0 : 1);
        assert.equal(received.invalidBodies, 0);
        assert.equal(await ingestion.finish(), 0);
      }
    } finally { await ingestion.close(); rmSync(workspace, { recursive: true, force: true }); }
  });

  it("fails closed for another destination and rejects non-loopback harness endpoints", async () => {
    assert.throws(() => telemetryPreloadSource("https://us.i.posthog.com/batch/"), /loopback/u);
    assert.throws(() => telemetryPreloadSource("http://127.0.0.1:1234/other/"), /loopback/u);
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-harness-test-"));
    try {
      const preload = join(workspace, "preload.mjs");
      const fixture = join(workspace, "fixture.mjs");
      writeFileSync(preload, telemetryPreloadSource("http://127.0.0.1:1/batch/"));
      for (const source of [
        "import {request} from 'node:https'; request('https://example.invalid/');",
        "import net from 'node:net'; net.connect({host:'203.0.113.1',port:443});",
        "import {Resolver} from 'node:dns'; new Resolver().resolve4('example.invalid',()=>{});",
        "import dgram from 'node:dgram'; dgram.createSocket('udp4').send('blocked',1234,'203.0.113.1');",
      ]) {
        writeFileSync(fixture, source);
        await assert.rejects(runBoundedProcess({ cli: fixture, args: [], preload, cwd: workspace, env: { ...process.env, NODE_OPTIONS: "" } }), /unexpected outbound/u);
      }
      writeFileSync(fixture, "const response=await fetch('data:application/octet-stream;base64,AGFzbQ==');if((await response.arrayBuffer()).byteLength!==4)process.exitCode=1;");
      const embedded = await runBoundedProcess({ cli: fixture, args: [], preload, cwd: workspace, env: { ...process.env, NODE_OPTIONS: "" } });
      assert.equal(embedded.code, 0);
      assert.equal(embedded.diagnostics.blocked, 0);
      assert.equal(embedded.diagnostics.redirected, 0);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it("bounds child lifetime without turning a killed process into a measurement", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mex-telemetry-harness-test-"));
    try {
      const preload = join(workspace, "preload.mjs");
      const fixture = join(workspace, "fixture.mjs");
      writeFileSync(preload, telemetryPreloadSource("http://127.0.0.1:1/batch/"));
      writeFileSync(fixture, "setInterval(() => {},1000);");
      await assert.rejects(runBoundedProcess({ cli: fixture, args: [], preload, cwd: workspace, env: { ...process.env, NODE_OPTIONS: "" }, timeoutMs: 150 }), /bounded lifetime/u);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
    assert.deepEqual(summarizeSamples([-1, 0, 4, 2]), { samples: [-1, 0, 4, 2], p50: 0, p95: 4, min: -1, max: 4 });
  });
});
