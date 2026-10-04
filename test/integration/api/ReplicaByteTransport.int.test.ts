import { describe, expect, it, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setupIntegrationTest, ensureUser } from '../helpers/setup';

/**
 * Does a `ReadableStream` survive a Durable Object RPC boundary?
 *
 * This is the one runtime assumption the whole byte path rests on, and it was worth
 * settling before building on it: `dofs.writeFile` accepts a stream, so a push or
 * pull could be end-to-end streaming with nothing buffered — but only if the RPC
 * layer carries a stream rather than flattening it. If it does not, every transfer
 * would have to be chunked, and the failure mode is silent (the write helper
 * reports nothing and the run still says `ok`).
 *
 * So this probes it rather than assuming it, and the runner is written to notice
 * either answer.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database; DAV_VOLUME: DurableObjectNamespace };

const VOLUME = 'streamprobe';
const EMAIL = 'test@example.com';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let OWNER = 'streamowner';
let auth: Record<string, string>;
const api = (path: string, init: RequestInit = {}): Promise<Response> => SELF.fetch(`https://example.com${path}`, init);
const dav = (inner: string, init: RequestInit = {}): Promise<Response> =>
  api(`/${OWNER}/${VOLUME}${inner}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv;
  await setupIntegrationTest(testEnv, EMAIL);
  await ensureUser(testEnv.DB, EMAIL, OWNER);
  const row = await testEnv.DB.prepare('SELECT username FROM users WHERE email = ?').bind(EMAIL).first<{ username: string | null }>();
  OWNER = row?.username ?? OWNER;
  expect((await api('/user/volumes', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ owner: OWNER, name: VOLUME }) })).status).toBe(201);
  const cred = await api(`/user/volumes/${OWNER}/${VOLUME}/credentials`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'probe' }) });
  const { username, password } = (await cred.json()) as { username: string; password: string };
  auth = { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
  expect((await dav('/payload.txt', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'stream payload' })).status).toBe(201);
});

describe('Durable Object RPC — byte transport', () => {
  it('returns a usable ReadableStream from readReplicaStream', async () => {
    const stub = (env as unknown as TestEnv).DAV_VOLUME.getByName(`${OWNER}/${VOLUME}`) as unknown as {
      readReplicaStream: (path: string) => Promise<ReadableStream<Uint8Array> | null>;
    };
    const stream = await stub.readReplicaStream('payload.txt');
    expect(stream, 'readReplicaStream returned nothing for a file that exists').not.toBeNull();
    expect(stream).toBeInstanceOf(ReadableStream);
    // The payload only round-trips if the stream is genuinely live rather than an
    // empty object the deserializer could not reconstruct.
    const text = await new Response(stream as ReadableStream).text();
    expect(text).toBe('stream payload');
  });

  it('accepts a ReadableStream back through applyReplicaOperations', async () => {
    const stub = (env as unknown as TestEnv).DAV_VOLUME.getByName(`${OWNER}/${VOLUME}`) as unknown as {
      applyReplicaOperations: (id: string, ops: unknown[]) => Promise<{ applied: number; failed: number; error: string | null }>;
    };
    const result = await stub.applyReplicaOperations('probe', [
      { op: 'write', path: 'streamed.txt', contentType: 'text/plain', data: new Response('written via stream').body },
    ]);
    expect(result.error).toBeNull();
    expect(result.failed).toBe(0);
    expect(await (await dav('/streamed.txt')).text()).toBe('written via stream');
  });

  it('accepts a Uint8Array through the same operation', async () => {
    const stub = (env as unknown as TestEnv).DAV_VOLUME.getByName(`${OWNER}/${VOLUME}`) as unknown as {
      applyReplicaOperations: (id: string, ops: unknown[]) => Promise<{ applied: number; failed: number; error: string | null }>;
    };
    const result = await stub.applyReplicaOperations('probe', [
      { op: 'write', path: 'buffered.txt', contentType: 'text/plain', data: new TextEncoder().encode('written as bytes') },
    ]);
    expect(result.failed).toBe(0);
    expect(await (await dav('/buffered.txt')).text()).toBe('written as bytes');
  });
});
describe('DavVolumeRemote — reading through a configured subdirectory', () => {
  it('reads a file the way the sync engine asks for it', async () => {
    // The path the sync engine uses is *root-relative* (`up.txt`), while the
    // sibling stores it under the target subdirectory. If the adapter's mapping is
    // wrong in either direction, the pull is a silent no-op and the run still
    // reports `ok` — which is exactly the failure this case exists to pin.
    const { DavVolumeRemote } = await import('../../../apps/background/src/replication/remote/DavVolumeRemote');
    const testEnv = env as unknown as TestEnv;
    const adapter = new DavVolumeRemote({
      getStub: (owner, volume) => testEnv.DAV_VOLUME.getByName(`${owner}/${volume}`) as never,
      owner: OWNER,
      volume: VOLUME,
      remotePath: 'sub',
      replicationId: 'probe',
    });
    expect((await dav('/sub', { method: 'MKCOL' })).status).toBe(201);
    expect((await dav('/sub/inner.txt', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'inner payload' })).status).toBe(201);

    const listing = await adapter.list('');
    expect(listing.entries.map((entry) => entry.path)).toEqual(['inner.txt']);

    const stream = await adapter.readFile('inner.txt');
    expect(stream, 'adapter read returned nothing for a file that exists').not.toBeNull();
    expect(await new Response(stream as ReadableStream).text()).toBe('inner payload');
  });
});
