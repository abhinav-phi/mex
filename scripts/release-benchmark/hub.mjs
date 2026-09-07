import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const MAX_CHILD_OUTPUT_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HUB_START_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 180_000;
const PROCESS_SAMPLE_INTERVAL_MS = 10;
const IDLE_WINDOW_MS = 2_000;
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "interrupted"]);
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

export async function startHub({
  projectRoot,
  cliPath,
  environment,
  startupTimeoutMs = HUB_START_TIMEOUT_MS,
}) {
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > HUB_START_TIMEOUT_MS) {
    throw new Error(`Hub startup timeout must be between 1 and ${HUB_START_TIMEOUT_MS} milliseconds.`);
  }
  const startedAt = performance.now();
  const child = spawn(process.execPath, [cliPath, "hub", "--no-open"], {
    cwd: projectRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => {
    const next = current + chunk.toString("utf8");
    return next.length <= MAX_CHILD_OUTPUT_BYTES ? next : next.slice(-MAX_CHILD_OUTPUT_BYTES);
  };

  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      rejectAfterTermination(new Error(`Timed out waiting for Hub readiness: ${bounded(stderr || stdout)}`));
    }, startupTimeoutMs);
    const onStdout = (chunk) => {
      stdout = append(stdout, chunk);
      const match = stdout.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/u);
      if (!match || settled) return;
      settled = true;
      cleanup();
      resolve({ bootstrapUrl: match[0], readyMs: performance.now() - startedAt });
    };
    const onStderr = (chunk) => { stderr = append(stderr, chunk); };
    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Hub exited before readiness (${String(code ?? signal)}): ${bounded(stderr || stdout)}`));
    };
    const onError = (error) => {
      rejectAfterTermination(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const rejectAfterTermination = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        reject(error);
        return;
      }
      void stopHub(child).catch(() => undefined).finally(() => reject(error));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  // Readiness parsing no longer needs the streams, but leaving them paused can
  // eventually back-pressure a maintenance-heavy benchmark run.
  child.stdout?.resume();
  child.stderr?.resume();
  return {
    child,
    projectRoot,
    origin: new URL(ready.bootstrapUrl).origin,
    bootstrapUrl: ready.bootstrapUrl,
    readyMs: ready.readyMs,
    close: () => stopHub(child),
  };
}

export async function authenticateHub(server) {
  const url = new URL(server.bootstrapUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("Hub readiness output omitted its bootstrap token.");
  const response = await fetch(`${server.origin}/api/v1/session/bootstrap`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", origin: server.origin },
    body: JSON.stringify({ token }),
  });
  const body = await boundedJson(response, "Hub bootstrap");
  if (response.status !== 201 || typeof body.expiresAt !== "string") {
    throw new Error(`Hub bootstrap failed with HTTP ${response.status}.`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Hub bootstrap did not set a session cookie.");
  const session = await hubJson(server, "/api/v1/session", { cookie });
  if (typeof session.csrfToken !== "string") throw new Error("Hub session omitted its CSRF token.");
  return { cookie, csrfToken: session.csrfToken };
}

export async function measureIdleProcess(server) {
  const initialRss = readProcessRssBytes(server.child.pid);
  const initialCpu = readProcessCpuMs(server.child.pid);
  let peakRss = initialRss;
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, readProcessRssBytes(server.child.pid));
  }, PROCESS_SAMPLE_INTERVAL_MS);
  try {
    await delay(IDLE_WINDOW_MS);
  } finally {
    clearInterval(timer);
  }
  const finalRss = readProcessRssBytes(server.child.pid);
  const finalCpu = readProcessCpuMs(server.child.pid);
  return {
    rssBytes: Math.max(initialRss, finalRss, peakRss),
    cpuMs: Math.max(0, finalCpu - initialCpu),
    windowMs: IDLE_WINDOW_MS,
  };
}

export async function measureCommonReads(server, auth, samples, teamFixture) {
  const warmSearch = await hubJson(
    server,
    "/api/v1/search?q=releaseBenchmarkNeedle&limit=25",
    auth,
  );
  const symbol = warmSearch.groups?.symbols?.items?.[0];
  if (typeof symbol?.id !== "string") {
    throw new Error("The benchmark Graph fixture did not produce a searchable symbol.");
  }
  const paths = releaseCommonReadPaths(symbol.id);
  await hubJson(server, paths.code, auth);
  await hubJson(server, paths.knowledge, auth);
  await hubJson(server, paths.activity, auth);
  const warmInboxDrafts = await hubJson(server, "/api/v1/inbox/drafts?limit=25", auth);
  const warmInboxProposals = await hubJson(
    server,
    "/api/v1/inbox/proposals?state=pending,stale&limit=25",
    auth,
  );
  assertInboxFixturePage(warmInboxDrafts, {
    kind: "draft",
    id: teamFixture.inboxDraftId,
    title: teamFixture.inboxDraftTitle,
  });
  assertInboxFixturePage(warmInboxProposals, {
    kind: "proposal",
    id: teamFixture.inboxProposalId,
    title: teamFixture.inboxProposalTitle,
  });
  const warmRelayDrafts = await hubJson(server, "/api/v1/relays/drafts?limit=25", auth);
  const warmRelays = await hubJson(
    server,
    "/api/v1/relays?perspective=mine&state=published,acknowledged&limit=25",
    auth,
  );
  assertRelayFixturePage(warmRelayDrafts, {
    kind: "draft",
    id: teamFixture.relayDraftId,
    summary: teamFixture.relayDraftSummary,
  });
  assertRelayFixturePage(warmRelays, {
    kind: "relay",
    id: teamFixture.relayId,
    summary: teamFixture.relaySummary,
  });

  const timings = Object.fromEntries(Object.keys(paths).map((name) => [name, []]));
  for (let sample = 0; sample < samples; sample += 1) {
    for (const [name, path] of Object.entries(paths)) {
      const startedAt = performance.now();
      await hubJson(server, path, auth);
      timings[name].push(performance.now() - startedAt);
    }
  }
  return { timings, codeSymbolId: symbol.id };
}

export function releaseCommonReadPaths(codeSymbolId) {
  return {
    search: "/api/v1/search?q=releaseBenchmarkNeedle&limit=25",
    code: `/api/v1/code/symbols/${encodeURIComponent(codeSymbolId)}?view=overview`,
    knowledge: "/api/v1/wiki/graph",
    activity: "/api/v1/activity?limit=25",
    inboxDrafts: "/api/v1/inbox/drafts?limit=25",
    inboxProposals: "/api/v1/inbox/proposals?state=pending,stale&limit=25",
    relayDrafts: "/api/v1/relays/drafts?limit=25",
    relays: "/api/v1/relays?perspective=mine&state=published,acknowledged&limit=25",
  };
}

export function assertInboxFixturePage(page, expected) {
  if (
    !page
    || !Array.isArray(page.items)
    || page.items.length !== 1
    || page.nextCursor !== null
    || page.truncated !== false
    || page.sourceTruncated !== false
    || !REVISION_PATTERN.test(page.deterministicRevision)
    || !Array.isArray(page.diagnostics)
    || page.diagnostics.length !== 0
    || page.diagnosticsTruncated !== false
  ) {
    throw new Error(
      `The benchmark Inbox ${expected.kind} list did not return its exact complete diagnostic-free one-item page.`,
    );
  }
  const item = page.items[0];
  const id = expected.kind === "proposal" ? item?.ref?.id : item?.id;
  if (id !== expected.id || item?.title !== expected.title) {
    throw new Error(`The benchmark Inbox ${expected.kind} list returned unexpected fixture content.`);
  }
  if (expected.kind === "proposal" && item?.state !== "pending") {
    throw new Error("The benchmark Inbox proposal is not pending.");
  }
}

export function assertRelayFixturePage(page, expected) {
  if (
    !page
    || !Array.isArray(page.items)
    || page.items.length !== 1
    || page.nextCursor !== null
    || page.truncated !== false
    || page.sourceTruncated !== false
    || !REVISION_PATTERN.test(page.deterministicRevision)
    || !Array.isArray(page.diagnostics)
    || page.diagnostics.length !== 0
    || page.diagnosticsTruncated !== false
  ) {
    throw new Error(
      `The benchmark Relay ${expected.kind} list did not return its exact complete diagnostic-free one-item page.`,
    );
  }
  const item = page.items[0];
  const id = expected.kind === "relay" ? item?.ref?.id : item?.id;
  if (id !== expected.id || item?.summary !== expected.summary) {
    throw new Error(`The benchmark Relay ${expected.kind} list returned unexpected fixture content.`);
  }
  if (expected.kind === "relay") {
    if (item?.state !== "published") {
      throw new Error("The benchmark Relay is not published.");
    }
    if (
      item?.schemaVersion !== 3
      || item?.workstream !== null
      || item?.publishedRepoState?.branch !== "benchmark"
      || item?.publishedRepoState?.head !== null
      || item?.publishedRepoState?.dirty !== false
      || item?.publishedRepoState?.observedAt !== "2026-08-01T00:00:00.000Z"
    ) {
      throw new Error(
        "The benchmark Relay is not the expected standalone schema-v3 publication.",
      );
    }
  }
}

export async function measureMaintenance({
  server,
  auth,
  timingSamples,
  memorySamples,
  beforeGraphRefresh,
  beforeWikiRefresh,
}) {
  const output = {};
  for (const kind of ["graph_refresh", "graph_rebuild", "wiki_refresh", "wiki_rebuild"]) {
    const elapsedMs = [];
    const peakRssBytes = [];
    for (let sample = 0; sample < timingSamples; sample += 1) {
      if (kind === "graph_refresh") beforeGraphRefresh();
      if (kind === "wiki_refresh") beforeWikiRefresh();
      const measured = await runMaintenanceJob(server, auth, kind);
      elapsedMs.push(measured.elapsedMs);
      if (sample < memorySamples) peakRssBytes.push(measured.peakRssBytes);
    }
    output[kind] = { elapsedMs, peakRssBytes };
  }
  return output;
}

export async function hubJson(server, path, auth, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json, application/problem+json");
  if (auth?.cookie) headers.set("cookie", auth.cookie);
  const response = await fetch(`${server.origin}${path}`, {
    ...init,
    headers,
    redirect: "error",
  });
  const body = await boundedJson(response, path);
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${bounded(JSON.stringify(body))}`);
  }
  return body;
}

export function readProcessRssBytes(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Cannot sample a process without a PID.");
  if (process.platform === "linux") {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu);
    if (!match) throw new Error(`Could not read VmRSS for process ${pid}.`);
    return Number(match[1]) * 1024;
  }
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const kib = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(kib)) throw new Error(`Could not sample RSS for process ${pid}.`);
  return kib * 1024;
}

export function readProcessCpuMs(pid) {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    const ticks = Number(fields[11]) + Number(fields[12]);
    if (!Number.isFinite(ticks)) throw new Error(`Could not read CPU ticks for process ${pid}.`);
    return ticks * 1_000 / clockTicksPerSecond();
  }
  const result = spawnSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not sample CPU time for process ${pid}.`);
  return parsePsCpuTime(result.stdout.trim());
}

async function runMaintenanceJob(server, auth, kind) {
  const baselineRss = readProcessRssBytes(server.child.pid);
  let peakRss = baselineRss;
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, readProcessRssBytes(server.child.pid));
  }, PROCESS_SAMPLE_INTERVAL_MS);
  const startedAt = performance.now();
  try {
    const job = await hubJson(server, "/api/v1/jobs", auth, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.origin,
        "x-mex-csrf": auth.csrfToken,
      },
      body: JSON.stringify({ kind }),
    });
    if (typeof job.id !== "string") throw new Error(`${kind} did not return a job ID.`);
    let terminal = job;
    const deadline = performance.now() + JOB_TIMEOUT_MS;
    while (!TERMINAL_JOB_STATES.has(terminal.state)) {
      if (performance.now() >= deadline) throw new Error(`${kind} did not settle within ${JOB_TIMEOUT_MS} ms.`);
      await delay(20);
      terminal = await hubJson(server, `/api/v1/jobs/${encodeURIComponent(job.id)}`, auth);
    }
    if (terminal.state !== "succeeded") {
      throw new Error(`${kind} settled as ${String(terminal.state)} (${String(terminal.problem?.code ?? "unknown")}).`);
    }
    return {
      elapsedMs: performance.now() - startedAt,
      peakRssBytes: Math.max(peakRss, readProcessRssBytes(server.child.pid)),
    };
  } finally {
    clearInterval(timer);
  }
}

async function boundedJson(response, label) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} exceeded the ${MAX_RESPONSE_BYTES}-byte benchmark response bound.`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function stopHub(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Hub did not stop within eight seconds."));
    }, 8_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let cachedClockTicks;
function clockTicksPerSecond() {
  if (cachedClockTicks !== undefined) return cachedClockTicks;
  const result = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const value = Number(result.stdout.trim());
  cachedClockTicks = result.status === 0 && Number.isFinite(value) && value > 0 ? value : 100;
  return cachedClockTicks;
}

function parsePsCpuTime(value) {
  const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u);
  if (!match) throw new Error(`Could not parse process CPU time: ${value}`);
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

function bounded(value) {
  const text = String(value ?? "").trim();
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}…`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
