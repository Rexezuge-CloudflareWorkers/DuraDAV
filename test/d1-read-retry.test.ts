import { describe, expect, it } from 'vitest';
import { DavCredentialDAO, DavReplicationConflictDAO, DavReplicationDAO, DavVolumeDAO, NamespaceDAO, UserDAO, UserEmailDAO } from '@durable-dav/backend-data/dao';
import { DatabaseError } from '@durable-dav/backend-errors';

/**
 * Every DAO read normalizes a failure to `DatabaseError`, and every read that
 * *decides* something must not be able to degrade.
 *
 * ## Why this is asserted per-read rather than once on `BaseDAO`
 *
 * `packages/backend-data/AGENTS.md` states the rule — reads go through
 * `firstWithRetry`/`allWithRetry`, never a bare `.first()`/`.all()` — and it was
 * documented, load-bearing, and then violated in nine places. `getByOwnerName`
 * carries a ten-line comment justifying it while `getById`, three lines below,
 * did not use it.
 *
 * A rule that can be forgotten one method at a time is not enforced by a comment,
 * so this walks the actual public surface instead.
 *
 * ## One failure shape for a read, and it is a throw
 *
 * A read reports failure by rejecting. `.first()` and `.all()` have no `success`
 * flag to inspect — that is on `run()` — so `executeD1WithRetry`'s
 * `result.success` check applies to writes, and `firstWithRetry`/`allWithRetry`
 * classify the rejection's message. Asserting a `success: false` read here would
 * be asserting a shape D1 does not produce.
 *
 * What matters is that the throw becomes a `DatabaseError` (so `DavAuth`'s 503 and
 * `BaseRoute`'s 500 are reachable), that a *transient* throw is retried rather
 * than surfaced, and that a read which **decides** something never answers a
 * value it invented.
 */

/**
Every read a DAO exposes that resolves a single row or a list.
*/
const READS: Array<{ name: string; run: (dao: never) => Promise<unknown> }> = [
  { name: 'UserDAO.getByEmail', run: (dao: never) => new UserDAO(dao as never).getByEmail('a@x.co') },
  { name: 'UserDAO.getById', run: (dao: never) => new UserDAO(dao as never).getById('usr_1') },
  { name: 'UserDAO.getByCurrentEmail', run: (dao: never) => new UserDAO(dao as never).getByCurrentEmail('a@x.co') },
  { name: 'UserDAO.getByUsernameCi', run: (dao: never) => new UserDAO(dao as never).getByUsernameCi('alice') },
  { name: 'UserEmailDAO.get', run: (dao: never) => new UserEmailDAO(dao as never).get('a@x.co') },
  { name: 'UserEmailDAO.resolveVerified', run: (dao: never) => new UserEmailDAO(dao as never).resolveVerified('a@x.co') },
  { name: 'UserEmailDAO.listByUserId', run: (dao: never) => new UserEmailDAO(dao as never).listByUserId('usr_1') },
  { name: 'NamespaceDAO.get', run: (dao: never) => new NamespaceDAO(dao as never).get('alice') },
  { name: 'DavVolumeDAO.getByOwnerName', run: (dao: never) => new DavVolumeDAO(dao as never).getByOwnerName('alice', 'files') },
  { name: 'DavVolumeDAO.getById', run: (dao: never) => new DavVolumeDAO(dao as never).getById('vol_1') },
  { name: 'DavVolumeDAO.listByOwnerUserId', run: (dao: never) => new DavVolumeDAO(dao as never).listByOwnerUserId('usr_1') },
  { name: 'DavVolumeDAO.countByOwnerUserId', run: (dao: never) => new DavVolumeDAO(dao as never).countByOwnerUserId('usr_1') },
  { name: 'DavVolumeDAO.listByOwnerEmail', run: (dao: never) => new DavVolumeDAO(dao as never).listByOwnerEmail('a@x.co') },
  { name: 'DavVolumeDAO.countByOwnerEmail', run: (dao: never) => new DavVolumeDAO(dao as never).countByOwnerEmail('a@x.co') },
  { name: 'DavCredentialDAO.getActiveByUsername', run: (dao: never) => new DavCredentialDAO(dao as never).getActiveByUsername('alice') },
  { name: 'DavCredentialDAO.getById', run: (dao: never) => new DavCredentialDAO(dao as never).getById('cred_1') },
  { name: 'DavCredentialDAO.listByVolume', run: (dao: never) => new DavCredentialDAO(dao as never).listByVolume('vol_1') },
  { name: 'DavCredentialDAO.countByVolume', run: (dao: never) => new DavCredentialDAO(dao as never).countByVolume('vol_1') },
  { name: 'DavCredentialDAO.usernameExists', run: (dao: never) => new DavCredentialDAO(dao as never).usernameExists('alice') },
  { name: 'DavReplicationDAO.getById', run: (dao: never) => new DavReplicationDAO(dao as never).getById('rep_1') },
  { name: 'DavReplicationDAO.getByVolumeAndTarget', run: (dao: never) => new DavReplicationDAO(dao as never).getByVolumeAndTarget('vol_1', {
    targetKind: 'dav',
    remoteUrl: 'https://example.com',
    remoteOwner: '',
    remoteVolume: '',
    remotePath: '',
  }) },
  { name: 'DavReplicationDAO.listByVolume', run: (dao: never) => new DavReplicationDAO(dao as never).listByVolume('vol_1') },
  { name: 'DavReplicationDAO.countByVolume', run: (dao: never) => new DavReplicationDAO(dao as never).countByVolume('vol_1') },
  { name: 'DavReplicationDAO.listDue', run: (dao: never) => new DavReplicationDAO(dao as never).listDue(1, 10) },
  { name: 'DavReplicationConflictDAO.listByReplication', run: (dao: never) => new DavReplicationConflictDAO(dao as never).listByReplication('rep_1', false) },
  { name: 'DavReplicationConflictDAO.countUnresolved', run: (dao: never) => new DavReplicationConflictDAO(dao as never).countUnresolved('rep_1') },
];

const TRANSIENT = 'D1_ERROR: database is temporarily busy';
const PERMANENT = 'D1_ERROR: no such table: users';

/**
 * A D1 whose every statement fails the same way.
 *
 * Every terminal method (`first`/`all`/`run`) returns the *same* promise, because
 * a DAO read picks one of them and a fake that implemented only `first` would make
 * a list read fail with `is not a function` — which this file would then report
 * as a normalization bug.
 *
 * When `message` is {@link TRANSIENT} the first attempt fails and later attempts
 * succeed, so a read that retries resolves normally.
 */
function failingDatabase(message: string): unknown {
  let attempts = 0;
  /**
   * `@param method` is the terminal call the DAO made. `.all()` must resolve a
   * *result object* while `.first()` resolves the row itself, and a fake that
   * returned the same shape for both would break every list read for a reason that
   * has nothing to do with retry behaviour.
   */
  const statement = (method: 'first' | 'all' | 'run'): unknown => {
    attempts += 1;
    const recovered = message === TRANSIENT && attempts > 1;
    if (method === 'all') {
      return recovered ? Promise.resolve({ results: [] }) : Promise.reject(new Error(message));
    }
    return recovered ? Promise.resolve(null) : Promise.reject(new Error(message));
  };
  const prepared = {
    bind: () => prepared,
    first: () => statement('first'),
    all: () => statement('all'),
    run: () => statement('run'),
  };
  return { prepare: () => prepared };
}

describe('every DAO read normalizes a failure to DatabaseError', () => {
  it('turns a failed read into a DatabaseError', async () => {
    // The documented reason the rule exists: `DavAuth` catches `DatabaseError` to
    // fail closed with a 503, but a bare `.first()` rejects with a raw `D1_ERROR`
    // that is not a `DatabaseError`, so that branch was unreachable and a D1 blip
    // surfaced as an opaque 500.
    //
    // A *permanent* message, so this exercises normalization rather than the retry
    // schedule — the transient case is covered separately, and 26 reads × 3
    // backoffs would otherwise make this test time out rather than assert anything.
    for (const read of READS) {
      await expect(read.run(failingDatabase(PERMANENT) as never), read.name).rejects.toBeInstanceOf(DatabaseError);
    }
  });

  it('never answers a failed read with a value', async () => {
    // The actual risk, stated positively. A quota count that degrades to `0`
    // lets `MAX_VOLUMES_PER_USER` be bypassed; a list that degrades to `[]` reads
    // as "the bucket is empty". These reads must fail, not answer.
    const deciding = READS.filter((read) => /count|usernameExists/.test(read.name));
    expect(deciding.length, 'the deciding reads must be covered').toBeGreaterThan(4);
    for (const read of deciding) {
      await expect(read.run(failingDatabase(PERMANENT) as never), read.name).rejects.toBeInstanceOf(DatabaseError);
    }
  });

  it('does not retry a permanent failure', async () => {
    // "Retryable is checked first" is only correct if the classifier is consulted
    // per attempt — a loop that retried unconditionally would turn a missing table
    // into four round trips and still surface the same 500.
    let statements = 0;
    const database = {
      prepare: () => {
        const prepared = {
          bind: () => prepared,
          first: () => {
            statements += 1;
            return Promise.reject(new Error(PERMANENT));
          },
          all: () => {
            statements += 1;
            return Promise.reject(new Error(PERMANENT));
          },
          run: () => {
            statements += 1;
            return Promise.reject(new Error(PERMANENT));
          },
        };
        return prepared;
      },
    };
    await expect(READS[0]!.run(database as never)).rejects.toBeInstanceOf(DatabaseError);
    expect(statements, 'a permanent error must not be retried').toBe(1);
  });

  it('retries a transient failure instead of surfacing it', async () => {
    // Normalization without the retry would still turn a blip into a 503, which is
    // correct but needlessly fails a request D1 would have answered. The retry is
    // why the schedule lives in one place shared by reads and writes.
    for (const read of READS) {
      await expect(read.run(failingDatabase(TRANSIENT) as never), `${read.name} should recover from a busy database`).resolves.not.toThrow();
    }
  });

  it('reports the failing read in the message, so a 500 is diagnosable', async () => {
    // `BaseRoute.toErrorResponse` surfaces this to the client as the AWS envelope's
    // Message, so "D1_ERROR" alone names neither the table nor the operation.
    await expect(READS[0]!.run(failingDatabase(PERMANENT) as never)).rejects.toThrow(/get user by email anchor/);
  });
});
