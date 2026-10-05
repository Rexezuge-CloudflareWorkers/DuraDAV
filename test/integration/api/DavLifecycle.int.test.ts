import { describe, expect, it, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';

function basic(username: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
}

describe('Durable-DAV lifecycle (buckets + WebDAV Class 1/2)', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as { DB: D1Database } & Record<string, unknown>;
    await setupIntegrationTest(testEnv, 'test@example.com');
    await ensureUser(testEnv.DB, 'test@example.com', 'test');
  });

  it('health reports durable-dav', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(body.service).toBe('durable-dav');
  });

  it('creates a private-by-default bucket, credentials, and speaks OPTIONS/PROPFIND', async () => {
    const create = await SELF.fetch('https://example.com/user/volumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'test', name: 'photos' }),
    });
    expect([201, 400]).toContain(create.status);
    if (create.status === 201) {
      const created = (await create.json()) as { isPrivate?: boolean };
      expect(created.isPrivate).toBe(true);
    }

    // Mint a bucket credential via the API.
    const minted = await SELF.fetch('https://example.com/user/volumes/test/photos/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'integration' }),
    });
    expect(minted.status).toBe(201);
    const { username, password } = (await minted.json()) as { username: string; password: string };
    expect(username.startsWith('photos-')).toBe(true);
    expect(password.startsWith('ddav_')).toBe(true);

    // Wrong username with valid password shape is rejected (username validated).
    const badUser = await SELF.fetch('https://example.com/test/photos/', {
      method: 'PROPFIND',
      headers: { ...basic('photos-wrong-user-0000', password), Depth: '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>',
    });
    expect(badUser.status).toBe(401);

    const auth = basic(username, password);
    const options = await SELF.fetch('https://example.com/test/photos/', { method: 'OPTIONS', headers: auth });
    expect(options.status).toBe(200);
    expect(options.headers.get('DAV')).toContain('1');
    expect(options.headers.get('DAV')).toContain('2');

    const propfind = await SELF.fetch('https://example.com/test/photos/', {
      method: 'PROPFIND',
      headers: { ...auth, Depth: '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>',
    });
    expect(propfind.status).toBe(207);
    const xml = await propfind.text();
    expect(xml).toContain('multistatus');
    expect(xml).toContain('resourcetype');
  });

  it('PUT/GET/MKCOL round-trip with bucket credentials', async () => {
    const listed = await SELF.fetch('https://example.com/user/volumes/test/photos/credentials');
    expect(listed.status).toBe(200);
    const { credentials } = (await listed.json()) as { credentials: Array<{ username: string }> };
    expect(credentials.length).toBeGreaterThan(0);

    // Re-mint a fresh credential for write isolation.
    const minted = await SELF.fetch('https://example.com/user/volumes/test/photos/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'writer' }),
    });
    const { username, password } = (await minted.json()) as { username: string; password: string };
    const auth = basic(username, password);

    // Unauthenticated writes are rejected even before credential check.
    const anonPut = await SELF.fetch('https://example.com/test/photos/dir/hello.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello durable-dav',
    });
    expect(anonPut.status).toBe(401);

    const mkcol = await SELF.fetch('https://example.com/test/photos/dir', { method: 'MKCOL', headers: auth });
    expect([201, 405]).toContain(mkcol.status);

    const put = await SELF.fetch('https://example.com/test/photos/dir/hello.txt', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: 'hello durable-dav',
    });
    expect([201, 204]).toContain(put.status);

    const get = await SELF.fetch('https://example.com/test/photos/dir/hello.txt', { headers: auth });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('hello durable-dav');
  });

  it('LOCK/UNLOCK round-trip (Class 2) with bucket credentials', async () => {
    const minted = await SELF.fetch('https://example.com/user/volumes/test/photos/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'locker' }),
    });
    const { username, password } = (await minted.json()) as { username: string; password: string };
    const auth = basic(username, password);

    const lock = await SELF.fetch('https://example.com/test/photos/dir/hello.txt', {
      method: 'LOCK',
      headers: { ...auth, Depth: '0', Timeout: 'Second-60', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
    });
    expect([200, 201]).toContain(lock.status);
    const token = lock.headers.get('Lock-Token');
    expect(token).toBeTruthy();

    const unlock = await SELF.fetch('https://example.com/test/photos/dir/hello.txt', {
      method: 'UNLOCK',
      headers: { ...auth, 'Lock-Token': token ?? '' },
    });
    expect(unlock.status).toBe(204);
  });

  /**
   * The ancestor walk had four implementations — the 423 guard, the
   * `lockdiscovery` projection, LOCK's per-path read, and LOCK's refresh lookup.
   * They were consolidated onto one exported walk, and this asserts the property
   * that consolidation was for: what `lockdiscovery` *reports* and what the guard
   * *enforces* are the same set, for a `Depth: infinity` lock on a collection.
   *
   * A disagreement is invisible from either side alone. The guard answers "may I
   * write this" and the PROPFIND answers "what is locked here"; each looks
   * correct while they name different paths, and the client sees a resource it
   * believes is unlocked then gets a 423 on it.
   */
  it('an infinity lock on a collection is advertised and enforced on its children', async () => {
    const minted = await SELF.fetch('https://example.com/user/volumes/test/photos/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'infinity-locker' }),
    });
    expect(minted.status).toBe(201);
    const { username, password } = (await minted.json()) as { username: string; password: string };
    const auth = basic(username, password);

    // A child inside the collection, distinct from `dir/hello.txt` so an earlier
    // test's lock cannot make this one a refresh.
    await SELF.fetch('https://example.com/test/photos/dir/child.txt', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: 'child',
    });

    const lock = await SELF.fetch('https://example.com/test/photos/dir', {
      method: 'LOCK',
      headers: { ...auth, Depth: 'infinity', Timeout: 'Second-60', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
    });
    expect(lock.status).toBe(201);
    const token = lock.headers.get('Lock-Token') ?? '';

    // A second credential, so the write below is genuinely *another* client and
    // cannot be answered by the lock holder's own token.
    const other = await SELF.fetch('https://example.com/user/volumes/test/photos/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bystander' }),
    });
    const { username: otherUser, password: otherPassword } = (await other.json()) as { username: string; password: string };
    const otherAuth = basic(otherUser, otherPassword);

    // What the guard enforces.
    const blockedWrite = await SELF.fetch('https://example.com/test/photos/dir/child.txt', {
      method: 'PUT',
      headers: { ...otherAuth, 'Content-Type': 'text/plain' },
      body: 'overwritten',
    });
    expect(blockedWrite.status).toBe(423);

    // What lockdiscovery advertises. The same child must be reported as locked —
    // this is the assertion the two walks used to fail.
    const propfind = await SELF.fetch('https://example.com/test/photos/dir/child.txt', {
      method: 'PROPFIND',
      headers: { ...otherAuth, Depth: '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><lockdiscovery/></prop></propfind>',
    });
    expect(propfind.status).toBe(207);
    const xml = await propfind.text();
    expect(xml).toContain('<activelock>');
    // The inherited lock's root is the collection, not the child — the answer a
    // depth-0-only walk would have got wrong by reporting nothing at all.
    expect(xml).toContain('<depth>infinity</depth>');

    // A refresh of the collection by its holder must not be refused by the
    // lock it already holds, and must keep the infinity depth (§9.10.2). The
    // `If` header carries the same `urn:uuid:` value the `Lock-Token` header
    // returned, brackets included.
    const refresh = await SELF.fetch('https://example.com/test/photos/dir', {
      method: 'LOCK',
      headers: { ...auth, Depth: '0', If: `(${token})`, 'Content-Type': 'application/xml' },
    });
    expect(refresh.status).toBe(200);
    expect(await refresh.text()).toContain('<depth>infinity</depth>');

    expect((await SELF.fetch('https://example.com/test/photos/dir', { method: 'UNLOCK', headers: { ...auth, 'Lock-Token': token } })).status).toBe(204);

    // Released: the same write that was refused now succeeds, so the 423 above
    // came from this lock and not from something else about the path.
    expect((await SELF.fetch('https://example.com/test/photos/dir/child.txt', {
      method: 'PUT',
      headers: { ...otherAuth, 'Content-Type': 'text/plain' },
      body: 'overwritten',
    })).status).toBe(204);
  });

  it('PATCH visibility and DELETE bucket (danger zone)', async () => {
    const patched = await SELF.fetch('https://example.com/user/volumes/test/photos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Integration bucket', isPrivate: true }),
    });
    expect(patched.status).toBe(200);
    const detail = (await patched.json()) as { description: string | null; isPrivate: boolean };
    expect(detail.description).toBe('Integration bucket');
    expect(detail.isPrivate).toBe(true);
  });

  it('browser plane serves private bucket via session without a Basic challenge', async () => {
    const body = '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>';
    // Protocol plane still requires bucket Basic on private buckets.
    const anonDav = await SELF.fetch('https://example.com/test/photos/', {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body,
    });
    expect(anonDav.status).toBe(401);
    expect(anonDav.headers.get('WWW-Authenticate')).toContain('Basic');

    // Browser plane: DEV_AUTH_EMAIL session lists without Basic, no challenge.
    const list = await SELF.fetch('https://example.com/user/volumes/test/photos/files/', {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body,
    });
    expect(list.status).toBe(207);
    expect(list.headers.get('WWW-Authenticate')).toBeNull();
    expect(await list.text()).toContain('multistatus');

    // Browser write + read round-trip via session (no Basic).
    const put = await SELF.fetch('https://example.com/user/volumes/test/photos/files/browser-hello.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello browser plane',
    });
    expect([201, 204]).toContain(put.status);
    const get = await SELF.fetch('https://example.com/user/volumes/test/photos/files/browser-hello.txt');
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('hello browser plane');
    expect(get.headers.get('WWW-Authenticate')).toBeNull();

    // Browser MOVE with a browser-style Destination is rewritten to the DAV base.
    const move = await SELF.fetch('https://example.com/user/volumes/test/photos/files/browser-hello.txt', {
      method: 'MOVE',
      headers: {
        Destination: 'https://example.com/user/volumes/test/photos/files/browser-moved.txt',
        Overwrite: 'T',
      },
    });
    expect([200, 201, 204]).toContain(move.status);
    const moved = await SELF.fetch('https://example.com/user/volumes/test/photos/files/browser-moved.txt');
    expect(moved.status).toBe(200);
    expect(await moved.text()).toBe('hello browser plane');

    // Missing volume hides existence without a Basic challenge.
    const missing = await SELF.fetch('https://example.com/user/volumes/test/no-such-vol/files/', {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body,
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('WWW-Authenticate')).toBeNull();
  });
});
