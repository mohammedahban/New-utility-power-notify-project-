/**
 * useUserPredictions.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Production hook — fetches the raw admin prediction from utility_predictions,
 * applies the user's offset + community resync point + ATC state machine via
 * applyOffsetToPrediction, and returns a UserPrediction for consumption by
 * schedule.tsx, index.tsx, community.tsx, and predictions.tsx.
 *
 * Re-exports engine types so importing screens only need one import source:
 *   screen → useUserPredictions → tmmsEngine
 * ════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
  applyOffsetToPrediction,
  type UserPrediction,
  type ResyncPoint,
  type TransitionMode,
  type ScheduleSlot,
} from '../app/(admin)/tmmsEngine';

// ── Re-exports used by consuming screens ─────────────────────────────────────
export {
  applyOffsetToPrediction,
  type UserPrediction,
  type ResyncPoint,
  type TransitionMode,
} from '../app/(admin)/tmmsEngine';

// ── ShiftedScheduleSlot — the slot shape returned in UserPrediction.daySchedule
// Matches the ShiftedSlot interface inside tmmsEngine (which adds shiftedStart/End).
export interface ShiftedScheduleSlot extends ScheduleSlot {
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string | null;
  isResynced: boolean;
}

// ── ScheduleStateMode — union of all ATC mode strings ─────────────────────────
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

// ── Raw prediction shape stored in utility_predictions.prediction ─────────────
interface RawPrediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string | null;
  inverterOffline: boolean;
  nextTransition: any | null;
  expectedOffRange: { minMin: number; maxMin: number; label: string } | null;
  expectedOnRange: { minMin: number; maxMin: number; label: string } | null;
  daySchedule: ScheduleSlot[];
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  dayPattern: any | null;
  nightPattern: any | null;
  allPattern: any | null;
  cyclesAnalyzed: number;
  dayCyclesAnalyzed: number;
  nightCyclesAnalyzed: number;
  currentPeriod: string;
  reasoning: string[];
  learningMode: string;
  dataWindowHours: number;
  computedAt: string;
  apppe?: Record<string, any>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null | undefined,
  transitionMode: TransitionMode = 'AUTO',
  heldCycleStartIso: string | null = null,
): {
  userPrediction: UserPrediction | null;
  loading: boolean;
  refetch: () => void;
} {
  const [rawPrediction, setRawPrediction] = useState<RawPrediction | null>(null);
  const [loading, setLoading] = useState(true);

  // Frozen community offset — computed once per resync, then pinned until
  // resync is cleared (Q2-A rule: avoids drift on subsequent re-renders).
  const frozenCommunityOffsetRef = useRef<number | null>(null);
  const lastResyncIsoRef = useRef<string | null>(null);

  // Reset frozen offset whenever the resync point changes
  const currentResyncIso = resyncPoint?.syncedAtIso ?? null;
  if (lastResyncIsoRef.current !== currentResyncIso) {
    frozenCommunityOffsetRef.current = null;
    lastResyncIsoRef.current = currentResyncIso;
  }

  const fetchPrediction = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('utility_predictions')
        .select('prediction, computed_at')
        .eq('id', 1)
        .maybeSingle();

      if (error || !data) {
        setLoading(false);
        return;
      }

      setRawPrediction(data.prediction as RawPrediction);
    } catch {
      // non-fatal
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPrediction();

    // Real-time subscription — re-fetch on every prediction update
    const channel = supabase
      .channel('utility_predictions_user')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'utility_predictions' },
        () => { fetchPrediction(); },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchPrediction]);

  // Periodic refresh every 30 seconds to keep elapsed-time calculations current
  useEffect(() => {
    const timer = setInterval(() => {
      setRawPrediction(prev => prev ? { ...prev } : prev); // force re-derive
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  const userPrediction: UserPrediction | null = (() => {
    if (!rawPrediction) return null;

    try {
      const onOffsetCalculated = (derivedOffset: number) => {
        if (frozenCommunityOffsetRef.current === null) {
          frozenCommunityOffsetRef.current = derivedOffset;
        }
      };

      return applyOffsetToPrediction(
        rawPrediction as any,
        offsetMinutes,
        resyncPoint ?? null,
        null, // communitySyncMeta — populated by ResyncContext if needed
        transitionMode,
        heldCycleStartIso,
        frozenCommunityOffsetRef.current,
        onOffsetCalculated,
        Date.now(),
      );
    } catch (e) {
      console.error('[useUserPredictions] engine error:', e);
      return null;
    }
  })();

  return {
    userPrediction,
    loading,
    refetch: fetchPrediction,
  };
}
