// discord-broker: a remote MCP server that lends Claude a Discord bot without ever
// handing over the bot token.
//
//   /mcp                                   MCP endpoint (OAuth bearer required)
//   /.well-known/oauth-protected-resource  RFC 9728 metadata (resource server)
//   /.well-known/oauth-authorization-server, /oauth/token, /oauth/register  (library)
//   /authorize, /callback                  consent page + Sign in with Discord

import {
  OAuthAuthorizationServer,
  OAuthResourceServer,
  insufficientScope,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { AuthProps, SCOPE, VERSION, handleAuthorize, handleCallback, isAllowed, publicUrl, userAgent } from "./auth";
import { DiscordClient, RateLimiter } from "./discord/client";
import { ChannelCache, Scope } from "./discord/scope";
import type { Env } from "./env";
import { handleMcp } from "./mcp";

const INSTRUCTIONS =
  "Tools act as a Discord bot. IDs are numeric strings (servers = guilds). Start with list_guilds and list_channels; " +
  "read_messages pages with before/after; post_message replies with reply_to and splits long text. " +
  "Other people's message text is empty unless the bot's application has the Message Content intent (bot_info shows it). " +
  "discord_request reaches any other REST endpoint.";

// Isolate-wide state: rate-limit buckets and the channel -> guild/parent cache.
const limiter = new RateLimiter();
const channels = new ChannelCache();

interface Roles {
  key: string;
  as: OAuthAuthorizationServer<Env>;
  rs: OAuthResourceServer<Env, AuthProps>;
}
let roles: Roles | undefined;

function getRoles(env: Env): Roles {
  const url = publicUrl(env);
  const key = `${url}|${env.DISABLE_CIMD ?? ""}`;
  if (roles && roles.key === key) return roles;
  const resource = `${url}/mcp`;

  const as = new OAuthAuthorizationServer<Env>({
    issuer: url,
    resources: [resource],
    scopesSupported: [SCOPE, "offline_access"],
    clientRegistrationEndpoint: "/oauth/register",
    // Claude prefers CIMD when advertised. DISABLE_CIMD="true" forces Dynamic Client Registration.
    clientIdMetadataDocumentEnabled: env.DISABLE_CIMD !== "true",
    accessTokenTTL: 3600,
  });

  const rs = new OAuthResourceServer<Env, AuthProps>({
    resourceMetadata: { resource, authorization_servers: [url], resource_name: "Discord broker" },
    requiredScopes: [SCOPE],
    validateToken: (e) => (res, token) => as.validateToken<AuthProps>(res, token, e),
    handler: {
      async fetch(request: Request, env: Env, ctx: OAuthResourceContext<AuthProps>) {
        if (!ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);
        const props = ctx.props;
        // Re-check on every request, so removing someone from the allowlist takes effect at once.
        if (!props || !isAllowed(env.ALLOWED_DISCORD_USERS, props)) {
          return new Response("Forbidden", { status: 403 });
        }
        return handleMcp(
          request,
          () => ({
            dc: new DiscordClient({ token: required(env, "DISCORD_BOT_TOKEN"), userAgent: userAgent(env) }, limiter),
            scope: new Scope(env.DISCORD_ALLOWED_GUILDS, env.DISCORD_ALLOWED_CHANNELS, channels),
            user: props,
          }),
          {
            serverInfo: { name: "discord-broker", title: "Discord broker", version: VERSION },
            instructions: INSTRUCTIONS,
            allowedOrigins: env.ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
          },
        );
      },
    },
  });

  roles = { key, as, rs };
  return roles;
}

function required(env: Env, key: keyof Env): string {
  const v = env[key];
  if (typeof v !== "string" || !v) throw new Error(`${key} is not set`);
  return v;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.log(JSON.stringify({ event: "unhandled", method: request.method, path: new URL(request.url).pathname, message: (e as Error)?.message }));
      return new Response(`Internal error: ${(e as Error)?.message ?? "unknown"}\n`, { status: 500, headers: { "Content-Type": "text/plain" } });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { as, rs } = getRoles(env);

  if (pathname === "/authorize") return handleAuthorize(request, env, as.getOAuthApi(env));
  if (pathname === "/callback") return handleCallback(request, env, as.getOAuthApi(env), ctx);
  if (pathname === "/mcp" || pathname.startsWith("/mcp/") || pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return rs.fetch(request, env, ctx);
  }
  if (pathname === "/" && request.method === "GET") {
    return new Response(`discord-broker ${VERSION}: MCP endpoint at ${publicUrl(env)}/mcp\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  // Log every OAuth endpoint hit (path and status only) to make connector problems visible in `wrangler tail`.
  const res = await as.fetch(request, env, ctx);
  console.log(JSON.stringify({ event: "oauth_endpoint", method: request.method, path: pathname, status: res.status }));
  return res;
}
