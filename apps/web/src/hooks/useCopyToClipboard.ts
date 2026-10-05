import { useEffect, useRef, useState } from 'react';
import { COPY_FEEDBACK_TIMEOUT_MS } from '../lib/constants';

/**
 * Copy text to the clipboard, reporting success only when it happened.
 *
 * Two things make the obvious `await writeText(text); setCopied(true)` wrong in
 * this app, and both were live bugs in one copy of this handler or the other:
 *
 * 1. **`navigator.clipboard` is absent in an insecure context.** A plain
 *    `navigator.clipboard.writeText` throws synchronously there, so the handler
 *    dies before setting state — or, where it was guarded with `if (clipboard)`,
 *    fell through to `setCopied(true)` anyway and showed a checkmark for a copy
 *    that never happened.
 * 2. **The write is a promise that rejects on a denied permission.** Awaiting it
 *    is not enough; the rejection has to be handled, or it surfaces as an
 *    unhandled rejection *and* the checkmark still appears.
 *
 * That second case is why this is a hook rather than a helper: the honest answer
 * ("nothing was copied, so there is nothing to undo") is expressed by `copied`
 * simply never becoming true, which is state a helper function cannot hold.
 *
 * Both of this app's call sites are secret reveals — a bucket credential's
 * copy-once password and a resource name typed to confirm a destructive action —
 * where a false success sends the user away believing they have something they
 * do not.
 *
 * ## Timer handling
 *
 * The reset timer is a ref and cleared on unmount. Local `setTimeout` handles in
 * both original copies leaked: a modal closed inside the feedback window set
 * state on an unmounted component, and repeated clicks each replaced the timer
 * without cancelling the previous one, so an early timer could clear the
 * checkmark while a later copy was still pending.
 */
export function useCopyToClipboard(): {
  /**
  True only after a write that actually resolved.
  */
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = (text: string) => {
    // Optional chaining, not a guard: `navigator.clipboard` is genuinely absent
    // over plain HTTP, and that is a normal deployment for a self-hosted bucket
    // rather than an error worth surfacing.
    const clipboard = globalThis.navigator?.clipboard as Clipboard | undefined;
    // Nothing was copied, so there is nothing to report and nothing to undo.
    if (!clipboard) return;

    void clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (resetTimer.current !== null) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
      })
      // Leave `copied` false rather than flashing and clearing it: a rejection
      // means the text is still on screen and unread.
      .catch(() => undefined);
  };

  return { copied, copy };
}
