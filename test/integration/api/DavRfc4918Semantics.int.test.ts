import { describe, expect, it, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';

/**
 * RFC 4918 §9 semantics that were wrong, against a real Durable Object.
 *
 * Each case here is a case where the server **answered with a status code that
 * looked correct and had already destroyed or falsified data by the time it did**.
 * That is why these are integration tests and not unit tests against a double: a
 * double cannot prove that bytes on a filesystem survive a rejected request, and
 * every one of these bugs was invisible to the status code alone.
 *
 * - `COPY` validated `Depth` *after* deleting the destination (H3).
 * - `MOVE` re-pathed `dav_locks`, carrying a write lock across a rename (§7.6).
 * - `UNLOCK` deleted any zero-byte file, destroying a `PUT`-created empty file
 *   through the ordinary PUT -> LOCK -> UNLOCK cycle (§7.3).
 * - `PUT` whose body exceeded the device quota destroyed the file it was
 *   overwriting, because `dofs.writeFile` unlinked before checking.
 * - `LOCK` with `Depth: infinity` on a file created the file and then answered
 *   400, leaving an unlocked phantom.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

const VOLUME = 'rfc4918';
const EMAIL = 'test@example.com';
let OWNER = 'rfcsem';

const XML = { 'Content-Type': 'application/xml; charset=utf-8' };
// Unprefixed elements on purpose: `handleLock` recognises a write lock with
// `/<write\b/i` and an exclusive scope with `/<shared\b/i`, so a prefixed
// `<D:write/>` reads as neither and the request is refused 400 before any of
// the behaviour under test runs. (The PROPFIND parser is namespace-aware; the
// LOCK body scanner is not.)
const LOCK_BODY =
  '<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype><owner>tester</owner></lockinfo>';

let auth: Record<string, string>;

function url(inner: string): string {
  return `https://example.com/${OWNER}/${VOLUME}/${inner}`;
}

async function currentUsername(): Promise<string> {
  const row = await (env as unknown as TestEnv).DB.prepare(`SELECT username FROM users WHERE email = ?`)
    .bind(EMAIL)
    .first<{ username: string | null }>();
  expect(row?.username).toBeTruthy();
  return row?.username ?? '';
}

describe('RFC 4918 §9 semantics over a real Durable Object', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, EMAIL);
    await ensureUser(testEnv.DB, EMAIL, OWNER);
    OWNER = await currentUsername();
    const created = await SELF.fetch('https://example.com/user/volumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, name: VOLUME, isPrivate: false }),
    });
    expect([201, 400]).toContain(created.status);
    const minted = await SELF.fetch(`https://example.com/user/volumes/${OWNER}/${VOLUME}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rfc' }),
    });
    expect(minted.status).toBe(201);
    const { username, password } = (await minted.json()) as { username: string; password: string };
    auth = { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
  });

  it('COPY rejects a bad Depth without destroying the destination', async () => {
    // §9.8.3 allows only `0` and `infinity` on a COPY of a collection. The
    // destination used to be recursively deleted *first* and the `Depth` checked
    // afterwards, so this request returned a clean 400 having already removed
    // `depth-dst/old.txt`.
    await SELF.fetch(url('depth-src'), { method: 'MKCOL', headers: auth });
    await SELF.fetch(url('depth-src/keep.txt'), { method: 'PUT', headers: auth, body: 'src' });
    // A populated destination, so `destExists` is true and the delete runs at all.
    await SELF.fetch(url('depth-dst'), { method: 'MKCOL', headers: auth });
    await SELF.fetch(url('depth-dst/old.txt'), { method: 'PUT', headers: auth, body: 'old' });

    const res = await SELF.fetch(url('depth-src'), {
      method: 'COPY',
      headers: { ...auth, Destination: url('depth-dst'), Overwrite: 'T', Depth: '1' },
    });
    expect(res.status).toBe(400);

    // The whole point: the *destination* survived the rejection, contents and all.
    const read = await SELF.fetch(url('depth-dst/old.txt'), { method: 'GET', headers: auth });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('old');
  });

  it('MOVE does not carry a write lock to the new path', async () => {
    // §7.6: "A successful MOVE request on a write locked resource MUST NOT move
    // the write lock with the resource." `renameNodeCascade` re-pathed
    // `dav_locks`, so a lock taken on a collection survived its rename and
    // applied to a resource in a collection the locker never named.
    await SELF.fetch(url('lockmove-src'), { method: 'MKCOL', headers: auth });
    const lock = await SELF.fetch(url('lockmove-src'), {
      method: 'LOCK',
      headers: { ...auth, Depth: 'infinity', ...XML },
      body: LOCK_BODY,
    });
    expect([200, 201]).toContain(lock.status);
    const token = lock.headers.get('Lock-Token') ?? '';
    expect(token).not.toBe('');

    const moved = await SELF.fetch(url('lockmove-src'), {
      method: 'MOVE',
      headers: { ...auth, Destination: url('lockmove-dst'), If: `(<${token}>)` },
    });
    expect([201, 204]).toContain(moved.status);

    // A write to the moved collection, with no `If` header, must succeed: the
    // lock stayed behind at the old path.
    const write = await SELF.fetch(url('lockmove-dst/after.txt'), { method: 'PUT', headers: auth, body: 'after' });
    expect([201, 204]).toContain(write.status);
    expect(write.status).not.toBe(423);
  });

  it('UNLOCK does not delete an uploaded empty file', async () => {
    // §7.3: a resource created with a LOCK "behaves the same way as a resource
    // created by a PUT request with an empty body", and a locked empty resource
    // "SHOULD NOT disappear when its lock goes away". The cleanup keyed on
    // `size === 0`, which cannot tell the two apart — so the standard client
    // cycle (PUT empty, LOCK, UNLOCK) deleted the file.
    await SELF.fetch(url('emptydoc.txt'), { method: 'PUT', headers: auth, body: '' });
    const lock = await SELF.fetch(url('emptydoc.txt'), {
      method: 'LOCK',
      headers: { ...auth, ...XML },
      body: LOCK_BODY,
    });
    expect([200, 201]).toContain(lock.status);
    const token = lock.headers.get('Lock-Token') ?? '';
    expect(token).not.toBe('');

    const unlock = await SELF.fetch(url('emptydoc.txt'), {
      method: 'UNLOCK',
      headers: { ...auth, 'Lock-Token': token },
    });
    expect(unlock.status).toBe(204);

    // Still there, and still readable.
    const read = await SELF.fetch(url('emptydoc.txt'), { method: 'GET', headers: auth });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('');
  });

  it('UNLOCK still removes a resource the LOCK itself created', async () => {
    // The other half of the same rule: a lock-null resource (created by the LOCK
    // on an unmapped URL) has no content of its own and SHOULD be cleaned up.
    // `dav_nodes.lock_null` is the only thing that can tell it from the uploaded
    // empty file above.
    const lock = await SELF.fetch(url('locknull.txt'), {
      method: 'LOCK',
      headers: { ...auth, ...XML },
      body: LOCK_BODY,
    });
    expect([200, 201]).toContain(lock.status);
    const token = lock.headers.get('Lock-Token') ?? '';
    const unlock = await SELF.fetch(url('locknull.txt'), { method: 'UNLOCK', headers: { ...auth, 'Lock-Token': token } });
    expect(unlock.status).toBe(204);

    const read = await SELF.fetch(url('locknull.txt'), { method: 'GET', headers: auth });
    expect(read.status).toBe(404);
  });

  it('a rejected LOCK with Depth: infinity leaves no phantom file', async () => {
    // The file was created and *then* the `Depth` was validated, so a 400 left
    // behind an unlocked 0-byte resource the client was told it had not created.
    const res = await SELF.fetch(url('phantom.txt'), {
      method: 'LOCK',
      headers: { ...auth, Depth: 'infinity', ...XML },
      body: LOCK_BODY,
    });
    expect(res.status).toBe(400);
    const read = await SELF.fetch(url('phantom.txt'), { method: 'GET', headers: auth });
    expect(read.status).toBe(404);
  });

  it('a PUT that exceeds the device quota leaves the existing file intact', async () => {
    // `dofs.writeFile` unlinked the target and only then checked the quota, so a
    // 507 destroyed the previous content: a routine failing PUT silently
    // truncated an existing resource to zero bytes with no way to recover it.
    await SELF.fetch(url('quota.txt'), { method: 'PUT', headers: auth, body: 'original content' });
    // Past the device budget configured for this suite (`DO_DEVICE_BYTES` in
    // `wrangler.test.jsonc`) but under `MAX_FILE_BYTES`, so this reaches dofs
    // and fails there. The per-file cap is a separate, already-tested `413` path
    // that never touches the filesystem.
    const oversized = 'x'.repeat(6 * 1024 * 1024);
    const res = await SELF.fetch(url('quota.txt'), { method: 'PUT', headers: auth, body: oversized });
    expect(res.status).toBe(507);

    const read = await SELF.fetch(url('quota.txt'), { method: 'GET', headers: auth });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('original content');
  });

  it('refuses an Overwrite value that is neither T nor F', async () => {
    // §10.6: `Overwrite = "Overwrite" ":" ("T" | "F")`. The old test was
    // `!== 'F'`, so `Overwrite: 0` meant "yes" and destroyed the destination.
    await SELF.fetch(url('ow-src.txt'), { method: 'PUT', headers: auth, body: 'src' });
    await SELF.fetch(url('ow-dst.txt'), { method: 'PUT', headers: auth, body: 'dst' });
    const res = await SELF.fetch(url('ow-src.txt'), {
      method: 'COPY',
      headers: { ...auth, Destination: url('ow-dst.txt'), Overwrite: '0' },
    });
    expect(res.status).toBe(412);
    const read = await SELF.fetch(url('ow-dst.txt'), { method: 'GET', headers: auth });
    expect(await read.text()).toBe('dst');
  });

  it('refuses MOVE with a Depth other than infinity', async () => {
    // §9.9.2. `handleCopy` validated its `Depth` and `handleMove` did not, so
    // `MOVE /a` with `Depth: 0` silently performed a full recursive move.
    await SELF.fetch(url('mdepth-src'), { method: 'MKCOL', headers: auth });
    await SELF.fetch(url('mdepth-src/k.txt'), { method: 'PUT', headers: auth, body: 'k' });
    const res = await SELF.fetch(url('mdepth-src'), {
      method: 'MOVE',
      headers: { ...auth, Destination: url('mdepth-dst'), Depth: '0' },
    });
    expect(res.status).toBe(400);
    const read = await SELF.fetch(url('mdepth-src/k.txt'), { method: 'GET', headers: auth });
    expect(read.status).toBe(200);
  });

  it('PUT does not read the query string as a trailing slash', async () => {
    // The check was `request.url.endsWith('/')`, so an ordinary file with a query
    // parameter ending in a slash was answered 405. A trailing slash is a
    // property of the path (§8.3).
    const res = await SELF.fetch(url('query.txt?next=/'), { method: 'PUT', headers: auth, body: 'q' });
    expect([201, 204]).toContain(res.status);
    const read = await SELF.fetch(url('query.txt'), { method: 'GET', headers: auth });
    expect(await read.text()).toBe('q');
  });
});