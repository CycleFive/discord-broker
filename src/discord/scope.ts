// Where the bot may act. Both lists empty means anywhere the bot can reach.
//   DISCORD_ALLOWED_GUILDS:   channels must belong to one of these guilds (DMs are then refused).
//   DISCORD_ALLOWED_CHANNELS: channels must be listed, or sit under a listed channel or category
//                             (a thread under a listed channel, a channel under a listed category).

import type { DiscordClient } from "./client";

export interface ChannelInfo {
  id: string;
  type: number;
  name?: string;
  guild_id?: string;
  parent_id?: string | null;
}

export class ScopeError extends Error {}

function parseIds(raw: string | undefined): Set<string> | null {
  const ids = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  if (!ids.length) return null;
  for (const id of ids) if (!/^\d{5,25}$/.test(id)) throw new Error(`"${id}" is not a Discord ID (allowlists take numeric IDs only)`);
  return new Set(ids);
}

const CHANNEL_TTL_MS = 10 * 60_000;

/** Isolate-wide cache of channel id -> guild/parent, so scope checks rarely cost a request. */
export class ChannelCache {
  readonly m = new Map<string, { info: ChannelInfo; at: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  get(id: string): ChannelInfo | undefined {
    const e = this.m.get(id);
    return e && this.now() - e.at < CHANNEL_TTL_MS ? e.info : undefined;
  }
  put(c: ChannelInfo) {
    this.m.set(c.id, { info: { id: c.id, type: c.type, name: c.name, guild_id: c.guild_id, parent_id: c.parent_id ?? null }, at: this.now() });
  }
}

export class Scope {
  readonly guilds: Set<string> | null;
  readonly channels: Set<string> | null;

  constructor(guildsRaw: string | undefined, channelsRaw: string | undefined, private readonly cache: ChannelCache) {
    this.guilds = parseIds(guildsRaw);
    this.channels = parseIds(channelsRaw);
  }

  get restricted(): boolean {
    return Boolean(this.guilds || this.channels);
  }

  describe() {
    return {
      guilds: this.guilds ? [...this.guilds] : "any guild the bot is in",
      channels: this.channels ? [...this.channels] : "any channel in an allowed guild",
      dms: this.guilds ? "refused (guild allowlist set)" : this.channels ? "only listed DM channels" : "allowed",
    };
  }

  guildAllowed(guildId: string): boolean {
    return !this.guilds || this.guilds.has(guildId);
  }

  async channel(dc: DiscordClient, id: string): Promise<ChannelInfo> {
    if (!/^\d{5,25}$/.test(id)) throw new ScopeError(`"${id}" is not a channel ID`);
    const hit = this.cache.get(id);
    if (hit) return hit;
    const c = await dc.call<ChannelInfo>({ path: `/channels/${id}` });
    this.cache.put(c);
    return this.cache.get(id)!;
  }

  remember(c: ChannelInfo) {
    this.cache.put(c);
  }

  /** Throws ScopeError unless the channel is inside the allowlists. Returns the channel's info. */
  async assertChannel(dc: DiscordClient, id: string): Promise<ChannelInfo> {
    const c = await this.channel(dc, id);
    if (this.guilds && !(c.guild_id && this.guilds.has(c.guild_id))) {
      throw new ScopeError(`Channel ${id} is outside DISCORD_ALLOWED_GUILDS.`);
    }
    if (this.channels && !(await this.#underListed(dc, c, 0))) {
      throw new ScopeError(`Channel ${id} is outside DISCORD_ALLOWED_CHANNELS.`);
    }
    return c;
  }

  /** Channel listed directly, or its parent (thread -> channel -> category) is. Two hops at most. */
  async #underListed(dc: DiscordClient, c: ChannelInfo, depth: number): Promise<boolean> {
    if (this.channels!.has(c.id)) return true;
    if (!c.parent_id || depth >= 2) return false;
    if (this.channels!.has(c.parent_id)) return true;
    return this.#underListed(dc, await this.channel(dc, c.parent_id), depth + 1);
  }

  /** Same test without a network call for channels already in hand (list_channels). */
  allowsListed(c: ChannelInfo, byId: Map<string, ChannelInfo>): boolean {
    if (this.guilds && !(c.guild_id && this.guilds.has(c.guild_id))) return false;
    if (!this.channels) return true;
    let cur: ChannelInfo | undefined = c;
    for (let i = 0; cur && i < 3; i++) {
      if (this.channels.has(cur.id)) return true;
      cur = cur.parent_id ? byId.get(cur.parent_id) ?? ({ id: cur.parent_id, type: -1 } as ChannelInfo) : undefined;
    }
    return false;
  }
}
