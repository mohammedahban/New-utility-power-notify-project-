/**
 * useTransitionMode — TMMS V2.2 Personal Timeline Replacement Model
 *
 * Manages the user's transition mode (AUTO / MANUAL).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.2 NOTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 * V2.2 mode semantics:
 *
 *   AUTO:
 *     Growatt transitions drive the user's Personal Timeline automatically.
 *     Community reports (YES confirmations) also drive transitions.
 *     User reports create Generated ON events with Period 1/2/3 rules.
 *     This is the default mode.
 *
 *   MANUAL:
 *     Growatt transitions are IGNORED for the user's Personal Timeline.
 *     Only user reports and community confirmations drive transitions.
 *     Growatt still feeds APPPE learning and predictions — but those
 *     predictions are NOT auto-applied to the user's timeline.
 *     This is for advanced users who want full manual control.
 *
 * V2.2 interaction with Period 1/2/3:
 *   - Period 1 (POSITIVE): In AUTO, Growatt ON triggers Short Verification
 *     Window. In MANUAL, only user/community reports trigger transitions.
 *   - Period 2 (PENDING_NEGATIVE): In both modes, the PENDING_NEGATIVE state
 *     resolves when Growatt turns ON. But in MANUAL, the resolved offset
 *     is not applied until the user confirms.
 *   - Period 3 (NEUTRAL): In AUTO, Growatt and user timelines are identical.
 *     In MANUAL, still identical because offset = 0.
 *
 * Original V2 / V2.1 responsibilities preserved:
 *   1. Load mode from AsyncStorage on mount
 *   2. Persist mode to AsyncStorage on change
 *   3. Provide toggle function
 */

import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'tmms_transition_mode';

/** V2.2: Transition mode controls how the user's Personal Timeline responds
 *  to Growatt transitions and community reports. */
export type TransitionMode = 'AUTO' | 'MANUAL';

export function useTransitionMode() {
  const [mode, setMode] = useState<TransitionMode>('AUTO');

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored === 'AUTO' || stored === 'MANUAL') setMode(stored);
      } catch (_) {}
    })();
  }, []);

  const toggle = useCallback(() => {
    setMode(prev => {
      const next = prev === 'AUTO' ? 'MANUAL' : 'AUTO';
      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  return { mode, toggle };
}
