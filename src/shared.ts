// Isolate-wide state, shared by the public entry (index.ts) and the internal Feed entrypoint:
// rate-limit buckets and the channel -> guild/parent cache.

import { RateLimiter } from "./discord/client";
import { ChannelCache } from "./discord/scope";

export const limiter = new RateLimiter();
export const channels = new ChannelCache();
