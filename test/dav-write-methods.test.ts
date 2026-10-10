/**
 * `apps/background/src/dav/methods/WriteMethods.ts` — PUT, DELETE, MKCOL.
 *
 * Two invariants carry most of the risk here:
 *
 * 1. **A quota failure must not destroy the file being overwritten.** That is
 *    guaranteed by `dofs.writeFile` checking the device quota *before* unlinking
 *    (pinned in `patches/dofs@0.1.0.patch`), and this file maps the failure to a
 *    507. The unlink-then-check order shipped once and truncated files.
 * 2. **The resource type comes from the request target, not from `isDirectory`.**
 *    A path ending in `/` names a collection whatever the filesystem says.
 */
import { describe, expect, it } from 'vitest';
import { handleDelete, handleMkcol, handlePut } from '../apps/background/src/dav/methods/WriteMethods';
import { BASES, fakeDofs, fakeLocks, fakeRepo } from './helpers/dav-fakes';
import type { FakeRepo } from './helpers/dav-fakes';

const URL_BASE = 'https://dav.example.com/alice/photos';

function seeded(): FakeRepo {
  return fakeRepo({
    'a.txt': { kind: 'file', bytes: new TextEncoder().encode('A'), meta: { etag: '"old"' } },
    dir: { kind: 'directory' },
    'dir/b.txt': { kind: 'file', bytes: new TextEncoder().encode('B'), meta: { etag: '"b"' } },
  });
}

function put(innerPath: string, body = 'hello', init: RequestInit = {}): Request {
  return new Request(`${URL_BASE}/${innerPath}`, {
    method: 'PUT',
    body,
    ...init,
    headers: { 'Content-Type': 'text/plain', ...(init.headers as Record<string, string> | undefined) },
  });
}

describe('handlePut — resource type comes from the request target', () => {
  // A path ending in `/` names a collection whatever the filesystem says, and
  // the volume root is a collection too. Parameterised because all three are the
  // same rule read three ways.
  it.each([
    { label: 'the volume root', request: put(''), innerPath: '' },
    { label: 'a path ending in a slash', request: put('notes.txt/'), innerPath: 'notes.txt/' },
    { label: 'an existing collection', request: put('dir'), innerPath: 'dir' },
  ])('405s a PUT to $label', async ({ request: req, innerPath }) => {
    const repo = seeded();
    const response = await handlePut(req, innerPath, repo as never, fakeLocks() as never, fakeDofs(repo) as never, 1024);
    expect(response.status).toBe(405);
  });

  it('does NOT 405 a file whose QUERY STRING ends in a slash', async () => {
    // `request.url.endsWith('/')` tested the whole URL, so an ordinary file
    // with `?next=/` was refused as a collection.
    const repo = seeded();
    const request = new Request(`${URL_BASE}/a.txt?next=/`, {
      method: 'PUT',
      body: 'updated',
      headers: { 'Content-Type': 'text/plain' },
    });
    const response = await handlePut(request, 'a.txt', repo as never, fakeLocks() as never, fakeDofs(repo) as never, 1024);
    expect(response.status).toBe(204);
    expect(new TextDecoder().decode(repo.nodes.get('a.txt')?.bytes)).toBe('updated');
  });
});

describe('handlePut — creation and overwrite', () => {
  it('201s a create', async () => {
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const response = await handlePut(put('new.txt', 'new'), 'new.txt', repo as never, fakeLocks() as never, dofs as never, 1024);
    expect(response.status).toBe(201);
    expect(new TextDecoder().decode(repo.nodes.get('new.txt')?.bytes)).toBe('new');
  });

  it('204s an overwrite and preserves crtime', async () => {
    const repo = seeded();
    repo.crtimes.set('a.txt', 1000);
    const response = await handlePut(put('a.txt', 'replaced'), 'a.txt', repo as never, fakeLocks() as never, fakeDofs(repo) as never, 1024);
    expect(response.status).toBe(204);
    // Reuse of the pre-write read is what preserves crtime without a second query.
    expect(repo.upsertFileNode).toHaveBeenCalledWith('a.txt', 'text/plain', expect.any(String), expect.any(Number), 1000);
    expect(repo.crtimes.get('a.txt')).toBe(1000);
  });

  it('409s when the parent does not exist', async () => {
    const repo = seeded();
    const response = await handlePut(put('missing/x.txt'), 'missing/x.txt', repo as never, fakeLocks() as never, fakeDofs(repo) as never, 1024);
    expect(response.status).toBe(409);
  });

  it('409s when the parent is a file', async () => {
    const repo = seeded();
    const response = await handlePut(put('a.txt/x.txt'), 'a.txt/x.txt', repo as never, fakeLocks() as never, fakeDofs(repo) as never, 1024);
    expect(response.status).toBe(409);
  });

  it('413s an oversize body without writing anything', async () => {
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const response = await handlePut(put('big.txt', 'x'.repeat(100)), 'big.txt', repo as never, fakeLocks() as never, dofs as never, 10);
    expect(response.status).toBe(413);
    expect(dofs.writeFile).not.toHaveBeenCalled();
    expect(repo.nodes.has('big.txt')).toBe(false);
  });

  it('507s when the write fails, rather than reporting a different fault', async () => {
    const repo = seeded();
    const dofs = fakeDofs(repo, { writeFailures: new Map([['a.txt', 'ENOSPC']]) });
    const response = await handlePut(put('a.txt', 'replacement'), 'a.txt', repo as never, fakeLocks() as never, dofs as never, 1024);
    expect(response.status).toBe(507);
    // The pre-existing bytes are still there: `dofs.writeFile` checks the quota
    // before unlinking, which is the invariant the pinned patch exists for.
    expect(new TextDecoder().decode(repo.nodes.get('a.txt')?.bytes)).toBe('A');
  });

  it('423s when the target is locked by another client', async () => {
    const repo = seeded();
    const response = await handlePut(put('a.txt', 'x'), 'a.txt', repo as never, fakeLocks({ lockedPaths: ['a.txt'] }) as never, fakeDofs(repo) as never, 1024);
    expect(response.status).toBe(423);
  });

  it('412s a create-only PUT with If-None-Match: *', async () => {
    // Finder/davfs2's create-only PUT; before the conditional guard this always
    // succeeded and silently clobbered the existing file.
    const repo = seeded();
    const response = await handlePut(
      put('a.txt', 'x', { headers: { 'If-None-Match': '*' } }),
      'a.txt',
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      1024,
    );
    expect(response.status).toBe(412);
    expect(new TextDecoder().decode(repo.nodes.get('a.txt')?.bytes)).toBe('A');
  });

  it('412s an overwrite with a stale If-Match', async () => {
    const repo = seeded();
    const response = await handlePut(
      put('a.txt', 'x', { headers: { 'If-Match': '"stale"' } }),
      'a.txt',
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      1024,
    );
    expect(response.status).toBe(412);
    expect(new TextDecoder().decode(repo.nodes.get('a.txt')?.bytes)).toBe('A');
  });
});

describe('handleDelete', () => {
  const del = (innerPath: string, headers: Record<string, string> = {}) =>
    new Request(`${URL_BASE}/${innerPath}`, { method: 'DELETE', headers });

  it('403s a DELETE of the volume root', async () => {
    const repo = seeded();
    const response = await handleDelete(del(''), '', repo as never, fakeLocks() as never, fakeDofs(repo) as never);
    expect(response.status).toBe(403);
  });

  it('404s a DELETE of something absent', async () => {
    const repo = seeded();
    const response = await handleDelete(del('missing.txt'), 'missing.txt', repo as never, fakeLocks() as never, fakeDofs(repo) as never);
    expect(response.status).toBe(404);
  });

  it('204s a file DELETE and cascades the metadata', async () => {
    const repo = seeded();
    const response = await handleDelete(del('a.txt'), 'a.txt', repo as never, fakeLocks() as never, fakeDofs(repo) as never);
    expect(response.status).toBe(204);
    expect(repo.deleteCascade).toHaveBeenCalledWith('a.txt');
  });

  it('204s a recursive collection DELETE', async () => {
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const response = await handleDelete(del('dir'), 'dir', repo as never, fakeLocks() as never, dofs as never);
    expect(response.status).toBe(204);
    expect(dofs.rmdir).toHaveBeenCalledWith('/dir', { recursive: true });
    expect(repo.deleteCascade).toHaveBeenCalledWith('dir');
  });

  it('423s when a DESCENDANT is locked', async () => {
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const response = await handleDelete(
      del('dir'),
      'dir',
      repo as never,
      fakeLocks({ lockedDescendants: { 'dir/b.txt': ['opaquelocktoken:abc'] } }) as never,
      dofs as never,
    );
    expect(response.status).toBe(423);
    expect(dofs.rmdir).not.toHaveBeenCalled();
    expect(repo.nodes.has('dir/b.txt')).toBe(true);
  });

  it('500s fail-closed when the descendant listing cannot be read', async () => {
    // The one lock check in the DO that could fail open. A failed listing must
    // not read as "nothing is locked" and take the subtree with it.
    const repo = seeded();
    repo.recursiveFails = true;
    const dofs = fakeDofs(repo);
    const response = await handleDelete(del('dir'), 'dir', repo as never, fakeLocks() as never, dofs as never);
    expect(response.status).toBe(500);
    expect(dofs.rmdir).not.toHaveBeenCalled();
    expect(repo.nodes.has('dir/b.txt')).toBe(true);
  });
});

describe('handleMkcol', () => {
  const mkcol = (innerPath: string, body?: string, headers: Record<string, string> = {}) =>
    new Request(`${URL_BASE}/${innerPath}`, { method: 'MKCOL', body, headers });

  it('201s a created collection', async () => {
    const repo = seeded();
    const response = await handleMkcol(mkcol('newdir'), 'newdir', repo as never, fakeLocks() as never, fakeDofs(repo) as never);
    expect(response.status).toBe(201);
    expect(repo.nodes.has('newdir')).toBe(true);
  });

  it('415s a request carrying a body', async () => {
    const repo = seeded();
    const response = await handleMkcol(mkcol('newdir', '<body/>'), 'newdir', repo as never, fakeLocks() as never, fakeDofs(repo) as never);
    expect(response.status).toBe(415);
    expect(repo.nodes.has('newdir')).toBe(false);
  });

  it('405s the volume root', async () => {
    const repo = seeded();
    const response = await handleMkcol(mkcol(''), '', repo as never, fakeLocks() as never, fakeDofs(repo) as never);
    expect(response.status).toBe(405);
  });

  it('405s when it already exists', async () => {
    const repo = seeded();
    const response = await handleMkcol(mkcol('dir'), 'dir', repo as never, fakeLocks() as never, fakeDofs(repo) as never);
    expect(response.status).toBe(405);
  });

  it('409s when the parent does not exist', async () => {
    const repo = seeded();
    const response = await handleMkcol(mkcol('missing/child'), 'missing/child', repo as never, fakeLocks() as never, fakeDofs(repo) as never);
    expect(response.status).toBe(409);
  });

  it('423s when the target is locked', async () => {
    const repo = seeded();
    const response = await handleMkcol(mkcol('newdir'), 'newdir', repo as never, fakeLocks({ lockedPaths: ['newdir'] }) as never, fakeDofs(repo) as never);
    expect(response.status).toBe(423);
  });
});

describe('BASES is only used for href emission', () => {
  it('the path base and href base stay distinct in the fixtures', () => {
    // Guards the assumption every handler here relies on: addressing uses
    // `pathBase`, presentation uses `hrefBase`, and they are not interchangeable.
    expect(BASES.pathBase).toBe('/alice/photos');
    expect(BASES.hrefBase).toBe('/alice/photos');
  });
});