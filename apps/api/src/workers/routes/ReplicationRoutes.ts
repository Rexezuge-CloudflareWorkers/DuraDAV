import { Tokens } from '@durable-dav/backend-services/composition';
import { VolumeReplicationService } from '@durable-dav/backend-services/dav';
import { NotFoundError } from '@durable-dav/backend-errors';
import { ReplicationRunner } from '@durable-dav/background/replication';
import type { LocalReplicaStub, RunResult } from '@durable-dav/background/replication';
import type { Container } from '@durable-dav/backend-runtime/di';
import { normalizeVolumeKey } from '@durable-dav/webdav';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import type { ApiApp, ApiContext } from '@/types/ApiContext';
import { VolumeScopedRoute } from './VolumeScopedRoute';
import type { VolumeRequestContext } from './VolumeScopedRoute';
import { getVolumeStub } from '../doStubs';
import { toConflictJson, toReplicationJson } from './replicationProjection';

type App = ApiApp;

/**
 * Owner-facing replication configuration.
 *
 * ## Why these are owner-only and never credential-authenticated
 *
 * `VolumeScopedRoute`'s guard is the whole authorisation story, and it is
 * deliberate that a bucket credential cannot reach any of this. A credential
 * grants content access to one bucket; letting it also name a remote URL would
 * make it exfiltration — point a victim's bucket at an attacker-controlled host,
 * wait for `keep-both` or `sync` to push the owner's files there, and read them.
 * Replication is a configuration surface about *where this bucket's contents go*,
 * so it rides on the same identity that owns the bucket.
 *
 * ## 404, not 403
 *
 * Constructed with `404` like the browser plane. A stranger should not be able to
 * probe which buckets exist, and a stranger must not learn that a bucket exists
 * *and* has replications pointed somewhere.
 */

class ListReplications extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const rows = await scope.get(Tokens.VolumeReplicationService).listReplications(row.id);
    return c.json({
      replications: rows.map(toReplicationJson),
      allowedIntervals: VolumeReplicationService.allowedIntervals(),
    });
  }
}

class CreateReplication extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row, owner, volume, email }: VolumeRequestContext): Promise<Response> {
    const read = await BaseRoute.readJson<Record<string, unknown>>(c);
    const unreadable = BaseRoute.rejectUnreadableBody(c, read);
    if (unreadable) return unreadable;
    const created = await scope
      .get(Tokens.VolumeReplicationService)
      // `normalizeVolumeKey` is what the self-replication guard compares against,
      // because the Durable Object — not the row id — is the volume's identity.
      .createReplication(row.id, normalizeVolumeKey(owner, volume), toCreateInput(read.body), email);
    return c.json({ replication: toReplicationJson(created) }, 201);
  }
}

/**
Narrow the unvalidated body to what the service validates.
*/
function toCreateInput(body: unknown): {
  targetKind?: unknown;
  remoteUrl?: unknown;
  remoteOwner?: unknown;
  remoteVolume?: unknown;
  remotePath?: unknown;
  authKind?: unknown;
  username?: unknown;
  secret?: unknown;
  mode?: unknown;
  mirrorDeletions?: unknown;
  intervalMinutes?: unknown;
  enabled?: unknown;
} {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  return {
    targetKind: record['targetKind'],
    remoteUrl: record['remoteUrl'],
    remoteOwner: record['remoteOwner'],
    remoteVolume: record['remoteVolume'],
    remotePath: record['remotePath'],
    authKind: record['authKind'],
    username: record['username'],
    secret: record['secret'],
    mode: record['mode'],
    mirrorDeletions: record['mirrorDeletions'],
    intervalMinutes: record['intervalMinutes'],
    enabled: record['enabled'],
  };
}

class GetReplication extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const service = scope.get(Tokens.VolumeReplicationService);
    const replication = await service.getReplication(row.id, c.req.param('replicationId') ?? '');
    const openConflicts = await service.countUnresolvedConflicts(row.id, replication.replication_id);
    return c.json({ replication: toReplicationJson(replication), openConflicts });
  }
}

class UpdateReplication extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const read = await BaseRoute.readJson<Record<string, unknown>>(c);
    const unreadable = BaseRoute.rejectUnreadableBody(c, read);
    if (unreadable) return unreadable;
    const updated = await scope
      .get(Tokens.VolumeReplicationService)
      .updateReplication(row.id, c.req.param('replicationId') ?? '', {
        mode: read.body?.['mode'],
        mirrorDeletions: read.body?.['mirrorDeletions'],
        intervalMinutes: read.body?.['intervalMinutes'],
        enabled: read.body?.['enabled'],
      });
    return c.json({ replication: toReplicationJson(updated) });
  }
}

/**
 * Rotate the stored remote credential.
 *
 * Separate from `PATCH` because it is the one update that touches the secret
 * envelope, and it must never be expressible as a field on the general patch —
 * a credential smuggled through a settings blob is a credential nobody audited.
 */
class RotateReplicationSecret extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const read = await BaseRoute.readJson<Record<string, unknown>>(c);
    const unreadable = BaseRoute.rejectUnreadableBody(c, read);
    if (unreadable) return unreadable;
    const updated = await scope.get(Tokens.VolumeReplicationService).rotateSecret(row.id, c.req.param('replicationId') ?? '', {
      authKind: read.body?.['authKind'],
      username: read.body?.['username'],
      secret: read.body?.['secret'],
    });
    return c.json({ replication: toReplicationJson(updated) });
  }
}

class DeleteReplication extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row, owner, volume }: VolumeRequestContext): Promise<Response> {
    const replicationId = c.req.param('replicationId') ?? '';
    const service = scope.get(Tokens.VolumeReplicationService);
    await service.deleteReplication(row.id, replicationId);
    // Forget the recorded base too. Without this a replication re-created against
    // the same target inherits the old base and its first pass compares a fresh
    // tree against a record of a tree that no longer exists — reporting thousands
    // of unchanged files and propagating every deletion the old one had recorded.
    // Best-effort: the D1 row is already gone, so the FK cascade has removed the
    // audit trail too, and a stale base row is inert until a replication with the
    // same id returns.
    await forgetReplicaState(c, owner, volume, replicationId);
    return c.json({ ok: true });
  }
}

class ListReplicationConflicts extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const includeResolved = c.req.query('includeResolved') === 'true';
    const conflicts = await scope.get(Tokens.VolumeReplicationService).listConflicts(row.id, c.req.param('replicationId') ?? '', includeResolved);
    return c.json({ conflicts: conflicts.map(toConflictJson) });
  }
}

class ResolveReplicationConflict extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const resolved = await scope
      .get(Tokens.VolumeReplicationService)
      .resolveConflict(row.id, c.req.param('replicationId') ?? '', c.req.param('conflictId') ?? '');
    // Idempotent by design: the second call reports `false` rather than 404,
    // because a client retrying after a dropped response must not be told the
    // conflict does not exist. `markResolved` is guarded on `resolved_at IS NULL`
    // so nothing is pushed twice.
    return c.json({ resolved });
  }
}

/**
 * Run one slice immediately, off the cron schedule.
 *
 * `waitUntil` so the HTTP response is not held open for a full sync: the work is
 * bounded by the slice budget but that is still tens of seconds, and a client
 * timeout here would look like a failed sync that had in fact succeeded. Without
 * an execution context — unit tests, and any harness that omits one — the slice
 * is awaited inline and the response says so, so a test never asserts against a
 * promise that was never started.
 */
class RunReplicationNow extends VolumeScopedRoute {
  constructor() {
    super(404);
  }

  protected async run(c: ApiContext, { scope, row }: VolumeRequestContext): Promise<Response> {
    const replicationId = c.req.param('replicationId') ?? '';
    const service = scope.get(Tokens.VolumeReplicationService);
    await service.getReplication(row.id, replicationId);
    const work = runReplicaSliceNow(scope, c.env, replicationId);
    const executionCtx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
    if (typeof executionCtx?.waitUntil === 'function') {
      executionCtx.waitUntil(work.catch(() => undefined));
      return c.json({ sync: 'started' }, 202);
    }
    const result = await work;
    return c.json({ sync: 'done', status: result.status, error: result.error });
  }
}

/**
 * Drive one slice from a request.
 *
 * Uses the same runner the cron sweep does, so "Sync now" cannot behave
 * differently from the scheduled path — a separate implementation here would be
 * a second thing to keep correct, and this is the code that deletes.
 *
 * The DAOs come from the request scope rather than `new`, which is both the
 * composition rule and the reason this can live in `apps/api` at all: the route
 * reaches the runner through `@durable-dav/background`, and the runner needs the
 * volume row to resolve the target's Durable Object.
 */
async function runReplicaSliceNow(scope: Container, env: Env, replicationId: string): Promise<RunResult> {
  const replicationDAO = await scope.get(Tokens.DavReplicationDAO)();
  const replication = await replicationDAO.getById(replicationId);
  if (!replication) throw new NotFoundError('Replication not found');
  const volumeDAO = await scope.get(Tokens.DavVolumeDAO)();
  const row = await volumeDAO.getById(replication.volume_id);
  if (!row) throw new NotFoundError('Volume not found');
  const stub = getVolumeStub(env, row.owner, row.name) as unknown as LocalReplicaStub;
  // Both DAOs, from the scope. Passing only `replicationDAO` left the runner to
  // fall back to `new DavReplicationConflictDAO(env.DB)`, so the conflict-audit
  // rows on the "Sync Now" path were written by a DAO that never passed through
  // the request scope — the exact inconsistency `serviceBindings` documents
  // having been fixed elsewhere.
  const conflictDAO = await scope.get(Tokens.DavReplicationConflictDAO)();
  return new ReplicationRunner(env, replication, row.owner, row.name, stub, { replicationDAO, conflictDAO }).runSlice();
}

async function forgetReplicaState(c: ApiContext, owner: string, volume: string, replicationId: string): Promise<void> {
  const stub = getVolumeStub(c.env, owner, volume) as unknown as { forgetReplication: (id: string) => Promise<void> };
  await stub.forgetReplication(replicationId).catch(() => undefined);
}

function registerReplicationRoutes(app: App): void {
  const base = '/user/volumes/:owner/:volume/replications';
  app.get(base, (c) => new ListReplications().handle(c));
  app.post(base, (c) => new CreateReplication().handle(c));
  app.get(`${base}/:replicationId`, (c) => new GetReplication().handle(c));
  app.patch(`${base}/:replicationId`, (c) => new UpdateReplication().handle(c));
  app.post(`${base}/:replicationId/credential`, (c) => new RotateReplicationSecret().handle(c));
  app.delete(`${base}/:replicationId`, (c) => new DeleteReplication().handle(c));
  app.post(`${base}/:replicationId/run`, (c) => new RunReplicationNow().handle(c));
  app.get(`${base}/:replicationId/conflicts`, (c) => new ListReplicationConflicts().handle(c));
  app.post(`${base}/:replicationId/conflicts/:conflictId/resolve`, (c) => new ResolveReplicationConflict().handle(c));
}

export { registerReplicationRoutes };
