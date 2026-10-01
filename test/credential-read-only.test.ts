import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Container, setRequestScope } from '@durable-dav/backend-runtime/di';
import { Tokens } from '@durable-dav/backend-services/composition';
import type { DavPermissionService, VolumeService } from '@durable-dav/backend-services/dav';
import type { UserIdentityService } from '@durable-dav/backend-services/identity';
import { DavCredentialDAO } from '@durable-dav/backend-data/dao';
import type { D1Queryable } from '@durable-dav/backend-data/utils';
import { DavCredentialUtil } from '@durable-dav/shared/utils';
import type { DavVolumeRow } from '@durable-dav/backend-data/dao';
import { davAuthForVolume } from '../apps/api/src/middleware/DavAuth';
import { davErrorResponse } from '@durable-dav/webdav';

type TestEnv = { Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } };
type TestApp = Hono<TestEnv>;

const VOLUME_ID = 'vol_1';
const USERNAME = 'quiet-otter';
const PASSWORD = 'ddav_probe_password';

/**
Methods the front door treats as writes (`DavRoutes.needsWrite`). `davAuthForVolume`
is called with that boolean, so the fake app derives it the same way the real
route does rather than the test hand-picking.
*/
function isWrite(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS', 'PROPFIND'].includes(method);
}

/**
A volume row shaped the way a post-0004 create writes it, with an
`owner_user_id` so `isVolumeOwner` takes the account-key branch.
*/
function volumeRow(overrides: Partial<DavVolumeRow> = {}): DavVolumeRow {
  return {
    id: VOLUME_ID,
    owner_email: 'owner@example.com',
    owner: 'alice',
    name: 'photos',
    description: null,
    is_private: 1,
    created_at: 1,
    updated_at: 1,
    owner_ci: 'alice',
    name_ci: 'photos',
    owner_user_id: 'usr_1',
    href_prefix_mode: 'base',
    ...overrides,
  } as DavVolumeRow;
}

/**
A fake D1 holding one credential row, and recording every statement it was
asked to run. The real `DavCredentialDAO` is used on top of it, so the test
exercises the production SELECT — including whether that SELECT names
`read_only`. A projection that dropped the column would coerce to `false` and
hand out write access, which is the failure this guards.
*/
function fakeDb(row: Record<string, unknown> | null): { db: D1Queryable; queries: string[] } {
  const queries: string[] = [];
  const db: D1Queryable = {
    prepare(query: string) {
      const normalized = query.replaceAll(/\s+/g, ' ').trim();
      queries.push(normalized);
      const statement = {
        bind: () => statement,
        first: async <T,>(): Promise<T | null> => {
          if (!row) return null;
          // The auth lookup filters on the username and an unexpired row; the
          // password is verified in the worker, never in SQL.
          if (normalized.includes('WHERE username = ? AND expires_at > ?')) {
            return (Number(row.expires_at) > 1 ? (row as T) : null);
          }
          return row as T;
        },
        all: async <T,>(): Promise<{ results: T[] }> => ({ results: (row ? [row] : []) as T[] }),
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
      return statement;
    },
  };
  return { db, queries };
}

async function credentialRow(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    credential_id: 'cred_1',
    volume_id: VOLUME_ID,
    username: USERNAME,
    password_hash: await DavCredentialUtil.hashPassword(PASSWORD),
    name: 'backup',
    password_prefix: 'ddav_pro',
    password_last_four: 'word',
    created_at: 1,
    expires_at: 4_102_444_800,
    last_used_at: null,
    ...overrides,
  };
}

/**
Mount `davAuthForVolume` behind a Hono request so the middleware is exercised
through the same `c.get`/`c.env` surface it sees in production. The scope is a
hand-wired `Container` rather than `createRequestScope`, so no real D1 is
needed and the authorization decision is the only thing under test.
*/
function buildApp(volume: DavVolumeRow, row: Record<string, unknown> | null): { app: TestApp; queries: string[] } {
  const { db, queries } = fakeDb(row);
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    const scope = new Container();
    // Structural stubs, not the real services: only `getVolume` /
    // `resolveUserById` are on the credential path, and building a real
    // `VolumeService` would drag a D1 and the whole DAO graph into a test whose
    // subject is one `if`.
    scope.bindValue(Tokens.VolumeService, { getVolume: () => Promise.resolve(volume) } as unknown as VolumeService);
    scope.bindValue(Tokens.DavCredentialDAO, () => Promise.resolve(new DavCredentialDAO(db)));
    // The anonymous-read branch is never taken when a credential is present,
    // but the token has to resolve or the container throws.
    scope.bindValue(Tokens.DavPermissionService, { getRole: () => 'read' as const } as unknown as DavPermissionService);
    scope.bindValue(Tokens.UserIdentityService, { resolveUserById: () => Promise.resolve(null) } as unknown as UserIdentityService);
    setRequestScope(c, scope);
    await next();
  });
  app.all('/:owner/:volume/*', async (c) => {
    const result = await davAuthForVolume(c, c.req.param('owner') ?? '', c.req.param('volume') ?? '', isWrite(c.req.method));
    return result instanceof Response ? result : c.json(result);
  });
  return { app, queries };
}

function basic(username = USERNAME, password = PASSWORD): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
}

async function authorize(app: TestApp, method: string, headers: Record<string, string> = basic()): Promise<Response> {
  return app.request(`https://x/alice/photos/file.txt`, { method, headers });
}

describe('read-only bucket credentials (migration 0005)', () => {
  it('refuses every content-changing method with 403 and a DAV error body', async () => {
    const { app } = buildApp(volumeRow(), await credentialRow({ read_only: 1 }));
    // This list is the DAV write surface: everything that changes content or
    // takes a lock. LOCK is included because a lock row is a write, and UNLOCK
    // follows it because a read-only client can never hold one.
    for (const method of ['PUT', 'DELETE', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'PROPPATCH']) {
      const response = await authorize(app, method);
      expect(response.status, `${method} must be refused`).toBe(403);
      expect(response.headers.get('Content-Type')).toContain('application/xml');
      const body = await response.text();
      expect(body).toContain('<D:error');
      expect(body).toContain('cannot-modify-protected-property');
    }
  });

  it('does not re-prompt the client for a password on the refusal', async () => {
    const { app } = buildApp(volumeRow(), await credentialRow({ read_only: 1 }));
    // A 403 carrying `WWW-Authenticate: Basic` is what turns a one-line refusal
    // into a native client re-entering the password and failing forever.
    const response = await authorize(app, 'PUT');
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('lets the read methods through', async () => {
    const { app } = buildApp(volumeRow(), await credentialRow({ read_only: 1 }));
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PROPFIND']) {
      expect((await authorize(app, method)).status, `${method} must be allowed`).toBe(200);
    }
  });

  it('leaves a full-access credential on the same bucket able to write', async () => {
    // The pair that proves the flag is per-credential and not per-bucket: the
    // read-only restriction must not leak onto the owner's other credentials.
    const { app } = buildApp(volumeRow(), await credentialRow({ read_only: 0 }));
    expect((await authorize(app, 'PUT')).status).toBe(200);
  });

  it('treats a missing read_only column as full access, never as read-only', async () => {
    // A row written before 0005 has no such field. Degrading to `false` keeps
    // existing credentials working; degrading to `true` would lock every user
    // out of their own bucket the moment the migration lands.
    const { app } = buildApp(volumeRow(), await credentialRow({ read_only: undefined }));
    expect((await authorize(app, 'PUT')).status).toBe(200);
  });

  it('names read_only in the auth lookup', async () => {
    // The flag is decided on this one query. A projection that omitted the
    // column would coerce to `false` and quietly grant write access.
    const { app, queries } = buildApp(volumeRow(), await credentialRow({ read_only: 1 }));
    await authorize(app, 'GET');
    const authQuery = queries.find((q) => q.includes('WHERE username = ?'));
    expect(authQuery).toBeDefined();
    expect(authQuery).toMatch(/\bread_only\b/u);
  });

  it('still answers 401 for a bad password', async () => {
    const { app } = buildApp(volumeRow(), await credentialRow({ read_only: 1 }));
    const response = await authorize(app, 'PUT', basic(USERNAME, 'not-the-password'));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('still answers 401 for a credential bound to another volume', async () => {
    const { app } = buildApp(volumeRow(), await credentialRow({ read_only: 1, volume_id: 'vol_other' }));
    expect((await authorize(app, 'PUT')).status).toBe(401);
  });

  it('builds the same 403 through the shared webdav helper', async () => {
    // `davErrorResponse` is the single producer of the DAV error body; this
    // pins the shape so the middleware and any future caller cannot drift.
    const response = davErrorResponse(403, 'cannot-modify-protected-property');
    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    expect(await response.text()).toBe('<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:cannot-modify-protected-property/></D:error>');
  });
});
