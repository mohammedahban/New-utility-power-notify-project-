/**
 * useTransitionMode — TMMS transition mode manager
 *
 * Stores AUTO / MANUAL preference in AsyncStorage.
 *
 * AUTO  — Growatt transitions + Community confirmations + User reports
 *          may all trigger state changes (priority order per spec).
 *
 * MANUAL — Only Community confirmations and User reports may change state.
 *          Growatt still feeds APPPE and pattern learning but does NOT
 *          trigger user-facing transitions.
 *
 * Spec: TMMS section "TRANSITION MODES"
 */

import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../contexts/AuthContext';

export type TransitionMode = 'AUTO' | 'MANUAL';

const KEY_PREFIX = 'tmms_transition_mode_v1_';

export function useTransitionMode() {
  const { user } = useAuth();
  const storageKey = user ? `${KEY_PREFIX}${user.id}` : null;

  const [mode, setMode] = useState<TransitionMode>('AUTO');
  const [loaded, setLoaded] = useState(false);

  // Load persisted mode on mount
  useEffect(() => {
    if (!storageKey) { setLoaded(true); return; }
    AsyncStorage.getItem(storageKey)
      .then(raw => {
        if (raw === 'AUTO' || raw === 'MANUAL') setMode(raw as TransitionMode);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [storageKey]);

  const toggle = useCallback(async () => {
    const next: TransitionMode = mode === 'AUTO' ? 'MANUAL' : 'AUTO';
    setMode(next);
    if (storageKey) {
      try { await AsyncStorage.setItem(storageKey, next); } catch (_) {}
    }
  }, [mode, storageKey]);

  const setModeExplicit = useCallback(async (m: TransitionMode) => {
    setMode(m);
    if (storageKey) {
      try { await AsyncStorage.setItem(storageKey, m); } catch (_) {}
    }
  }, [storageKey]);

  return { mode, loaded, toggle, setMode: setModeExplicit };
}
