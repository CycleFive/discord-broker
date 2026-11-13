// Thin Discord REST client that authenticates as the bot. The token is only ever put in
// the Authorization header of requests to the API base; it is never logged or returned.

export const API_BASE = "https://discord.com/api/v10";

export interface DiscordRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Written to the guild audit log (X-Audit-Log-Reason) where Discord supports it. */
  reason?: string;
}

export interface DiscordResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  data: unknown;
}

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.startsWith("//") || /^\/*[a-z][a-z0-9+.-]*:/i.test(path.slice(1)) || /(^|\/)\.\.?(\/|$)/.test(path) || /%2e|%2f|%5c/i.test(path) || path.includes("\\")) {
    throw new Error("path must be an API path such as /channels/123/messages, not a URL");
  }
  // Callers pass paths relative to /api/v10; tolerate a pasted prefix.
  return path.replace(/^\/api(\/v\d+)?(?=\/)/, "");
}

/**
 * Discord's per-route buckets are keyed by the route with its "major parameter"
 * (channel, guild or webhook id) kept and every other id collapsed.
 */
export function routeKey(method: string, path: string): { route: string; major: string } {
  const p = path.split("?")[0];
  const m = p.match(/^\/(channels|guilds|webhooks)\/(\d+)/);
  const major = m ? `${m[1]}/${m[2]}` : "";
  const rest = m ? p.slice(m[0].length) : p;
  let collapsed = rest.replace(/\/\d{5,}/g, "/:id");
  // All reaction routes on a message share a bucket regardless of emoji.
  collapsed = collapsed.replace(/\/reactions\/.*$/, "/reactions/*");
  return { route: `${method} ${m ? `/${m[1]}/:major` : ""}${collapsed}`, major };
}

interface BucketState {
  remaining: number;
  resetAt: number;
}

/** Isolate-wide rate-limit memory: route -> bucket hash, bucket -> state, plus global and auth breakers. */
export class RateLimiter {
  readonly routeBuckets = new Map<string, string>();
  readonly buckets = new Map<string, BucketState>();
  globalUntil = 0;
  /** After a 401 the token is presumed bad: stop calling for a while so we don't rack up invalid requests. */
  authFailedUntil = 0;
  /** 401/403/429 (non-shared) answers in the current window, to stay far below Discord's 10,000/10 min ban. */
  invalid = { windowStart: 0, count: 0 };

  bucketKey(method: string, path: string): string {
    const { route, major } = routeKey(method, path);
    return `${this.routeBuckets.get(route) ?? route}|${major}`;
  }
}

export interface ClientOptions {
  token: string;
  userAgent: string;
  apiBase?: string;
  /** Longest single wait for a rate limit before giving up and reporting it. */
  maxWaitMs?: number;
  /** Most invalid (401/403/429) answers per 10 minutes before the client refuses to send. */
  invalidBudget?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const AUTH_BACKOFF_MS = 5 * 60_000;
const INVALID_WINDOW_MS = 10 * 60_000;

export class DiscordClient {
  private readonly apiBase: string;
  private readonly maxWaitMs: number;
  private readonly invalidBudget: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly opts: ClientOptions,
    private readonly limiter: RateLimiter,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.apiBase = opts.apiBase ?? API_BASE;
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
    this.invalidBudget = opts.invalidBudget ?? 1_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  async request(req: DiscordRequest): Promise<DiscordResponse> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = normalizePath(req.path);
    const url = new URL(this.apiBase + path);
    if (url.origin !== new URL(this.apiBase).origin) throw new Error("path resolved outside the Discord API");
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      await this.#waitForCapacity(method, path);
      const headers: Record<string, string> = {
        Authorization: `Bot ${this.opts.token}`,
        "User-Agent": this.opts.userAgent,
      };
      let body: string | undefined;
      if (req.body !== undefined && req.body !== null) {
        headers["Content-Type"] = "application/json";
        body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }
      if (req.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(req.reason.slice(0, 512));

      const res = await this.fetchImpl(url.toString(), { method, headers, body, redirect: "manual" });
      this.#record(method, path, res);
      const data = await readBody(res);

      if (res.status === 429) {
        const scope = res.headers.get("x-ratelimit-scope");
        if (scope !== "shared") this.#countInvalid();
        if (!data || typeof data !== "object") {
          // Not Discord's JSON: Cloudflare's edge refused this Worker's (shared) egress IP.
          throw new DiscordError(
            429,
            "Discord's Cloudflare edge rate-limited this Worker's outgoing IP (an HTML 429, usually error 1015). " +
              "Workers share egress IPs, so this can be someone else's traffic. It normally clears within an hour; retry later.",
          );
        }
        const d = data as { retry_after?: number; global?: boolean; message?: string };
        const waitMs = Math.ceil((Number(d.retry_after ?? res.headers.get("retry-after") ?? 1) || 1) * 1000);
        if (d.global || scope === "global") this.limiter.globalUntil = this.now() + waitMs;
        if (attempt < 2 && waitMs <= this.maxWaitMs) {
          await this.sleep(waitMs);
          continue;
        }
        throw new DiscordError(429, `Discord rate limit (${scope ?? "route"}): retry after ${(waitMs / 1000).toFixed(1)} s`, data, waitMs);
      }
      if (res.status === 401) {
        this.#countInvalid();
        this.limiter.authFailedUntil = this.now() + AUTH_BACKOFF_MS;
      } else if (res.status === 403) {
        this.#countInvalid();
      }
      return { status: res.status, ok: res.ok, headers: res.headers, data };
    }
  }

  /** Like request(), but throws DiscordError on a non-2xx answer. */
  async call<T = any>(req: DiscordRequest): Promise<T> {
    const res = await this.request(req);
    if (!res.ok) {
      const d = res.data as { message?: string; code?: number; errors?: unknown } | string | null;
      let msg = "";
      if (d && typeof d === "object") {
        msg = `${d.message ?? ""}${d.code !== undefined ? ` (code ${d.code})` : ""}`;
        if (d.errors) msg += ` ${JSON.stringify(d.errors).slice(0, 500)}`;
      } else if (typeof d === "string") msg = d.slice(0, 300);
      if (res.status === 401) msg += ". The bot token was rejected; set DISCORD_BOT_TOKEN again with `wrangler secret put`.";
      if (res.status === 403) msg += ". The bot lacks a permission here (see README, Permissions).";
      throw new DiscordError(res.status, `Discord ${req.method ?? "GET"} ${req.path} -> ${res.status} ${msg}`.trim(), res.data);
    }
    return res.data as T;
  }

  async #waitForCapacity(method: string, path: string) {
    const l = this.limiter;
    const now = this.now();
    if (l.authFailedUntil > now) {
      throw new DiscordError(401, "The bot token was rejected recently; not calling Discord again for a few minutes. Set DISCORD_BOT_TOKEN again with `wrangler secret put`.");
    }
    if (now - l.invalid.windowStart < INVALID_WINDOW_MS && l.invalid.count >= this.invalidBudget) {
      throw new DiscordError(429, "Too many refused requests in the last 10 minutes; pausing to stay clear of Discord's invalid-request ban.");
    }
    let wait = Math.max(0, l.globalUntil - now);
    const b = l.buckets.get(l.bucketKey(method, path));
    if (b && b.remaining <= 0 && b.resetAt > now) wait = Math.max(wait, b.resetAt - now);
    if (wait > this.maxWaitMs) {
      throw new DiscordError(429, `Discord rate limit: retry after ${(wait / 1000).toFixed(1)} s`, undefined, wait);
    }
    if (wait > 0) await this.sleep(wait);
  }

  #record(method: string, path: string, res: Response) {
    const bucket = res.headers.get("x-ratelimit-bucket");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const resetAfter = res.headers.get("x-ratelimit-reset-after");
    if (!bucket) return;
    const { route, major } = routeKey(method, path);
    this.limiter.routeBuckets.set(route, bucket);
    if (remaining !== null && resetAfter !== null) {
      this.limiter.buckets.set(`${bucket}|${major}`, {
        remaining: Number(remaining),
        resetAt: this.now() + Math.ceil(Number(resetAfter) * 1000),
      });
    }
  }

  #countInvalid() {
    const inv = this.limiter.invalid;
    const now = this.now();
    if (now - inv.windowStart >= INVALID_WINDOW_MS) {
      inv.windowStart = now;
      inv.count = 0;
    }
    inv.count++;
  }
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("json") && text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text || null;
}
