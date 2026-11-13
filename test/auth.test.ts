import { describe, expect, it } from "vitest";
import { configProblem, escapeHtml, isAllowed, parseAllowlist } from "../src/auth";
import type { Env } from "../src/env";

describe("allowlist", () => {
  it("matches numeric Discord IDs exactly and nothing else", () => {
    const raw = "800000000000000001, lothrop  800000000000000003";
    expect(parseAllowlist(raw).ids).toEqual(new Set(["800000000000000001", "800000000000000003"]));
    expect(parseAllowlist(raw).bad).toEqual(["lothrop"]);
    expect(isAllowed(raw, { id: "800000000000000001" })).toBe(true);
    expect(isAllowed(raw, { id: "80000000000000000" })).toBe(false);
  });

  it("an empty allowlist lets nobody in", () => {
    expect(isAllowed("", { id: "1" })).toBe(false);
    expect(isAllowed(undefined, { id: "1" })).toBe(false);
  });
});

describe("configuration checks before sending anyone to Discord", () => {
  const base = { DISCORD_CLIENT_ID: "123456789012345678", ALLOWED_DISCORD_USERS: "800000000000000001", DISCORD_CLIENT_SECRET: "s" } as Env;
  it("passes a sane config", () => expect(configProblem(base)).toBeNull());
  it("spots a bot token pasted as the client ID", () => expect(configProblem({ ...base, DISCORD_CLIENT_ID: "MTk4.Cl2FMQ.ZnCj" })).toMatch(/bot token/));
  it("spots a placeholder client ID", () => expect(configProblem({ ...base, DISCORD_CLIENT_ID: "REPLACE" })).toMatch(/Application ID/));
  it("spots a username in the allowlist", () => expect(configProblem({ ...base, ALLOWED_DISCORD_USERS: "lothrop" })).toMatch(/Copy User ID/));
  it("spots a missing client secret", () => expect(configProblem({ ...base, DISCORD_CLIENT_SECRET: "" })).toMatch(/DISCORD_CLIENT_SECRET/));
});

it("escapes client-supplied strings for the consent page", () => {
  expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});
