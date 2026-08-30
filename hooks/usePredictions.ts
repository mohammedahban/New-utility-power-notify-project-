import { useEffect, useState, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
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

  // APPPE v6.2: dedicated per-phase models, keyed by offset-hour group
  // ("+5"…"+9", "-3"…"-7"). Each value is a full prediction payload computed
  // by an independent pipeline run over the phase-shifted event stream.
  // Optional + absent on old servers → callers fall back to this base model.
  phaseModels?: Record<string, Prediction>;

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

// Polling fallback (ms): how often the prediction is re-fetched from the
// server. ISSUE-2 FIX — the app previously relied on a single mount-time fetch
// plus a lossy realtime channel with NO recovery, so a dropped/lost realtime
// subscription left the user app permanently stale (sometimes for days) even
// though the Admin Dashboard (which reads inverter_state directly) was correct.
// A bounded poll guarantees the app eventually converges to the latest
// prediction regardless of realtime health. In steady state realtime still
// delivers instantly; this is only the safety net.
const POLL_INTERVAL_MS = 60_000;

// RealTime re-subscribe backoff after a channel close/error (ms).
const RESUBSCRIBE_DELAY_MS = 10_000;

export function usePredictions() {
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Latest server timestamp we've accepted — guards against a stale realtime
  // or late poll response overwriting a newer prediction (the "stale
  // client-side state overwriting newer server state" failure mode).
  const acceptedAtRef = useRef<string | null>(null);

  // Coerce a possibly-{originally:null} computed_at into an epoch ms.
  const toMs = (iso: string | null | undefined): number => {
    if (!iso) return 0;
    const n = new Date(iso).getTime();
    return Number.isFinite(n) ? n : 0;
  };

  const fetchPredictions = useCallback(async () => {
    const { data, error } = await supabase
      .from('utility_predictions')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      console.error('[usePredictions] fetch error:', error.message, error.code);
    } else if (data) {
      // Staleness guard: never let an older server row overwrite a newer one
      // (the "stale client-side state overwriting newer server state" failure
      // mode). We accept whenever the incoming row has no usable timestamp
      // (analyze-patterns always sets computed_at, so a bare update is treated
      // as authoritative) OR its timestamp is >= what we already hold.
      const incomingAt = toMs(data.computed_at);
      const acceptedAt = toMs(acceptedAtRef.current);
      if (incomingAt === 0 || incomingAt >= acceptedAt) {
        acceptedAtRef.current = data.computed_at ?? null;
        setPrediction(data.prediction as Prediction);
        setComputedAt(data.computed_at);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;

    fetchPredictions();

    // ISSUE-2 FIX — bounded polling fallback: keeps the prediction fresh even
    // if the realtime channel is dead or a message is dropped.
    const pollTimer = setInterval(() => {
      if (!disposed) fetchPredictions();
    }, POLL_INTERVAL_MS);

    // ISSUE-2 FIX — re-fetch immediately when the app returns to the
    // foreground, so a backgrounded app re-syncs on resume instead of relying
    // on a possibly-connectionless realtime socket.
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && !disposed) fetchPredictions();
    });

    const openChannel = () => {
      if (disposed) return;
      const channelName = `utility_predictions_live_${Math.random().toString(36).slice(2)}`;
      channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'utility_predictions' },
          (payload) => {
            const row = payload.new as any;
            // Staleness guard applies to realtime too (late/reordered events).
            if (row?.prediction) {
              const incomingAt = toMs(row.computed_at);
              const acceptedAt = toMs(acceptedAtRef.current);
              if (incomingAt === 0 || incomingAt >= acceptedAt) {
                acceptedAtRef.current = row.computed_at ?? null;
                setPrediction(row.prediction as Prediction);
                setComputedAt(row.computed_at);
              }
            }
          }
        )
        .subscribe((status) => {
          console.log('[usePredictions] channel status:', status);
          // ISSUE-2 FIX — reconnect the realtime channel when it drops, so a
          // transient socket failure cannot leave us permanently unsubscribed.
          if (!disposed && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) {
            if (resubscribeTimer) clearTimeout(resubscribeTimer);
            resubscribeTimer = setTimeout(() => {
              if (!disposed) {
                try { supabase.removeChannel(channel as any); } catch (_) {}
                openChannel();
              }
            }, RESUBSCRIBE_DELAY_MS);
          }
        });
    };
    openChannel();

    return () => {
      disposed = true;
      if (resubscribeTimer) clearTimeout(resubscribeTimer);
      clearInterval(pollTimer);
      appStateSub.remove();
      if (channel) supabase.removeChannel(channel);
    };
  }, [fetchPredictions]);

  return { prediction, computedAt, loading };
}
