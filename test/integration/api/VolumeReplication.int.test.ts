import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetRateLimitForTests } from '../../../apps/api/src/middleware/index';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';

/**
 * Two-way replication between two buckets, end to end.
 *
 * The unit suites prove the planner's truth table and the runner's wiring against
 * fakes. Neither can prove the thing that actually matters here: that a real Durable
 * Object, reached over real DO RPC, converges with another one — and specifically
 * that the *deletion* direction works, since that is the only path where a bug
 * destroys data on both sides at once and there is no undo.
 *
 * Two buckets on the same deployment, so the `dav-volume` adapter is exercised
 * rather than the HTTP one: no egress, no SSRF policy, and the sync is one real RPC
 * hop between two real `DavVolumeWorker`s with real dofs storage behind them.
 *
 * The cron never fires here — `wrangler.test.jsonc` has no `triggers` — so each case
 * drives `POST .../replications/:id/run` directly. That is the same runner the sweep
 * uses, which is the point: "Sync now" cannot be a second implementation.
 *
 * ## Why one bucket pair per group, and not per case
 *
 * A fresh pair per case is the tidiest isolation and is what this was written as
 * first. It costs two volume creations and two credential creations per case, and
 * `/user/volumes/*` is rate limited to 60 per minute per isolate — 28 of those within
 * a few seconds answers `429`, and every case after the eighth fails for a reason
 * that has nothing to do with replication.
 *
 * A pair per `describe` block is the coarsest split that still isolates: each group
 * gets its own source, its own target, and its own credentials, so no case reads or
 * writes another's paths. Cases inside a group share a source but are separated by a
 * per-case directory and target subdirectory, so they also share no paths — the only
 * thing they share is the recorded base, which is keyed per replication and so is
 * distinct for every one of them.
 *
 * The target per case is left in place rather than deleted afterwards. Deleting it
 * would keep the bucket under `MAX_REPLICATIONS_PER_VOLUME`, but it doubles the
 * `/user/*` traffic for no gain: a group holds five replications against a cap of
 * ten.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

// Must match `DEV_AUTH_EMAIL` in `wrangler.test.jsonc`.
const EMAIL = 'test@example.com';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let OWNER = 'replowner';

type Pair = { source: string; target: string; auth: Map<string, Record<string, string>> };

/**
One pair per group, created in `beforeAll`.
*/
const pairs = new Map<string, Pair>();

const api = (path: string, init: RequestInit = {}): Promise<Response> => SELF.fetch(`https://example.com${path}`, init);

/**
 * Bucket Basic credentials, keyed by volume.
 *
 * The WebDAV plane has no owner identity at all — a `Basic` header carries no user,
 * which is exactly why the read-only flag exists — so every DAV-plane request here
 * needs a credential. One per bucket rather than one shared, because a credential is
 * bound to a single volume id.
 */
function dav(pair: Pair, volume: 'source' | 'target', path: string, init: RequestInit = {}): Promise<Response> {
  const name = pair[volume];
  return api(`/${OWNER}/${name}${path}`, {
    ...init,
    headers: { ...pair.auth.get(name), ...(init.headers as Record<string, string>) },
  });
}

type ReplicationRow = {
  replicationId: string;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  passInFlight: boolean;
  mode: string;
  enabled: boolean;
};

async function createVolume(name: string): Promise<void> {
  const res = await api('/user/volumes', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ owner: OWNER, name }) });
  expect(res.status, `creating ${name}`).toBe(201);
}

/**
A writable bucket credential, recorded for the DAV-plane helpers.
*/
async function createCredential(volume: string, auth: Map<string, Record<string, string>>): Promise<void> {
  const res = await api(`/user/volumes/${OWNER}/${volume}/credentials`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'replication' }),
  });
  expect(res.status, `credential for ${volume}`).toBe(201);
  const { username, password } = (await res.json()) as { username: string; password: string };
  auth.set(volume, { Authorization: `Basic ${btoa(`${username}:${password}`)}` });
}

async function makePair(group: string): Promise<Pair> {
  const source = `rep-src-${group}`;
  const target = `rep-dst-${group}`;
  const auth = new Map<string, Record<string, string>>();
  await createVolume(source);
  await createVolume(target);
  await createCredential(source, auth);
  await createCredential(target, auth);
  const pair: Pair = { source, target, auth };
  pairs.set(group, pair);
  return pair;
}

function pairOf(group: string): Pair {
  const pair = pairs.get(group);
  if (pair === undefined) throw new Error(`pair for group ${group} was not created`);
  return pair;
}

async function put(pair: Pair, side: 'source' | 'target', inner: string, body: string): Promise<void> {
  const res = await dav(pair, side, `/${inner}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
  expect([201, 204], `PUT ${side}/${inner}`).toContain(res.status);
}

async function getBody(pair: Pair, side: 'source' | 'target', inner: string): Promise<string | null> {
  const res = await dav(pair, side, `/${inner}`);
  if (res.status === 404) return null;
  expect(res.status, `GET ${side}/${inner}`).toBe(200);
  return res.text();
}

/**
 * Create a collection, tolerating one that already exists.
 *
 * A target subdirectory is created *by the sync* when it first pushes into it, so a
 * test that writes on the target side first has to make the directory itself, or the
 * PUT answers 409 on a missing parent.
 */
async function ensureDir(pair: Pair, side: 'source' | 'target', inner: string): Promise<void> {
  const res = await dav(pair, side, `/${inner}`, { method: 'MKCOL' });
  expect([201, 405], `MKCOL ${side}/${inner}`).toContain(res.status);
}

/**
Names present in one collection, from a real `Depth: 1` PROPFIND.
*/
async function listing(pair: Pair, side: 'source' | 'target', inner: string): Promise<string[]> {
  const res = await dav(pair, side, inner === '' ? '/' : `/${inner}/`, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>',
  });
  expect(res.status, `PROPFIND ${side}/${inner}`).toBe(207);
  const body = await res.text();
  const name = pair[side];
  const base = `/${OWNER}/${name}/${inner}/`;
  const children = [...body.matchAll(/<href>([^<]*)<\/href>/g)].map((match) => decodeURIComponent(match[1] ?? ''));
  return children.filter((href) => href.startsWith(base)).map((href) => href.slice(base.length)).filter((entry) => entry !== '');
}

/**
 * The path a file lands at inside the target, given a case's subdirectory.
 *
 * The target stores its subdirectory *plus* the replication's own path, so a pushed
 * file is two segments deep. Every assertion about a push goes through this rather
 * than hand-writing the prefix, because getting it wrong produces a case that
 * asserts against a file nothing ever wrote.
 */
function inTarget(label: string, inner: string): string {
  return `${label}/${inner}`;
}

/**
 * Where a file the *target* contributes lands on the source.
 *
 * The target's subdirectory is stripped when its listing is mapped into the
 * replication's namespace, because that subdirectory is a target-side container
 * letting several replications share one bucket — not part of the source's tree. So
 * `target/<label>/up.txt` arrives at the source as `up.txt`, not `up.txt` under
 * `<label>`, and no helper can paper over the asymmetry with `inTarget`.
 *
 * Worth stating because it is the single most confusing thing about a
 * subdirectory-scoped replication, and it is why this suite pushes and pulls from
 * differently-named paths.
 */
function pulledTo(inner: string): string {
  return inner;
}

/**
Point the pair's source at its target, with `label` as the target's subdirectory.
*/
async function replicate(pair: Pair, label: string, mode: string): Promise<ReplicationRow> {
  const res = await api(`/user/volumes/${OWNER}/${pair.source}/replications`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ targetKind: 'dav-volume', remoteOwner: OWNER, remoteVolume: pair.target, remotePath: label, mode, intervalMinutes: 360 }),
  });
  expect(res.status, `configuring ${label}`).toBe(201);
  return ((await res.json()) as { replication: ReplicationRow }).replication;
}

/**
 * Drive one slice and wait for it to finish.
 *
 * The route detaches the work into `waitUntil` and answers `202`, which is the
 * contract: a slice can run for tens of seconds, and a client timeout would look like
 * a failed sync that had in fact succeeded. So the wait is on observable state, which
 * is what an owner watching the dashboard would do.
 */
async function syncNow(pair: Pair, replicationId: string): Promise<ReplicationRow> {
  const res = await api(`/user/volumes/${OWNER}/${pair.source}/replications/${replicationId}/run`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  });
  expect([200, 202], `POST sync ${replicationId}`).toContain(res.status);
  // Wait for the pass to *open* before waiting for it to close. Waiting only for "not
  // in flight" is satisfied instantly by the previous pass's finished state, so a
  // second sync would return before it had done anything — and the assertions after it
  // would measure the pass before it.
  const opened = await waitFor(replicationId, (row) => row.passInFlight);
  expect(opened, `replication ${replicationId} never opened a pass — row: ${JSON.stringify(await status(replicationId))}`).not.toBeNull();
  const finished = await waitFor(replicationId, (row) => !row.passInFlight && row.lastRunAt !== null);
  expect(finished, `replication ${replicationId} never finished a pass — row: ${JSON.stringify(await status(replicationId))}`).not.toBeNull();
  return finished as ReplicationRow;
}

/**
 * Poll the row until `predicate` holds, or give up.
 *
 * Bounded by wall clock rather than attempt count, so the bound is the same whether the
 * interval is yielding or sleeping.
 *
 * The interval starts at zero and settles at 25 ms. A pass over a warm bucket can open
 * and close in well under one tick, so a fixed sleep steps over the window entirely;
 * yielding without a delay catches it, and backing off afterwards keeps a genuinely slow
 * pass cheap to wait for.
 */
async function waitFor(replicationId: string, predicate: (row: ReplicationRow) => boolean): Promise<ReplicationRow | null> {
  const deadline = Date.now() + 10_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const row = await status(replicationId);
    if (predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, attempts < 200 ? 0 : 25));
  }
  return null;
}

/**
 * The row the runner wrote, read straight from D1.
 *
 * Not through the API: the wait loops poll, and `/user/*` is rate limited, so an HTTP
 * poll rate-limits itself into a 429 and the case fails for a reason that has nothing
 * to do with replication. This reads the same row the runner updates.
 */
async function status(replicationId: string): Promise<ReplicationRow> {
  const db = (env as unknown as TestEnv).DB;
  const row = await db
    .prepare('SELECT last_run_at, last_status, last_error, pass_started_at, mode, enabled FROM dav_replications WHERE replication_id = ?')
    .bind(replicationId)
    .first<{ last_run_at: number | null; last_status: string | null; last_error: string | null; pass_started_at: number | null; mode: string; enabled: number }>();
  expect(row, `replication ${replicationId} row`).toBeDefined();
  return {
    replicationId,
    lastRunAt: row?.last_run_at ?? null,
    lastStatus: row?.last_status ?? null,
    lastError: row?.last_error ?? null,
    passInFlight: row?.pass_started_at !== null,
    mode: row?.mode ?? 'keep-both',
    enabled: row?.enabled === 1,
  };
}

/**
The API's view of one replication, used only where the projection is under test.
*/
async function projection(pair: Pair, replicationId: string): Promise<ReplicationRow> {
  const res = await api(`/user/volumes/${OWNER}/${pair.source}/replications/${replicationId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { replication: ReplicationRow }).replication;
}

/**
The recorded decisions for one replication.
*/
async function decisions(pair: Pair, replicationId: string): Promise<Array<{ path: string; kind: string; keptPath: string | null }>> {
  const res = await api(`/user/volumes/${OWNER}/${pair.source}/replications/${replicationId}/conflicts`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { conflicts: Array<{ path: string; kind: string; keptPath: string | null }> }).conflicts;
}

/**
 * The whole file is given a generous per-case timeout.
 *
 * Every case provisions two buckets, then runs one to three *real* replication passes
 * and polls D1 for their outcome. A two-pass case is genuinely double the work, and the
 * suite runs fifteen files concurrently against one Miniflare pool, so a case that
 * takes ~500 ms alone can exceed vitest's 5 s default purely on contention. The bound
 * is still far below `waitFor`'s own 5 s ceiling, so a genuinely stuck pass still fails
 * with the message naming it rather than as a timeout.
 */
const CASE_TIMEOUT_MS = 20_000;

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv;
  await setupIntegrationTest(testEnv, EMAIL);
  await ensureUser(testEnv.DB, EMAIL, OWNER);
  const row = await testEnv.DB.prepare('SELECT username FROM users WHERE email = ?').bind(EMAIL).first<{ username: string | null }>();
  OWNER = row?.username ?? OWNER;
  expect(OWNER).not.toBe('');
  for (const group of ['config', 'transfer', 'deletions', 'modes', 'teardown']) await makePair(group);
});

/**
 * Clear the per-isolate token bucket between cases.
 *
 * `/user/volumes/*` is limited to 60 requests a minute per identity, and this suite
 * makes roughly two per case across twenty — so without a reset the tenth case
 * onwards answers `429` and fails for a reason that has nothing to do with
 * replication. It would also make each case's outcome depend on how many calls its
 * predecessors happened to make.
 *
 * The limiter itself is not under test here; it has its own coverage in
 * `test/api-hardening.test.ts`, which exercises the bucket directly rather than
 * through twenty real cases.
 */
beforeEach(() => {
  resetRateLimitForTests();
});

describe('replication: configuration', { timeout: CASE_TIMEOUT_MS }, () => {
  it('is owner-only and hidden behind 404 for a stranger', async () => {
    const pair = pairOf('config');
    const created = await replicate(pair, 'owner', 'keep-both');
    expect(created.mode).toBe('keep-both');
    expect(created.enabled).toBe(true);
    // A stranger gets the same answer as for a volume that does not exist, so the
    // endpoint cannot be used to probe which buckets exist or where they sync to.
    const stranger = await api(`/user/volumes/someoneelse/${pair.source}/replications`);
    expect(stranger.status).toBe(404);
  });

  it('refuses a bucket replicating to itself', async () => {
    const pair = pairOf('config');
    // The Durable Object is keyed by path, so this would deadlock: the runner would
    // call the object it is already executing inside.
    const res = await api(`/user/volumes/${OWNER}/${pair.source}/replications`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ targetKind: 'dav-volume', remoteOwner: OWNER, remoteVolume: pair.source, mode: 'sync', intervalMinutes: 360 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { Exception: { Message: string } };
    expect(body.Exception.Message).toMatch(/itself/);
  });

  it('never returns the stored credential', async () => {
    const pair = pairOf('config');
    const created = await replicate(pair, 'secret', 'sync');
    const single = await api(`/user/volumes/${OWNER}/${pair.source}/replications/${created.replicationId}`);
    expect(single.status).toBe(200);
    const text = await single.text();
    expect(text).not.toContain('encryptedSecret');
    expect(text).not.toContain('secretIv');
    expect(text).not.toContain('password');
  });

  it('rejects a duplicate target rather than racing a second row', async () => {
    const pair = pairOf('config');
    await replicate(pair, 'dupe', 'sync');
    const again = await api(`/user/volumes/${OWNER}/${pair.source}/replications`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ targetKind: 'dav-volume', remoteOwner: OWNER, remoteVolume: pair.target, remotePath: 'dupe', mode: 'sync', intervalMinutes: 360 }),
    });
    // The unique index would turn this into a constraint 500. Reporting the conflict it
    // is keeps the API's error contract intact.
    expect(again.status).toBe(400);
  });

  it('accepts a mode change and rejects an unknown one', async () => {
    const pair = pairOf('config');
    const created = await replicate(pair, 'patch', 'copy-only');
    const patched = await api(`/user/volumes/${OWNER}/${pair.source}/replications/${created.replicationId}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: 'sync' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { replication: ReplicationRow }).replication.mode).toBe('sync');

    const rejected = await api(`/user/volumes/${OWNER}/${pair.source}/replications/${created.replicationId}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: 'sideways' }),
    });
    expect(rejected.status).toBe(400);
  });

  it('drops a paused target off the cron\'s due list', async () => {
    const pair = pairOf('config');
    const created = await replicate(pair, 'paused', 'sync');
    const patched = await api(`/user/volumes/${OWNER}/${pair.source}/replications/${created.replicationId}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    // The sweep's only query. Asserted against D1 because that is exactly what
    // `listDue` reads, and going through the API would prove nothing about it.
    const db = (env as unknown as TestEnv).DB;
    const due = await db
      .prepare('SELECT COUNT(*) AS cnt FROM dav_replications WHERE replication_id = ? AND enabled = 1')
      .bind(created.replicationId)
      .first<{ cnt: number }>();
    expect(due?.cnt).toBe(0);
  });
});

describe('replication: two-way transfer', { timeout: CASE_TIMEOUT_MS }, () => {
  it('pushes a local change down and pulls a remote change back up', async () => {
    const pair = pairOf('transfer');
    const source = await replicate(pair, 'roundtrip', 'sync');
    await ensureDir(pair, 'source', 'roundtrip');
    await put(pair, 'source', 'roundtrip/down.txt', 'written on the source');
    await ensureDir(pair, 'target', 'roundtrip');
    await put(pair, 'target', 'roundtrip/up.txt', 'written on the target');

    await syncNow(pair, source.replicationId);

    expect(await getBody(pair, 'target', inTarget('roundtrip', 'roundtrip/down.txt'))).toBe('written on the source');
    expect(await getBody(pair, 'source', pulledTo('up.txt'))).toBe('written on the target');
  });

  it('creates parent collections before the files inside them', async () => {
    const pair = pairOf('transfer');
    const source = await replicate(pair, 'nested', 'sync');
    await ensureDir(pair, 'source', 'nested');
    await ensureDir(pair, 'source', 'nested/deep');
    await put(pair, 'source', 'nested/deep/file.txt', 'nested payload');
    await syncNow(pair, source.replicationId);
    expect(await getBody(pair, 'target', inTarget('nested', 'nested/deep/file.txt'))).toBe('nested payload');
  });

  it('records a clean run and leaves no pass in flight', async () => {
    const pair = pairOf('transfer');
    const source = await replicate(pair, 'clean', 'sync');
    const after = await syncNow(pair, source.replicationId);
    expect(after.lastStatus).toBe('ok');
    expect(after.lastError).toBeNull();
    // The deletion gate. A pass left open after completing is the state where
    // deletions would never propagate — on the one configuration where everything else
    // is working.
    expect(after.passInFlight).toBe(false);
  });

  it('is idempotent — a second pass changes nothing', async () => {
    const pair = pairOf('transfer');
    const source = await replicate(pair, 'idem', 'sync');
    await ensureDir(pair, 'source', 'idem');
    await put(pair, 'source', 'idem/idem.txt', 'idempotent payload');
    await syncNow(pair, source.replicationId);
    const before = await listing(pair, 'target', 'idem');
    await syncNow(pair, source.replicationId);
    expect(await listing(pair, 'target', 'idem')).toEqual(before);
    expect(await getBody(pair, 'target', inTarget('idem', 'idem/idem.txt'))).toBe('idempotent payload');
  });

  it('reports the run through the API projection', async () => {
    const pair = pairOf('transfer');
    const source = await replicate(pair, 'projection', 'sync');
    await ensureDir(pair, 'source', 'projection');
    await put(pair, 'source', 'projection/f.txt', 'payload');
    await syncNow(pair, source.replicationId);
    const seen = await projection(pair, source.replicationId);
    expect(seen.lastStatus).toBe('ok');
    expect(seen.passInFlight).toBe(false);
  });
});

describe('replication: deletions', { timeout: CASE_TIMEOUT_MS }, () => {
  it('propagates a local delete to the target', async () => {
    const pair = pairOf('deletions');
    const source = await replicate(pair, 'del-local', 'sync');
    await ensureDir(pair, 'source', 'del-local');
    await put(pair, 'source', 'del-local/doomed.txt', 'about to be deleted');
    await syncNow(pair, source.replicationId);
    expect(await getBody(pair, 'target', inTarget('del-local', 'del-local/doomed.txt'))).toBe('about to be deleted');

    expect((await dav(pair, 'source', '/del-local/doomed.txt', { method: 'DELETE' })).status).toBe(204);
    await syncNow(pair, source.replicationId);
    // The copy that existed only on the target must be gone. Deleting the wrong side
    // here would leave the file nowhere, which is the failure this direction of the
    // decision exists to prevent — and the one the planner's own tests pin.
    expect(await getBody(pair, 'target', inTarget('del-local', 'del-local/doomed.txt'))).toBeNull();
  });

  it('propagates a target delete back to the source bucket', async () => {
    const pair = pairOf('deletions');
    const source = await replicate(pair, 'del-remote', 'sync');
    await ensureDir(pair, 'target', 'del-remote');
    await put(pair, 'target', 'del-remote/vanishing.txt', 'only on the target');
    await syncNow(pair, source.replicationId);
    expect(await getBody(pair, 'source', pulledTo('vanishing.txt'))).toBe('only on the target');

    expect((await dav(pair, 'target', '/del-remote/vanishing.txt', { method: 'DELETE' })).status).toBe(204);
    await syncNow(pair, source.replicationId);
    expect(await getBody(pair, 'source', pulledTo('vanishing.txt'))).toBeNull();
  });

  it('leaves an untouched file alone when its neighbour is deleted', async () => {
    // A deletion that took more than its own path would show up here, and it is the
    // cheapest way to catch a cascade over-reaching.
    const pair = pairOf('deletions');
    const source = await replicate(pair, 'del-sibling', 'sync');
    await ensureDir(pair, 'source', 'del-sibling');
    await put(pair, 'source', 'del-sibling/keeper.txt', 'stays put');
    await put(pair, 'source', 'del-sibling/sibling.txt', 'goes away');
    await syncNow(pair, source.replicationId);
    expect((await dav(pair, 'source', '/del-sibling/sibling.txt', { method: 'DELETE' })).status).toBe(204);
    await syncNow(pair, source.replicationId);
    expect(await getBody(pair, 'target', inTarget('del-sibling', 'del-sibling/keeper.txt'))).toBe('stays put');
    expect(await getBody(pair, 'target', inTarget('del-sibling', 'del-sibling/sibling.txt'))).toBeNull();
  });

  it('deletes a whole subtree without touching its neighbours', async () => {
    const pair = pairOf('deletions');
    const source = await replicate(pair, 'del-subtree', 'sync');
    await ensureDir(pair, 'source', 'del-subtree');
    await ensureDir(pair, 'source', 'del-subtree/tree');
    await ensureDir(pair, 'source', 'del-subtree/tree/inner');
    await put(pair, 'source', 'del-subtree/tree/a.txt', 'a');
    await put(pair, 'source', 'del-subtree/tree/inner/b.txt', 'b');
    await put(pair, 'source', 'del-subtree/untouched.txt', 'untouched');
    await syncNow(pair, source.replicationId);

    expect((await dav(pair, 'source', '/del-subtree/tree', { method: 'DELETE' })).status).toBe(204);
    await syncNow(pair, source.replicationId);
    // Deepest-first ordering is what makes this possible at all: a target that refuses
    // to delete a non-empty collection would fail the parent and wedge the sweep on it
    // forever.
    expect((await listing(pair, 'target', inTarget('del-subtree', 'del-subtree'))).sort()).toEqual(['untouched.txt']);
  });

  it('records every propagated deletion in the audit trail', async () => {
    const pair = pairOf('deletions');
    const source = await replicate(pair, 'del-audit', 'sync');
    await ensureDir(pair, 'source', 'del-audit');
    await put(pair, 'source', 'del-audit/audited.txt', 'audited payload');
    await syncNow(pair, source.replicationId);
    expect((await dav(pair, 'source', '/del-audit/audited.txt', { method: 'DELETE' })).status).toBe(204);
    await syncNow(pair, source.replicationId);

    // A deletion is the one irreversible thing here, so "which side did it, and what
    // was kept" has to be answerable afterwards.
    const rows = await decisions(pair, source.replicationId);
    expect(rows.some((row) => row.path === 'del-audit/audited.txt' && row.kind === 'deletion')).toBe(true);
  });
});

describe('replication: modes', { timeout: CASE_TIMEOUT_MS }, () => {
  it('never pulls in copy-only mode', async () => {
    // A mirror that imports from the mirror lets a corrupted copy overwrite the
    // original, which is the failure this mode exists to prevent.
    const pair = pairOf('modes');
    const source = await replicate(pair, 'mirror', 'copy-only');
    await ensureDir(pair, 'target', 'mirror');
    await put(pair, 'target', 'mirror/remote-only.txt', 'must not come back');
    await ensureDir(pair, 'source', 'mirror');
    await put(pair, 'source', 'mirror/local-only.txt', 'must go down');
    await syncNow(pair, source.replicationId);
    // Both spellings are checked. A null assertion on one path cannot tell "the pull
    // was refused" from "it landed somewhere else", which is exactly the confusion
    // `pulledTo` documents.
    expect(await getBody(pair, 'source', pulledTo('remote-only.txt'))).toBeNull();
    expect(await getBody(pair, 'source', 'mirror/remote-only.txt')).toBeNull();
    expect(await getBody(pair, 'target', inTarget('mirror', 'mirror/local-only.txt'))).toBe('must go down');
  });

  it('preserves both versions rather than overwriting, in keep-both', async () => {
    const pair = pairOf('modes');
    const source = await replicate(pair, 'conflict', 'keep-both');
    await ensureDir(pair, 'source', 'conflict');
    await put(pair, 'source', 'conflict/contested.txt', 'source version');
    await syncNow(pair, source.replicationId);

    // Now change both sides of the *same* resource. The target's copy lives at the
    // subdirectory plus the local path, so the edit has to go there — editing
    // `target/conflict/contested.txt` would touch a different file and the two sides
    // would never actually contend.
    //
    // Timestamps need no arranging: `keep-both` never consults them. That is the
    // mode's whole point, and it is why it is the default — a conflict resolved by two
    // servers' clocks is a conflict resolved by whichever server is wrong.
    expect((await dav(pair, 'source', '/conflict/contested.txt', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'source edited' })).status).toBe(204);
    expect(
      (await dav(pair, 'target', `/${inTarget('conflict', 'conflict/contested.txt')}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'target edited',
      })).status,
    ).toBe(204);
    await syncNow(pair, source.replicationId);

    const rows = await decisions(pair, source.replicationId);
    const recorded = rows.find((row) => row.path === 'conflict/contested.txt');
    expect(recorded, 'the contested path must be recorded').toBeDefined();
    expect(recorded?.kind).toBe('conflict');
    // Neither side lost its version, and that is stronger than "one side won": both
    // keep the bytes they had, and both gain a copy of the other's. `keptPath` names
    // the local copy slot; the target's is discovered from its listing, because the
    // name embeds a timestamp this test cannot predict.
    expect(recorded?.keptPath).not.toBeNull();
    expect(await getBody(pair, 'source', 'conflict/contested.txt')).toBe('source edited');
    expect(await getBody(pair, 'source', recorded?.keptPath ?? '')).toBe('target edited');
    expect(await getBody(pair, 'target', inTarget('conflict', 'conflict/contested.txt'))).toBe('target edited');
    const targetCopies = (await listing(pair, 'target', inTarget('conflict', 'conflict'))).filter((name) => name.startsWith('contested.txt.conflict-'));
    expect(targetCopies).toHaveLength(1);
    expect(await getBody(pair, 'target', inTarget('conflict', `conflict/${targetCopies[0]}`))).toBe('source edited');
  });

  it('applies the newer side in sync mode', async () => {
    const pair = pairOf('modes');
    const source = await replicate(pair, 'raced', 'sync');
    await ensureDir(pair, 'source', 'raced');
    await put(pair, 'source', 'raced/file.txt', 'original');
    await syncNow(pair, source.replicationId);

    // The recorded mtimes come from two different servers, so the ordering is made
    // unambiguous by spacing the edits rather than by assuming a clock's resolution.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await dav(pair, 'source', '/raced/file.txt', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'source edit' })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(
      (await dav(pair, 'target', `/${inTarget('raced', 'raced/file.txt')}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'target edit' })).status,
    ).toBe(204);
    await syncNow(pair, source.replicationId);

    // Newer wins outright: the target's edit propagates up and the source's version is
    // gone, with no conflict copy anywhere — a copy here would mean the timestamp
    // tiebreak never ran.
    expect(await getBody(pair, 'source', 'raced/file.txt')).toBe('target edit');
    expect(await getBody(pair, 'target', inTarget('raced', 'raced/file.txt'))).toBe('target edit');
    // The decision is still recorded, and its kind says which kind it was: a conflict
    // that was *decided*, not a deletion. Nothing was deleted — the loser was
    // overwritten by the winner, and saying "deletion" would misdescribe the one thing
    // this audit trail exists to get right.
    const rows = (await decisions(pair, source.replicationId)).filter((row) => row.path === 'raced/file.txt');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'conflict', winner: 'remote', keptPath: null });
  });
});

describe('replication: teardown', { timeout: CASE_TIMEOUT_MS }, () => {
  it('forgets the recorded base when the target is removed', async () => {
    const pair = pairOf('teardown');
    const first = await replicate(pair, 'teardown', 'sync');
    await ensureDir(pair, 'source', 'teardown');
    await put(pair, 'source', 'teardown/forget-me.txt', 'payload');
    await syncNow(pair, first.replicationId);

    expect((await api(`/user/volumes/${OWNER}/${pair.source}/replications/${first.replicationId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/user/volumes/${OWNER}/${pair.source}/replications/${first.replicationId}`)).status).toBe(404);

    // A re-created target must not inherit the old base, or its first pass would
    // compare a fresh tree against a record of a tree that no longer exists and
    // propagate every deletion the old one had recorded. A different subdirectory, so
    // the unique target index is satisfied without deleting anything else.
    const second = await replicate(pair, 'teardown-fresh', 'sync');
    await syncNow(pair, second.replicationId);
    // A fresh target pushes what the source has, rather than deciding from a base it
    // was never given.
    expect(await getBody(pair, 'target', inTarget('teardown-fresh', 'teardown/forget-me.txt'))).toBe('payload');
  });
});
