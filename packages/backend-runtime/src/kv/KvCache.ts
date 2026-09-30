// `KvCache` — typed facade over the single `CACHE` KV binding.
//
// Domains are separated by key prefix (`KvDomains.ts`); nothing outside this
// module constructs a raw key. Semantics are fail-soft by design: reads return
// `null` on miss, missing binding, or backend error; writes return `false`
// when skipped (no binding, oversize value, backend error) and `true` when
// stored. Callers treat KV as a pure optimization — D1/DO stay authoritative.
import { createLogger } from '../logger';
import { KV_DOMAINS, buildKvKey, clampTtl, utf8ByteLength } from './KvDomains';
import type { KvDomainName } from './KvDomains';

const logger = createLogger('KvCache');

interface KvListPage {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<KvListPage>;
}

interface KvPutOptions {
  ttlSeconds?: number;
}

const PURGE_LIST_LIMIT = 1000;
const PURGE_MAX_PAGES = 10;

class KvCache {
  constructor(private readonly namespace?: KvNamespaceLike | null) {}

  public get available(): boolean {
    return !!this.namespace;
  }

  public async getText(domain: KvDomainName, parts: readonly string[]): Promise<string | null> {
    const ns = this.namespace;
    if (!ns) return null;
    try {
      return await ns.get(buildKvKey(domain, parts));
    } catch (error) {
      logger.debug(`KV get failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  public async putText(domain: KvDomainName, parts: readonly string[], value: string, options?: KvPutOptions): Promise<boolean> {
    const ns = this.namespace;
    if (!ns) return false;
    // No unknown-domain check: `buildKvKey` below throws for one, and the
    // return type has never been able to express that. A silent `false` here
    // would have made an unknown domain look like a namespace miss.
    const def = KV_DOMAINS[domain];
    if (utf8ByteLength(value) > def.maxValueBytes) {
      logger.debug(`KV put skipped for ${domain}: value exceeds ${def.maxValueBytes} bytes.`);
      return false;
    }
    try {
      // `clampTtl` always resolves to a number: every domain declares a
      // required `ttlSeconds`, so there is no "persist forever" case to branch
      // on any more.
      const ttl = clampTtl(options?.ttlSeconds, domain);
      await ns.put(buildKvKey(domain, parts), value, { expirationTtl: ttl });
      return true;
    } catch (error) {
      logger.debug(`KV put failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  public async getJson<T>(domain: KvDomainName, parts: readonly string[]): Promise<T | null> {
    const raw = await this.getText(domain, parts);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  public async putJson(domain: KvDomainName, parts: readonly string[], value: unknown, options?: KvPutOptions): Promise<boolean> {
    let raw: unknown;
    try {
      raw = JSON.stringify(value);
    } catch {
      return false;
    }
    return typeof raw === 'string' && this.putText(domain, parts, raw, options);
  }

  public async del(domain: KvDomainName, parts: readonly string[]): Promise<void> {
    const ns = this.namespace;
    if (!ns) return;
    try {
      await ns.delete(buildKvKey(domain, parts));
    } catch (error) {
      logger.debug(`KV delete failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async purgePrefix(domain: KvDomainName, parts: readonly string[] = []): Promise<number> {
    const ns = this.namespace;
    if (!ns) return 0;
    const prefix = parts.length === 0 ? `${domain}:` : buildKvKey(domain, parts);
    let deleted = 0;
    try {
      // Restart from the start after each page: deleting while a positional
      // cursor advances would skip keys. Each pass removes a full page, so
      // the loop terminates; the page cap bounds worst-case cost.
      for (let page = 0; page < PURGE_MAX_PAGES; page += 1) {
        const result = await ns.list({ prefix, limit: PURGE_LIST_LIMIT });
        if (result.keys.length === 0) return deleted;
        for (const key of result.keys) {
          await ns.delete(key.name);
          deleted += 1;
        }
        if (result.keys.length < PURGE_LIST_LIMIT) return deleted;
      }
    } catch (error) {
      logger.debug(`KV purge failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return deleted;
  }
}

export { KvCache };
export type { KvListPage, KvNamespaceLike, KvPutOptions };
