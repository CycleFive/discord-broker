import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLS, callTool, encodeEmoji, resetBotCache, splitContent } from "../src/tools";
import { BOT_TOKEN, C1, C2, C9, CAT, DM, FORUM, G1, G2, T1, fakeDiscord, toolContext } from "./fake-discord";

vi.spyOn(console, "log").mockImplementation(() => {});
beforeEach(() => resetBotCache());

async function run(ctx: any, name: string, args: any) {
  const r = await callTool(name, args, ctx);
  if (!r) throw new Error("unknown tool");
  const text = r.content[0].text;
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: r.isError, text, data };
}

describe("read tools", () => {
  it("bot_info reports the intent and never the token", async () => {
    const d = fakeDiscord();
    const r = await run(toolContext(d.fetchImpl), "bot_info", {});
    expect(r.isError).toBe(false);
    expect(r.data.privileged_intents.message_content).toMatch(/^enabled/);
    expect(r.data.signed_in_as.username).toBe("lothrop");
    expect(r.text).not.toContain(BOT_TOKEN);
    expect(d.log.every((x) => x.auth === `Bot ${BOT_TOKEN}` && x.ua?.startsWith("DiscordBot ("))).toBe(true);
  });

  it("list_guilds honours the guild allowlist", async () => {
    const d = fakeDiscord();
    expect((await run(toolContext(d.fetchImpl), "list_guilds", {})).data.map((g: any) => g.id)).toEqual([G1, G2]);
    expect((await run(toolContext(d.fetchImpl, { guilds: G1 }), "list_guilds", {})).data.map((g: any) => g.id)).toEqual([G1]);
  });

  it("list_channels puts categories first, includes threads, and filters by channel allowlist", async () => {
    const d = fakeDiscord();
    const all = (await run(toolContext(d.fetchImpl), "list_channels", { guild_id: G1 })).data;
    expect(all[0]).toMatchObject({ id: CAT, type: "category" });
    expect(all.map((c: any) => c.id)).toEqual(expect.arrayContaining([C1, C2, FORUM, T1]));
    // Allowing the category allows its channel and that channel's thread, not the others.
    const some = (await run(toolContext(d.fetchImpl, { channels: CAT }), "list_channels", { guild_id: G1 })).data;
    expect(some.map((c: any) => c.id).sort()).toEqual([CAT, C1, T1].sort());
    const refused = await run(toolContext(d.fetchImpl, { guilds: G1 }), "list_channels", { guild_id: G2 });
    expect(refused.isError).toBe(true);
  });

  it("read_messages returns oldest first with paging hints", async () => {
    const d = fakeDiscord();
    const r = (await run(toolContext(d.fetchImpl), "read_messages", { channel_id: C1, limit: 10 })).data;
    expect(r.messages.map((m: any) => m.content)).toEqual(["hello from nyx", "hi nyx", "carry on"]);
    expect(r.messages[1].reply_to).toBe("700000000000000001");
    expect(r.messages[2].reactions[0]).toEqual({ emoji: "👍", count: 2, me: true });
    expect(r.next_before).toBe("700000000000000001");
    expect(r.next_after).toBe("700000000000000003");
    expect(r.note).toBeUndefined();
    const older = (await run(toolContext(d.fetchImpl), "read_messages", { channel_id: C1, before: "700000000000000003" })).data;
    expect(older.count).toBe(2);
  });

  it("read_messages explains empty content from a missing Message Content intent", async () => {
    const d = fakeDiscord({ messageContent: false });
    const r = (await run(toolContext(d.fetchImpl), "read_messages", { channel_id: C1 })).data;
    expect(r.note).toMatch(/2 message\(s\).*Message Content intent/);
  });

  it("rejects bad arguments before calling Discord", async () => {
    const d = fakeDiscord();
    const ctx = toolContext(d.fetchImpl);
    expect((await run(ctx, "read_messages", { channel_id: "general" })).isError).toBe(true);
    expect((await run(ctx, "read_messages", { channel_id: C1, before: "1", after: "2" })).isError).toBe(true);
    expect((await run(ctx, "read_messages", { channel_id: C1, limit: 500 })).text).toContain("at most 100");
    expect((await run(ctx, "post_message", { channel_id: C1, content: "x", bogus: 1 })).text).toContain('unknown argument "bogus"');
    expect(d.log).toHaveLength(0);
  });

  it("get_message includes the replied-to message and a jump link", async () => {
    const d = fakeDiscord();
    const r = (await run(toolContext(d.fetchImpl), "get_message", { channel_id: C1, message_id: "700000000000000002" })).data;
    expect(r.replied_message.content).toBe("hello from nyx");
    expect(r.jump_url).toBe(`https://discord.com/channels/${G1}/${C1}/700000000000000002`);
  });
});

describe("write tools", () => {
  it("post_message replies with safe mentions by default", async () => {
    const d = fakeDiscord();
    const r = await run(toolContext(d.fetchImpl), "post_message", { channel_id: C1, content: "on it @everyone", reply_to: "700000000000000001" });
    expect(r.isError).toBe(false);
    const sent = d.log.find((x) => x.method === "POST")!;
    expect(sent.body.allowed_mentions).toEqual({ parse: ["users"], replied_user: true });
    expect(sent.body.message_reference).toEqual({ message_id: "700000000000000001", fail_if_not_exists: false });
    expect(r.data.messages[0].jump_url).toContain(`/channels/${G1}/${C1}/`);
  });

  it("post_message splits long text and only the first part replies", async () => {
    const d = fakeDiscord();
    const content = Array.from({ length: 120 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const r = await run(toolContext(d.fetchImpl), "post_message", { channel_id: C1, content, reply_to: "700000000000000001", silent: true });
    expect(r.isError).toBe(false);
    const posts = d.log.filter((x) => x.method === "POST");
    expect(posts.length).toBe(r.data.messages.length);
    expect(posts.length).toBeGreaterThan(2);
    expect(posts[0].body.message_reference).toBeDefined();
    expect(posts.slice(1).every((p) => !p.body.message_reference)).toBe(true);
    expect(posts.every((p) => p.body.content.length <= 2000 && p.body.flags === 4096)).toBe(true);
  });

  it("delete_message only removes the bot's own messages", async () => {
    const d = fakeDiscord();
    const ctx = toolContext(d.fetchImpl);
    const theirs = await run(ctx, "delete_message", { channel_id: C1, message_id: "700000000000000001" });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain("not the bot");
    expect(d.log.some((x) => x.method === "DELETE")).toBe(false);
    const mine = await run(ctx, "delete_message", { channel_id: C1, message_id: "700000000000000002" });
    expect(mine.isError).toBe(false);
  });

  it("reactions encode unicode and custom emoji", async () => {
    const d = fakeDiscord();
    const ctx = toolContext(d.fetchImpl);
    await run(ctx, "add_reaction", { channel_id: C1, message_id: "700000000000000001", emoji: "👀" });
    await run(ctx, "add_reaction", { channel_id: C1, message_id: "700000000000000001", emoji: "<:nyx:123456789012345678>" });
    expect(d.reactions).toEqual(["👀", "nyx:123456789012345678"]);
    expect(() => encodeEmoji("not an emoji/../x")).toThrow();
  });

  it("create_thread from a message, standalone, and as a forum post", async () => {
    const d = fakeDiscord();
    const ctx = toolContext(d.fetchImpl, { channels: CAT });
    const a = await run(ctx, "create_thread", { channel_id: C1, name: "plan", message_id: "700000000000000001", first_message: "kickoff" });
    expect(a.isError).toBe(false);
    expect(d.log.some((x) => x.method === "POST" && x.path === `/channels/${a.data.thread_id}/messages`)).toBe(true);
    // The new thread inherits the allowlist from its parent.
    expect((await run(ctx, "post_message", { channel_id: a.data.thread_id, content: "inside" })).isError).toBe(false);

    const b = await run(toolContext(d.fetchImpl), "create_thread", { channel_id: C2, name: "solo", private: true });
    expect(b.data.type).toBe("private_thread");

    const noBody = await run(toolContext(d.fetchImpl), "create_thread", { channel_id: FORUM, name: "idea" });
    expect(noBody.text).toContain("first_message");
    const c = await run(toolContext(d.fetchImpl), "create_thread", { channel_id: FORUM, name: "idea", first_message: "what if" });
    expect(c.isError).toBe(false);
    expect(c.data.first_message_ids).toBeUndefined();
  });
});

describe("allowlists", () => {
  it("guild allowlist refuses other guilds and DMs", async () => {
    const d = fakeDiscord();
    const ctx = toolContext(d.fetchImpl, { guilds: G1 });
    expect((await run(ctx, "post_message", { channel_id: C9, content: "x" })).text).toContain("DISCORD_ALLOWED_GUILDS");
    expect((await run(ctx, "read_messages", { channel_id: DM })).isError).toBe(true);
    expect((await run(ctx, "read_messages", { channel_id: C1 })).isError).toBe(false);
    expect(d.log.some((x) => x.method === "POST")).toBe(false);
  });

  it("channel allowlist covers threads under a listed channel but not siblings", async () => {
    const d = fakeDiscord();
    const ctx = toolContext(d.fetchImpl, { channels: C1 });
    expect((await run(ctx, "post_message", { channel_id: T1, content: "x" })).isError).toBe(false);
    expect((await run(ctx, "post_message", { channel_id: C2, content: "x" })).text).toContain("DISCORD_ALLOWED_CHANNELS");
  });

  it("a malformed allowlist is a configuration error, not an open door", () => {
    expect(() => toolContext(fakeDiscord().fetchImpl, { channels: "general" })).toThrow(/not a Discord ID/);
  });

  it("discord_request: unrestricted without allowlists", async () => {
    const d = fakeDiscord();
    const r = await run(toolContext(d.fetchImpl), "discord_request", { method: "PATCH", path: `/guilds/${G1}`, body: { name: "x" } });
    expect(r.data.status).toBe(200);
  });

  it("discord_request: scoped when allowlists are set", async () => {
    const d = fakeDiscord();
    const ctx = toolContext(d.fetchImpl, { guilds: G1, channels: C1 });
    expect((await run(ctx, "discord_request", { method: "GET", path: `/channels/${C1}/pins` })).isError).toBe(false);
    expect((await run(ctx, "discord_request", { method: "GET", path: `/channels/${C2}/pins` })).isError).toBe(true);
    expect((await run(ctx, "discord_request", { method: "PATCH", path: `/guilds/${G1}`, body: {} })).text).toContain("Guild-level writes");
    expect((await run(ctx, "discord_request", { method: "POST", path: "/users/@me/channels", body: { recipient_id: "1" } })).text).toContain("only GET");
    // Forwarding from a channel outside the allowlist into an allowed one is refused.
    const fwd = await run(ctx, "discord_request", { method: "POST", path: `/channels/${C1}/messages`, body: { message_reference: { type: 1, channel_id: C9, message_id: "1" } } });
    expect(fwd.isError).toBe(true);
    // Encoded traversal can't escape a channel path.
    const trav = await run(ctx, "discord_request", { method: "PATCH", path: `/channels/${C1}/%2e%2e/%2e%2e/guilds/${G1}`, body: {} });
    expect(trav.isError).toBe(true);
    expect(d.log.some((x) => x.method === "PATCH")).toBe(false);
  });
});

describe("helpers", () => {
  it("splitContent keeps code fences balanced", () => {
    const body = "```ts\n" + Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n```\ndone";
    const parts = splitContent(body);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(2000);
      expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(parts[1].startsWith("```ts\n")).toBe(true);
    expect(splitContent("short")).toEqual(["short"]);
  });

  it("every tool has a strict schema and annotations", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.annotations).toBeDefined();
    }
  });
});
