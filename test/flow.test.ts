// End-to-end through the real Worker entry point and the real OAuth library:
// client registration -> consent -> Discord sign-in (mocked) -> token -> MCP calls.
// Discord is faked at the fetch layer; KV is in memory.

import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { BOT_TOKEN, C1, fakeDiscord, jsonRes } from "./fake-discord";
import { resetBotCache } from "../src/tools";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

class MemoryKV {
  m = new Map<string, { v: string; exp?: number; metadata?: unknown }>();
  async get(k: string, type?: any) {
    const e = this.m.get(k);
    if (!e || (e.exp && e.exp < Date.now())) return null;
    const t = typeof type === "string" ? type : type?.type;
    return t === "json" ? JSON.parse(e.v) : e.v;
  }
  async put(k: string, v: string, o?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
    const exp = o?.expirationTtl ? Date.now() + o.expirationTtl * 1000 : o?.expiration ? o.expiration * 1000 : undefined;
    this.m.set(k, { v, exp, metadata: o?.metadata });
  }
  async delete(k: string) {
    this.m.delete(k);
  }
  async list(o?: { prefix?: string; limit?: number; cursor?: string }) {
    const keys = [...this.m.keys()].filter((k) => !o?.prefix || k.startsWith(o.prefix)).sort();
    return { keys: keys.map((name) => ({ name, metadata: this.m.get(name)!.metadata })), list_complete: true, cursor: "" };
  }
}

const BASE = "https://broker.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const LOTHROP = "800000000000000001";
const CLIENT_ID = "123456789012345678";

function env(allowed = LOTHROP, extra: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: new MemoryKV() as unknown as KVNamespace,
    PUBLIC_URL: BASE,
    DISCORD_CLIENT_ID: CLIENT_ID,
    ALLOWED_DISCORD_USERS: allowed,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_CLIENT_SECRET: "test-client-secret",
    ...extra,
  };
}

const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

const call = (e: Env, path: string, init?: RequestInit) => worker.fetch(new Request(BASE + path, init), e, ctx);

function cookieHeader(res: Response, prior = ""): string {
  const jar = new Map(prior.split("; ").filter(Boolean).map((c) => c.split("=", 2) as [string, string]));
  for (const sc of res.headers.getSetCookie()) {
    const [nv] = sc.split(";");
    const i = nv.indexOf("=");
    jar.set(nv.slice(0, i), nv.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

let calls: { url: string; init?: RequestInit }[] = [];
let discordUser = { id: LOTHROP, username: "lothrop" };
let tokenAnswer: () => Response = () => jsonRes({ access_token: "user_token", token_type: "Bearer", scope: "identify" });
let api = fakeDiscord();

beforeEach(() => {
  calls = [];
  api = fakeDiscord();
  resetBotCache();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (url === "https://discord.com/api/oauth2/token") return tokenAnswer();
    if (url === "https://discord.com/api/oauth2/token/revoke") return new Response(null, { status: 200 });
    const auth = new Headers(init?.headers).get("authorization");
    if (url === "https://discord.com/api/v10/users/@me" && auth?.startsWith("Bearer ")) return jsonRes(discordUser);
    return api.fetchImpl(input, init);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function signIn(e: Env, withResource = true) {
  const reg = await call(e, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    scope: "discord offline_access",
    state: "st8",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (withResource) q.set("resource", `${BASE}/mcp`);
  const consent = await call(e, `/authorize?${q}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("<code>claude.ai</code>");
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  let cookies = cookieHeader(consent);

  const approve = await call(e, "/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
    body: new URLSearchParams({ handle, decision: "approve" }).toString(),
  });
  expect(approve.status).toBe(302);
  const dc = new URL(approve.headers.get("location")!);
  expect(dc.origin + dc.pathname).toBe("https://discord.com/oauth2/authorize");
  expect(dc.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
  expect(dc.searchParams.get("scope")).toBe("identify");
  expect(dc.searchParams.get("client_id")).toBe(CLIENT_ID);
  cookies = cookieHeader(approve, cookies);

  const cb = await call(e, `/callback?code=dc_code&state=${encodeURIComponent(dc.searchParams.get("state")!)}`, { headers: { cookie: cookies } });
  return { cb, client_id, verifier, challenge: dc.searchParams.get("code_challenge") };
}

describe("full sign-in and MCP flow", () => {
  it.each([true, false])("issues a token to an allowlisted user and serves MCP with it (resource param: %s)", async (withResource) => {
    const e = env();
    const { cb, client_id, verifier, challenge } = await signIn(e, withResource);
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st8");
    const code = back.searchParams.get("code")!;
    expect(challenge).toBeNull(); // PKCE to Discord is opt-in

    // The code exchange is form-encoded with HTTP Basic client auth, and the user token gets revoked.
    const exch = calls.find((c) => c.url === "https://discord.com/api/oauth2/token")!;
    expect(new Headers(exch.init!.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new Headers(exch.init!.headers).get("authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:test-client-secret`)}`);
    expect(new URLSearchParams(String(exch.init!.body)).get("redirect_uri")).toBe(`${BASE}/callback`);
    await Promise.all(waits);
    const rev = calls.find((c) => c.url === "https://discord.com/api/oauth2/token/revoke")!;
    expect(new URLSearchParams(String(rev.init!.body)).get("token")).toBe("user_token");

    const tok = await call(e, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: verifier, ...(withResource ? { resource: `${BASE}/mcp` } : {}) }).toString(),
    });
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token?: string; scope: string };
    expect(t.access_token).toBeTruthy();
    expect(t.refresh_token).toBeTruthy();

    const mcp = (body: unknown) =>
      call(e, "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      });
    const list = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    expect(list.result.tools.length).toBeGreaterThan(8);
    const info = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bot_info", arguments: {} } })).json()) as any;
    expect(info.result.isError).toBe(false);
    expect(info.result.content[0].text).toContain('"username": "lothrop"');
    expect(info.result.content[0].text).not.toContain(BOT_TOKEN);
    const read = (await (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_messages", arguments: { channel_id: C1 } } })).json()) as any;
    expect(read.result.content[0].text).toContain("hello from nyx");

    // Removing the user from the allowlist cuts off an already-issued token.
    e.ALLOWED_DISCORD_USERS = "800000000000000009";
    expect((await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list" })).status).toBe(403);

    // A garbage token is a 401 challenge.
    const bad = await call(e, "/mcp", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("sends PKCE to Discord when DISCORD_OAUTH_PKCE is on", async () => {
    const { cb, challenge } = await signIn(env(LOTHROP, { DISCORD_OAUTH_PKCE: "true" }));
    expect(cb.status).toBe(302);
    const sent = new URLSearchParams(String(calls.find((c) => c.url === "https://discord.com/api/oauth2/token")!.init!.body));
    expect(createHash("sha256").update(sent.get("code_verifier")!).digest("base64url")).toBe(challenge);
  });

  it("explains a bad DISCORD_CLIENT_ID instead of sending you to Discord's error page", async () => {
    await expect(signIn(env(LOTHROP, { DISCORD_CLIENT_ID: "REPLACE_WITH_APPLICATION_ID" }))).rejects.toThrow();
  });

  it("explains a rejected client secret", async () => {
    tokenAnswer = () => jsonRes({ error: "invalid_client" }, 401);
    const { cb } = await signIn(env());
    expect(cb.status).toBe(502);
    expect(await cb.text()).toContain("not the bot token");
    tokenAnswer = () => jsonRes({ access_token: "user_token", token_type: "Bearer", scope: "identify" });
  });

  it("refuses a Discord account that is not on the allowlist", async () => {
    discordUser = { id: "800000000000000007", username: "stranger" };
    const { cb } = await signIn(env());
    expect(cb.status).toBe(403);
    expect(await cb.text()).toContain("not in ALLOWED_DISCORD_USERS");
    discordUser = { id: LOTHROP, username: "lothrop" };
  });
});
