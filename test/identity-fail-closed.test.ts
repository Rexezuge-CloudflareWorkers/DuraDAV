import { describe, expect, it } from 'vitest';
import { resolveAccount } from '@durable-dav/backend-services/user';
import type { AccountLookupDeps } from '@durable-dav/backend-services/user';

/**
 * Address → account resolution must fail **closed**.
 *
 * The registry (`user_emails`) is consulted first, and a *revoked* row must
 * resolve to nothing — that is what stops an address, after its holder moved off
 * it, from continuing to authenticate the previous holder. The old code collapsed
 * "the registry has no row" and "the registry read failed" into the same `null`,
 * so any transient D1 error on that one statement fell through to the *anchor*
 * lookup below — which is documented as an attribution lookup whose key is a
 * re-registrable string, not an identity. One failed `SELECT` was therefore
 * enough to hand a reassigned address the previous holder's account id.
 */

interface Row {
  id: string;
  anchor: string;
  current: string;
  username: string | null;
  verified: boolean;
}

/**
 * A two-account fixture that models the dangerous state precisely: Alice's anchor
 * is `old@x.co`, she has since moved to `new@x.co`, and `old@x.co` is revoked —
 * so it is now available for someone else and *must not* resolve to Alice.
 */
function fixture(): {
  deps: AccountLookupDeps;
  registryFails: (error: Error) => void;
  seen: string[];
} {
  const rows: Row[] = [
    { id: 'usr_alice', anchor: 'old@x.co', current: 'new@x.co', username: 'alice', verified: false },
    { id: 'usr_bob', anchor: 'bob@x.co', current: 'bob@x.co', username: 'bob', verified: true },
  ];
  const seen: string[] = [];
  let registryError: Error | null = null;

  // Projected onto the shape `summarize` reads, matching `test/user-identity.test.ts`.
  const project = (row: Row) => ({ id: row.id, email: row.anchor, current_email: row.current, username: row.username });
  const userDAO = {
    getById: async (id: string) => {
      const row = rows.find((r) => r.id === id);
      return row ? project(row) : null;
    },
    getByEmail: async (anchor: string) => {
      seen.push(`getByEmail:${anchor}`);
      const row = rows.find((r) => r.anchor === anchor.toLowerCase());
      return row ? project(row) : null;
    },
    getByCurrentEmail: async (email: string) => {
      seen.push(`getByCurrentEmail:${email}`);
      const row = rows.find((r) => r.current === email.toLowerCase());
      return row ? project(row) : null;
    },
  };

  const userEmailDAO = {
    get: async (email: string) => {
      if (registryError !== null) throw registryError;
      const row = rows.find((r) => r.anchor === email.toLowerCase() || r.current === email.toLowerCase());
      return row ? { email: email.toLowerCase(), user_id: row.id, is_verified: row.verified ? 1 : 0 } : null;
    },
  };

  return {
    deps: { userDAO: async () => userDAO, userEmailDAO: async () => userEmailDAO } as unknown as AccountLookupDeps,
    registryFails: (error: Error) => {
      registryError = error;
    },
    seen,
  };
}

const TRANSIENT = new Error('D1_ERROR: network request failed');

describe('resolveAccount fails closed on a registry read error', () => {
  it('propagates a transient registry failure instead of resolving the anchor', async () => {
    const { deps, registryFails } = fixture();
    // The dangerous input: a revoked address that a *different* person now signs
    // in with. With the swallow in place, the code fell through to the anchor
    // lookup, found Alice, and returned her id.
    await expect(resolveAccount(deps, 'old@x.co')).resolves.toBeNull();
    registryFails(TRANSIENT);
    await expect(resolveAccount(deps, 'old@x.co')).rejects.toThrow(/network request failed/);
  });

  it('still tolerates a missing registry, which is what pre-0004 looks like', () => {
    // The degradation that was legitimate, and the only one. A database without
    // `user_emails` must keep working: the address *is* the anchor there.
    const rows: Row[] = [{ id: 'usr_a', anchor: 'a@x.co', current: 'a@x.co', username: 'a', verified: true }];
    const project = (row: Row) => ({ id: row.id, email: row.anchor, current_email: row.current, username: row.username });
    const userDAO = {
      getById: async (id: string) => {
        const row = rows.find((r) => r.id === id);
        return row ? project(row) : null;
      },
      getByEmail: async (anchor: string) => {
        const row = rows.find((r) => r.anchor === anchor.toLowerCase());
        return row ? project(row) : null;
      },
      getByCurrentEmail: async (email: string) => {
        const row = rows.find((r) => r.current === email.toLowerCase());
        return row ? project(row) : null;
      },
    };
    const userEmailDAO = {
      get: async () => {
        throw new Error('D1_ERROR: no such table: user_emails');
      },
    };
    const deps = { userDAO: async () => userDAO, userEmailDAO: async () => userEmailDAO } as unknown as AccountLookupDeps;
    return expect(resolveAccount(deps, 'a@x.co')).resolves.toMatchObject({ id: 'usr_a' });
  });

  it('does not reach the anchor lookup at all when the registry is readable', async () => {
    // The revoked case must not consult `getByEmail` even on the happy path —
    // that lookup is the whole hazard.
    const { deps, seen } = fixture();
    await expect(resolveAccount(deps, 'old@x.co')).resolves.toBeNull();
    expect(seen).toEqual([]);
  });

  it('does not swallow a failed `users` read either', async () => {
    // Both `.catch(() => null)` calls on the `users` side had the same defect: a
    // failed read reported as "no such account", which turns a D1 blip into a 404
    // and provokes a spurious re-registration attempt.
    const userEmailDAO = { get: async () => null };
    const userDAO = {
      getById: async () => null,
      getByEmail: async () => {
        throw TRANSIENT;
      },
      getByCurrentEmail: async () => null,
    };
    const deps = { userDAO: async () => userDAO, userEmailDAO: async () => userEmailDAO } as unknown as AccountLookupDeps;
    await expect(resolveAccount(deps, 'nobody@x.co')).rejects.toThrow(/network request failed/);
  });

  it('resolves a verified address through the registry, not the anchor', async () => {
    const { deps } = fixture();
    await expect(resolveAccount(deps, 'bob@x.co')).resolves.toMatchObject({ id: 'usr_bob', username: 'bob' });
  });

  it('returns null for a blank address without touching the database', async () => {
    const { deps, seen } = fixture();
    await expect(resolveAccount(deps, ' '.repeat(3))).resolves.toBeNull();
    expect(seen).toEqual([]);
  });
});