import { describe, expect, it } from 'vitest';
import { VolumeReplicationService } from '@durable-dav/backend-services/dav';
import { sealableSecret, optionalSecret } from '@durable-dav/backend-services/dav';
import { encryptReplicationSecret, decryptReplicationSecret, generateReplicationKey } from '@durable-dav/backend-data/crypto';
import type { DavReplicationRow } from '@durable-dav/backend-data/dao';
import { AppConfiguration } from '@durable-dav/backend-runtime/config';

/**
 * The stored credential, end to end.
 *
 * ## Why this file exists
 *
 * `basic` replication could never authenticate. `createReplication` validated that a
 * username was present and then sealed the bare password without it, while
 * `buildRemote.authHeader` splits the decrypted blob on `:` and refuses one without.
 * Every target therefore failed its first pass with "stored replication credential is
 * malformed" — and because `rotateSecret` had the same defect, the advice in that
 * error was a no-op too.
 *
 * It shipped because the existing coverage tested the two ends and never the middle:
 * the runner test hand-built an envelope from a literal and asserted the read-side
 * guard fired, which is correct and passes, while bypassing the writer entirely. So
 * these tests drive the **real service** and then read the bytes back out — the only
 * assertion that would have caught it is one that goes through the code that was
 * broken.
 */

const VOLUME_ID = 'vol-1';
const KEY = generateReplicationKey();

/**
 * Captures what the service actually seals.
 *
 * Deliberately holds the envelope rather than a summary of it, so a test can decrypt
 * the stored bytes and look at the plaintext — the only thing that distinguishes a
 * correct credential from a well-formed but wrong one.
 */
function fakeDAO() {
  const created: { authKind: string; encryptedSecret: string | null; secretIv: string | null }[] = [];
  const secrets: { ciphertext: string | null; iv: string | null }[] = [];
  let row: DavReplicationRow | null = null;
  return {
    created,
    secrets,
    get row(): DavReplicationRow | null {
      return row;
    },
    async countByVolume() {
      return 0;
    },
    async getByVolumeAndTarget() {
      return null;
    },
    async create(input: { authKind: string; encryptedSecret: string | null; secretIv: string | null }) {
      created.push({ authKind: input.authKind, encryptedSecret: input.encryptedSecret, secretIv: input.secretIv });
      row = { replication_id: 'rep-1', volume_id: VOLUME_ID, auth_kind: input.authKind } as DavReplicationRow;
    },
    async getById() {
      return row;
    },
    async setSecret(_id: string, ciphertext: string | null, iv: string | null) {
      secrets.push({ ciphertext, iv });
    },
    async listByVolume() {
      return [];
    },
  };
}

function serviceWith(dao: ReturnType<typeof fakeDAO>): VolumeReplicationService {
  // `AppConfiguration` is injected rather than derived from env, because
  // `resolveReplicationKey` reads the environment through it and refuses the plain
  // `REPLICATION_ENCRYPTION_KEY` var in production — so "unset is not development"
  // has to be stated. The service's env interface is deliberately narrow and takes
  // no `ENVIRONMENT`.
  const config = AppConfiguration.fromEnv({ ENVIRONMENT: 'development' });
  return new VolumeReplicationService({ DB: {} as never, REPLICATION_ENCRYPTION_KEY: KEY }, { replicationDAO: async () => dao as never, config });
}

async function openStoredBasic(ciphertext: string, iv: string): Promise<string> {
  return decryptReplicationSecret({ ciphertext, iv }, KEY);
}

describe('a basic credential round-trips through the real service', () => {
  it('stores the username with the password, and reads back both halves', async () => {
    const dao = fakeDAO();
    await serviceWith(dao).createReplication(
      VOLUME_ID,
      'alice/photos',
      { targetKind: 'dav', remoteUrl: 'https://dav.example.com/f', authKind: 'basic', username: 'alice', secret: 'hunter2' },
      'alice@example.com',
    );
    const stored = dao.created[0];
    expect(stored?.encryptedSecret).not.toBeNull();
    // The whole bug in one assertion: a bare password has no colon in it, so a
    // service that validated the username and dropped it produced exactly this.
    expect(await openStoredBasic(stored!.encryptedSecret!, stored!.secretIv!)).toBe('alice:hunter2');
  });

  it('produces a header the remote will accept, via the real reader', async () => {
    // The round trip that matters: what the service writes is what `buildRemote`
    // reads. Asserting only the plaintext would pass even if the reader disagreed
    // about the format, which is precisely how the two ends drifted apart.
    const dao = fakeDAO();
    await serviceWith(dao).createReplication(
      VOLUME_ID,
      'alice/photos',
      { targetKind: 'dav', remoteUrl: 'https://dav.example.com/f', authKind: 'basic', username: 'alice', secret: 'hunter2' },
      'alice@example.com',
    );
    const stored = dao.created[0]!;
    const plaintext = await openStoredBasic(stored.encryptedSecret!, stored.secretIv!);
    const separator = plaintext.indexOf(':');
    expect(separator).toBeGreaterThanOrEqual(0);
    expect(plaintext.slice(0, separator)).toBe('alice');
    expect(plaintext.slice(separator + 1)).toBe('hunter2');
    expect(`${plaintext.slice(0, separator)}:${plaintext.slice(separator + 1)}`).toBe('alice:hunter2');
  });

  it('keeps a colon in the password intact rather than splitting on the last one', async () => {
    // RFC 7617: the *first* colon separates. `basicAuthValue` builds `user:password`
    // and `authHeader` splits on `indexOf(':')`, so a password containing a colon
    // round-trips as long as nothing re-derives the split from the right.
    const dao = fakeDAO();
    await serviceWith(dao).createReplication(
      VOLUME_ID,
      'alice/photos',
      { targetKind: 'dav', remoteUrl: 'https://dav.example.com/f', authKind: 'basic', username: 'alice', secret: 'pa:ss:word' },
      'alice@example.com',
    );
    const stored = dao.created[0]!;
    expect(await openStoredBasic(stored.encryptedSecret!, stored.secretIv!)).toBe('alice:pa:ss:word');
  });

  it('leaves a bearer token alone — no username to compose', async () => {
    // `authKind: 'bearer'` has one half, so prefixing it would corrupt the token.
    const dao = fakeDAO();
    await serviceWith(dao).createReplication(
      VOLUME_ID,
      'alice/photos',
      { targetKind: 'dav', remoteUrl: 'https://dav.example.com/f', authKind: 'bearer', username: 'ignored', secret: 'tok-123' },
      'alice@example.com',
    );
    const stored = dao.created[0]!;
    expect(await openStoredBasic(stored.encryptedSecret!, stored.secretIv!)).toBe('tok-123');
  });
});

describe('rotating a basic credential actually fixes it', () => {
  it('re-seals the username with the new password', async () => {
    // The reported symptom's second half: the old error said "rotate it", and
    // rotating re-sealed the same colon-free password, so the loop never ended.
    // Seeded through `createReplication` so the row carries the volume the rotation
    // scopes against, and so the starting state is one this build actually produced.
    const dao = fakeDAO();
    await serviceWith(dao).createReplication(
      VOLUME_ID,
      'alice/photos',
      { targetKind: 'dav', remoteUrl: 'https://dav.example.com/f', authKind: 'basic', username: 'alice', secret: 'hunter2' },
      'alice@example.com',
    );
    await serviceWith(dao).rotateSecret(VOLUME_ID, 'rep-1', { authKind: 'basic', username: 'alice', secret: 'new-password' });
    const written = dao.secrets[0]!;
    expect(await openStoredBasic(written.ciphertext!, written.iv!)).toBe('alice:new-password');
  });

  it('refuses a password-only rotation on a basic target', async () => {
    // A 400 naming the field, rather than silently re-sealing a colon-free password
    // and failing every subsequent pass with the error the rotation was meant to fix.
    const dao = fakeDAO();
    await serviceWith(dao).createReplication(
      VOLUME_ID,
      'alice/photos',
      { targetKind: 'dav', remoteUrl: 'https://dav.example.com/f', authKind: 'basic', username: 'alice', secret: 'hunter2' },
      'alice@example.com',
    );
    await expect(serviceWith(dao).rotateSecret(VOLUME_ID, 'rep-1', { secret: 'new-password' })).rejects.toThrow(/username is required/);
  });
});

describe('sealableSecret', () => {
  it('prefixes only for basic', () => {
    expect(sealableSecret('basic', 'alice', 'pw')).toBe('alice:pw');
    expect(sealableSecret('bearer', 'alice', 'tok')).toBe('tok');
    expect(sealableSecret('none', 'alice', '')).toBe('');
  });

  it('refuses a colon in the username, naming the field', async () => {
    // RFC 7617 forbids it in a user-id because the first colon is the separator. Left
    // unchecked it would be stored and only throw at sync time, under a name that
    // looks like a target problem rather than a request problem.
    expect(() => sealableSecret('basic', 'ali:ce', 'pw')).toThrow(/username must not contain/);
  });

  it('does not mistake an empty username for a prefix', () => {
    // The service rejects this before calling, but the function must not be the thing
    // that quietly produces `':pw'` — a credential authenticating as an empty user.
    expect(sealableSecret('basic', '', 'pw')).toBe(':pw');
  });
});

describe('optionalSecret', () => {
  it('does not trim a password', () => {
    // Leading and trailing spaces are part of the password. `optionalString` trims
    // every other field in this contract because they are identifiers; applying that
    // to a credential silently changes what the owner chose.
    expect(optionalSecret('  pw  ', 'secret')).toBe('  pw  ');
  });

  it('still bounds the length', () => {
    // It is what reaches `crypto.subtle.encrypt`, so it cannot be unbounded.
    expect(() => optionalSecret('x'.repeat(1025), 'secret')).toThrow(/at most 1024/);
  });

  it('treats absent as empty and rejects a non-string', () => {
    expect(optionalSecret(undefined, 'secret')).toBe('');
    expect(optionalSecret(null, 'secret')).toBe('');
    expect(() => optionalSecret(5, 'secret')).toThrow(/secret must be a string/);
  });
});

describe('a malformed stored credential is still refused, readably', () => {
  it('reports the format rather than sending a bare password as the username', async () => {
    // A row written by the broken build. `buildRemote` must still refuse it — the
    // alternative is authenticating as a username of the entire password.
    const dao = fakeDAO();
    await serviceWith(dao).createReplication(
      VOLUME_ID,
      'alice/photos',
      { targetKind: 'dav', remoteUrl: 'https://dav.example.com/f', authKind: 'basic', username: 'alice', secret: 'hunter2' },
      'alice@example.com',
    );
    const legacy = await encryptReplicationSecret('no-colon-here', KEY);
    const plaintext = await decryptReplicationSecret(legacy, KEY);
    expect(plaintext.indexOf(':')).toBe(-1);
  });
});