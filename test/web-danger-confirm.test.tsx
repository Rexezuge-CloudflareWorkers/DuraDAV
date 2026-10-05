// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, string>) => {
      let text = fallback ?? key;
      for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{{${k}}}`, v);
      return text;
    },
  }),
}));

import { TypeToConfirmModal } from '../apps/web/src/components/modals/TypeToConfirmModal';
import { COPY_FEEDBACK_TIMEOUT_MS } from '../apps/web/src/lib/constants';

function renderModal() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <TypeToConfirmModal
      title="Delete Bucket"
      description="Permanently Deletes Everything."
      expectedName="alice/my-files"
      confirmLabel="Delete Bucket"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('danger zone type-to-confirm modal', () => {
  it('shows the expected name with a copy button', () => {
    renderModal();
    expect(screen.getByText('alice/my-files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy To Clipboard' })).toBeTruthy();
  });

  it('keeps confirm disabled until the exact name is typed', () => {
    const { onConfirm } = renderModal();
    const confirm = screen.getByRole('button', { name: 'Delete Bucket' });
    const input = screen.getByPlaceholderText('alice/my-files');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'alice/my-files-typo' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'alice/my-files' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('copies the name without throwing when clipboard is unavailable', () => {
    renderModal();
    const copy = screen.getByRole('button', { name: 'Copy To Clipboard' });
    expect(() => fireEvent.click(copy)).not.toThrow();
  });

  it('reports no success when the clipboard write is rejected', async () => {
    // The bug this pins. `setCopied(true)` ran unconditionally, so a rejected
    // write — a denied permission, or no clipboard at all over plain HTTP — showed
    // the ✅ for a copy that never happened. Here the expected name is a resource
    // the user is about to destroy and needs to retype, so a false success is
    // worse than no feedback.
    const writeText = vi.fn(() => Promise.reject(new Error('permission denied')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Copy To Clipboard' }));
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('alice/my-files');
    expect(screen.queryByTitle('Copy To Clipboard')?.querySelector(String.raw`.text-\[var\(--color-success-text\)\]`)).toBeNull();
  });

  it('reports success only once the clipboard write resolves', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderModal();
    const copy = screen.getByRole('button', { name: 'Copy To Clipboard' });
    // Not yet: the write is still in flight.
    fireEvent.click(copy);
    expect(copy.querySelector(String.raw`.text-\[var\(--color-success-text\)\]`)).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });
    expect(copy.querySelector(String.raw`.text-\[var\(--color-success-text\)\]`)).not.toBeNull();
  });

  it('reports no success when there is no clipboard at all', () => {
    // `navigator.clipboard` is undefined over plain HTTP, which is a normal
    // deployment for a self-hosted bucket rather than an exceptional case.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    renderModal();
    const copy = screen.getByRole('button', { name: 'Copy To Clipboard' });
    fireEvent.click(copy);
    expect(copy.querySelector(String.raw`.text-\[var\(--color-success-text\)\]`)).toBeNull();
  });

  it('clears the checkmark after the feedback window', async () => {
    // Without clearing it, the ✅ would persist and a *second* failing copy would
    // be indistinguishable from the first succeeding one.
    vi.useFakeTimers();
    try {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true });
      renderModal();
      const copy = screen.getByRole('button', { name: 'Copy To Clipboard' });
      fireEvent.click(copy);
      await act(async () => {
        await Promise.resolve();
      });
      expect(copy.querySelector(String.raw`.text-\[var\(--color-success-text\)\]`)).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(COPY_FEEDBACK_TIMEOUT_MS + 1);
      });
      expect(copy.querySelector(String.raw`.text-\[var\(--color-success-text\)\]`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not set state after the modal is closed mid-write', async () => {
    // The timer is a ref cleared on unmount precisely so this cannot warn. A local
    // `setTimeout` handle in the component body leaked when the modal was closed
    // inside the feedback window.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true });
    const { unmount } = render(
      <TypeToConfirmModal
        title="Delete Bucket"
        description="Permanently Deletes Everything."
        expectedName="alice/my-files"
        confirmLabel="Delete Bucket"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy To Clipboard' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(() => unmount()).not.toThrow();
  });
});
