// A small in-memory Discord REST API, faked at the fetch layer.

import { DiscordClient, RateLimiter } from "../src/discord/client";
import { ChannelCache, Scope } from "../src/discord/scope";
import type { ToolContext } from "../src/tools";

export const BOT_TOKEN = "TEST.BOT.TOKEN";
export const BOT_ID = "900000000000000001";
export const ME_ID = "800000000000000001";
export const OTHER_ID = "800000000000000002";
export const G1 = "100000000000000001";
export const G2 = "100000000000000002";
export const CAT = "200000000000000001";
export const C1 = "300000000000000001"; // under CAT
export const C2 = "300000000000000002"; // no category
export const FORUM = "300000000000000003";
export const C9 = "300000000000000009"; // in G2
export const T1 = "400000000000000001"; // thread under C1
export const DM = "500000000000000001";

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | null;
  ua: string | null;
  body: any;
}

export function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Handler = (r: Recorded, m: RegExpMatchArray) => Response | Promise<Response>;

export function fakeDiscord(opts: { messageContent?: boolean } = {}) {
  const log: Recorded[] = [];
  let seq = 600000000000000000n;
  const nextId = () => String(++seq);
  const channels: Record<string, any> = {
    [CAT]: { id: CAT, type: 4, name: "agents", guild_id: G1, position: 0 },
    [C1]: { id: C1, type: 0, name: "general", guild_id: G1, parent_id: CAT, position: 0, topic: "talk" },
    [C2]: { id: C2, type: 0, name: "lobby", guild_id: G1, position: 1 },
    [FORUM]: { id: FORUM, type: 15, name: "ideas", guild_id: G1, position: 2 },
    [C9]: { id: C9, type: 0, name: "elsewhere", guild_id: G2, position: 0 },
    [T1]: { id: T1, type: 11, name: "a thread", guild_id: G1, parent_id: C1 },
    [DM]: { id: DM, type: 1 },
  };
  const user = (id: string, username: string, bot = false) => ({ id, username, global_name: username.toUpperCase(), ...(bot ? { bot: true } : {}) });
  const msg = (id: string, channel_id: string, author: any, content: string, extra: any = {}) => ({
    id, channel_id, type: 0, content, timestamp: "2026-11-05T00:00:00Z", edited_timestamp: null, author, attachments: [], embeds: [], mentions: [], ...extra,
  });
  const messages: Record<string, any[]> = {
    [C1]: [
      msg("700000000000000001", C1, user(OTHER_ID, "nyx", true), opts.messageContent === false ? "" : "hello from nyx"),
      msg("700000000000000002", C1, user(BOT_ID, "claude", true), "hi nyx", { message_reference: { message_id: "700000000000000001" } }),
      msg("700000000000000003", C1, user(ME_ID, "lothrop"), opts.messageContent === false ? "" : "carry on", { reactions: [{ emoji: { id: null, name: "👍" }, count: 2, me: true }] }),
    ],
  };
  const reactions: string[] = [];

  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/users\/@me$/, () => jsonRes(user(BOT_ID, "claude", true))],
    ["GET", /^\/applications\/@me$/, () => jsonRes({ id: BOT_ID, name: "Claude", flags: opts.messageContent === false ? 0 : 1 << 19, approximate_guild_count: 2 })],
    ["GET", /^\/users\/@me\/guilds$/, () => jsonRes([{ id: G1, name: "Agents", permissions: "1024" }, { id: G2, name: "Other", permissions: "1024" }])],
    ["GET", /^\/guilds\/(\d+)\/channels$/, (_r, m) => jsonRes(Object.values(channels).filter((c) => c.guild_id === m[1] && ![10, 11, 12].includes(c.type)))],
    ["GET", /^\/guilds\/(\d+)\/threads\/active$/, (_r, m) => jsonRes({ threads: Object.values(channels).filter((c) => c.guild_id === m[1] && [10, 11, 12].includes(c.type)), members: [] })],
    ["GET", /^\/channels\/(\d+)$/, (_r, m) => (channels[m[1]] ? jsonRes(channels[m[1]]) : jsonRes({ message: "Unknown Channel", code: 10003 }, 404))],
    [
      "GET",
      /^\/channels\/(\d+)\/messages$/,
      (r, m) => {
        let list = [...(messages[m[1]] ?? [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)); // newest first, like Discord
        const before = r.query.get("before");
        const after = r.query.get("after");
        if (before) list = list.filter((x) => BigInt(x.id) < BigInt(before));
        if (after) list = list.filter((x) => BigInt(x.id) > BigInt(after));
        return jsonRes(list.slice(0, Number(r.query.get("limit") ?? 50)));
      },
    ],
    [
      "GET",
      /^\/channels\/(\d+)\/messages\/(\d+)$/,
      (_r, m) => {
        const found = (messages[m[1]] ?? []).find((x) => x.id === m[2]);
        if (!found) return jsonRes({ message: "Unknown Message", code: 10008 }, 404);
        const ref = found.message_reference && (messages[m[1]] ?? []).find((x) => x.id === found.message_reference.message_id);
        return jsonRes({ ...found, ...(ref ? { referenced_message: ref } : {}) });
      },
    ],
    [
      "POST",
      /^\/channels\/(\d+)\/messages$/,
      (r, m) => {
        if (!channels[m[1]]) return jsonRes({ message: "Unknown Channel", code: 10003 }, 404);
        if ((r.body.content ?? "").length > 2000) return jsonRes({ message: "Invalid Form Body", code: 50035 }, 400);
        const x = msg(nextId(), m[1], user(BOT_ID, "claude", true), r.body.content, r.body.message_reference ? { message_reference: r.body.message_reference } : {});
        (messages[m[1]] ??= []).push(x);
        return jsonRes(x);
      },
    ],
    ["PATCH", /^\/channels\/(\d+)\/messages\/(\d+)$/, (r, m) => jsonRes({ ...msg(m[2], m[1], user(BOT_ID, "claude", true), r.body.content), edited_timestamp: "2026-11-05T01:00:00Z" })],
    [
      "DELETE",
      /^\/channels\/(\d+)\/messages\/(\d+)$/,
      (_r, m) => {
        messages[m[1]] = (messages[m[1]] ?? []).filter((x) => x.id !== m[2]);
        return new Response(null, { status: 204 });
      },
    ],
    [
      "PUT",
      /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/,
      (_r, m) => {
        reactions.push(decodeURIComponent(m[3]));
        return new Response(null, { status: 204 });
      },
    ],
    ["DELETE", /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/, () => new Response(null, { status: 204 })],
    [
      "POST",
      /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/,
      (r, m) => {
        const t = { id: nextId(), type: 11, name: r.body.name, guild_id: channels[m[1]].guild_id, parent_id: m[1] };
        channels[t.id] = t;
        return jsonRes(t, 201);
      },
    ],
    [
      "POST",
      /^\/channels\/(\d+)\/threads$/,
      (r, m) => {
        const parent = channels[m[1]];
        if ([15, 16].includes(parent.type) && !r.body.message) return jsonRes({ message: "Invalid Form Body", code: 50035 }, 400);
        const t = { id: nextId(), type: r.body.type ?? 11, name: r.body.name, guild_id: parent.guild_id, parent_id: m[1] };
        channels[t.id] = t;
        return jsonRes(t, 201);
      },
    ],
    ["GET", /^\/channels\/(\d+)\/pins$/, () => jsonRes([])],
    ["PATCH", /^\/guilds\/(\d+)$/, () => jsonRes({})],
    ["POST", /^\/users\/@me\/channels$/, () => jsonRes(channels[DM])],
  ];

  let override: ((r: Recorded) => Response | undefined) | undefined;

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init.headers);
    if (url.origin !== "https://discord.com" || !url.pathname.startsWith("/api/v10/")) throw new Error(`unexpected fetch ${url}`);
    const rec: Recorded = {
      method: (init.method ?? "GET").toUpperCase(),
      path: url.pathname.slice("/api/v10".length),
      query: url.searchParams,
      auth: headers.get("authorization"),
      ua: headers.get("user-agent"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    log.push(rec);
    const o = override?.(rec);
    if (o) return o;
    if (rec.auth !== `Bot ${BOT_TOKEN}`) return jsonRes({ message: "401: Unauthorized", code: 0 }, 401);
    for (const [meth, re, h] of routes) {
      const m = rec.path.match(re);
      if (meth === rec.method && m) return h(rec, m);
    }
    return jsonRes({ message: "404: Not Found", code: 0 }, 404);
  };

  return {
    fetchImpl: fetchImpl as typeof fetch,
    log,
    messages,
    channels,
    reactions,
    setOverride(f: typeof override) {
      override = f;
    },
  };
}

export function toolContext(
  fetchImpl: typeof fetch,
  o: { guilds?: string; channels?: string; token?: string; sleep?: (ms: number) => Promise<void>; limiter?: RateLimiter } = {},
): ToolContext {
  return {
    dc: new DiscordClient({ token: o.token ?? BOT_TOKEN, userAgent: "DiscordBot (https://broker.test, 0.0.0)", sleep: o.sleep ?? (async () => {}) }, o.limiter ?? new RateLimiter(), fetchImpl),
    scope: new Scope(o.guilds, o.channels, new ChannelCache()),
    user: { id: ME_ID, username: "lothrop" },
  };
}
