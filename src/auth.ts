// Sign-in for the MCP endpoint: a consent page, then "Sign in with Discord" through the
// same Discord application's OAuth2 (scope identify), then an allowlist check on the
// Discord user ID. The Discord user token is used once to read /users/@me and then
// revoked; it is never stored.

import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";

export const SCOPE = "discord";

export const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
export const DISCORD_REVOKE = "https://discord.com/api/oauth2/token/revoke";
export const DISCORD_ME = "https://discord.com/api/v10/users/@me";

export interface AuthProps {
  id: string;
  username: string;
}

/** ALLOWED_DISCORD_USERS: numeric Discord user IDs, comma- or space-separated. */
export function parseAllowlist(raw: string | undefined): { ids: Set<string>; bad: string[] } {
  const ids = new Set<string>();
  const bad: string[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (/^\d{5,25}$/.test(entry)) ids.add(entry);
    else bad.push(entry);
  }
  return { ids, bad };
}

export function isAllowed(raw: string | undefined, user: { id: string | number }): boolean {
  return parseAllowlist(raw).ids.has(String(user.id));
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Catch the usual configuration mix-ups before sending anyone to Discord, which answers them with an unhelpful page. */
export function configProblem(env: Env): string | null {
  const cid = env.DISCORD_CLIENT_ID ?? "";
  if (cid.includes(".")) {
    return "DISCORD_CLIENT_ID looks like a bot token, not the Application ID. Reset the bot token in the Developer Portal now (it was in a plain var), then set DISCORD_CLIENT_ID to the numeric Application ID.";
  }
  if (!/^\d{15,25}$/.test(cid)) {
    return "DISCORD_CLIENT_ID is not set to the application's numeric Application ID (Developer Portal, General Information, or OAuth2, Client ID).";
  }
  const { ids, bad } = parseAllowlist(env.ALLOWED_DISCORD_USERS);
  if (bad.length) {
    return `ALLOWED_DISCORD_USERS takes numeric Discord user IDs only, but has: ${bad.join(", ")}. In Discord turn on Developer Mode (Settings, Advanced), then right-click your name and Copy User ID.`;
  }
  if (!ids.size) return "ALLOWED_DISCORD_USERS is empty, so nobody could sign in.";
  if (!env.DISCORD_CLIENT_SECRET) return "DISCORD_CLIENT_SECRET is not set (wrangler secret put DISCORD_CLIENT_SECRET).";
  return null;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string, headers?: Headers, status = 200): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#e8e8e8;background:#161616}}
code{font-size:.95em}.warn{border-left:3px solid #c80;padding-left:.8rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style></head>
<body>${body}</body></html>`,
    { status, headers: h },
  );
}

export function consentPage(d: ConsentDescription, handle: string, headers: Headers): Response {
  const who = d.clientDomain ? `${escapeHtml(d.clientName)} (verified domain ${escapeHtml(d.clientDomain)})` : escapeHtml(d.clientName);
  return page(
    "Connect Discord broker",
    `<h1>Connect Discord broker</h1>
<p><strong>${who}</strong> wants to act as this server's Discord bot: read and post wherever the bot is allowed.</p>
<p>Access will be sent to <code>${escapeHtml(d.redirectHost)}</code>${d.redirectIsLoopback ? " (an app on this computer)" : ""}.</p>
<p class="warn">Only continue if you started this yourself, from Claude, and that host is <code>claude.ai</code> (or <code>localhost</code> for Claude Code).</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">Continue to Discord</button>
<button name="decision" value="deny">Deny</button>
</form>`,
    headers,
  );
}

export function errorPage(message: string, status = 400): Response {
  return page("Sign-in failed", `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>`, undefined, status);
}

async function sha256b64url(s: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

function randomVerifier(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64url(b);
}

function redirect(location: string, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("Location", location);
  return new Response(null, { status: 302, headers: h });
}

function renderAuthError(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    console.log(JSON.stringify({ event: "authorize_error", code: e.code, description: e.description, redirect: Boolean(e.redirectTo) }));
    if (e.redirectTo) return redirect(e.redirectTo);
    return errorPage(e.description, 400);
  }
  if (e instanceof CimdFetchError) {
    // The client identified itself by a metadata URL that this Worker could not fetch.
    console.log(JSON.stringify({ event: "cimd_fetch_failed", url: e.metadataUrl, detail: e.detail }));
    return errorPage(`Could not fetch the client's metadata document (${e.metadataUrl}): ${e.detail}. Setting DISABLE_CIMD="true" makes clients register instead.`, 502);
  }
  console.log(JSON.stringify({ event: "authorize_exception", message: (e as Error)?.message }));
  return errorPage(`Unexpected error: ${(e as Error)?.message ?? String(e)}`, 500);
}

/** GET and POST /authorize. */
export async function handleAuthorize(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  try {
    if (request.method === "GET") {
      const authReq = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      return consentPage(details, consent.handle, consent.headers);
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // One scope covers everything; offline_access lets the client refresh without a new sign-in.
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE, "offline_access"] });

    const problem = configProblem(env);
    if (problem) {
      console.log(JSON.stringify({ event: "config_error", message: problem }));
      return errorPage(problem, 500);
    }
    const pkce = env.DISCORD_OAUTH_PKCE === "true";
    const verifier = pkce ? randomVerifier() : "";
    const up = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    const dc = new URL(DISCORD_AUTHORIZE);
    dc.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
    dc.searchParams.set("response_type", "code");
    dc.searchParams.set("redirect_uri", `${publicUrl(env)}/callback`);
    dc.searchParams.set("scope", "identify");
    dc.searchParams.set("state", up.state);
    if (pkce) {
      dc.searchParams.set("code_challenge", await sha256b64url(verifier));
      dc.searchParams.set("code_challenge_method", "S256");
    }
    return redirect(dc.toString(), up.headers);
  } catch (e) {
    return renderAuthError(e);
  }
}

/** GET /callback from Discord. */
export async function handleCallback(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
  ctx: ExecutionContext,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<Response> {
  let resumed;
  try {
    resumed = await oauth.finishUpstream<{ verifier: string }>(request);
  } catch (e) {
    return renderAuthError(e);
  }
  const { request: authReq, data, headers } = resumed;
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    console.log(JSON.stringify({ event: "sign_in_cancelled", error: params.get("error"), description: params.get("error_description") }));
    return redirect(authorizationErrorRedirect(authReq, "access_denied", "Discord sign-in was cancelled"), headers);
  }

  const basic = `Basic ${btoa(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`)}`;
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${publicUrl(env)}/callback` });
  if (data.verifier) form.set("code_verifier", data.verifier);
  const tokenRes = await fetchImpl(DISCORD_TOKEN, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": userAgent(env) },
    body: form.toString(),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!tok.access_token) {
    console.log(JSON.stringify({ event: "token_exchange_failed", status: tokenRes.status, error: tok.error, description: tok.error_description }));
    const hint =
      tok.error === "invalid_client"
        ? " Check DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (the OAuth2 client secret, not the bot token)."
        : tok.error === "invalid_grant"
          ? " The redirect URI registered on the Discord application must be exactly PUBLIC_URL + /callback."
          : "";
    return errorPage(`Discord did not return a token (${tok.error ?? tokenRes.status}${tok.error_description ? `: ${tok.error_description}` : ""}).${hint}`, 502);
  }

  const userRes = await fetchImpl(DISCORD_ME, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json", "User-Agent": userAgent(env) },
  });
  const user = (await userRes.json().catch(() => ({}))) as { id?: string; username?: string };

  // The user token was only needed for /users/@me. Revoke it so nothing lingers.
  ctx.waitUntil(
    fetchImpl(DISCORD_REVOKE, {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent(env) },
      body: new URLSearchParams({ token: tok.access_token, token_type_hint: "access_token" }).toString(),
    }).then(
      () => undefined,
      () => undefined,
    ),
  );

  if (!user.id || !user.username) {
    console.log(JSON.stringify({ event: "user_read_failed", status: userRes.status }));
    return errorPage("Could not read your Discord account.", 502);
  }
  if (!isAllowed(env.ALLOWED_DISCORD_USERS, { id: user.id })) {
    console.log(JSON.stringify({ event: "sign_in_refused", username: user.username, id: user.id }));
    return errorPage(`Discord account ${user.username} (ID ${user.id}) is not in ALLOWED_DISCORD_USERS.`, 403);
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: authReq,
    userId: user.id,
    metadata: { username: user.username },
    scope: authReq.scope,
    props: { id: user.id, username: user.username } satisfies AuthProps,
  });
  console.log(JSON.stringify({ event: "sign_in", username: user.username, id: user.id, client: authReq.clientId }));
  return redirect(redirectTo, headers);
}

export const VERSION = "0.1.0";

export function userAgent(env: Env): string {
  return `DiscordBot (${env.PUBLIC_URL || "https://github.com/cycle-five"}, ${VERSION}) discord-broker`;
}

export function publicUrl(env: Env): string {
  if (!env.PUBLIC_URL) throw new Error("PUBLIC_URL is not set");
  return env.PUBLIC_URL.replace(/\/+$/, "");
}
