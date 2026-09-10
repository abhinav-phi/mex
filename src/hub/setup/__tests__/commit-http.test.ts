import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubApp, type HubSetupService } from "../../app.js";
import { HubHttpError } from "../../http/errors.js";
import { HubSessionManager } from "../../security/session.js";
import { createSetupHubServices } from "../services.js";

const ORIGIN = "http://127.0.0.1:48123";
const HOST = "127.0.0.1:48123";
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const revision = "00000000-0000-4000-8000-000000000192";
const preview = {
  revision, expiresAt: "2026-09-10T12:00:00.000Z", branch: "main", head: null,
  defaultMessage: "chore: initialize MEX", canCommit: true, blockedReason: null,
  files: [{ path: ".mex/config.json", status: "added" as const, diff: "+<script>literal review text</script>\n", truncated: false }],
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("setup commit HTTP boundary", () => {
  it.each(["/commit/preview", "/commit"])("protects %s with session, Host, Origin and CSRF", async (path) => {
    const f = fixture();
    const headers = await authenticate(f.app);
    const body = path === "/commit" ? JSON.stringify({ revision, message: "Initialize MEX" }) : "{}";
    const noCsrf = { ...headers }; delete noCsrf["x-mex-csrf"];
    const noCookie = { ...headers }; delete noCookie.cookie;
    for (const [input, expected] of [
      [noCookie, 401], [noCsrf, 403], [{ ...headers, host: "example.com" }, 400],
      [{ ...headers, origin: "https://example.com" }, 403],
    ] as const) {
      const response = await f.app.request(`${ORIGIN}/api/v1/setup${path}`, { method: "POST", headers: input, body });
      expect(response.status).toBe(expected);
    }
    expect(f.previewCommit).not.toHaveBeenCalled();
    expect(f.commitSetup).not.toHaveBeenCalled();
  });

  it("rejects extra queries, client file paths, invalid revisions and oversized messages before invoking Git", async () => {
    const f = fixture();
    const headers = await authenticate(f.app);
    for (const [path, body] of [
      ["/commit/preview?force=true", {}], ["/commit/preview", { files: ["README.md"] }],
      ["/commit", { revision: "old", message: "Commit" }],
      ["/commit", { revision, message: "Commit", files: ["README.md"] }],
      ["/commit", { revision, message: "x".repeat(2001) }],
      ["/commit?force=true", { revision, message: "Commit" }],
    ] as const) {
      const response = await f.app.request(`${ORIGIN}/api/v1/setup${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    expect(f.previewCommit).not.toHaveBeenCalled();
    expect(f.commitSetup).not.toHaveBeenCalled();
  });

  it("returns the exact bounded review and saves only the revision and message supplied by the reviewed action", async () => {
    const f = fixture();
    const headers = await authenticate(f.app);
    const reviewed = await f.app.request(`${ORIGIN}/api/v1/setup/commit/preview`, { method: "POST", headers, body: "{}" });
    expect(reviewed.status).toBe(200);
    expect(reviewed.headers.get("cache-control")).toContain("no-store");
    expect(await reviewed.json()).toEqual(preview);
    const committed = await f.app.request(`${ORIGIN}/api/v1/setup/commit`, { method: "POST", headers, body: JSON.stringify({ revision, message: "  Initialize MEX  " }) });
    expect(committed.status).toBe(200);
    expect(f.commitSetup).toHaveBeenCalledExactlyOnceWith({ revision, message: "Initialize MEX" });
    expect(await committed.json()).toMatchObject({ commit: "a".repeat(40), files: [".mex/config.json"] });
  });

  it("returns a stale-review conflict and keeps commit routes unavailable outside setup", async () => {
    const f = fixture();
    const headers = await authenticate(f.app);
    f.commitSetup.mockRejectedValueOnce(new HubHttpError(409, "REVISION_CONFLICT", "Setup review changed", "Refresh the setup review before committing."));
    const rejected = await f.app.request(`${ORIGIN}/api/v1/setup/commit`, { method: "POST", headers, body: JSON.stringify({ revision, message: "Commit" }) });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "REVISION_CONFLICT" });
    const full = fixture(false);
    const fullHeaders = await authenticate(full.app);
    const unavailable = await full.app.request(`${ORIGIN}/api/v1/setup/commit/preview`, { method: "POST", headers: fullHeaders, body: "{}" });
    expect(unavailable.status).toBe(503);
    expect(full.previewCommit).not.toHaveBeenCalled();
  });
});

function fixture(withSetup = true) {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-commit-http-")); roots.push(root);
  const base = createSetupHubServices(root);
  const previewCommit = vi.fn(async () => preview);
  const commitSetup = vi.fn(async (_request: unknown) => ({ commit: "a".repeat(40), files: [".mex/config.json"], message: "Setup files committed.", run: base.setup.snapshot() }));
  const setup: HubSetupService = {
    status: () => base.setup.status(), snapshot: () => base.setup.snapshot(),
    start: (request) => base.setup.start(request), cancel: () => base.setup.cancel(),
    subscribe: (listener) => base.setup.subscribe(listener), previewCommit, commitSetup,
  };
  let random = 20;
  const app = createHubApp({
    security: new HubSessionManager({ bootstrapToken: TOKEN, expectedOrigin: ORIGIN, random: (size) => new Uint8Array(size).fill(random++) }),
    services: base.services, ...(withSetup ? { setup } : {}),
  });
  return { app, previewCommit, commitSetup };
}

async function authenticate(app: ReturnType<typeof createHubApp>): Promise<Record<string, string>> {
  const bootstrap = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, {
    method: "POST", headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const response = await app.request(`${ORIGIN}/api/v1/session`, { headers: { host: HOST, cookie } });
  const { csrfToken } = await response.json() as { csrfToken: string };
  return { host: HOST, origin: ORIGIN, "content-type": "application/json", cookie, "x-mex-csrf": csrfToken };
}
