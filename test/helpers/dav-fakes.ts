/**
 * Test doubles for the Durable Object's WebDAV handlers.
 *
 * `apps/background/src/dav/methods/*` is 466 lines of RFC 4918 semantics that
 * had **no unit coverage at all** — reachable only over HTTP from the workerd
 * integration suite, and therefore invisible to the coverage floor. Every handler
 * is a function of `(Request, innerPath, repo, locks, dofs)`, so they are directly
 * testable here with no new seams and no worker runtime.
 *
 * These fakes are deliberately *strict*: every method a handler calls is defined,
 * so a handler reaching for a collaborator it was not given fails loudly rather
 * than silently resolving to `undefined` and passing for correct behaviour.
 */
import { vi } from 'vitest';

type Stat = { exists: boolean; isDirectory: boolean; size: number; mtime: number };

export interface FakeNode {
  kind: 'file' | 'directory';
  bytes?: Uint8Array;
  meta?: { etag?: string | null; mtime?: number | null; contentType?: string | null };
}

/**
 * An in-memory volume.
 *
 * `statInner`/`readMeta` answer from this map, and every mutator the handlers
 * perform (`mkdir`/`writeFile`/`rename`/`unlink`) is applied to it, so a test can
 * assert on the *result* of a handler rather than on a mock's call list alone.
 */
export function fakeRepo(initial: Record<string, FakeNode> = {}): FakeRepo {
  return new FakeRepo(initial);
}

export class FakeRepo {
  public readonly nodes = new Map<string, FakeNode>();

  /**
  Set to make `requireRecursive` throw, as a storage failure would.
  */
  public recursiveFails = false;

  public readonly copyMeta = vi.fn((src: string, dest: string, isDir: boolean) => {
    const node = this.nodes.get(src);
    if (node) this.nodes.set(dest, { ...node, kind: isDir ? 'directory' : 'file' });
  });

  public readonly renameCascade = vi.fn((src: string, dest: string) => {
    const node = this.nodes.get(src);
    this.nodes.delete(src);
    if (node) this.nodes.set(dest, node);
  });

  public readonly deleteCascade = vi.fn((path: string) => {
    for (const key of this.nodes.keys()) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
    }
  });

  public readonly upsertDeadProperty = vi.fn();

  /**
  `crtime` is preserved across an overwrite by the handler, not recomputed.
  */
  public readonly crtimes = new Map<string, number>();

  public readonly upsertFileNode = vi.fn((path: string, _contentType: string, etag: string, mtime: number, crtime: number) => {
    const existing = this.nodes.get(path);
    this.crtimes.set(path, existing ? (this.crtimes.get(path) ?? crtime) : crtime);
    this.nodes.set(path, {
      kind: 'file',
      bytes: existing?.bytes ?? new Uint8Array(),
      meta: { etag, mtime, contentType: _contentType },
    });
  });

  public readonly upsertCollectionNode = vi.fn((path: string, _mtime: number, _crtime: number) => {
    this.nodes.set(path, { kind: 'directory' });
  });

  /**
   * Whether the resource exists only to hold a lock.
   *
   * The discriminator between an abandoned LOCK and an ordinary zero-byte file —
   * "is it empty" cannot tell them apart, and using that as the test deleted
   * every empty file the moment its lock was released.
   */
  public lockNull = false;

  public isLockNull(path: string): boolean {
    return this.lockNull && this.nodes.has(path);
  }

  constructor(initial: Record<string, FakeNode> = {}) {
    for (const [path, node] of Object.entries(initial)) this.nodes.set(path, node);
  }

  public seed(path: string, node: FakeNode): this {
    this.nodes.set(path, node);
    return this;
  }

  public statInner(path: string): Stat {
    const node = this.nodes.get(path);
    if (!node) return { exists: false, isDirectory: false, size: 0, mtime: 0 };
    return {
      exists: true,
      isDirectory: node.kind === 'directory',
      size: node.bytes?.byteLength ?? 0,
      mtime: node.meta?.mtime ?? 1_700_000_000_000,
    };
  }

  public requireStatInner(path: string): Stat {
    const stat = this.statInner(path);
    if (!stat.exists) throw new Error(`ENOENT: ${path}`);
    return stat;
  }

  public readMeta(path: string): { etag: string | null; mtime: number | null; contentType: string | null; crtime: number | null } {
    const node = this.nodes.get(path);
    if (!node) return { etag: null, mtime: null, contentType: null, crtime: null };
    return {
      etag: node.meta?.etag ?? null,
      mtime: node.meta?.mtime ?? 1_700_000_000_000,
      contentType: node.meta?.contentType ?? null,
      crtime: this.crtimes.get(path) ?? null,
    };
  }

  /**
   * Immediate children, as **names relative to `path`**.
   *
   * `dofs.listDir` returns relative names (with `.`/`..` filtered by the
   * caller), and every handler joins them back with `childInner`. Returning
   * absolute paths here silently breaks that pairing.
   */
  public listChildren(path: string): string[] {
    const prefix = path === '' ? '' : `${path}/`;
    return [...this.nodes.keys()]
      .filter((key) => key !== path && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map((key) => key.slice(prefix.length));
  }

  /**
  Every descendant, as names relative to `path`.
  */
  public listRecursive(path: string): string[] {
    const prefix = path === '' ? '' : `${path}/`;
    return [...this.nodes.keys()].filter((key) => key !== path && key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  public requireRecursive(path: string): string[] {
    if (this.recursiveFails) throw new Error('listing failed');
    return this.listRecursive(path);
  }

  public countChildren(path: string): number {
    return this.listChildren(path).length;
  }

  /**
  `{name, isDirectory}` entries, as `DavRepository.listChildPage` returns.
  */
  public listChildPage(path: string, offset: number, limit: number): Array<{ name: string; isDirectory: boolean }> {
    return this.listChildren(path)
      .slice(offset, offset + limit)
      .map((name) => ({ name, isDirectory: this.statInner(this.childInner(path, name)).isDirectory }));
  }

  public childInner(parent: string, name: string): string {
    return parent === '' ? name : `${parent}/${name}`;
  }

  /**
   * A full `DavNodeInfo`.
   *
   * `crtime`/`mtime` are `Date`s, not epoch numbers — `toLiveProperties` calls
   * `.toUTCString()` on them directly, so a partial node throws there rather
   * than failing usefully at the assertion.
   */
  public nodeInfo(path: string, _hrefBase: string): FakeNodeInfo | null {
    const stat = this.statInner(path);
    if (!stat.exists) return null;
    const meta = this.readMeta(path);
    return {
      key: path,
      isCollection: stat.isDirectory,
      size: stat.size,
      etag: meta.etag ?? undefined,
      mtime: new Date(meta.mtime ?? stat.mtime),
      crtime: new Date(meta.crtime ?? meta.mtime ?? stat.mtime),
      contentType: meta.contentType ?? undefined,
      // Derived from the last segment by the real repository; nothing ever
      // stored a `displayname`.
      displayname: path === '' ? undefined : (path.split('/').pop() ?? undefined),
      locks: [],
      deadProperties: [],
    };
  }

  public rootNode(): FakeNodeInfo {
    return {
      key: '',
      isCollection: true,
      size: 0,
      etag: undefined,
      mtime: new Date(0),
      crtime: new Date(0),
      contentType: undefined,
      displayname: undefined,
      locks: [],
      deadProperties: [],
    };
  }
}

export interface FakeDofsOptions {
  /**
  Paths whose `writeFile` should throw, e.g. to simulate ENOSPC.
  */
  writeFailures?: Map<string, string>;
}

/**
 * The `dofs` filesystem surface the handlers use.
 *
 * `writeFailures` maps a path to an error `code`, which is how the COPY handler's
 * `ENOSPC` → 507 branch is reached without a real quota.
 */
export function fakeDofs(repo: FakeRepo, options: FakeDofsOptions = {}): FakeDofs {
  return new FakeDofs(repo, options);
}

export class FakeDofs {
  public readonly read: ReturnType<typeof vi.fn>;
  public readonly readFile: ReturnType<typeof vi.fn>;
  public readonly writeFile: ReturnType<typeof vi.fn>;
  public readonly mkdir: ReturnType<typeof vi.fn>;
  public readonly rename: ReturnType<typeof vi.fn>;
  public readonly unlink: ReturnType<typeof vi.fn>;
  public readonly rmdir: ReturnType<typeof vi.fn>;

  public readonly writeFailures: Map<string, string>;

  constructor(
    private readonly repo: FakeRepo,
    options: FakeDofsOptions = {},
  ) {
    this.writeFailures = new Map(options.writeFailures);
    this.read = vi.fn((path: string) => this.readBytes(path));
    this.readFile = vi.fn((path: string) => this.readBytes(path));
    this.writeFile = vi.fn(async (path: string, data: ArrayBuffer) => {
      const inner = fsPathToInner(path);
      const failure = this.writeFailures.get(inner);
      if (failure) throw Object.assign(new Error(failure), { code: failure });
      this.repo.nodes.set(inner, { kind: 'file', bytes: new Uint8Array(data) });
    });
    this.mkdir = vi.fn((path: string) => {
      const inner = fsPathToInner(path);
      if (this.repo.nodes.has(inner)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      this.repo.nodes.set(inner, { kind: 'directory' });
    });
    this.rename = vi.fn((from: string, to: string) => {
      const node = this.repo.nodes.get(fsPathToInner(from));
      if (!node) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      this.repo.nodes.delete(fsPathToInner(from));
      this.repo.nodes.set(fsPathToInner(to), node);
    });
    this.unlink = vi.fn((path: string) => {
      this.repo.nodes.delete(fsPathToInner(path));
    });
    this.rmdir = vi.fn((path: string) => {
      this.repo.nodes.delete(fsPathToInner(path));
    });
  }

  private readBytes(path: string): ArrayBuffer {
    const node = this.repo.nodes.get(fsPathToInner(path));
    if (!node?.bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // Copied by offset and length, not `.buffer`: a `Uint8Array` is a *view*,
    // and `.buffer` can be larger than the view — so `.buffer.slice(0)` would
    // hand back trailing bytes the caller never wrote. That is silent data
    // corruption in a fixture, which is the worst place for it.
    const bytes = node.bytes;
    return bytes.slice().buffer as ArrayBuffer;
  }
}

// The handlers address the volume through `fsPathOf`, which prefixes with `/`.
// The fakes normalise so a test can reason in inner-path terms.
function fsPathToInner(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * A `DavLockGuard` stand-in.
 *
 * `lockedPaths` returns a `423` for any path listed; `lockedDescendants` maps a
 * source path to children that carry an active lock, which is the state MOVE and
 * DELETE must refuse to act on.
 */
export function fakeLocks(options: { lockedPaths?: string[]; lockedDescendants?: Record<string, string[]> } = {}): FakeLockGuard {
  const locked = new Set(options.lockedPaths);
  const descendants = options.lockedDescendants ?? {};
  return {
    assertLock: vi.fn((_request: Request, path: string) => (locked.has(path) ? new Response('Locked', { status: 423 }) : null)),
    activeTokensForPath: vi.fn((path: string) => (descendants[path] ?? []).map((token) => ({ token, isWrite: true }))),
    ancestorsOf: vi.fn(() => []),
  } as unknown as FakeLockGuard;
}

export type FakeLockGuard = {
  assertLock(request: Request, path: string): Response | null;
  activeTokensForPath(path: string): Array<{ token: string; isWrite: boolean }>;
  ancestorsOf(path: string): string[];
};

/**
The subset of `DavNodeInfo` the multistatus renderer reads.
*/
export type FakeNodeInfo = {
  key: string;
  isCollection: boolean;
  size: number;
  etag: string | undefined;
  mtime: Date;
  crtime: Date;
  contentType: string | undefined;
  displayname: string | undefined;
  locks: Array<{ token: string; scope: string; depth: string; ownerXml: string }>;
  deadProperties: Array<{ namespaceURI: string; localName: string; valueXml: string }>;
};

/**
The two bases every handler takes. See `DavBases` for why they differ.
*/
export const BASES = { pathBase: '/alice/photos', hrefBase: '/alice/photos' } as const;

/**
A `Destination` header pointing inside `BASES.pathBase`.
*/
export function destination(inner: string): string {
  return `https://dav.example.com/alice/photos/${inner}`;
}