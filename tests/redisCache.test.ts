import { describe, it, expect, beforeEach, vi } from 'vitest';
import { redisCache, type RedisLikeClient } from '../src/index.js';

/**
 * Hand-rolled in-memory mock of the node-redis v4 surface this provider uses.
 *
 * Records every command so tests can assert behavior (e.g. verify a SET was
 * issued with `EX: 86400` for the default TTL). Exposes the underlying maps
 * so tests can also do whitebox checks if needed.
 */
class FakeRedis implements RedisLikeClient {
  isOpen = false;
  connectCalls = 0;
  failOnConnect = false;
  store = new Map<string, string>();
  // ZSET: key -> ordered array of {score, value}, kept sorted by score asc.
  zsets = new Map<string, { score: number; value: string }[]>();
  ttls = new Map<string, { type: 'EX' | 'PX'; value: number }>();
  commands: Array<{ cmd: string; args: unknown[] }> = [];

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failOnConnect) {
      throw new Error('mock connect failure');
    }
    this.isOpen = true;
  }

  async get(key: string): Promise<string | null> {
    this.commands.push({ cmd: 'GET', args: [key] });
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async set(
    key: string,
    value: string,
    options?: { EX?: number; PX?: number },
  ): Promise<unknown> {
    this.commands.push({ cmd: 'SET', args: [key, value, options] });
    this.store.set(key, value);
    if (options?.EX !== undefined) {
      this.ttls.set(key, { type: 'EX', value: options.EX });
    } else if (options?.PX !== undefined) {
      this.ttls.set(key, { type: 'PX', value: options.PX });
    } else {
      this.ttls.delete(key);
    }
    return 'OK';
  }

  async del(keys: string | string[]): Promise<number> {
    const arr = Array.isArray(keys) ? keys : [keys];
    this.commands.push({ cmd: 'DEL', args: arr });
    let deleted = 0;
    for (const k of arr) {
      if (this.store.delete(k)) deleted += 1;
      if (this.zsets.delete(k)) deleted += 1;
      this.ttls.delete(k);
    }
    return deleted;
  }

  async zAdd(
    key: string,
    member: { score: number; value: string } | { score: number; value: string }[],
  ): Promise<number> {
    this.commands.push({ cmd: 'ZADD', args: [key, member] });
    const list = this.zsets.get(key) ?? [];
    const members = Array.isArray(member) ? member : [member];
    let added = 0;
    for (const m of members) {
      const existingIdx = list.findIndex((x) => x.value === m.value);
      if (existingIdx >= 0) {
        list[existingIdx] = m; // update score
      } else {
        list.push(m);
        added += 1;
      }
    }
    list.sort((a, b) => a.score - b.score);
    this.zsets.set(key, list);
    return added;
  }

  async zCard(key: string): Promise<number> {
    this.commands.push({ cmd: 'ZCARD', args: [key] });
    return (this.zsets.get(key) ?? []).length;
  }

  async zRange(key: string, start: number, stop: number): Promise<string[]> {
    this.commands.push({ cmd: 'ZRANGE', args: [key, start, stop] });
    const list = this.zsets.get(key) ?? [];
    return list.slice(start, stop + 1).map((m) => m.value);
  }

  async zRem(key: string, member: string | string[]): Promise<number> {
    this.commands.push({ cmd: 'ZREM', args: [key, member] });
    const list = this.zsets.get(key);
    if (!list) return 0;
    const arr = Array.isArray(member) ? member : [member];
    const before = list.length;
    const filtered = list.filter((m) => !arr.includes(m.value));
    this.zsets.set(key, filtered);
    return before - filtered.length;
  }

  async *scanIterator(options: { MATCH: string; COUNT?: number }): AsyncIterable<string> {
    this.commands.push({ cmd: 'SCAN', args: [options] });
    // Convert MATCH glob (we only support `*` suffix) to a prefix check.
    const match = options.MATCH;
    const prefix = match.endsWith('*') ? match.slice(0, -1) : match;
    const keys: string[] = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) keys.push(k);
    }
    for (const k of this.zsets.keys()) {
      if (k.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) yield k;
  }
}

describe('redisCache', () => {
  let mock: FakeRedis;

  beforeEach(() => {
    mock = new FakeRedis();
  });

  describe('configuration', () => {
    it('throws if neither url nor client is provided', () => {
      expect(() => redisCache({} as never)).toThrow(/url.*or.*client/i);
    });

    it('accepts a pre-built client (does not require url)', async () => {
      const cache = redisCache({ client: mock });
      await cache.set('k', 'v');
      expect(mock.connectCalls).toBe(1);
      expect(mock.isOpen).toBe(true);
    });

    it('accepts a url (lazy connect)', async () => {
      // We don't actually want to attempt a real connection here. Use a pre-built
      // client to stand in, but verify URL-only construction at least doesn't throw.
      expect(() => redisCache({ url: 'redis://localhost:6379' })).not.toThrow();
    });

    it('throws on invalid maxEntries', () => {
      expect(() => redisCache({ client: mock, maxEntries: 1.5 })).toThrow(/maxEntries/);
      expect(() => redisCache({ client: mock, maxEntries: -2 })).toThrow(/maxEntries/);
    });
  });

  describe('defaults', () => {
    it('with both maxEntries and ttl unset, uses (500, 24h)', async () => {
      const cache = redisCache({ client: mock });
      await cache.set('k', 'v');

      const setCmds = mock.commands.filter((c) => c.cmd === 'SET');
      expect(setCmds).toHaveLength(1);
      expect(setCmds[0].args[2]).toEqual({ EX: 24 * 60 * 60 });

      // maxEntries is enforced (index ZSET is maintained).
      expect(mock.zsets.has('infera:cache:__index')).toBe(true);
    });

    it('with only ttl set, maxEntries is no-limit (no index ZSET)', async () => {
      const cache = redisCache({ client: mock, ttl: '5m' });
      await cache.set('k', 'v');

      const setCmds = mock.commands.filter((c) => c.cmd === 'SET');
      expect(setCmds[0].args[2]).toEqual({ EX: 5 * 60 });

      expect(mock.zsets.has('infera:cache:__index')).toBe(false);
    });

    it('with only maxEntries set, ttl is no-limit (no EX/PX on SET)', async () => {
      const cache = redisCache({ client: mock, maxEntries: 10 });
      await cache.set('k', 'v');

      const setCmds = mock.commands.filter((c) => c.cmd === 'SET');
      expect(setCmds[0].args[2]).toBeUndefined();

      expect(mock.zsets.has('infera:cache:__index')).toBe(true);
    });

    it('with both set, both bounds are enforced', async () => {
      const cache = redisCache({ client: mock, maxEntries: 10, ttl: '1h' });
      await cache.set('k', 'v');

      const setCmds = mock.commands.filter((c) => c.cmd === 'SET');
      expect(setCmds[0].args[2]).toEqual({ EX: 60 * 60 });
      expect(mock.zsets.has('infera:cache:__index')).toBe(true);
    });

    it('ttl: -1 disables expiry (SET without EX/PX)', async () => {
      const cache = redisCache({ client: mock, ttl: -1, maxEntries: 10 });
      await cache.set('k', 'v');

      const setCmds = mock.commands.filter((c) => c.cmd === 'SET');
      expect(setCmds[0].args[2]).toBeUndefined();
    });

    it("ttl: '-1' disables expiry (SET without EX/PX)", async () => {
      const cache = redisCache({ client: mock, ttl: '-1', maxEntries: 10 });
      await cache.set('k', 'v');

      const setCmds = mock.commands.filter((c) => c.cmd === 'SET');
      expect(setCmds[0].args[2]).toBeUndefined();
    });

    it('maxEntries: -1 skips index maintenance', async () => {
      const cache = redisCache({ client: mock, maxEntries: -1, ttl: '5m' });
      await cache.set('k', 'v');

      expect(mock.zsets.has('infera:cache:__index')).toBe(false);
    });

    it('uses PX when ttl is sub-second-aligned ms', async () => {
      const cache = redisCache({ client: mock, ttl: 1500, maxEntries: -1 });
      await cache.set('k', 'v');

      const setCmds = mock.commands.filter((c) => c.cmd === 'SET');
      expect(setCmds[0].args[2]).toEqual({ PX: 1500 });
    });
  });

  describe('get/set roundtrip', () => {
    it('round-trips a string', async () => {
      const cache = redisCache({ client: mock, maxEntries: -1, ttl: -1 });
      await cache.set('hello', 'world');
      expect(await cache.get('hello')).toBe('world');
    });

    it('returns undefined on missing key (not null)', async () => {
      const cache = redisCache({ client: mock, maxEntries: -1, ttl: -1 });
      expect(await cache.get('absent')).toBeUndefined();
    });

    it('honors a custom prefix', async () => {
      const cache = redisCache({
        client: mock,
        prefix: 'mycache:',
        maxEntries: -1,
        ttl: -1,
      });
      await cache.set('k', 'v');
      expect(mock.store.has('mycache:k')).toBe(true);
      expect(mock.store.has('infera:cache:k')).toBe(false);
      expect(await cache.get('k')).toBe('v');
    });
  });

  describe('eviction (maxEntries)', () => {
    it('evicts oldest entry when capacity is exceeded', async () => {
      const cache = redisCache({ client: mock, maxEntries: 3, ttl: -1 });

      // Use real timers, but spread inserts so insertion-time scores differ.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
      await cache.set('a', '1');
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 1));
      await cache.set('b', '2');
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 2));
      await cache.set('c', '3');
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 3));
      await cache.set('d', '4');
      vi.useRealTimers();

      // 'a' should have been evicted.
      expect(await cache.get('a')).toBeUndefined();
      expect(await cache.get('b')).toBe('2');
      expect(await cache.get('c')).toBe('3');
      expect(await cache.get('d')).toBe('4');

      const list = mock.zsets.get('infera:cache:__index')!;
      expect(list.map((m) => m.value)).toEqual(['b', 'c', 'd']);
    });

    it('updates score on re-set (does not double-count toward capacity)', async () => {
      const cache = redisCache({ client: mock, maxEntries: 2, ttl: -1 });
      await cache.set('a', '1');
      await cache.set('a', '1-updated');
      await cache.set('b', '2');

      // Both still present — re-setting 'a' should not have grown the index.
      expect(await cache.get('a')).toBe('1-updated');
      expect(await cache.get('b')).toBe('2');
      const list = mock.zsets.get('infera:cache:__index')!;
      expect(list).toHaveLength(2);
    });
  });

  describe('clear', () => {
    it('removes all prefixed keys including the index ZSET', async () => {
      const cache = redisCache({ client: mock, maxEntries: 10, ttl: '1h' });
      await cache.set('a', '1');
      await cache.set('b', '2');
      expect(mock.store.size).toBeGreaterThan(0);
      expect(mock.zsets.size).toBeGreaterThan(0);

      await cache.clear();

      expect(mock.store.size).toBe(0);
      expect(mock.zsets.size).toBe(0);
    });

    it('does not touch keys outside the prefix', async () => {
      const cache = redisCache({
        client: mock,
        prefix: 'mycache:',
        maxEntries: -1,
        ttl: -1,
      });
      await cache.set('a', '1');
      mock.store.set('other:foo', 'bar');

      await cache.clear();

      expect(mock.store.has('mycache:a')).toBe(false);
      expect(mock.store.has('other:foo')).toBe(true);
    });

    it('is a no-op when nothing matches the prefix', async () => {
      const cache = redisCache({ client: mock, maxEntries: -1, ttl: -1 });
      await expect(cache.clear()).resolves.toBeUndefined();
    });
  });

  describe('connection lifecycle', () => {
    it('connects lazily on first operation (not at construction)', () => {
      redisCache({ client: mock });
      expect(mock.connectCalls).toBe(0);
    });

    it('only connects once across many concurrent operations', async () => {
      const cache = redisCache({ client: mock, maxEntries: -1, ttl: -1 });
      await Promise.all([
        cache.set('a', '1'),
        cache.set('b', '2'),
        cache.set('c', '3'),
        cache.get('a'),
      ]);
      expect(mock.connectCalls).toBe(1);
    });

    it('skips connect if client is already open (e.g. shared pool)', async () => {
      mock.isOpen = true;
      const cache = redisCache({ client: mock, maxEntries: -1, ttl: -1 });
      await cache.set('a', '1');
      expect(mock.connectCalls).toBe(0);
    });

    it('rejects the operation when connect fails', async () => {
      mock.failOnConnect = true;
      const cache = redisCache({ client: mock, maxEntries: -1, ttl: -1 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(cache.set('a', '1')).rejects.toThrow(/connect/i);
      warn.mockRestore();
    });

    it('does not include the password in the warning on connect failure', async () => {
      mock.failOnConnect = true;
      // Provide both: url drives the warning text; client drives the actual call.
      const cache = redisCache({
        client: mock,
        url: 'redis://default:hunter2@example.com:6379',
        maxEntries: -1,
        ttl: -1,
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(cache.set('a', '1')).rejects.toThrow();
      const messages = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('***');
      expect(messages).not.toContain('hunter2');
      warn.mockRestore();
    });
  });
});
