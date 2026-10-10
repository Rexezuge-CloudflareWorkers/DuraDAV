/**
 * `apps/background/src/dav/methods/CopyMoveMethods.ts` — the only handlers in
 * the codebase that can delete a subtree.
 *
 * The ordering rules here are the point. `COPY` once validated `Depth` *after*
 * recursively deleting the destination, so a request rejected with a clean `400`
 * had already destroyed a subtree with no way for the client to know it should
 * retry. `MOVE` did not validate `Depth` at all, so `Depth: 0` silently performed
 * a full recursive move.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleCopy, handleMove } from '../apps/background/src/dav/methods/CopyMoveMethods';
import { BASES, destination, fakeDofs, fakeLocks, fakeRepo } from './helpers/dav-fakes';
import type { FakeRepo } from './helpers/dav-fakes';

function request(method: string, srcInner: string, headers: Record<string, string> = {}, url = 'https://dav.example.com/alice/photos'): Request {
  return new Request(`${url}/${srcInner}`, { method, headers });
}

function file(bytes = 'hello'): { kind: 'file'; bytes: Uint8Array; meta: { etag: string } } {
  return { kind: 'file', bytes: new TextEncoder().encode(bytes), meta: { etag: '"e1"' } };
}

/**
A repo pre-seeded with `/a.txt` and `/dir/` containing `/dir/b.txt`.
*/
function seeded(): FakeRepo {
  return fakeRepo({
    'a.txt': file('A'),
    dir: { kind: 'directory' },
    'dir/b.txt': file('B'),
    'existing.txt': file('EXISTING'),
  });
}

/**
`removeDestination` / `deleteForMove` that records the call and removes nothing.
*/
function destroyer() {
  return vi.fn(() => Promise.resolve(null));
}

describe('handleCopy — validation happens before any mutation', () => {
  it('rejects a collection COPY with Depth: 1 WITHOUT deleting the destination', async () => {
    // The regression this file exists for. A 400 that already removed a subtree
    // is unrecoverable and looks like a clean rejection to the client.
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const removeDestination = destroyer();

    const response = await handleCopy(
      request('COPY', 'dir', { Destination: destination('existing.txt'), Depth: '1' }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      dofs as never,
      removeDestination as never,
    );

    expect(response.status).toBe(400);
    expect(removeDestination).not.toHaveBeenCalled();
    expect(repo.nodes.has('existing.txt')).toBe(true);
  });

  it('does not delete the destination when Overwrite: F refuses', async () => {
    const repo = seeded();
    const removeDestination = destroyer();

    const response = await handleCopy(
      request('COPY', 'a.txt', { Destination: destination('existing.txt'), Overwrite: 'F' }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      removeDestination as never,
    );

    expect(response.status).toBe(412);
    expect(removeDestination).not.toHaveBeenCalled();
    expect(repo.nodes.has('existing.txt')).toBe(true);
  });

  it('refuses a malformed Overwrite value rather than assuming consent', async () => {
    // The old test was `raw !== 'F'`, so `Overwrite: 0` meant "yes" and
    // destroyed the destination — backwards for a header whose only job is to
    // prevent that.
    for (const value of ['0', 'no', 'yes', 'TF', '']) {
      const repo = seeded();
      const response = await handleCopy(
        request('COPY', 'a.txt', { Destination: destination('existing.txt'), Overwrite: value }),
        'a.txt',
        BASES,
        repo as never,
        fakeLocks() as never,
        fakeDofs(repo) as never,
        destroyer() as never,
      );
      expect(response.status).toBe(412);
    }
  });

  it('accepts the ABNF literals case-insensitively', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'a.txt', { Destination: destination('fresh.txt'), Overwrite: 't' }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(201);
  });
});

describe('handleCopy — destination validation', () => {
  it('refuses a Destination naming the source itself', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'dir', { Destination: destination('dir') }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(400);
  });

  it('refuses a Destination inside the source subtree', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'dir', { Destination: destination('dir/inner') }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(400);
  });

  it('refuses a Destination outside the volume base', async () => {
    const repo = seeded();
    const request = new Request('https://dav.example.com/alice/photos/a.txt', {
      method: 'COPY',
      headers: { Destination: 'https://dav.example.com/bob/other/x.txt' },
    });
    const response = await handleCopy(
      request,
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(400);
  });

  it('refuses a missing Destination header', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'a.txt'),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(400);
  });

  it('409s when the destination parent is a file', async () => {
    // The parent check is `getParentPath(dest)` and must be non-empty — the
    // volume root is exempt because every collection has it as a parent.
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'dir/b.txt', { Destination: destination('a.txt/child.txt') }),
      'dir/b.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(409);
  });

  it('404s when the source does not exist', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'missing.txt', { Destination: destination('x.txt') }),
      'missing.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(404);
  });

  it('423s when the destination is locked by another client', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'a.txt', { Destination: destination('existing.txt') }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks({ lockedPaths: ['existing.txt'] }) as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(423);
  });
});

describe('handleCopy — successful transfers', () => {
  it('201s a file COPY to a new destination and writes the bytes', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'a.txt', { Destination: destination('copy.txt') }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(201);
    expect(new TextDecoder().decode(repo.nodes.get('copy.txt')?.bytes)).toBe('A');
  });

  it('204s a file COPY that replaces an existing destination', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'a.txt', { Destination: destination('existing.txt') }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(204);
    expect(new TextDecoder().decode(repo.nodes.get('existing.txt')?.bytes)).toBe('A');
  });

  it('507s on ENOSPC rather than reporting the source as gone', async () => {
    // `srcStat.exists` was already confirmed, so a failed write is ENOSPC —
    // reporting "Not Found" blamed the source for a destination failure.
    const repo = seeded();
    const dofs = fakeDofs(repo, { writeFailures: new Map([['copy.txt', 'ENOSPC']]) });
    const response = await handleCopy(
      request('COPY', 'a.txt', { Destination: destination('copy.txt') }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      dofs as never,
      destroyer() as never,
    );
    expect(response.status).toBe(507);
  });

  it('Depth: 0 on a collection copies the collection without its members', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'dir', { Destination: destination('dir-copy'), Depth: '0' }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(201);
    expect(repo.nodes.has('dir-copy')).toBe(true);
    expect(repo.nodes.has('dir-copy/b.txt')).toBe(false);
  });

  it('Depth: infinity copies every descendant', async () => {
    const repo = seeded();
    const response = await handleCopy(
      request('COPY', 'dir', { Destination: destination('dir-copy'), Depth: 'infinity' }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(201);
    expect(new TextDecoder().decode(repo.nodes.get('dir-copy/b.txt')?.bytes)).toBe('B');
  });

  it('207s and names each failed child rather than reporting a truncated success', async () => {
    // A child that fails to copy used to be `continue`d, so a quota-limited
    // COPY answered 201 with a silently truncated tree and 0-byte phantoms.
    const repo = seeded();
    const dofs = fakeDofs(repo, { writeFailures: new Map([['dir-copy/b.txt', 'ENOSPC']]) });
    const response = await handleCopy(
      request('COPY', 'dir', { Destination: destination('dir-copy'), Depth: 'infinity' }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      dofs as never,
      destroyer() as never,
    );
    expect(response.status).toBe(207);
    const body = await response.text();
    expect(body).toContain('507');
    expect(body).toContain('b.txt');
  });
});

describe('handleMove', () => {
  it('400s a collection MOVE carrying Depth: 0', async () => {
    // §9.9.2 forbids any Depth but infinity. MOVE did not validate it at all, so
    // `Depth: 0` silently performed a full recursive move.
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const response = await handleMove(
      request('MOVE', 'dir', { Destination: destination('moved'), Depth: '0' }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      dofs as never,
      destroyer() as never,
    );
    expect(response.status).toBe(400);
    expect(dofs.rename).not.toHaveBeenCalled();
    expect(repo.nodes.has('dir')).toBe(true);
  });

  it('accepts Depth: infinity and moves the tree', async () => {
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const response = await handleMove(
      request('MOVE', 'dir', { Destination: destination('moved'), Depth: 'infinity' }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      dofs as never,
      destroyer() as never,
    );
    expect(response.status).toBe(201);
    expect(repo.nodes.has('dir')).toBe(false);
    expect(repo.nodes.has('moved')).toBe(true);
  });

  it('423s when a DESCENDANT of the source collection is locked', async () => {
    // §9.9.4 lists a locked descendant as a 423 cause. MOVE used only
    // `assertLock`, which walks ancestors of the target, so a lock on
    // `/dir/b.txt` did not stop a MOVE of `/dir` out from under it.
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const response = await handleMove(
      request('MOVE', 'dir', { Destination: destination('moved') }),
      'dir',
      BASES,
      repo as never,
      fakeLocks({ lockedDescendants: { 'dir/b.txt': ['opaquelocktoken:abc'] } }) as never,
      dofs as never,
      destroyer() as never,
    );
    expect(response.status).toBe(423);
    expect(dofs.rename).not.toHaveBeenCalled();
    expect(repo.nodes.has('dir')).toBe(true);
  });

  it('500s fail-closed when the descendant listing cannot be read', async () => {
    // A failed listing must not read as "nothing is locked", or MOVE removes a
    // locked subtree on a transient storage error.
    const repo = seeded();
    repo.recursiveFails = true;
    const dofs = fakeDofs(repo);
    const response = await handleMove(
      request('MOVE', 'dir', { Destination: destination('moved') }),
      'dir',
      BASES,
      repo as never,
      fakeLocks() as never,
      dofs as never,
      destroyer() as never,
    );
    expect(response.status).toBe(500);
    expect(dofs.rename).not.toHaveBeenCalled();
    expect(repo.nodes.has('dir')).toBe(true);
  });

  it('does not carry locks across the move', async () => {
    // §7.6: a successful MOVE on a write-locked resource MUST NOT move the
    // lock with the resource.
    const repo = seeded();
    const response = await handleMove(
      request('MOVE', 'a.txt', { Destination: destination('moved.txt') }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(201);
    expect(repo.renameCascade).toHaveBeenCalledWith('a.txt', 'moved.txt');
  });

  it('412s a MOVE onto an existing destination with Overwrite: F', async () => {
    const repo = seeded();
    const response = await handleMove(
      request('MOVE', 'a.txt', { Destination: destination('existing.txt'), Overwrite: 'F' }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      fakeDofs(repo) as never,
      destroyer() as never,
    );
    expect(response.status).toBe(412);
    expect(repo.nodes.has('existing.txt')).toBe(true);
  });

  it('surfaces a 423 from the destination deletion instead of proceeding', async () => {
    const repo = seeded();
    const dofs = fakeDofs(repo);
    const response = await handleMove(
      request('MOVE', 'a.txt', { Destination: destination('existing.txt') }),
      'a.txt',
      BASES,
      repo as never,
      fakeLocks() as never,
      dofs as never,
      vi.fn(() => Promise.resolve(new Response('Locked', { status: 423 }))) as never,
    );
    expect(response.status).toBe(423);
    expect(dofs.rename).not.toHaveBeenCalled();
  });
});