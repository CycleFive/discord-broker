# discord-broker

A remote MCP server on Cloudflare Workers that lends an MCP client (Claude) a Discord bot.
The bot token lives only in the Worker's secret store. The client never sees it, only tool
results.

```
Claude ──OAuth bearer──▶ /mcp ──▶ scope check ──▶ tools ──"Bot <token>"──▶ discord.com/api/v10
                                                    │
                                                    └─ rate-limit buckets, 429 retry, 401 breaker
```

It's the twin of `github-broker`: same OAuth front door, same hand-written MCP transport,
same audit logging. Sign-in goes through Discord instead of GitHub.

## What you get

| Tool | What it does |
| --- | --- |
| `bot_info` | The bot's identity, which privileged intents its application has (Message Content above all), the active allowlists, and who is signed in. Never returns the token. |
| `list_guilds` | Servers the bot is in (filtered by the allowlist), with its permission bits. |
| `list_channels` | A server's channels, categories first, plus active threads. |
| `read_messages` | Up to 100 messages, oldest first, paged with `before` / `after` / `around`. Compact by default (author, content, replies, attachments, embeds, reactions, threads); `raw` gives Discord's objects. Adds a note when other people's messages come back empty (see Message Content below). |
| `get_message` | One message, the message it replies to, and a jump link. |
| `post_message` | Send as the bot. `reply_to` makes it a reply. Text over 2000 characters is split on line breaks with code fences kept valid, and only the first part replies. Mentions are safe by default: users ping, `@everyone`/`@here` and roles don't unless `allow_mentions` says so. `silent` and `suppress_embeds` flags. |
| `edit_message` | Replace the text of one of the bot's messages. |
| `delete_message` | Delete one of the bot's own messages. Refuses anyone else's, even if the bot could. |
| `add_reaction` / `remove_reaction` | Unicode emoji as the character, custom emoji as `name:id` or `<:name:id>`. |
| `create_thread` | From a message, standalone (public or private) in a text channel, or as a post in a forum/media channel. `first_message` goes into the new thread. |
| `discord_request` | Any REST endpoint: method, path under `/api/v10`, query, JSON body, audit-log reason. Scoped by the allowlists (below). |

IDs are numeric strings. Every tool call writes one audit line (tool, signed-in Discord
user, guild or channel, ok, ms; never message text) to Workers Logs. Discord shows
everything as the bot.

## Auth

The connector URL alone grants nothing. `/mcp` is an OAuth 2.1 protected resource, and
the Worker is its own authorization server
([`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
1.2.4, the one runtime dependency):

1. Claude finds the server from the `401` challenge and registers itself (Client ID
   Metadata Document, or Dynamic Client Registration as a fallback). PKCE S256 throughout.
2. `/authorize` shows a consent page naming the client and the host the grant goes to.
   Approve only when it says `claude.ai` (or `localhost` for Claude Code).
3. You sign in with Discord, through **the same Discord application's** OAuth2 with scope
   `identify` only. The Worker reads `/users/@me` once, revokes that user token, and checks
   your numeric Discord user ID against `ALLOWED_DISCORD_USERS`.
4. Claude gets a 1-hour access token plus a rotating refresh token, both bound to
   `PUBLIC_URL/mcp`. The allowlist is checked again on every MCP request, so removing an
   ID cuts off existing tokens immediately.

Before redirecting to Discord the Worker checks its own config and shows a plain error
page instead of Discord's: a non-numeric or placeholder `DISCORD_CLIENT_ID`, a bot token
pasted into `DISCORD_CLIENT_ID` (it tells you to reset the token), a username in
`ALLOWED_DISCORD_USERS`, a missing client secret. A failed code exchange says whether the
client secret or the redirect URI is the likely cause. All of these are logged for
`wrangler tail`.

PKCE towards Discord is off by default. Discord's docs say to use the authorization code
grant "with PKCE" but document no PKCE parameters, so the default flow relies on the
client secret plus the cookie-bound `state`. Set `DISCORD_OAUTH_PKCE="true"` to send
`code_challenge`/`code_verifier` as well; if sign-in then fails at the code exchange, turn
it back off.

## Where the bot may act

Two optional vars, both numeric IDs, comma- or space-separated:

- `DISCORD_ALLOWED_GUILDS`: only channels in these servers. DMs are refused.
- `DISCORD_ALLOWED_CHANNELS`: only these channels, plus threads under them and channels
  under a listed category.

Both empty means anywhere the bot can reach, DMs included. A malformed entry makes every
tool call fail with a config error rather than opening up. `discord_request` follows the
same lists: `/channels/ID/...` must name an allowed channel (and a forward's source
channel must be allowed too), `/guilds/ID/...` an allowed server (read-only while a
channel list is set), and any other path is GET only. Discord's own permissions for the
bot still apply on top, and are the real limit when both lists are empty.

## Message Content intent (checked against Discord's docs)

A common assumption is that the intent only matters for the gateway.
It doesn't: Discord's gateway docs say `MESSAGE_CONTENT` "permits your app to receive
message content data across the APIs", and apps without it "receive empty values" in
`content`, `embeds`, `attachments`, `components` and `poll`, REST reads included. The
exceptions are the bot's own messages, DMs with the bot, and messages that mention it.

So for `read_messages` to show what Nyx, Muse and you write, turn on **Message Content
Intent** on the application's Bot page. Under 100 servers that's a toggle, no review.
`bot_info` shows whether it's on, and `read_messages` adds a note when it sees the
telltale empty messages.

## Permissions

Invite the bot with these permissions (integer `377957207104`):

| Permission | For |
| --- | --- |
| View Channels | everything |
| Read Message History | `read_messages`, `get_message` |
| Send Messages | `post_message` |
| Send Messages in Threads | posting inside threads (Send Messages doesn't cover them) |
| Add Reactions | a new emoji on a message |
| Create Public Threads / Create Private Threads | `create_thread` |
| Embed Links | link previews in its own messages |

Channel overrides can still hide channels from it; `list_channels` shows what this server
allows, not what Discord lets the bot read. A 403 from Discord comes back as "the bot lacks
a permission here".

## Rate limits

- Per-route buckets from `X-RateLimit-Bucket` / `Remaining` / `Reset-After`, keyed by the
  major parameter (channel, guild, webhook), shared across requests in an isolate. An
  exhausted bucket is waited out before sending.
- A `429` with `retry_after` up to 10 s is waited out and retried (twice at most); longer
  ones come back as an error with the wait. A global 429 pauses every route.
- After a `401` the Worker stops calling Discord for 5 minutes, and it caps refused
  answers (401/403/429) at 1,000 per 10 minutes. Discord bans an IP for a while after
  10,000 invalid requests in 10 minutes, and Workers share egress IPs, so a bad token
  shouldn't be allowed to hammer it.
- **Known risk:** Discord's Cloudflare edge sometimes answers Workers with an HTML 429
  (error 1015) because of someone else's traffic on the shared IP. The Worker reports
  that plainly. It usually clears on its own; if it becomes chronic, the fix is a proxy
  with its own IP, not anything in this code.

## Setup

You need Node 20+ and a Cloudflare account. The examples assume a new Discord application
for Claude; see "Which bot" below.

### 1. Discord application

[Developer Portal](https://discord.com/developers/applications) → New Application (e.g.
"Claude"), then:

- **General Information**: copy the **Application ID** (numeric). That's `DISCORD_CLIENT_ID`.
- **Bot**: Reset Token, and keep it for step 4 without pasting it anywhere else. Turn on
  **Message Content Intent**. Turning off "Public Bot" stops other people adding it to
  their servers.
- **OAuth2**: Reset Secret, keep it for step 4 (`DISCORD_CLIENT_SECRET`; this is not the
  bot token). Add a **Redirect**: `https://<your-worker-host>/callback`. You learn the
  host in step 3; come back then. It must match exactly, no trailing slash.
- **Invite the bot**: open
  `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=377957207104`
  and pick your agents' server.

Your Discord user ID: Settings → Advanced → Developer Mode on, then right-click your name →
Copy User ID. Server and channel IDs come the same way, for the optional allowlists.

### 2. Configure

```sh
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

`wrangler.jsonc` is git-ignored: it holds your own IDs and URL, no secrets. Paste the KV
id into it, then fill in `vars`: `DISCORD_CLIENT_ID`,
`ALLOWED_DISCORD_USERS` (your numeric user ID, not a username), and optionally
`DISCORD_ALLOWED_GUILDS` / `DISCORD_ALLOWED_CHANNELS`.

### 3. First deploy, to learn the URL

```sh
npx wrangler deploy
```

It prints `https://discord-broker.<subdomain>.workers.dev`. Put that in `PUBLIC_URL` (no
trailing slash), and add `<PUBLIC_URL>/callback` as the OAuth2 Redirect on the Discord
application.

### 4. Secrets

Paste each at the prompt so it never lands in shell history or a file:

```sh
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_CLIENT_SECRET
```

### 5. Deploy and smoke test

```sh
npx wrangler deploy
curl -si -X POST "$PUBLIC_URL/mcp" -d '{}' | grep -i www-authenticate   # 401 + resource_metadata
curl -s "$PUBLIC_URL/.well-known/oauth-authorization-server" | jq .issuer
```

### 6. Connect

- **claude.ai**: Settings → Connectors → Add custom connector. Name it, and give the URL
  `<PUBLIC_URL>/mcp` exactly (the resource metadata must match it). **Leave Advanced
  settings blank**: no client ID or secret there. You'll see the consent page (check it
  says `claude.ai`), then Discord's "authorize" screen asking only for your username.
- **Claude Code**: `claude mcp add --transport http discord-broker <PUBLIC_URL>/mcp`.

Then ask for `bot_info`: it should show the bot's name and `message_content: enabled`.

### If sign-in fails

| You see | Usually |
| --- | --- |
| The Worker's "Sign-in failed" page about `DISCORD_CLIENT_ID` or `ALLOWED_DISCORD_USERS` | Exactly what it says; fix the var and deploy. |
| Discord says "Invalid OAuth2 redirect_uri" | The Redirect on the application isn't exactly `<PUBLIC_URL>/callback`. |
| "Discord did not return a token (invalid_client)" | Wrong client secret (the OAuth2 secret, not the bot token) or wrong Application ID. |
| "not in ALLOWED_DISCORD_USERS" | The page names the account and its ID; put that ID in the var. |
| Tools answer "bot token was rejected" | `wrangler secret put DISCORD_BOT_TOKEN` again (tokens die when reset). |

`npx wrangler tail` shows every sign-in step as a JSON line (`config_error`,
`token_exchange_failed`, `sign_in_refused`, `sign_in`, `oauth_endpoint`, `tool_call`).

## Which bot

Claude can use a new application of its own or one of the existing ones. A separate
"Claude" application keeps its messages, permissions, intents and token separate from Nyx
and Muse, and you can kick or reset it without touching them. Reusing one would make Claude
post under that agent's name.

## Operating it

- **Logs**: `npx wrangler tail`, or Workers Logs in the dashboard (`observability` is on).
- **Cut someone off**: remove them from `ALLOWED_DISCORD_USERS` and deploy. Takes effect on
  the next request.
- **Rotate the token**: Bot → Reset Token, then `wrangler secret put DISCORD_BOT_TOKEN`.
  The old token stops working the moment you reset it.
- **Kill switch**: kick the bot from the server, or reset its token.
- **Narrow it**: set `DISCORD_ALLOWED_GUILDS` / `DISCORD_ALLOWED_CHANNELS` and deploy, or
  take permissions away from its role in Discord.

## Development

```sh
npm test            # vitest: client (rate limits, breakers), tools, scope, MCP conformance, full OAuth flow
npm run typecheck
cp .dev.vars.example .dev.vars && npm run dev   # local workerd on :8787
```

The tests run the server against the official MCP clients (`@modelcontextprotocol/client`
2.4 in 2026-07-28 and legacy modes, `@modelcontextprotocol/sdk` 1.32), and walk the whole
sign-in: registration → consent → Discord (faked) → token → MCP calls. Discord's API is
faked at the fetch layer; no test touches a real token.

Layout: `src/index.ts` (routing, OAuth roles), `src/auth.ts` (consent, Discord sign-in,
allowlist, config checks), `src/mcp.ts` (transport, identical to github-broker's),
`src/tools.ts`, `src/discord/client.ts` (REST client, rate limits),
`src/discord/scope.ts` (guild/channel allowlists).

Not covered yet: uploading files (multipart), slash commands and interactions, the
gateway (the Worker only speaks REST, so it can't be woken by a mention; Claude reads
when asked).

## License

MIT — see [LICENSE](LICENSE).
