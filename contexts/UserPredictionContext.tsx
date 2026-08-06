/**
 * UserPredictionContext — SPEC-FIX (F13, 2026-08-01)
 *
 * Runs the TMMS engine (useUserPredictions) exactly ONCE for the whole user
 * area and shares the result with the Home, Schedule and Community screens.
 *
 * Spec (Part 2, Step 6/7): "Both Today Timeline and 24-hour Schedule must
 * rebuild from the same prediction source. No independent calculations are
 * allowed." Previously each screen ran its own engine instance (own 30-s
 * ticks, own AsyncStorage frozen-offset reads, own realtime watchers), which
 * could transiently diverge. One instance now feeds all screens — and as a
 * side benefit the Growatt-ON watcher / accuracy logger / timers exist once
 * instead of three times.
 */

import React, { createContext, useCallback, useContext, useMemo, ReactNode } from 'react';
import { useUserPredictions, type UserPrediction } from '../hooks/useUserPredictions';
import { useUserOffset } from '../hooks/useUserOffset';
import { useResync } from './ResyncContext';
import type { TransitionMode } from '../hooks/useTransitionMode';
import { useStateAnchor } from '../hooks/useStateAnchor';

interface UserPredictionContextType {
  userPrediction: UserPrediction | null;
  loading: boolean;
}

const UserPredictionContext = createContext<UserPredictionContextType | undefined>(undefined);

export function UserPredictionProvider({ children }: { children: ReactNode }) {
  const { offset, saveOffset } = useUserOffset();
  const { resyncPoint } = useResync();
  // The home-screen AUTO/MANUAL toggle was removed per product decision —
  // the app always runs in the default AUTO mode (Growatt + community +
  // user reports may all trigger transitions). The hook is kept in the repo
  // in case the toggle is reintroduced later.
  const transitionMode: TransitionMode = 'AUTO';
  const { anchor } = useStateAnchor();

  // Community-computed offsets are persisted (moved here from the Home screen
  // — identical behaviour, now single-instance).
  const onCommunityOffsetComputed = useCallback((computedOffsetMinutes: number) => {
    saveOffset(computedOffsetMinutes);
  }, [saveOffset]);

  const { userPrediction, loading } = useUserPredictions(
    offset?.offset_minutes ?? 0,
    resyncPoint,
    transitionMode,
    anchor?.startIso ?? null,
    onCommunityOffsetComputed,
  );

  const value = useMemo(
    () => ({ userPrediction, loading }),
    [userPrediction, loading],
  );

  return (
    <UserPredictionContext.Provider value={value}>
      {children}
    </UserPredictionContext.Provider>
  );
}

export function useSharedUserPrediction(): UserPredictionContextType {
  const ctx = useContext(UserPredictionContext);
  if (!ctx) {
    throw new Error('useSharedUserPrediction must be used within UserPredictionProvider');
  }
  return ctx;
}
