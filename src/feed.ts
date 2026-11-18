// Feed: a read-only internal entrypoint for other Workers in this account (mailroom),
// reached through a service binding. A named WorkerEntrypoint is not routable from the
// internet; only the default export is. The caller sends ordinary Requests; the host name
// is meaningless, only the path matters.
//
//   GET  /identity        the bot's id, login and name
//   GET  /api/<path>      any Discord GET, under the same allowlists as the MCP tools
//   GET  /signin/client   the application's client id
//   POST /signin          Discord sign-in code exchange (the client secret stays here)

import { WorkerEntrypoint } from "cloudflare:workers";
import { exchangeDiscordCode, userAgent } from "./auth";
import { DiscordClient, DiscordError, normalizePath } from "./discord/client";
import { Scope, ScopeError } from "./discord/scope";
import type { Env } from "./env";
import { channels, limiter } from "./shared";
import { ToolInputError, checkPassthrough } from "./tools";

interface FeedDeps {
  dc: DiscordClient;
  scope: Scope;
  fetchImpl?: typeof fetch;
}

type Ctx = { waitUntil(p: Promise<unknown>): void };

function json(body: unknown, status = 200): Response {
  if (status === 204 || status === 205 || status === 304) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fail = (status: number, error: string) => json({ error }, status);

export async function handleFeed(request: Request, env: Env, ctx: Ctx, deps: FeedDeps): Promise<Response> {
  const started = Date.now();
  const { pathname, searchParams } = new URL(request.url);
  let res: Response;
  try {
    res = await route(request, pathname, searchParams, env, ctx, deps);
  } catch (e) {
    res = e instanceof DiscordError ? fail(e.status, e.message) : fail(500, (e as Error)?.message ?? "internal error");
  }
  console.log(JSON.stringify({ event: "feed", path: pathname, status: res.status, ms: Date.now() - started }));
  return res;
}

async function route(request: Request, pathname: string, query: URLSearchParams, env: Env, ctx: Ctx, deps: FeedDeps): Promise<Response> {
  const { dc, scope } = deps;

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    if (request.method !== "GET") return fail(405, "feed is read-only");
    let path: string;
    try {
      path = normalizePath(pathname.slice("/api".length));
    } catch (e) {
      return fail(400, (e as Error).message);
    }
    try {
      await checkPassthrough("GET", path, undefined, { dc, scope, user: { id: "feed", username: "feed" } });
    } catch (e) {
      if (e instanceof ScopeError) return fail(403, e.message);
      if (e instanceof ToolInputError) return fail(400, e.message);
      throw e;
    }
    const up = await dc.request({ method: "GET", path, query: Object.fromEntries(query) });
    return json(up.data, up.status);
  }

  if (pathname === "/identity" && request.method === "GET") {
    const me = await dc.call<{ id: string; username: string; global_name?: string | null }>({ path: "/users/@me" });
    return json({ id: me.id, login: me.username, name: me.global_name ?? me.username });
  }

  if (pathname === "/signin/client" && request.method === "GET") return json({ client_id: env.DISCORD_CLIENT_ID });

  if (pathname === "/signin" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { code?: unknown; redirect_uri?: unknown } | null;
    if (typeof body?.code !== "string" || !body.code || typeof body.redirect_uri !== "string" || !body.redirect_uri) {
      return fail(400, "code and redirect_uri are required");
    }
    const id = await exchangeDiscordCode(env, body.code, body.redirect_uri, undefined, ctx, deps.fetchImpl);
    return id.ok ? json({ id: id.id, username: id.username }) : fail(id.status, id.message);
  }

  return fail(404, "not found");
}

export class Feed extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const { env } = this;
    try {
      if (!env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is not set");
      return await handleFeed(request, env, this.ctx, {
        dc: new DiscordClient({ token: env.DISCORD_BOT_TOKEN, userAgent: userAgent(env) }, limiter),
        scope: new Scope(env.DISCORD_ALLOWED_GUILDS, env.DISCORD_ALLOWED_CHANNELS, channels),
      });
    } catch (e) {
      console.log(JSON.stringify({ event: "feed", path: new URL(request.url).pathname, status: 500, message: (e as Error)?.message }));
      return fail(500, (e as Error)?.message ?? "internal error");
    }
  }
}
