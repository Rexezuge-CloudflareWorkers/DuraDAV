// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopyToClipboard } from '~/hooks/useCopyToClipboard';
import { COPY_FEEDBACK_TIMEOUT_MS } from '~/lib/constants';

/**
 * The clipboard handler's whole job is honesty.
 *
 * Both call sites are secret reveals — a bucket credential's copy-once password,
 * and a resource name typed to confirm a destructive action — so a false
 * success sends the user away believing they have something they do not. The two
 * bugs this guards against both shipped:
 *
 * - `navigator.clipboard` is absent in an insecure context, and the original
 *   showed a checkmark for a copy that never happened.
 * - The write is a promise that rejects on a denied permission, and the
 *   unhandled rejection still left the checkmark showing.
 */
function setClipboard(clipboard: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true, writable: true });
}

describe('useCopyToClipboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports copied only after the write resolves', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    const { result } = renderHook(() => useCopyToClipboard());

    expect(result.current.copied).toBe(false);
    await act(async () => {
      result.current.copy('secret-password');
    });
    expect(result.current.copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith('secret-password');
  });

  it('does NOT report copied when the write rejects', async () => {
    setClipboard({ writeText: () => Promise.reject(new Error('permission denied')) });
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      result.current.copy('secret-password');
    });
    // The whole point: nothing was copied, so there is nothing to undo.
    expect(result.current.copied).toBe(false);
  });

  it('does NOT report copied when clipboard is absent (insecure context)', () => {
    setClipboard(undefined);
    const { result } = renderHook(() => useCopyToClipboard());

    act(() => {
      result.current.copy('secret-password');
    });
    // Over plain HTTP — a normal deployment for a self-hosted bucket. The
    // original fell through to `setCopied(true)` and showed a checkmark.
    expect(result.current.copied).toBe(false);
  });

  it('resets copied after the feedback window', async () => {
    setClipboard({ writeText: () => Promise.resolve() });
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      result.current.copy('value');
    });
    expect(result.current.copied).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(COPY_FEEDBACK_TIMEOUT_MS + 1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('clears the reset timer on unmount, rather than setting state afterwards', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    setClipboard({ writeText: () => Promise.resolve() });
    const { result, unmount } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      result.current.copy('value');
    });
    unmount();
    // A leaked timer fired against an unmounted modal in one of the two
    // original copies.
    expect(clearSpy).toHaveBeenCalled();
    expect(() => vi.advanceTimersByTime(COPY_FEEDBACK_TIMEOUT_MS * 10)).not.toThrow();
  });

  it('a repeated copy does not let an earlier timer clear a later checkmark', async () => {
    setClipboard({ writeText: () => Promise.resolve() });
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      result.current.copy('first');
    });
    await act(async () => {
      vi.advanceTimersByTime(COPY_FEEDBACK_TIMEOUT_MS / 2);
      result.current.copy('second');
    });

    // The first copy's timer must have been cancelled, not left to fire.
    await act(async () => {
      vi.advanceTimersByTime(COPY_FEEDBACK_TIMEOUT_MS / 2 + 1);
    });
    expect(result.current.copied).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(COPY_FEEDBACK_TIMEOUT_MS + 1);
    });
    expect(result.current.copied).toBe(false);
  });
});