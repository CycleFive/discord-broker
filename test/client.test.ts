import { describe, expect, it } from "vitest";
import { DiscordClient, DiscordError, RateLimiter, normalizePath, routeKey } from "../src/discord/client";
import { BOT_TOKEN, C1, jsonRes } from "./fake-discord";

const UA = "DiscordBot (https://broker.test, 0.0.0)";

function scripted(responses: (() => Response)[]) {
  const calls: { url: string; headers: Headers }[] = [];
  let i = 0;
  const f = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: new Headers(init.headers) });
    return responses[Math.min(i++, responses.length - 1)]();
  };
  return { f: f as typeof fetch, calls };
}

function client(f: typeof fetch, extra: Partial<ConstructorParameters<typeof DiscordClient>[0]> = {}, limiter = new RateLimiter()) {
  const slept: number[] = [];
  let t = 1_000_000;
  const c = new DiscordClient(
    { token: BOT_TOKEN, userAgent: UA, sleep: async (ms) => void (slept.push(ms), (t += ms)), now: () => t, ...extra },
    limiter,
    f,
  );
  return { c, slept, limiter };
}

describe("DiscordClient", () => {
  it("sends the bot token and user agent only to the API", async () => {
    const s = scripted([() => jsonRes({ id: "1" })]);
    const { c } = client(s.f);
    await c.call({ path: "/users/@me" });
    expect(s.calls[0].url).toBe("https://discord.com/api/v10/users/@me");
    expect(s.calls[0].headers.get("authorization")).toBe(`Bot ${BOT_TOKEN}`);
    expect(s.calls[0].headers.get("user-agent")).toBe(UA);
  });

  it("refuses URLs and traversal in paths", () => {
    expect(() => normalizePath("https://evil.example/x")).toThrow();
    expect(() => normalizePath("//evil.example/x")).toThrow();
    expect(() => normalizePath("/channels/1/../../x")).toThrow();
    expect(() => normalizePath("/channels/1/%2E%2E/x")).toThrow();
    expect(normalizePath("/api/v10/channels/1")).toBe("/channels/1");
  });

  it("waits out a 429 retry_after and retries", async () => {
    const s = scripted([() => jsonRes({ message: "You are being rate limited.", retry_after: 1.5, global: false }, 429, { "x-ratelimit-scope": "user" }), () => jsonRes({ ok: true })]);
    const { c, slept } = client(s.f);
    expect(await c.call({ path: `/channels/${C1}/messages` })).toEqual({ ok: true });
    expect(slept).toEqual([1500]);
  });

  it("gives up on a long retry_after and reports it", async () => {
    const s = scripted([() => jsonRes({ message: "slow down", retry_after: 60, global: true }, 429)]);
    const { c, limiter } = client(s.f);
    const err = await c.call({ path: "/users/@me" }).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect(err.retryAfterMs).toBe(60_000);
    expect(limiter.globalUntil).toBeGreaterThan(0);
    // The next call doesn't even go out while the global limit lasts.
    await expect(c.call({ path: "/users/@me" })).rejects.toThrow(/retry after/);
    expect(s.calls).toHaveLength(1);
  });

  it("explains Cloudflare's HTML 429 (shared Worker IP)", async () => {
    const s = scripted([() => new Response("<html>error code: 1015</html>", { status: 429, headers: { "content-type": "text/html" } })]);
    const { c } = client(s.f);
    await expect(c.call({ path: "/users/@me" })).rejects.toThrow(/share egress IPs/);
  });

  it("respects an exhausted bucket before sending", async () => {
    const s = scripted([
      () => jsonRes({}, 200, { "x-ratelimit-bucket": "abc", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2" }),
      () => jsonRes({}, 200, { "x-ratelimit-bucket": "abc", "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "5" }),
    ]);
    const { c, slept } = client(s.f);
    await c.call({ method: "POST", path: `/channels/${C1}/messages`, body: {} });
    await c.call({ method: "POST", path: `/channels/${C1}/messages`, body: {} });
    expect(slept).toEqual([2000]);
  });

  it("stops calling for a while after the token is rejected", async () => {
    const s = scripted([() => jsonRes({ message: "401: Unauthorized", code: 0 }, 401)]);
    const { c } = client(s.f);
    await expect(c.call({ path: "/users/@me" })).rejects.toThrow(/wrangler secret put/);
    await expect(c.call({ path: "/users/@me" })).rejects.toThrow(/rejected recently/);
    expect(s.calls).toHaveLength(1);
  });

  it("caps invalid requests well below Discord's ban threshold", async () => {
    const s = scripted([() => jsonRes({ message: "Missing Access", code: 50001 }, 403)]);
    const { c } = client(s.f, { invalidBudget: 3 });
    for (let i = 0; i < 3; i++) await expect(c.call({ path: `/channels/${C1}` })).rejects.toThrow(/Missing Access/);
    await expect(c.call({ path: `/channels/${C1}` })).rejects.toThrow(/invalid-request ban/);
    expect(s.calls).toHaveLength(3);
  });

  it("buckets routes by major parameter", () => {
    expect(routeKey("GET", "/channels/111111/messages/222222").route).toBe("GET /channels/:major/messages/:id");
    expect(routeKey("GET", "/channels/111111/messages/222222").major).toBe("channels/111111");
    expect(routeKey("PUT", "/channels/1111111/messages/2222222/reactions/%F0%9F%91%8D/@me").route).toBe("PUT /channels/:major/messages/:id/reactions/*");
  });
});
