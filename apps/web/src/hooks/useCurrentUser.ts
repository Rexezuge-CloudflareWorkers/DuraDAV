import { useCallback, useEffect, useRef, useState } from 'react';
import type { CurrentUser } from '../types';
import { loadCurrentUser } from '../services/userService';
import { getBackendErrorStatus } from '../lib/api';

/**
 * The signed-in account, fetched once on mount.
 *
 * The fetch is keyed on `reloadKey` alone and nothing else. This used to list
 * `onError` — its only dependency — which made the hook's behaviour a function
 * of the *caller's* prop identity: `SpaApp` passed an inline arrow, so a fresh
 * function landed on every render, the effect re-ran on every render, and its
 * success path called `setUser(me)` with a freshly `JSON.parse`d object that is
 * never `Object.is`-equal to the current one. That closes a render -> fetch ->
 * setState -> render cycle, so the shell issued an unbounded stream of
 * `GET /user/me` from its first paint. `setAuthorized(true)` would have bailed
 * out (a repeated primitive); `setUser` does not, and the in-flight dedupe in
 * `userService` cannot help because it clears `inflight` the moment the promise
 * settles.
 *
 * So `onError` is read through a ref instead of being a dependency: a caller
 * can pass an inline arrow, a fresh object, or `undefined` and the request
 * count is unchanged. Refreshing is explicit, via `reload`.
 */
export function useCurrentUser(onError?: (message: string) => void) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    loadCurrentUser()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setAuthorized(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Distinguish "not signed in" from "the server is broken". Collapsing
        // both into `authorized: false` sent a 500 or 503 on `/user/me` to the
        // landing page with no notice at all, so a transient outage looked
        // exactly like a logout.
        if (getBackendErrorStatus(error) === 401) {
          setAuthorized(false);
          return;
        }
        onErrorRef.current?.(error instanceof Error ? error.message : String(error));
        // Still "authorized" so the shell renders and the notice is visible;
        // the user object stays null, so owner-gated views show Unauthorized.
        setAuthorized(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  return { user, setUser, authorized, reload };
}