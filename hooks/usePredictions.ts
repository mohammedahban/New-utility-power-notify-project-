import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

export interface PatternStats {
  cycles: number;
  avgOffMin: number;
  stdDevOffMin: number;
  avgOnMin: number | null;
  stdDevOnMin: number | null;
  minOffMin: number;
  maxOffMin: number;
  minOnMin: number | null;
  maxOnMin: number | null;
}

export interface NextTransition {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  earliestTime: string;
  latestTime: string;
  earliestFormatted: string;
  latestFormatted: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  rangeLabel: string;
}

export interface RangeLabel {
  minMin: number;
  maxMin: number;
  label: string;
}

export interface ScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
}

export interface Prediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string | null;
  inverterOffline: boolean;

  nextTransition: NextTransition | null;
  expectedOffRange: RangeLabel | null;
  expectedOnRange: RangeLabel | null;
  daySchedule: ScheduleSlot[];

  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;

  dayPattern: PatternStats | null;
  nightPattern: PatternStats | null;
  allPattern: PatternStats | null;
  cyclesAnalyzed: number;
  dayCyclesAnalyzed: number;
  nightCyclesAnalyzed: number;

  currentPeriod: 'day' | 'night';
  reasoning: string[];
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  dataWindowHours: number;
  computedAt: string;

  // APPPE v4.0 metadata
  apppe?: {
    version: string;
    // v4 fields
    crisisActive: boolean;
    crisisReason: string | null;
    driftOffset: number;
    driftSampleCount: number;
    biasRatio: number;
    biasSampleCount: number;
    volatilityEMA: number;
    volatilityLabel: string;
    crisisShift: { off: number; on: number };
    learningStrength: number;
    effectiveWeightedSamples: number;
    effectiveWeightedSamplesOn: number;
    madOff: number;
    madOn: number | null;
    predictionQuality: {
      dataQuantityFactor: number;
      stabilityFactor: number;
      driftStabilityFactor: number;
      biasStabilityFactor: number;
      volatilityFactor: number;
      crisisFactor: number;
    };
    historySource: string;
    rangeWasClamped: boolean;
    // v3 compat fields (kept for backward compat, may be absent in v4)
    crisisMode?: boolean;
    dominantProfile?: string;
    profileBlend?: Record<string, number>;
    profileSamples?: Record<string, number>;
  };
}

export function usePredictions() {
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastTriggerRef = useRef<number>(0);

  const fetchPredictions = useCallback(async () => {
    const { data, error } = await supabase
      .from('utility_predictions')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      console.error('[usePredictions] fetch error:', error.message, error.code);
    } else {
      console.log('[usePredictions] fetched:', data ? 'has prediction data' : 'null');
      if (data) {
        setPrediction(data.prediction as Prediction);
        setComputedAt(data.computed_at);
      }
    }
    setLoading(false);
  }, []);

  // V2.2.1 FIX (Issue 8): the APPPE computation ('analyze-patterns') was
  // only ever invoked by the admin Predictions screen — on mount, and via
  // its manual refresh button. That meant a Growatt state change only
  // produced a fresh prediction if an admin happened to have that specific
  // screen open at the time; every other screen, and every regular user,
  // just kept showing whatever was last (manually) computed, sometimes
  // long stale.
  //
  // usePredictions() is the one hook nearly every screen in both apps
  // already mounts, so triggering the recompute here — the moment a new
  // row lands in power_events, the same table useUserPredictions.ts and
  // useResyncNotifications.ts already watch for Growatt transitions —
  // means it fires automatically from whichever screen happens to be
  // open, in either app, with no manual step required. (If your project
  // renamed the raw Growatt-event table, update the table name below to
  // match — this assumes 'power_events' based on where it's used
  // elsewhere in this codebase.)
  const triggerAnalysis = useCallback(async () => {
    const now = Date.now();
    if (now - lastTriggerRef.current < 5000) return; // basic debounce
    lastTriggerRef.current = now;
    try {
      await supabase.functions.invoke('analyze-patterns', { body: {} });
    } catch (e) {
      console.warn('[usePredictions] auto analyze-patterns trigger failed:', e);
    }
  }, []);

  useEffect(() => {
    fetchPredictions();

    const channelName = `utility_predictions_live_${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'utility_predictions' },
        (payload) => {
          const row = payload.new as any;
          if (row?.prediction) {
            setPrediction(row.prediction as Prediction);
            setComputedAt(row.computed_at);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'power_events' },
        () => {
          triggerAnalysis();
        }
      )
      .subscribe((status) => {
        console.log('[usePredictions] channel status:', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchPredictions, triggerAnalysis]);

  return { prediction, computedAt, loading };
}
