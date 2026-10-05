import { describe, expect, it, vi } from 'vitest';
import { KvCache } from '@durable-dav/backend-runtime/kv';
import type { KvNamespaceLike } from '@durable-dav/backend-runtime/kv';
import { buildKvKey, clampTtl, digest128, KV_DOMAINS, KV_MAX_KEY_LENGTH } from '@durable-dav/backend-runtime/kv';
import { Tokens, createRequestScope } from '@durable-dav/backend-services/composition';
import {
  MAX_CACHED_FILE_BYTES,
  base64ToBytes,
  bytesToBase64,
  cacheControlFor,
  cacheKeyForVolume,
  etagForPropfind,
  getCachedFile,
  getCachedPropfind,
  getCachedVolumeList,
  hashBody,
  invalidateVolumeCaches,
  invalidateVolumeListCache,
  isFresh,
  putCachedFile,
  putCachedPropfind,
  putCachedVolumeList,
} from '../apps/api/src/workers/routes/DavReadCache';

// In-memory fake of the single CACHE binding (structural KvNamespaceLike).
// Ported from ../Git `test/kv-cache.test.ts`.
function makeFakeKv(
  initial: Record<string, string> = {},
): KvNamespaceLike & { store: Map<string, string>; seen: Array<{ key: string; ttl?: number }> } {
  const store = new Map(Object.entries(initial));
  const seen: Array<{ key: string; ttl?: number }> = [];
  return {
    store,
    seen,
    get(key: string): Promise<string | null> {
      return Promise.resolve(store.has(key) ? (store.get(key) as string) : null);
    },
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      seen.push({ key, ttl: options?.expirationTtl });
      store.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      return Promise.resolve(store.delete(key));
    },
    list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
      keys: Array<{ name: string }>;
      list_complete: boolean;
      cursor?: string;
    }> {
      const names = [...store.keys()].filter((name) => name.startsWith(options.prefix)).sort();
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const next = start + limit;
      return Promise.resolve({
        keys: page.map((name) => ({ name })),
        list_complete: next >= names.length,
        cursor: next >= names.length ? undefined : String(next),
      });
    },
  };
}

describe('dav KV domains', () => {
  it('registers davProp/davFile/davMeta alongside the Git-ported domains', () => {
    expect(KV_DOMAINS.davProp.ttlSeconds).toBe(120);
    expect(KV_DOMAINS.davFile.ttlSeconds).toBe(300);
    expect(KV_DOMAINS.davMeta.ttlSeconds).toBe(60);
    expect(KV_DOMAINS.davFile.maxValueBytes).toBe(1_048_576);
    expect(buildKvKey('davProp', ['alice/demo', 'x'])).toBe('davProp:v1:alice%2Fdemo:x');
  });

  it('isolates DAV domains sharing the same parts', () => {
    expect(buildKvKey('davProp', ['x'])).not.toBe(buildKvKey('davFile', ['x']));
    expect(buildKvKey('davMeta', ['x'])).not.toBe(buildKvKey('davProp', ['x']));
  });

  it('rejects unknown domains, empty parts, and empty segments', () => {
    expect(() => buildKvKey('nope' as never, ['x'])).toThrow(/Unknown KV domain/);
    expect(() => buildKvKey('davProp', [])).toThrow(/at least one key part/);
    expect(() => buildKvKey('davFile', [' '.repeat(3)])).toThrow(/must not be empty/);
  });

  it('hashes overlong DAV keys deterministically within the length cap', () => {
    const long = `v/${'a'.repeat(600)}`;
    const first = buildKvKey('davProp', [long, 'path']);
    const second = buildKvKey('davProp', [long, 'path']);
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(KV_MAX_KEY_LENGTH);
    expect(first).toContain(':h:');
  });

  it('digest128 is stable and 32 hex chars', () => {
    // 128 bits, not 32: `davFile` keys embed a user-controlled path, so a
    // short digest in a shared keyspace is collision-searchable.
    expect(digest128('durable-dav')).toBe(digest128('durable-dav'));
    expect(digest128('a')).not.toBe(digest128('b'));
    expect(digest128('x')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('overflow keys are 32 hex chars and still domain-prefixed', () => {
    const long = 'a'.repeat(600);
    const key = buildKvKey('davFile', ['alice/demo', `path:${long}`]);
    expect(key).toMatch(/^davFile:v1:h:[0-9a-f]{32}$/);
  });
});

describe('clampTtl for DAV domains', () => {
  it('uses domain defaults and honors overrides', () => {
    expect(clampTtl(undefined, 'davProp')).toBe(120);
    expect(clampTtl(undefined, 'davFile')).toBe(300);
    expect(clampTtl(undefined, 'davMeta')).toBe(60);
    expect(clampTtl(180, 'davProp')).toBe(180);
  });

  it('clamps below the platform minimum and falls back to the domain default', () => {
    expect(clampTtl(1, 'davMeta')).toBe(60);
    // Every domain declares a required ttl, so a non-finite override falls back
    // to that default rather than disabling expiry.
    expect(clampTtl(NaN, 'davProp')).toBe(120);
    expect(clampTtl(Infinity, 'davFile')).toBe(300);
  });
});

describe('KvCache without a binding', () => {
  it('is unavailable and fail-soft', async () => {
    const cache = new KvCache(null);
    expect(cache.available).toBe(false);
    await expect(cache.getText('davProp', ['a'])).resolves.toBeNull();
    await expect(cache.putText('davProp', ['a'], 'v')).resolves.toBe(false);
    await expect(cache.getJson('davProp', ['a'])).resolves.toBeNull();
    await expect(cache.putJson('davProp', ['a'], { v: 1 })).resolves.toBe(false);
    await expect(cache.del('davProp', ['a'])).resolves.toBeUndefined();
    await expect(cache.purgePrefix('davProp')).resolves.toBe(0);
  });
});

describe('KvCache DAV round-trips', () => {
  it('stores propfind text with the domain TTL and reads it back', async () => {
    const kv = makeFakeKv();
    const cache = new KvCache(kv);
    await expect(cache.putText('davProp', ['alice/demo', 'p'], '<multistatus/>')).resolves.toBe(true);
    await expect(cache.getText('davProp', ['alice/demo', 'p'])).resolves.toBe('<multistatus/>');
    expect(kv.seen).toHaveLength(1);
    expect(kv.seen[0].ttl).toBe(KV_DOMAINS.davProp.ttlSeconds);
  });

  it('rejects oversize values without touching the binding', async () => {
    const kv = makeFakeKv();
    const cache = new KvCache(kv);
    await expect(cache.putText('davMeta', ['w'], 'x'.repeat(100_000))).resolves.toBe(false);
    expect(kv.seen).toHaveLength(0);
  });

  it('purges a DAV sub-prefix without touching sibling domains', async () => {
    const kv = makeFakeKv();
    const cache = new KvCache(kv);
    await cache.putText('davProp', ['alice/demo', 'a'], 'a');
    await cache.putText('davProp', ['alice/demo', 'b'], 'b');
    await cache.putText('davFile', ['alice/demo', 'a'], 'c');
    await expect(cache.purgePrefix('davProp', ['alice/demo'])).resolves.toBe(2);
    await expect(cache.getText('davFile', ['alice/demo', 'a'])).resolves.toBe('c');
  });
});

describe('KvCache backend failures stay fail-soft', () => {
  it('returns null/false on throwing bindings', async () => {
    const failing: KvNamespaceLike = {
      get: () => Promise.reject(new Error('boom')),
      put: () => Promise.reject(new Error('boom')),
      delete: () => Promise.reject(new Error('boom')),
      list: () => Promise.reject(new Error('boom')),
    };
    const cache = new KvCache(failing);
    await expect(cache.getText('davProp', ['a'])).resolves.toBeNull();
    await expect(cache.putText('davProp', ['a'], 'v')).resolves.toBe(false);
    await expect(cache.del('davProp', ['a'])).resolves.toBeUndefined();
    await expect(cache.purgePrefix('davProp')).resolves.toBe(0);
  });
});

describe('request-scope KvCache binding', () => {
  it('binds an unavailable cache without CACHE and a live one with it', () => {
    const without = createRequestScope({ DB: {} } as never);
    expect(without.get(Tokens.KvCache).available).toBe(false);
    const kv = makeFakeKv();
    const withBinding = createRequestScope({ DB: {}, CACHE: kv } as never);
    expect(withBinding.get(Tokens.KvCache).available).toBe(true);
    expect(withBinding.get(Tokens.KvCache)).toBe(withBinding.get(Tokens.KvCache));
  });

  it('shares one instance per scope', () => {
    const scope = createRequestScope({ DB: {}, CACHE: makeFakeKv() } as never);
    const seen = vi.fn();
    seen(scope.get(Tokens.KvCache));
    expect(scope.get(Tokens.KvCache)).toBe(scope.get(Tokens.KvCache));
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('DavReadCache helpers', () => {
  it('canonicalizes volume keys to lowercase', () => {
    expect(cacheKeyForVolume('Alice', 'Demo')).toBe('alice/demo');
    expect(cacheKeyForVolume('ALICE', 'DEMO')).toBe(cacheKeyForVolume('alice', 'demo'));
  });

  it('detects fresh conditional requests', () => {
    const etag = 'W/"prop-abc"';
    expect(isFresh(new Request('https://x/', { headers: { 'If-None-Match': etag } }), etag)).toBe(true);
    expect(isFresh(new Request('https://x/', { headers: { 'If-None-Match': '*' } }), etag)).toBe(true);
    expect(isFresh(new Request('https://x/', { headers: { 'If-None-Match': 'W/"other"' } }), etag)).toBe(false);
    expect(isFresh(new Request('https://x/'), etag)).toBe(false);
    expect(isFresh(new Request('https://x/', { headers: { 'If-None-Match': etag } }), null)).toBe(false);
  });

  it('builds stable propfind etags distinct per input', () => {
    const a = etagForPropfind('alice/demo', 'docs', '1', hashBody('<a/>'));
    expect(a).toBe(etagForPropfind('alice/demo', 'docs', '1', hashBody('<a/>')));
    expect(a).not.toBe(etagForPropfind('alice/demo', 'docs', '0', hashBody('<a/>')));
    expect(a).not.toBe(etagForPropfind('alice/demo', 'other', '1', hashBody('<a/>')));
    expect(a).toMatch(/^W\/".+"$/);
  });

  it('assigns private cache-control per kind', () => {
    expect(cacheControlFor('file')).toContain('private');
    expect(cacheControlFor('propfind')).toContain('private');
    // A file's window is longer than a propfind's, and the difference is the point:
    // the body is immutable per etag while a multistatus reflects sibling changes.
    expect(cacheControlFor('file')).not.toBe(cacheControlFor('propfind'));
  });

  it('rejects a shape it does not know, rather than silently using a default', () => {
    // The parameter is the closed `CachedShape` union, so a typo is a compile error.
    // It was a bare `string` and any other value fell through to `max-age=30` —
    // this asserts that the type is doing the work, at runtime as well, because a
    // cast from untyped JSON would otherwise reintroduce the silent default.
    // @ts-expect-error deliberately wrong shape: proves the union is closed
    expect(() => cacheControlFor('meta')).toThrow();
  });

  it('round-trips base64 file bodies', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips propfind snapshots keyed by volume+path+depth+body', async () => {
    const cache = new KvCache(makeFakeKv());
    await expect(getCachedPropfind(cache, 'Alice', 'Demo', 'docs', '1', '<a/>')).resolves.toBeNull();
    await putCachedPropfind(cache, 'Alice', 'Demo', 'docs', '1', '<a/>', { body: '<xml/>', etag: 'W/"1"' });
    await expect(getCachedPropfind(cache, 'alice', 'demo', 'docs', '1', '<a/>')).resolves.toEqual({
      body: '<xml/>',
      etag: 'W/"1"',
    });
    // Different depth/body miss.
    await expect(getCachedPropfind(cache, 'alice', 'demo', 'docs', '0', '<a/>')).resolves.toBeNull();
    await expect(getCachedPropfind(cache, 'alice', 'demo', 'docs', '1', '<b/>')).resolves.toBeNull();
  });

  it('round-trips small files and skips oversize bodies', async () => {
    const kv = makeFakeKv();
    const cache = new KvCache(kv);
    const bytes = new Uint8Array([104, 105]);
    await putCachedFile(cache, 'alice', 'demo', 'a.txt', bytes, 'text/plain', '"etag1"');
    await expect(getCachedFile(cache, 'Alice', 'Demo', 'a.txt')).resolves.toEqual({
      b64: bytesToBase64(bytes),
      contentType: 'text/plain',
      etag: '"etag1"',
    });
    const big = new Uint8Array(MAX_CACHED_FILE_BYTES + 1);
    const before = kv.seen.length;
    await putCachedFile(cache, 'alice', 'demo', 'big.bin', big, 'application/octet-stream', '"big"');
    expect(kv.seen.length).toBe(before);
  });

  it('invalidates the volume prop+file caches', async () => {
    const cache = new KvCache(makeFakeKv());
    await putCachedPropfind(cache, 'alice', 'demo', 'docs', '1', '<a/>', { body: '<xml/>', etag: 'W/"1"' });
    await putCachedFile(cache, 'alice', 'demo', 'a.txt', new Uint8Array([1]), 'text/plain', '"e"');
    // Sibling volume untouched.
    await putCachedPropfind(cache, 'alice', 'other', 'docs', '1', '<a/>', { body: '<xml/>', etag: 'W/"1"' });
    await invalidateVolumeCaches(cache, 'Alice', 'Demo');
    await expect(getCachedPropfind(cache, 'alice', 'demo', 'docs', '1', '<a/>')).resolves.toBeNull();
    await expect(getCachedFile(cache, 'alice', 'demo', 'a.txt')).resolves.toBeNull();
    await expect(getCachedPropfind(cache, 'alice', 'other', 'docs', '1', '<a/>')).resolves.toEqual({
      body: '<xml/>',
      etag: 'W/"1"',
    });
  });

  it('round-trips the volume list with case-insensitive email keys', async () => {
    const cache = new KvCache(makeFakeKv());
    await putCachedVolumeList(cache, 'Alice@Example.com', [{ fullName: 'alice/demo' }]);
    await expect(getCachedVolumeList(cache, 'alice@example.com')).resolves.toEqual([{ fullName: 'alice/demo' }]);
    await invalidateVolumeListCache(cache, 'ALICE@example.com');
    await expect(getCachedVolumeList(cache, 'alice@example.com')).resolves.toBeNull();
  });

  it('stays fail-soft when the KV backend throws', async () => {
    const failing: KvNamespaceLike = {
      get: () => Promise.reject(new Error('boom')),
      put: () => Promise.reject(new Error('boom')),
      delete: () => Promise.reject(new Error('boom')),
      list: () => Promise.reject(new Error('boom')),
    };
    const cache = new KvCache(failing);
    await expect(getCachedPropfind(cache, 'a', 'b', '', '1', '<x/>')).resolves.toBeNull();
    await expect(getCachedFile(cache, 'a', 'b', 'f')).resolves.toBeNull();
    await expect(getCachedVolumeList(cache, 'a@x.com')).resolves.toBeNull();
    await expect(invalidateVolumeCaches(cache, 'a', 'b')).resolves.toBeUndefined();
    await expect(invalidateVolumeListCache(cache, 'a@x.com')).resolves.toBeUndefined();
  });
});
