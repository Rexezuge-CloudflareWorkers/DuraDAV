// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { CurrentUser } from '~/types';

/**
 * Regression: the shell used to issue an unbounded stream of `GET /user/me`.
 *
 * `SpaApp` passed an inline arrow to `useCurrentUser`, whose effect listed
 * `onError` as its only dependency. A fresh function identity on every render
 * re-ran the effect; the success path called `setUser(me)` with a freshly
 * parsed object, which is never `Object.is`-equal to the previous one, so React
 * re-rendered and the cycle closed on itself. `setAuthorized(true)` would have
 * bailed out — it is a repeated primitive — but `setUser` does not.
 */
const loadCurrentUser = vi.fn<() => Promise<CurrentUser>>();
vi.mock('~/services/userService', () => ({
  loadCurrentUser: () => loadCurrentUser(),
  renameCurrentUsername: vi.fn(),
}));

const { useCurrentUser } = await import('~/hooks/useCurrentUser');

const ME: CurrentUser = {
  email: 'alice@example.com',
  username: 'alice',
  preferredLanguage: 'en',
} as CurrentUser;

/**
Models `SpaApp`: an inline arrow, i.e. a new identity on every render.
*/
function UnstableCaller({ onRender }: { onRender: () => void }) {
  const { user } = useCurrentUser(() => undefined);
  onRender();
  return <span>{user?.username ?? 'loading'}</span>;
}

describe('useCurrentUser', () => {
  it('fetches once and does not re-arm when the caller passes an unstable onError', async () => {
    loadCurrentUser.mockReset();
    loadCurrentUser.mockResolvedValue(ME);

    let renders = 0;
    const view = render(<UnstableCaller onRender={() => (renders += 1)} />);

    await waitFor(() => {
      expect(view.getByText('alice')).toBeTruthy();
    });
    // Let every settled promise and effect flush that the loop would have used
    // to re-fire. A self-sustaining loop keeps rendering past this point; a
    // stable hook does not.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(loadCurrentUser).toHaveBeenCalledTimes(1);
    expect(renders).toBeGreaterThan(1);
  });

  it('re-fetches only when reload is called explicitly', async () => {
    loadCurrentUser.mockReset();
    loadCurrentUser.mockResolvedValue(ME);
    const reload = vi.fn();

    function StableCaller() {
      const api = useCurrentUser(() => undefined);
      reload.mockImplementation(api.reload);
      return <span>{api.user?.username ?? 'loading'}</span>;
    }

    const view = render(<StableCaller />);
    await waitFor(() => {
      expect(view.getByText('alice')).toBeTruthy();
    });
    expect(loadCurrentUser).toHaveBeenCalledTimes(1);

    reload();
    await waitFor(() => {
      expect(loadCurrentUser).toHaveBeenCalledTimes(2);
    });
  });
});