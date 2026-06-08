/**
 * useStateAnchor — Persistent, prediction-independent current-state tracker.
 *
 * Sources the utility state start time from:
 *   1. `inverter_state` real-time updates (Growatt live data)
 *   2. `power_events` (historical transitions) on mount
 *   3. AsyncStorage cache — survives app restarts so the timer never resets
 *
 * Completely decoupled from `utility_predictions` refreshes, so the
 * "elapsed" timer and slot start times never jump on DB re-analysis.
 */

import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';

const STORAGE_KEY = 'state_anchor_v1';

export interface StateAnchor {
  /** 'ON' | 'OFF' — current utility state */
  state: 'ON' | 'OFF';
  /** ISO string of when this state began */
  startIso: string;
}

/** Persist anchor to AsyncStorage silently */
async function persistAnchor(anchor: StateAnchor) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
  } catch (_) {}
}

/** Load cached anchor from AsyncStorage */
async function loadCachedAnchor(): Promise<StateAnchor | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StateAnchor;
    if (parsed.state && parsed.startIso) return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

export function useStateAnchor(): { anchor: StateAnchor | null } {
  const [anchor, setAnchor] = useState<StateAnchor | null>(null);
  // Track the last known utility_on boolean so we only update on genuine flips
  const lastUtilityOnRef = useRef<boolean | null>(null);

  const applyUtilityOn = (utilityOn: boolean, occurredAt: string) => {
    const newState: 'ON' | 'OFF' = utilityOn ? 'ON' : 'OFF';
    setAnchor(prev => {
      // Only update if the state has genuinely flipped
      if (prev && prev.state === newState) return prev;
      const next: StateAnchor = { state: newState, startIso: occurredAt };
      persistAnchor(next);
      return next;
    });
    lastUtilityOnRef.current = utilityOn;
  };

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // 1. Load cached anchor first so the timer is immediately available
      const cached = await loadCachedAnchor();
      if (!cancelled && cached) {
        setAnchor(cached);
        lastUtilityOnRef.current = cached.state === 'ON';
      }

      // 2. Fetch current inverter_state to get the ground truth
      const { data: inv } = await supabase
        .from('inverter_state')
        .select('utility_on, last_polled')
        .eq('id', 1)
        .maybeSingle();

      if (cancelled) return;

      if (inv && inv.utility_on !== null && inv.last_polled) {
        const currentUtilityOn = inv.utility_on as boolean;

        // Only look up power_events if the state differs from cached, or no cache
        if (!cached || (cached.state === 'ON') !== currentUtilityOn) {
          // 3. Find the most recent power_event that matches the current state
          const eventType = currentUtilityOn ? 'UTILITY_ON' : 'UTILITY_OFF';
          const { data: events } = await supabase
            .from('power_events')
            .select('occurred_at, event_type')
            .eq('event_type', eventType)
            .order('occurred_at', { ascending: false })
            .limit(1);

          if (!cancelled) {
            const startIso = events?.[0]?.occurred_at ?? inv.last_polled;
            applyUtilityOn(currentUtilityOn, startIso);
          }
        } else if (cached) {
          // State matches cache — trust the cached startIso (more accurate)
          lastUtilityOnRef.current = currentUtilityOn;
        }
      }
    };

    init();

    // 4. Subscribe to real-time inverter_state changes
    const channel = supabase
      .channel(`state_anchor_live_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'inverter_state',
      }, async (payload) => {
        if (cancelled) return;
        const row = payload.new as any;
        if (row?.utility_on === null || row?.utility_on === undefined) return;
        const newUtilityOn = row.utility_on as boolean;

        // Flip detected — find the matching power_event for accurate start time
        if (lastUtilityOnRef.current !== newUtilityOn) {
          const eventType = newUtilityOn ? 'UTILITY_ON' : 'UTILITY_OFF';
          const { data: events } = await supabase
            .from('power_events')
            .select('occurred_at, event_type')
            .eq('event_type', eventType)
            .order('occurred_at', { ascending: false })
            .limit(1);

          const startIso = events?.[0]?.occurred_at ?? new Date().toISOString();
          if (!cancelled) applyUtilityOn(newUtilityOn, startIso);
        }
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return { anchor };
}
