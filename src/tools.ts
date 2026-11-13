// MCP tool definitions. Each tool is a small wrapper over the Discord REST API, plus
// discord_request, a passthrough for what the named tools don't cover. Every tool that
// names a channel or guild goes through the scope check first.

import { DiscordClient, DiscordError, normalizePath } from "./discord/client";
import { ChannelInfo, Scope, ScopeError } from "./discord/scope";

export interface ToolContext {
  dc: DiscordClient;
  scope: Scope;
  user: { id: string; username: string };
}

type JsonSchema = {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  run(args: Record<string, any>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

export class ToolInputError extends Error {}

const DEFAULT_MAX_CHARS = 100_000;
const MAX_MESSAGE = 2000;
const SNOWFLAKE = /^\d{5,25}$/;

// ---------- helpers ----------

export const CHANNEL_TYPES: Record<number, string> = {
  0: "text",
  1: "dm",
  2: "voice",
  3: "group_dm",
  4: "category",
  5: "announcement",
  10: "announcement_thread",
  11: "public_thread",
  12: "private_thread",
  13: "stage",
  14: "directory",
  15: "forum",
  16: "media",
};
const THREAD_TYPES = new Set([10, 11, 12]);

function id(args: Record<string, any>, key: string): string {
  const v = String(args[key] ?? "");
  if (!SNOWFLAKE.test(v)) throw new ToolInputError(`${key} must be a numeric Discord ID, got "${v}"`);
  return v;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters; raise max_chars or narrow the request]`;
}

export function jumpUrl(guildId: string | undefined, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

/** Discord wants unicode emoji percent-encoded and custom emoji as name:id. */
export function encodeEmoji(raw: string): string {
  const s = raw.trim();
  const custom = s.match(/^<?a?:?([A-Za-z0-9_~]{2,32}):(\d{5,25})>?$/);
  if (custom) return encodeURIComponent(`${custom[1]}:${custom[2]}`);
  if (!s || s.length > 32 || /[\s/?#]/.test(s)) throw new ToolInputError(`"${raw}" is not an emoji (use the character itself, or name:id for a custom emoji)`);
  return encodeURIComponent(s);
}

/**
 * Split text into Discord-sized messages, preferring line breaks, and keep fenced code
 * blocks valid across the cut by closing and reopening the fence.
 */
export function splitContent(text: string, max = MAX_MESSAGE): string[] {
  const out: string[] = [];
  let rest = text;
  let openFence: string | null = null;
  while (rest.length) {
    if (openFence && openFence.length > 40) openFence = "```";
    const prefix = openFence ? `${openFence}\n` : "";
    const budget = max - prefix.length - 4; // room for a closing "\n```"
    if (prefix.length + rest.length <= max) {
      out.push(prefix + rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", budget);
    if (cut < budget / 2) cut = rest.lastIndexOf(" ", budget);
    if (cut < budget / 2) cut = budget;
    let chunk = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");
    // Track whether we end inside a fence.
    let fence: string | null = openFence;
    for (const m of chunk.matchAll(/^(```|~~~)([^\n`]*)$/gm)) fence = fence ? null : m[0];
    chunk = prefix + chunk;
    if (fence) chunk += "\n```";
    out.push(chunk);
    openFence = fence;
  }
  return out;
}

interface RawMessage {
  id: string;
  channel_id: string;
  type: number;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  attachments?: { id: string; filename: string; url: string; size: number; content_type?: string }[];
  embeds?: { title?: string; description?: string; url?: string }[];
  reactions?: { emoji: { id: string | null; name: string | null }; count: number; me: boolean }[];
  mentions?: { id: string; username: string }[];
  message_reference?: { message_id?: string; channel_id?: string; type?: number };
  referenced_message?: RawMessage | null;
  thread?: { id: string; name: string };
  sticker_items?: { name: string }[];
  components?: unknown[];
  poll?: unknown;
  pinned?: boolean;
}

export function compactMessage(m: RawMessage) {
  const out: Record<string, unknown> = {
    id: m.id,
    author: { id: m.author.id, name: m.author.global_name || m.author.username, username: m.author.username, ...(m.author.bot ? { bot: true } : {}) },
    content: m.content,
    at: m.timestamp,
  };
  if (m.edited_timestamp) out.edited_at = m.edited_timestamp;
  if (m.type !== 0 && m.type !== 19) out.type = m.type;
  if (m.message_reference?.message_id) {
    out.reply_to = m.message_reference.message_id;
    if (m.message_reference.type === 1) out.forwarded = true;
  }
  if (m.mentions?.length) out.mentions = m.mentions.map((u) => ({ id: u.id, username: u.username }));
  if (m.attachments?.length) out.attachments = m.attachments.map((a) => ({ filename: a.filename, url: a.url, size: a.size, content_type: a.content_type }));
  if (m.embeds?.length) out.embeds = m.embeds.map((e) => ({ title: e.title, description: e.description?.slice(0, 500), url: e.url }));
  if (m.reactions?.length) out.reactions = m.reactions.map((r) => ({ emoji: r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name, count: r.count, me: r.me }));
  if (m.sticker_items?.length) out.stickers = m.sticker_items.map((s) => s.name);
  if (m.thread) out.thread = { id: m.thread.id, name: m.thread.name };
  if (m.pinned) out.pinned = true;
  return out;
}

/** A message from someone else with nothing in it is the signature of a missing Message Content intent. */
function looksEmptied(m: RawMessage, botId?: string): boolean {
  if (botId && m.author.id === botId) return false;
  if (botId && m.mentions?.some((u) => u.id === botId)) return false;
  return (
    (m.type === 0 || m.type === 19) &&
    !m.content &&
    !m.attachments?.length &&
    !m.embeds?.length &&
    !m.sticker_items?.length &&
    !m.components?.length &&
    !m.poll
  );
}

let botUser: { id: string; username: string } | undefined;
async function bot(ctx: ToolContext) {
  if (!botUser) {
    const u = await ctx.dc.call<{ id: string; username: string }>({ path: "/users/@me" });
    botUser = { id: u.id, username: u.username };
  }
  return botUser;
}
/** For tests. */
export function resetBotCache() {
  botUser = undefined;
}

function allowedMentions(args: Record<string, any>) {
  const parse = (args.allow_mentions ?? ["users"]) as string[];
  for (const p of parse) if (!["users", "roles", "everyone"].includes(p)) throw new ToolInputError(`allow_mentions entries must be users, roles or everyone, got "${p}"`);
  return { parse, replied_user: args.ping_reply_author ?? true };
}

/** Validate tool arguments: required keys, primitive types, enums, unknown keys. */
export function validateArgs(schema: JsonSchema, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  for (const r of schema.required ?? []) {
    if (a[r] === undefined || a[r] === null) return `missing required argument "${r}"`;
  }
  for (const [k, v] of Object.entries(a)) {
    const prop = schema.properties[k];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown argument "${k}"`;
      continue;
    }
    if (v === undefined || v === null) continue;
    const t = prop.type;
    const ok =
      t === undefined ||
      (t === "string" && typeof v === "string") ||
      (t === "integer" && Number.isInteger(v)) ||
      (t === "number" && typeof v === "number") ||
      (t === "boolean" && typeof v === "boolean") ||
      (t === "array" && Array.isArray(v)) ||
      (t === "object" && typeof v === "object" && !Array.isArray(v));
    if (!ok) return `argument "${k}" must be ${t}`;
    if (prop.enum && !prop.enum.includes(v)) return `argument "${k}" must be one of ${prop.enum.join(", ")}`;
    if (t === "integer" && prop.minimum !== undefined && (v as number) < prop.minimum) return `argument "${k}" must be at least ${prop.minimum}`;
    if (t === "integer" && prop.maximum !== undefined && (v as number) > prop.maximum) return `argument "${k}" must be at most ${prop.maximum}`;
  }
  return null;
}

const channelProp = { type: "string", description: "Channel or thread ID (numeric)." };
const messageProp = { type: "string", description: "Message ID (numeric)." };
const rawProp = { type: "boolean", description: "Return Discord's full objects instead of the compact form." };
const maxCharsProp = { type: "integer", description: `Truncate the result to this many characters. Default ${DEFAULT_MAX_CHARS}.` };

// ---------- tools ----------

export const TOOLS: ToolDef[] = [
  {
    name: "bot_info",
    title: "Bot info",
    description:
      "Who the bot is, which privileged intents its application has (Message Content matters for reading other people's messages, over REST too), where this server lets it act, and who is signed in. Never returns the token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(_args, ctx) {
      const me = await ctx.dc.call<{ id: string; username: string; global_name?: string; discriminator?: string }>({ path: "/users/@me" });
      botUser = { id: me.id, username: me.username };
      let app: { id: string; name: string; flags?: number; approximate_guild_count?: number } | undefined;
      try {
        app = await ctx.dc.call({ path: "/applications/@me" });
      } catch {
        app = undefined;
      }
      const flags = app?.flags ?? 0;
      const intent = (full: number, limited: number) => (flags & full ? "enabled" : flags & limited ? "enabled (limited, under 100 servers)" : "off");
      return {
        bot: { id: me.id, username: me.username, display_name: me.global_name ?? null },
        application: app ? { id: app.id, name: app.name, approximate_guild_count: app.approximate_guild_count } : "could not read",
        privileged_intents: app
          ? {
              message_content: intent(1 << 18, 1 << 19),
              server_members: intent(1 << 14, 1 << 15),
              presence: intent(1 << 12, 1 << 13),
            }
          : "unknown",
        scope: ctx.scope.describe(),
        signed_in_as: { id: ctx.user.id, username: ctx.user.username },
      };
    },
  },
  {
    name: "list_guilds",
    title: "List servers",
    description: "Servers (guilds) the bot is in and this server allows, with the bot's permission bits in each.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(_args, ctx) {
      const guilds = await ctx.dc.call<{ id: string; name: string; permissions?: string; owner?: boolean }[]>({ path: "/users/@me/guilds", query: { limit: 200 } });
      return guilds.filter((g) => ctx.scope.guildAllowed(g.id)).map((g) => ({ id: g.id, name: g.name, permissions: g.permissions }));
    },
  },
  {
    name: "list_channels",
    title: "List channels",
    description:
      "Channels in a server, grouped under their categories, with active threads by default. Only channels this server allows are shown; whether the bot can read each one depends on its Discord permissions.",
    inputSchema: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Server (guild) ID." },
        include_threads: { type: "boolean", description: "Include active threads. Default true." },
      },
      required: ["guild_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const gid = id(args, "guild_id");
      if (!ctx.scope.guildAllowed(gid)) throw new ScopeError(`Guild ${gid} is outside DISCORD_ALLOWED_GUILDS.`);
      const chans = await ctx.dc.call<(ChannelInfo & { position?: number; topic?: string | null })[]>({ path: `/guilds/${gid}/channels` });
      let threads: (ChannelInfo & { thread_metadata?: { archived?: boolean } })[] = [];
      if (args.include_threads !== false) {
        try {
          threads = (await ctx.dc.call<{ threads: typeof threads }>({ path: `/guilds/${gid}/threads/active` })).threads ?? [];
        } catch (e) {
          if (!(e instanceof DiscordError) || e.status !== 403) throw e;
        }
      }
      const all = [...chans, ...threads].map((c) => ({ ...c, guild_id: c.guild_id ?? gid }));
      const byId = new Map(all.map((c) => [c.id, c]));
      for (const c of all) ctx.scope.remember(c);
      const visible = all.filter((c) => ctx.scope.allowsListed(c, byId));
      const shape = (c: (typeof all)[number]) => ({
        id: c.id,
        name: c.name,
        type: CHANNEL_TYPES[c.type] ?? c.type,
        ...(c.parent_id ? { parent_id: c.parent_id } : {}),
        ...((c as any).topic ? { topic: (c as any).topic } : {}),
      });
      const pos = (c: any) => c.position ?? 0;
      return visible
        .filter((c) => !THREAD_TYPES.has(c.type))
        .sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || pos(a) - pos(b))
        .map(shape)
        .concat(visible.filter((c) => THREAD_TYPES.has(c.type)).map(shape));
    },
  },
  {
    name: "read_messages",
    title: "Read messages",
    description:
      "Messages in a channel or thread, oldest first. Give at most one of before, after or around (message IDs) to page; with none you get the latest. The result's next_before/next_after continue backwards/forwards. Needs View Channel and Read Message History; other people's text comes back empty unless the app has the Message Content intent.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: channelProp,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1-100, default 50." },
        before: { type: "string", description: "Messages older than this message ID." },
        after: { type: "string", description: "Messages newer than this message ID." },
        around: { type: "string", description: "Messages around this message ID." },
        raw: rawProp,
        max_chars: maxCharsProp,
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const cid = id(args, "channel_id");
      const anchors = ["before", "after", "around"].filter((k) => args[k] !== undefined);
      if (anchors.length > 1) throw new ToolInputError("give at most one of before, after, around");
      for (const k of anchors) id(args, k);
      await ctx.scope.assertChannel(ctx.dc, cid);
      const msgs = await ctx.dc.call<RawMessage[]>({
        path: `/channels/${cid}/messages`,
        query: { limit: args.limit ?? 50, before: args.before, after: args.after, around: args.around },
      });
      msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      let botId: string | undefined;
      try {
        botId = (await bot(ctx)).id;
      } catch {}
      const emptied = msgs.filter((m) => looksEmptied(m, botId)).length;
      const out: Record<string, unknown> = {
        channel_id: cid,
        count: msgs.length,
        messages: args.raw ? msgs : msgs.map(compactMessage),
      };
      if (msgs.length) {
        out.next_before = msgs[0].id;
        out.next_after = msgs[msgs.length - 1].id;
      }
      if (emptied) {
        out.note = `${emptied} message(s) from others came back with no content. That is what Discord returns when the application lacks the Message Content intent (Developer Portal, Bot tab).`;
      }
      return truncate(JSON.stringify(out, null, 2), args.max_chars ?? DEFAULT_MAX_CHARS);
    },
  },
  {
    name: "get_message",
    title: "Get message",
    description: "One message, with the message it replies to if any, and a jump link.",
    inputSchema: {
      type: "object",
      properties: { channel_id: channelProp, message_id: messageProp, raw: rawProp },
      required: ["channel_id", "message_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const cid = id(args, "channel_id");
      const mid = id(args, "message_id");
      const ch = await ctx.scope.assertChannel(ctx.dc, cid);
      const m = await ctx.dc.call<RawMessage>({ path: `/channels/${cid}/messages/${mid}` });
      if (args.raw) return m;
      return {
        ...compactMessage(m),
        ...(m.referenced_message ? { replied_message: compactMessage(m.referenced_message) } : {}),
        jump_url: jumpUrl(ch.guild_id, cid, m.id),
      };
    },
  },
  {
    name: "post_message",
    title: "Post message",
    description:
      "Send a message as the bot. Text over 2000 characters is split into several messages (code fences kept intact); only the first is a reply. Mentions: users ping by default, @everyone/@here and roles only if allow_mentions says so. Needs Send Messages (Send Messages in Threads for a thread).",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: channelProp,
        content: { type: "string", description: "Markdown text." },
        reply_to: { type: "string", description: "Message ID in the same channel to reply to." },
        ping_reply_author: { type: "boolean", description: "Ping the author of reply_to. Default true." },
        allow_mentions: {
          type: "array",
          items: { type: "string", enum: ["users", "roles", "everyone"] },
          description: 'Which mentions in content may ping. Default ["users"]. [] pings nobody.',
        },
        silent: { type: "boolean", description: "Send without a push/desktop notification (@silent)." },
        suppress_embeds: { type: "boolean", description: "No link previews." },
      },
      required: ["channel_id", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const cid = id(args, "channel_id");
      if (args.reply_to !== undefined) id(args, "reply_to");
      const content = String(args.content);
      if (!content.trim()) throw new ToolInputError("content is empty");
      const ch = await ctx.scope.assertChannel(ctx.dc, cid);
      const flags = (args.silent ? 1 << 12 : 0) | (args.suppress_embeds ? 1 << 2 : 0);
      const parts = splitContent(content);
      if (parts.length > 10) throw new ToolInputError(`content would need ${parts.length} messages; keep it under about 20,000 characters`);
      const sent: { id: string; jump_url: string }[] = [];
      for (const [i, part] of parts.entries()) {
        const m = await ctx.dc.call<RawMessage>({
          method: "POST",
          path: `/channels/${cid}/messages`,
          body: {
            content: part,
            allowed_mentions: allowedMentions(args),
            ...(flags ? { flags } : {}),
            ...(i === 0 && args.reply_to ? { message_reference: { message_id: args.reply_to, fail_if_not_exists: false } } : {}),
          },
        });
        sent.push({ id: m.id, jump_url: jumpUrl(ch.guild_id, cid, m.id) });
      }
      return { channel_id: cid, messages: sent };
    },
  },
  {
    name: "edit_message",
    title: "Edit message",
    description: "Replace the text of one of the bot's own messages (2000 characters at most).",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: channelProp,
        message_id: messageProp,
        content: { type: "string" },
        allow_mentions: { type: "array", items: { type: "string", enum: ["users", "roles", "everyone"] }, description: 'Default ["users"].' },
      },
      required: ["channel_id", "message_id", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const cid = id(args, "channel_id");
      const mid = id(args, "message_id");
      if (String(args.content).length > MAX_MESSAGE) throw new ToolInputError(`content is over ${MAX_MESSAGE} characters`);
      const ch = await ctx.scope.assertChannel(ctx.dc, cid);
      const m = await ctx.dc.call<RawMessage>({
        method: "PATCH",
        path: `/channels/${cid}/messages/${mid}`,
        body: { content: args.content, allowed_mentions: { parse: allowedMentions(args).parse } },
      });
      return { id: m.id, edited_at: m.edited_timestamp, jump_url: jumpUrl(ch.guild_id, cid, m.id) };
    },
  },
  {
    name: "delete_message",
    title: "Delete message",
    description: "Delete one of the bot's own messages. Other people's messages are refused here.",
    inputSchema: {
      type: "object",
      properties: { channel_id: channelProp, message_id: messageProp },
      required: ["channel_id", "message_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const cid = id(args, "channel_id");
      const mid = id(args, "message_id");
      await ctx.scope.assertChannel(ctx.dc, cid);
      const [m, me] = await Promise.all([ctx.dc.call<RawMessage>({ path: `/channels/${cid}/messages/${mid}` }), bot(ctx)]);
      if (m.author.id !== me.id) throw new ToolInputError(`Message ${mid} was written by ${m.author.username}, not the bot; delete_message only removes the bot's own messages.`);
      await ctx.dc.call({ method: "DELETE", path: `/channels/${cid}/messages/${mid}` });
      return { deleted: mid };
    },
  },
  {
    name: "add_reaction",
    title: "Add reaction",
    description: 'React to a message as the bot. emoji is the character itself ("👍") or a custom emoji as name:id or <:name:id>. A new emoji on a message needs Add Reactions.',
    inputSchema: {
      type: "object",
      properties: { channel_id: channelProp, message_id: messageProp, emoji: { type: "string" } },
      required: ["channel_id", "message_id", "emoji"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const cid = id(args, "channel_id");
      const mid = id(args, "message_id");
      const e = encodeEmoji(String(args.emoji));
      await ctx.scope.assertChannel(ctx.dc, cid);
      await ctx.dc.call({ method: "PUT", path: `/channels/${cid}/messages/${mid}/reactions/${e}/@me` });
      return { reacted: decodeURIComponent(e), message_id: mid };
    },
  },
  {
    name: "remove_reaction",
    title: "Remove reaction",
    description: "Take back one of the bot's own reactions.",
    inputSchema: {
      type: "object",
      properties: { channel_id: channelProp, message_id: messageProp, emoji: { type: "string" } },
      required: ["channel_id", "message_id", "emoji"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const cid = id(args, "channel_id");
      const mid = id(args, "message_id");
      const e = encodeEmoji(String(args.emoji));
      await ctx.scope.assertChannel(ctx.dc, cid);
      await ctx.dc.call({ method: "DELETE", path: `/channels/${cid}/messages/${mid}/reactions/${e}/@me` });
      return { removed: decodeURIComponent(e), message_id: mid };
    },
  },
  {
    name: "create_thread",
    title: "Create thread",
    description:
      "Start a thread: from a message (message_id), as a standalone thread in a text channel, or as a post in a forum/media channel (first_message required there). first_message is posted into the new thread. Needs Create Public Threads (Create Private Threads for private).",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Parent text, announcement or forum channel ID." },
        name: { type: "string", description: "Thread name, 1-100 characters." },
        message_id: { type: "string", description: "Start the thread from this message." },
        first_message: { type: "string", description: "Text to post in the thread (required for forum posts)." },
        private: { type: "boolean", description: "Private thread (text channels only, not from a message)." },
        auto_archive_minutes: { type: "integer", enum: [60, 1440, 4320, 10080], description: "Archive after this much inactivity. Default 1440." },
      },
      required: ["channel_id", "name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const cid = id(args, "channel_id");
      const name = String(args.name).trim();
      if (!name || name.length > 100) throw new ToolInputError("name must be 1-100 characters");
      if (args.message_id !== undefined) id(args, "message_id");
      const ch = await ctx.scope.assertChannel(ctx.dc, cid);
      const auto_archive_duration = args.auto_archive_minutes ?? 1440;
      const forum = ch.type === 15 || ch.type === 16;
      const parts = args.first_message ? splitContent(String(args.first_message)) : [];
      if (parts.length > 10) throw new ToolInputError("first_message is too long");
      let thread: ChannelInfo;
      let remaining = parts;
      if (args.message_id) {
        if (args.private) throw new ToolInputError("a thread started from a message is always public");
        thread = await ctx.dc.call({ method: "POST", path: `/channels/${cid}/messages/${args.message_id}/threads`, body: { name, auto_archive_duration } });
      } else if (forum) {
        if (!parts.length) throw new ToolInputError("a forum post needs first_message");
        thread = await ctx.dc.call({
          method: "POST",
          path: `/channels/${cid}/threads`,
          body: { name, auto_archive_duration, message: { content: parts[0], allowed_mentions: { parse: ["users"] } } },
        });
        remaining = parts.slice(1);
      } else {
        thread = await ctx.dc.call({
          method: "POST",
          path: `/channels/${cid}/threads`,
          body: { name, auto_archive_duration, type: args.private ? 12 : 11 },
        });
      }
      ctx.scope.remember({ ...thread, guild_id: thread.guild_id ?? ch.guild_id, parent_id: thread.parent_id ?? cid });
      const posted: string[] = [];
      for (const part of remaining) {
        const m = await ctx.dc.call<RawMessage>({ method: "POST", path: `/channels/${thread.id}/messages`, body: { content: part, allowed_mentions: { parse: ["users"] } } });
        posted.push(m.id);
      }
      return {
        thread_id: thread.id,
        name: thread.name ?? name,
        type: CHANNEL_TYPES[thread.type] ?? thread.type,
        parent_id: cid,
        url: `https://discord.com/channels/${ch.guild_id ?? "@me"}/${thread.id}`,
        ...(posted.length ? { first_message_ids: posted } : {}),
      };
    },
  },
  {
    name: "discord_request",
    title: "Discord API request",
    description:
      "Any Discord REST endpoint, as the bot: method, path relative to /api/v10 (e.g. /channels/123/pins), query, JSON body. With an allowlist configured, /channels/ID paths must name an allowed channel, /guilds/ID paths an allowed guild (read-only when a channel allowlist is set), and every other path is GET only.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "API path, e.g. /channels/123/messages/456" },
        query: { type: "object", description: "Query parameters." },
        body: { description: "JSON body." },
        reason: { type: "string", description: "Audit log reason, for moderation endpoints." },
        max_chars: maxCharsProp,
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const method = String(args.method).toUpperCase();
      const path = String(args.path).split("?")[0];
      await checkPassthrough(method, path, args.body, ctx);
      const res = await ctx.dc.request({ method, path, query: args.query, body: args.body, reason: args.reason });
      const out = { status: res.status, data: res.data };
      return truncate(JSON.stringify(out, null, 2), args.max_chars ?? DEFAULT_MAX_CHARS);
    },
  },
];

export async function checkPassthrough(method: string, path: string, body: unknown, ctx: ToolContext) {
  const s = ctx.scope;
  if (!s.restricted) return;
  let norm: string;
  try {
    norm = normalizePath(path);
  } catch (e) {
    throw new ToolInputError((e as Error).message);
  }
  const ch = norm.match(/^\/channels\/(\d+)(\/|$)/);
  const gu = norm.match(/^\/guilds\/(\d+)(\/|$)/);
  if (ch) {
    await s.assertChannel(ctx.dc, ch[1]);
    // A forward or cross-channel reference pulls content from its source channel.
    const ref = (body as { message_reference?: { channel_id?: string } } | undefined)?.message_reference;
    if (ref?.channel_id) await s.assertChannel(ctx.dc, String(ref.channel_id));
    return;
  }
  if (gu) {
    if (!s.guildAllowed(gu[1])) throw new ScopeError(`Guild ${gu[1]} is outside DISCORD_ALLOWED_GUILDS.`);
    if (s.channels && method !== "GET") throw new ScopeError("Guild-level writes are off while DISCORD_ALLOWED_CHANNELS is set.");
    return;
  }
  if (method !== "GET") throw new ScopeError(`${method} ${norm} is outside the allowlist (only GET is allowed off /channels and /guilds paths).`);
}

export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  const err = validateArgs(tool.inputSchema, args);
  if (err) return { content: [{ type: "text", text: `Invalid arguments: ${err}` }], isError: true };
  const a = (args ?? {}) as Record<string, any>;
  const started = Date.now();
  let ok = false;
  try {
    const out = await tool.run(a, ctx);
    ok = true;
    const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    return { content: [{ type: "text", text }], isError: false };
  } catch (e) {
    if (e instanceof DiscordError || e instanceof ToolInputError || e instanceof ScopeError) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  } finally {
    // Audit line for `wrangler tail` / Workers Logs: tool, who, where, outcome. No content.
    console.log(
      JSON.stringify({
        event: "tool_call",
        tool: name,
        user: ctx.user.username,
        user_id: ctx.user.id,
        guild: typeof a.guild_id === "string" ? a.guild_id : undefined,
        channel: typeof a.channel_id === "string" ? a.channel_id : undefined,
        path: name === "discord_request" ? `${a.method} ${a.path}` : undefined,
        ok,
        ms: Date.now() - started,
      }),
    );
  }
}
