import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEAM_ACCESS_FOLLOW_UP_SUBJECT,
  TEAM_ACCESS_SOURCE,
  TEAM_ACCESS_STORAGE_KEY,
  TEAM_ACCESS_SUBJECT,
  TEAM_ACCESS_SUBMIT_ERROR,
  WEB3FORMS_SUBMIT_URL,
  __setWeb3FormsAccessKeyForTests,
  buildTeamAccessContactPayload,
  buildTeamAccessFollowUpPayload,
  readTeamAccessState,
  submitTeamAccessPayload,
  validateTeamAccessContact,
  writeTeamAccessState,
} from "./team-access-lead";

afterEach(() => {
  __setWeb3FormsAccessKeyForTests(null);
  window.localStorage.removeItem(TEAM_ACCESS_STORAGE_KEY);
});

describe("team-access lead payloads", () => {
  it("builds a closed contact payload without repo or machine fields", () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const payload = buildTeamAccessContactPayload({
      name: "  Ada Lovelace  ",
      email: " ada@example.com ",
    });

    expect(payload).toEqual({
      access_key: "public-test-key",
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: TEAM_ACCESS_SUBJECT,
      from_name: "mex Hub",
      source: TEAM_ACCESS_SOURCE,
    });
    expect(Object.keys(payload).sort()).toEqual([
      "access_key",
      "email",
      "from_name",
      "name",
      "source",
      "subject",
    ]);
  });

  it("omits empty optional follow-up fields and keeps the same contact identity", () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const payload = buildTeamAccessFollowUpPayload({
      name: "Ada Lovelace",
      email: "ada@example.com",
      company: "  ",
      teamSize: "",
      foundMex: "",
      installReason: "",
      repoKind: "",
      othersUseAgents: "",
      need: "",
      missing: "",
    });

    expect(payload).toEqual({
      access_key: "public-test-key",
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: TEAM_ACCESS_FOLLOW_UP_SUBJECT,
      from_name: "mex Hub",
      source: TEAM_ACCESS_SOURCE,
    });
    expect(payload).not.toHaveProperty("company");
    expect(payload).not.toHaveProperty("i_want");
    expect(payload).not.toHaveProperty("repo");
    expect(payload).not.toHaveProperty("path");
  });

  it("includes only allowlisted optional answers", () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const payload = buildTeamAccessFollowUpPayload({
      name: "Ada Lovelace",
      email: "ada@example.com",
      company: "Analytical Engines",
      teamSize: "2–10",
      foundMex: "GitHub",
      installReason: "Agent memory",
      repoKind: "Work",
      othersUseAgents: "Yes",
      need: "Shared team memory",
      missing: "Shared follow-up",
    });

    expect(payload).toMatchObject({
      company: "Analytical Engines",
      team_size: "2–10",
      found_mex: "GitHub",
      install_reason: "Agent memory",
      repo_kind: "Work",
      others_use_agents: "Yes",
      i_need: "Shared team memory",
      whats_missing: "Shared follow-up",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "access_key",
      "company",
      "email",
      "found_mex",
      "from_name",
      "i_need",
      "install_reason",
      "name",
      "others_use_agents",
      "repo_kind",
      "source",
      "subject",
      "team_size",
      "whats_missing",
    ]);
    expect(payload).not.toHaveProperty("repo");
    expect(payload).not.toHaveProperty("path");
  });

  it("rejects blank or malformed contact details before submit", () => {
    expect(validateTeamAccessContact("", "ada@example.com")).toEqual({ name: "Enter your name." });
    expect(validateTeamAccessContact("Ada", "")).toEqual({ email: "Enter your email." });
    expect(validateTeamAccessContact("Ada", "not-an-email")).toEqual({ email: "Enter a valid email." });
    expect(validateTeamAccessContact("Ada", "ada@example.com")).toEqual({});
  });
});

describe("team-access Web3Forms submit", () => {
  it("posts JSON to Web3Forms and requires a success response", async () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    const payload = buildTeamAccessContactPayload({ name: "Ada", email: "ada@example.com" });
    const result = await submitTeamAccessPayload(payload, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(WEB3FORMS_SUBMIT_URL);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(payload);
  });

  it("stays failed when Web3Forms does not accept the payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, message: "invalid" }),
    });
    const result = await submitTeamAccessPayload(
      { access_key: "public-test-key", name: "Ada", email: "ada@example.com" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, message: TEAM_ACCESS_SUBMIT_ERROR });
  });

  it("does not call the network when the public access key is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await submitTeamAccessPayload(
      { access_key: "", name: "Ada", email: "ada@example.com" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, message: TEAM_ACCESS_SUBMIT_ERROR });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("team-access local state", () => {
  it("remembers that this Hub checkout already sent contact details", () => {
    expect(readTeamAccessState()).toBeNull();
    writeTeamAccessState({ contactSent: true });
    expect(readTeamAccessState()).toEqual({ contactSent: true });
  });
});
