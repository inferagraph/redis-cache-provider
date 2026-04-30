# @inferagraph/redis-cache-provider

Redis-backed [`CacheProvider`](https://github.com/inferagraph/core) for [`@inferagraph/core`](https://github.com/inferagraph/core)'s `AIEngine`. Suitable for production deployments where the built-in in-memory `lruCache` is insufficient — e.g. when you want a cache shared across server processes, persisted across browser reloads, or sized larger than available process memory.

Honors the same `maxEntries` + `ttl` semantics as `lruCache`, so swapping providers is a one-line change.

## Installation

```bash
pnpm add @inferagraph/redis-cache-provider @inferagraph/core redis
```

## Usage

```typescript
import { AIEngine } from '@inferagraph/core';
import { redisCache } from '@inferagraph/redis-cache-provider';

const cache = redisCache({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // Optional bounds. If both are unset, defaults to (500, '24h') — same as lruCache.
  maxEntries: 1000,
  ttl: '12h',
});

const engine = new AIEngine({ /* ... */ });
engine.setCache(cache);
```

### Configuration

| Option | Required | Description |
|---|---|---|
| `url` | One of `url` / `client` | Redis connection URL (e.g. `redis://localhost:6379`, `rediss://...`). |
| `client` | One of `url` / `client` | Pre-built node-redis client. When provided, `url` is ignored. Useful for tests and connection-pool reuse. |
| `prefix` | No | Key prefix to namespace this cache (default `infera:cache:`). Lets multiple InferaGraph instances share a Redis instance without collisions. |
| `maxEntries` | No | Maximum entries to retain. `-1` disables the bound. See defaults note below. |
| `ttl` | No | Time-to-live per entry. Number (ms) or duration string (`5m`, `2h`, `7d`, `1w`). `-1` / `'-1'` disables the bound. |

**Defaults**: when both `maxEntries` and `ttl` are unset, the provider defaults to `(500, '24h')`. When only one is set, the unset bound is treated as no-limit. This matches `lruCache`'s contract.

### Notes

- The provider connects lazily on first operation, so constructing it is cheap and won't throw.
- `maxEntries` is enforced by maintaining a Redis `ZSET` index at `${prefix}__index` keyed by insertion timestamp; on overflow, the oldest key is evicted (insertion-order; not strict LRU).
- `clear()` uses `SCAN` (never `KEYS`) so it is safe on large datasets.

## License

MIT
