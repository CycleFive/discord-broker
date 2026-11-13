export interface Env {
  /** KV namespace the OAuth library keeps clients, grants and tokens in. */
  OAUTH_KV: KVNamespace;

  /** This Worker's public origin, e.g. https://discord-broker.example.workers.dev (no trailing slash). */
  PUBLIC_URL: string;

  /** The Discord application's ID (the numeric "Application ID", same as its OAuth2 Client ID). Not secret. */
  DISCORD_CLIENT_ID: string;
  /** Discord user IDs allowed to sign in, comma- or space-separated. Numeric IDs only. */
  ALLOWED_DISCORD_USERS: string;

  /** Optional: guild (server) IDs the bot may act in. Empty means every guild the bot is in, plus DMs. */
  DISCORD_ALLOWED_GUILDS?: string;
  /** Optional: channel or category IDs the bot may act in. Threads inherit from their parent channel, channels from their category. */
  DISCORD_ALLOWED_CHANNELS?: string;
  /** Optional: "true" sends PKCE (S256) on the Discord sign-in. Off by default; see README. */
  DISCORD_OAUTH_PKCE?: string;

  /** Optional: comma-separated Origins the MCP endpoint accepts when an Origin header is present. */
  ALLOWED_ORIGINS?: string;
  /** Optional: "true" turns off Client ID Metadata Documents so clients use Dynamic Client Registration. */
  DISABLE_CIMD?: string;

  /** Secret: the bot token (Bot tab, Reset Token). Only ever sent to discord.com. */
  DISCORD_BOT_TOKEN: string;
  /** Secret: the application's OAuth2 client secret, for the sign-in code exchange. */
  DISCORD_CLIENT_SECRET: string;
}
