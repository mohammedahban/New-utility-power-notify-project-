import { useEffect, useState, useCallback } from 'react';
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
      .subscribe((status) => {
        console.log('[usePredictions] channel status:', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchPredictions]);

  return { prediction, computedAt, loading };
}
