import { beforeEach, describe, expect, it, vi } from "vitest";
import { DISCORD_ME, DISCORD_REVOKE, DISCORD_TOKEN } from "../src/auth";
import { handleFeed } from "../src/feed";
import type { Env } from "../src/env";
import { resetBotCache } from "../src/tools";
import { BOT_ID, C1, C2, CAT, fakeDiscord, jsonRes, toolContext } from "./fake-discord";

vi.spyOn(console, "log").mockImplementation(() => {});
beforeEach(() => resetBotCache());

const env = { PUBLIC_URL: "https://broker.test", DISCORD_CLIENT_ID: "123456789012345678", DISCORD_CLIENT_SECRET: "shh" } as Env;

function setup(o: { channels?: string; guilds?: string; fetchImpl?: typeof fetch } = {}) {
  const d = fakeDiscord();
  const tc = toolContext(d.fetchImpl, { channels: o.channels, guilds: o.guilds });
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
  const feed = (path: string, init?: RequestInit) =>
    handleFeed(new Request(`https://feed${path}`, init), env, ctx, { dc: tc.dc, scope: tc.scope, fetchImpl: o.fetchImpl });
  return { d, feed, waited };
}

describe("Feed", () => {
  it("identity returns id, login and name of the bot", async () => {
    const { feed } = setup();
    const res = await feed("/identity");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: BOT_ID, login: "claude", name: "CLAUDE" });
  });

  it("passes a GET through with upstream status and body", async () => {
    const { feed } = setup({ channels: CAT });
    const res = await feed(`/api/channels/${C1}/messages?limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(3);
    expect(body[0].content).toBe("carry on");
  });

  it("forwards the query string", async () => {
    const { feed, d } = setup();
    await feed(`/api/channels/${C1}/messages?limit=1&after=700000000000000001`);
    const sent = d.log.at(-1)!;
    expect(sent.method).toBe("GET");
    expect(sent.path).toBe(`/channels/${C1}/messages`);
    expect(sent.query.get("limit")).toBe("1");
    expect(sent.query.get("after")).toBe("700000000000000001");
  });

  it("refuses a channel outside the allowlist with 403", async () => {
    const { feed } = setup({ channels: CAT });
    const res = await feed(`/api/channels/${C2}/messages`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toEqual(expect.any(String));
  });

  it("refuses non-GET on /api with 405", async () => {
    const { feed, d } = setup();
    for (const method of ["POST", "DELETE"]) {
      const res = await feed(`/api/channels/${C1}/messages`, { method, body: method === "POST" ? "{}" : undefined });
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "feed is read-only" });
    }
    expect(d.log).toHaveLength(0);
  });

  it("rejects a URL smuggled as a path", async () => {
    const { feed, d } = setup();
    const res = await feed("/api/https://evil.example");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toEqual(expect.any(String));
    expect(d.log).toHaveLength(0);
  });

  it("passes an upstream 404 through as 404", async () => {
    const { feed } = setup();
    const res = await feed("/api/channels/399999999999999999");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Unknown Channel", code: 10003 });
  });
});

describe("Feed sign-in", () => {
  function signinFetch(tokenRes: Response | null = null) {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? "GET" });
      if (url === DISCORD_TOKEN) return tokenRes ?? jsonRes({ access_token: "user-token" });
      if (url === DISCORD_ME) return jsonRes({ id: "800000000000000001", username: "lothrop" });
      if (url === DISCORD_REVOKE) return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }
  const post = (body: unknown) => ({ method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

  it("signin/client returns the application id", async () => {
    const { feed } = setup();
    const res = await feed("/signin/client");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ client_id: env.DISCORD_CLIENT_ID });
  });

  it("signin exchanges the code and returns the user", async () => {
    const f = signinFetch();
    const { feed, waited } = setup({ fetchImpl: f.fetchImpl });
    const res = await feed("/signin", post({ code: "abc", redirect_uri: "https://mailroom.test/callback" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "800000000000000001", username: "lothrop" });
    await Promise.all(waited);
    expect(f.calls.map((c) => c.url)).toEqual([DISCORD_TOKEN, DISCORD_ME, DISCORD_REVOKE]);
  });

  it("signin reports a failed exchange as 502 with the hint text", async () => {
    const f = signinFetch(jsonRes({ error: "invalid_grant" }, 400));
    const { feed } = setup({ fetchImpl: f.fetchImpl });
    const res = await feed("/signin", post({ code: "abc", redirect_uri: "https://mailroom.test/callback" }));
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("Discord did not return a token (invalid_grant)");
    expect(error).toContain("redirect URI");
  });

  it("signin rejects a body without code or redirect_uri", async () => {
    const f = signinFetch();
    const { feed } = setup({ fetchImpl: f.fetchImpl });
    for (const body of [{ code: "abc" }, { redirect_uri: "https://x.test/cb" }, {}, "not json"]) {
      expect((await feed("/signin", post(body))).status).toBe(400);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("unknown route is 404", async () => {
    const { feed } = setup();
    for (const path of ["/", "/nope", "/identity/extra"]) {
      const res = await feed(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });
});
