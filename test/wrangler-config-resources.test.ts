/**
 * Secrets Store resolution in `scripts/wrangler-config/resources.ts`.
 *
 * ## The failure these tests exist to prevent
 *
 * `Prepare Wrangler Configuration` failed on a deployment whose Cloudflare
 * account already held a Secrets Store. `ensureSecretStore` accepted only a
 * store named `default`, and having just removed the `?? stores[0]` fallback it
 * fell through to `wrangler secrets-store store create default --remote` on
 * every run. That `create` failed, so the step failed three times over and the
 * Worker was never deployed — while the previous release of the same script had
 * passed, because it reused whatever store the account already had.
 *
 * Removing the fallback was correct on its own terms and is kept: binding
 * whichever store happened to sort first would put the replication key in an
 * unrelated store. What was missing is the middle case the fallback had been
 * silently covering — an account with exactly one store under a name of the
 * operator's choosing, where there is nothing to be ambiguous about.
 *
 * ## The second defect, which the first one hid
 *
 * `wrangler secrets-store store list` exits non-zero on an account holding no
 * stores (`List request returned no stores.`), and `runWrangler` turns any
 * non-zero exit into a thrown `Error`. So `listSecretStores` could never return
 * an empty list: a genuinely fresh account threw at the *list* step and never
 * reached the create. The distinction that matters is empty-versus-failed, since
 * treating a bad token as an empty account sends the deploy into a `create` it
 * was never allowed to perform.
 *
 * `scripts/init-secrets.ts` already handles the identical hazard for
 * `secrets-store secret list`; this file had no equivalent and no tests at all.
 */

import { describe, expect, it } from 'vitest';
import { chooseSecretStore, isEmptyAccountListing, parseSecretStoresTable, type SecretStoreChoice } from '../scripts/wrangler-config/resources';

/**
 * A `cli-table3` rendering of `wrangler secrets-store store list`, which is all
 * that command emits — there is no `--json`. Data rows are separated with `│`;
 * the header and separator rows use `┼` and `├`/`┤`, so they carry no `│`.
 *
 * The real header is `Name | ID | AccountID | Created | Modified`, so the store
 * name and its 32-hex id are the first two cells.
 */
const storeTable = (...stores: Array<{ name: string; id: string }>): string =>
  [
    '┌──────────────┬────────────────────────────────┬────────────────────────────────┬──────────────────────┬──────────────────────┐',
    '│ Name         │ ID                             │ AccountID                      │ Created              │ Modified             │',
    '├──────────────┼────────────────────────────────┼────────────────────────────────┼──────────────────────┼──────────────────────┤',
    ...stores.map(
      (store) =>
        `│ ${store.name.padEnd(12)} │ ${store.id.padEnd(30)} │ ${'b'.repeat(32)} │ 10/9/2026, 4:12:00 PM │ 10/9/2026, 4:12:00 PM │`,
    ),
    '└──────────────┴────────────────────────────────┴────────────────────────────────┴──────────────────────┴──────────────────────┘',
  ].join('\n');

const store = (name: string): { name: string; id: string } => ({ name, id: name.replaceAll(/\W/g, 'x').repeat(32).slice(0, 32) });

describe('parseSecretStoresTable', () => {
  it('reads the name and id columns, skipping the header and the frame', () => {
    expect(parseSecretStoresTable(storeTable({ name: 'default', id: 'a'.repeat(32) }))).toEqual([
      { name: 'default', id: 'a'.repeat(32) },
    ]);
  });

  it('returns every row, so a later match is not shadowed by an earlier one', () => {
    const stores = parseSecretStoresTable(
      storeTable({ name: 'alpha', id: 'a'.repeat(32) }, { name: 'default', id: 'b'.repeat(32) }),
    );
    expect(stores.map((candidate) => candidate.name)).toEqual(['alpha', 'default']);
  });

  it('returns nothing for an empty response', () => {
    expect(parseSecretStoresTable('')).toEqual([]);
    expect(parseSecretStoresTable('🔐 Listing stores...')).toEqual([]);
  });

  it('skips a row whose second cell is not a store id', () => {
    // The `AccountID` column is also 32 hex characters. Reading the wrong column
    // would bind the Worker to the account's own id.
    const row = '│ default │ not-a-store-id │ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb │ x │ y │';
    expect(parseSecretStoresTable(row)).toEqual([]);
  });
});

describe('isEmptyAccountListing', () => {
  it('reads wrangler\'s empty-account message as a confirmed absence', () => {
    // The mirror of `EMPTY_STORE_MARKER` in `scripts/init-secrets.ts`, applied to
    // `store list` instead of `secret list`.
    expect(isEmptyAccountListing(new Error('Command failed: pnpm exec wrangler secrets-store store list --remote'))).toBe(
      false,
    );
    expect(
      isEmptyAccountListing(
        new Error(
          'Command failed: pnpm exec wrangler secrets-store store list --remote\n' +
            '✘ ERROR: List request returned no stores.',
        ),
      ),
    ).toBe(true);
  });

  it('does not read an authentication failure as an empty account', () => {
    // This is the whole reason the marker is matched rather than every non-zero
    // exit being taken as permission to create: a bad token would otherwise look
    // like a fresh account, and the `create` would fail for an unrelated reason.
    expect(isEmptyAccountListing(new Error('Authentication error [code: 10000]'))).toBe(false);
    expect(isEmptyAccountListing(new Error('Invalid access token [code: 9109]'))).toBe(false);
  });

  it('handles a non-Error rejection', () => {
    expect(isEmptyAccountListing('List request returned no stores.')).toBe(true);
    expect(isEmptyAccountListing('boom')).toBe(false);
  });
});

describe('chooseSecretStore', () => {
  const use = (choice: SecretStoreChoice) => {
    expect(choice.kind).toBe('use');
    return choice.kind === 'use' ? choice : undefined;
  };

  it('prefers a store named default, even alongside others', () => {
    const choice = use(
      chooseSecretStore([
        { name: 'alpha', id: 'a'.repeat(32) },
        { name: 'default', id: 'b'.repeat(32) },
      ]),
    );
    expect(choice).toMatchObject({ id: 'b'.repeat(32), adopted: false });
  });

  it('adopts a lone store under any name', () => {
    // The regression itself. This account deployed before the fallback was
    // removed and stopped deploying after it was; with one store there is no
    // choice to get wrong, so it must not reach a `create`.
    const choice = use(chooseSecretStore([{ name: 'durable-dav-secrets', id: 'c'.repeat(32) }]));
    expect(choice).toMatchObject({ id: 'c'.repeat(32), adopted: true });
  });

  it('reports an adopted store as adopted, so the caller can say so out loud', () => {
    // The binding then rests on a name that lives only in the account, which the
    // operator has to be told rather than left to discover.
    expect(use(chooseSecretStore([store('lone')]))?.adopted).toBe(true);
    expect(use(chooseSecretStore([{ name: 'default', id: 'd'.repeat(32) }]))?.adopted).toBe(false);
  });

  it('refuses an ambiguous account instead of taking whichever sorted first', () => {
    // The property `508a477` removed the fallback to preserve: binding an
    // arbitrary store would put the replication key somewhere unrelated, and the
    // store_id would not be reproducible from the config alone.
    const choice = chooseSecretStore([{ name: 'alpha', id: 'a'.repeat(32) }, { name: 'beta', id: 'b'.repeat(32) }]);
    expect(choice.kind).toBe('ambiguous');
    expect(choice.kind === 'ambiguous' && choice.names).toEqual(['alpha', 'beta']);
  });

  it('reports an empty account as absent, so a create is attempted', () => {
    // Only reachable once `listSecretStores` can return an empty list at all,
    // which it could not before `EMPTY_ACCOUNT_MARKER` was handled.
    expect(chooseSecretStore([])).toEqual({ kind: 'absent' });
  });
});