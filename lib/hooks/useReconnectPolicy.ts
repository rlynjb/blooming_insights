'use client';

import { useCallback, useState } from 'react';

/** STRICT-PRESERVATION lift of the revoked-token reconnect policy from
 *  app/page.tsx. The alpha Bloomreach server revokes its OAuth token after
 *  a few minutes; this hook owns the "auth-shaped error → reset + reload"
 *  one-shot reconnect dance, the session flag that prevents it from
 *  looping, and the predicate the UI uses to decide whether to show the
 *  explicit reconnect button.
 *
 *  Two regex variants are preserved verbatim — they are NOT unified:
 *
 *    LONG  — used by the NDJSON error handler and the captureAll loop
 *            (the auto-reconnect path).
 *    SHORT — used by the manual "reconnect" button in the error UI.
 *
 *  Unifying them would require manual verification against the live
 *  Bloomreach server, which is not available in the current session.
 *  There IS a latent bug worth flagging (the button regex is missing
 *  `invalid_token` and `reconnect` matches) — filed as a future concern;
 *  not this refactor's job. See:
 *    .aipe/specs/refactors/design-frontend-extract-usereconnectpolicy.md
 *    (the strict-preservation alternative path at the bottom of the stub)
 *
 *  The predicates are exported at module scope so non-hook consumers
 *  (like useDemoCapture) can match without rendering a separate hook
 *  instance. The hook owns the state slot, the one-shot guard, and the
 *  reset+reload action — what the page-decomposition notebook calls the
 *  Separation-of-Concerns anchor: a wire-format `switch` should not be
 *  mutating session storage and reloading the window. */

const AUTH_ERROR_RE_AUTO = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;
const FLAG_KEY = 'bi:reconnecting';

/** Predicate for the auto-reconnect path (NDJSON error case + capture loop). */
export function isAuthErrorAuto(msg: string): boolean {
  return AUTH_ERROR_RE_AUTO.test(msg);
}

/** Predicate for the explicit reconnect button (error UI). */
export function isAuthErrorButton(msg: string): boolean {
  return AUTH_ERROR_RE_BUTTON.test(msg);
}

export interface UseReconnectPolicyResult {
  /** True briefly while the reset+reload is in flight — the page reads this
   *  to render the "session expired — reconnecting…" banner. */
  reconnecting: boolean;

  /** Inspect an error message. If it's auth-shaped (LONG regex) AND we
   *  haven't already tried this session, fire the reset+reload and return
   *  true (caller should bail). Otherwise return false — caller handles
   *  the error the normal way. */
  handle: (errorMessage: string) => boolean;

  /** Fire the reset+reload unconditionally — used by the manual reconnect
   *  button in the error UI. */
  reconnect: () => void;

  /** Clear the session flag so the next auth expiry can fire a fresh
   *  auto-reconnect. Caller invokes this on the success path (e.g. the
   *  NDJSON `case 'done'` arm). */
  clearFlag: () => void;
}

export function useReconnectPolicy(): UseReconnectPolicyResult {
  const [reconnecting, setReconnecting] = useState(false);

  const fireReset = useCallback(() => {
    setReconnecting(true);
    fetch('/api/mcp/reset', { method: 'POST' })
      .catch(() => {
        /* ignore — reload still triggers the auth check */
      })
      .finally(() => {
        if (typeof window !== 'undefined') {
          window.location.href = '/';
        }
      });
  }, []);

  const handle = useCallback(
    (msg: string): boolean => {
      if (!isAuthErrorAuto(msg)) return false;
      if (typeof window === 'undefined') return false;
      let alreadyTried = false;
      try {
        alreadyTried = sessionStorage.getItem(FLAG_KEY) === '1';
      } catch {
        /* ignore */
      }
      if (alreadyTried) {
        try {
          sessionStorage.removeItem(FLAG_KEY);
        } catch {
          /* ignore */
        }
        return false;
      }
      try {
        sessionStorage.setItem(FLAG_KEY, '1');
      } catch {
        /* ignore */
      }
      fireReset();
      return true;
    },
    [fireReset],
  );

  const clearFlag = useCallback(() => {
    if (typeof window === 'undefined') return;
    try {
      sessionStorage.removeItem(FLAG_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { reconnecting, handle, reconnect: fireReset, clearFlag };
}
