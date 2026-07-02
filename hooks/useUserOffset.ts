import { useEffect, useState, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

// ── Pending DSD candidate (spec §6.2 / §15) ───────────────────────────────────
// When a user with negative DSD (ahead of Growatt) reports a transition, we
// cannot immediately compute the real DSD because the matching Growatt event
// hasn't arrived yet. Instead we store a pending candidate and finalize only
// once a matching power_events entry appears within the 2-hour window.

export interface PendingDSDCandidate {
  /** The event type the user reported */
  eventType: 'UTILITY_ON' | 'UTILITY_OFF';
  /** The ISO time the user believes the transition occurred */
  reportedTransitionIso: string;
  /** Tentative (unfinalized) DSD from the closest known Growatt event */
  tentativeDSD: number;
  /** When the candidate was created — expires after CANDIDATE_TTL_MS */
  createdAtIso: string;
}

const PENDING_DSD_KEY_PREFIX = 'pending_dsd_candidate_v1_';
const CANDIDATE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface UserOffset {
  id: number;
  user_id: string;
  offset_minutes: number;
  last_event_type: 'UTILITY_ON' | 'UTILITY_OFF' | null;
  last_event_at: string | null;
  updated_at: string;
}

export function useUserOffset() {
  const { user } = useAuth();
  const [offset, setOffset] = useState<UserOffset | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingDSD, setPendingDSD] = useState<PendingDSDCandidate | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const storageKey = user ? `${PENDING_DSD_KEY_PREFIX}${user.id}` : null;

  const fetchOffset = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    const { data, error } = await supabase
      .from('user_offsets')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) console.error('[useUserOffset] fetch error:', error.message);
    setOffset(data as UserOffset | null);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchOffset(); }, [fetchOffset]);

  // ── Load persisted pending DSD candidate on mount ───────────────────────────
  useEffect(() => {
    if (!storageKey) { setPendingDSD(null); return; }
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (raw) {
          const parsed: PendingDSDCandidate = JSON.parse(raw);
          const ageMs = Date.now() - new Date(parsed.createdAtIso).getTime();
          if (ageMs < CANDIDATE_TTL_MS) {
            setPendingDSD(parsed);
          } else {
            await AsyncStorage.removeItem(storageKey);
          }
        }
      } catch (_) {}
    })();
  }, [storageKey]);

  // ── Background watcher: finalize pending DSD when Growatt emits a match ─────
  // Subscribes to power_events real-time. When a matching event arrives within
  // the 2-hour TTL, compute the real DSD from the matched transition pair and
  // persist it to user_offsets (spec §6.2 / §15).
  useEffect(() => {
    if (!pendingDSD || !user || !storageKey) return;

    const finalizeFromMatchedEvents = async (
      events: { occurred_at: string; event_type: string }[],
      candidate: PendingDSDCandidate,
    ) => {
      const reportedMs = new Date(candidate.reportedTransitionIso).getTime();
      let bestMatch: { growattMs: number; diffMin: number } | null = null;

      for (const ev of events) {
        const growattMs = new Date(ev.occurred_at).getTime();
        const diffMin = Math.round((reportedMs - growattMs) / 60_000);
        if (bestMatch === null || Math.abs(diffMin) < Math.abs(bestMatch.diffMin)) {
          bestMatch = { growattMs, diffMin };
        }
      }

      if (!bestMatch) return;

      const finalDSD = bestMatch.diffMin;
      console.log(`[useUserOffset] Finalizing pending DSD=${finalDSD}min from matched Growatt event`);

      // Persist finalized DSD to Supabase
      const { error } = await supabase
        .from('user_offsets')
        .upsert(
          {
            user_id: user.id,
            offset_minutes: finalDSD,
            last_event_type: candidate.eventType,
            last_event_at: candidate.reportedTransitionIso,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' },
        );

      if (!error) {
        await fetchOffset();
        // Clear pending candidate
        setPendingDSD(null);
        try { await AsyncStorage.removeItem(storageKey!); } catch (_) {}
      }
    };

    // Check existing power_events in case the matching event already landed
    const checkExistingEvents = async () => {
      const windowStart = new Date(
        new Date(pendingDSD.reportedTransitionIso).getTime() - 30 * 60_000,
      ).toISOString();
      const { data: events } = await supabase
        .from('power_events')
        .select('occurred_at, event_type')
        .eq('event_type', pendingDSD.eventType)
        .gte('occurred_at', windowStart)
        .order('occurred_at', { ascending: false })
        .limit(5);

      if (events && events.length > 0) {
        await finalizeFromMatchedEvents(events, pendingDSD);
      }
    };

    checkExistingEvents();

    // Subscribe to future power_events INSERTs
    const ch = supabase
      .channel(`pending_dsd_watcher_${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'power_events',
      }, async (payload) => {
        const row = payload.new as any;
        if (!row || row.event_type !== pendingDSD.eventType) return;
        // Check TTL
        const ageMs = Date.now() - new Date(pendingDSD.createdAtIso).getTime();
        if (ageMs >= CANDIDATE_TTL_MS) {
          setPendingDSD(null);
          try { await AsyncStorage.removeItem(storageKey!); } catch (_) {}
          return;
        }
        await finalizeFromMatchedEvents(
          [{ occurred_at: row.occurred_at, event_type: row.event_type }],
          pendingDSD,
        );
      })
      .subscribe();

    channelRef.current = ch;
    return () => {
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [pendingDSD, user, storageKey, fetchOffset]);

  /**
   * Calibrate offset: user reports the time of a recent power event.
   * We find the nearest matching event in power_events and compute the diff.
   *
   * Negative DSD path (spec §6.2 / §15):
   *   If computed DSD < 0 (user is ahead of Growatt), store a pending candidate
   *   and wait for the next matching Growatt power_events entry to finalize.
   *
   * Zero / Positive DSD path (spec §6.3):
   *   Growatt reference is safely available — finalize immediately.
   */
  const calibrate = useCallback(async (
    eventType: 'UTILITY_ON' | 'UTILITY_OFF',
    userReportedHour: number,
    userReportedMinute: number,
  ): Promise<{ offsetMinutes: number; error: string | null }> => {
    if (!user) return { offsetMinutes: 0, error: 'Not authenticated' };

    // Fetch recent matching events from power_events (last 48h)
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: events, error: evErr } = await supabase
      .from('power_events')
      .select('occurred_at, event_type')
      .eq('event_type', eventType)
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false })
      .limit(5);

    if (evErr || !events || events.length === 0) {
      return { offsetMinutes: 0, error: 'No recent events found to calibrate against. Try again later.' };
    }

    // Build user's reported time for today and yesterday in Yemen time (UTC+3)
    const nowYemen = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const candidates: Date[] = [];

    for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
      const d = new Date(nowYemen);
      d.setUTCDate(d.getUTCDate() - dayOffset);
      d.setUTCHours(userReportedHour - 3, userReportedMinute, 0, 0); // convert Yemen → UTC
      candidates.push(d);
    }

    // Find nearest Growatt event to user's reported time
    let bestMatch: { eventTime: Date; userTime: Date; diffMin: number } | null = null;

    for (const ev of events) {
      const evTime = new Date(ev.occurred_at);
      for (const userTime of candidates) {
        const diffMin = Math.round((userTime.getTime() - evTime.getTime()) / 60000);
        if (bestMatch === null || Math.abs(diffMin) < Math.abs(bestMatch.diffMin)) {
          bestMatch = { eventTime: evTime, userTime, diffMin };
        }
      }
    }

    if (!bestMatch) {
      return { offsetMinutes: 0, error: 'Could not find a matching event.' };
    }

    const offsetMinutes = bestMatch.diffMin;

    // ── Negative DSD path (spec §6.2 / §15) ──────────────────────────────────
    // User is ahead of Growatt. Do NOT finalize yet — the existing Growatt event
    // we matched against may be unrelated. Store a pending candidate and wait for
    // the next real matching Growatt transition within the 2-hour window.
    if (offsetMinutes < 0) {
      const candidate: PendingDSDCandidate = {
        eventType,
        reportedTransitionIso: bestMatch.userTime.toISOString(),
        tentativeDSD: offsetMinutes,
        createdAtIso: new Date().toISOString(),
      };
      setPendingDSD(candidate);
      if (storageKey) {
        try { await AsyncStorage.setItem(storageKey, JSON.stringify(candidate)); } catch (_) {}
      }
      console.log(`[useUserOffset] Negative DSD=${offsetMinutes}min — pending candidate stored, awaiting Growatt confirmation`);
      // Return the tentative value so callers can show appropriate UI
      return { offsetMinutes, error: null };
    }

    // ── Zero / Positive DSD path (spec §6.3): finalize immediately ───────────
    const { error: upsertErr } = await supabase
      .from('user_offsets')
      .upsert(
        {
          user_id: user.id,
          offset_minutes: offsetMinutes,
          last_event_type: eventType,
          last_event_at: bestMatch.userTime.toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

    if (upsertErr) {
      return { offsetMinutes: 0, error: upsertErr.message };
    }

    await fetchOffset();
    return { offsetMinutes, error: null };
  }, [user, fetchOffset, storageKey]);

  /**
   * Directly save a specific offset value (used by auto-suggest one-tap apply).
   */
  const saveOffset = useCallback(async (offsetMinutes: number): Promise<void> => {
    if (!user) return;
    const { error } = await supabase
      .from('user_offsets')
      .upsert(
        { user_id: user.id, offset_minutes: offsetMinutes, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
    if (error) console.error('[useUserOffset] saveOffset error:', error.message);
    else await fetchOffset();
  }, [user, fetchOffset]);

  /**
   * Manually discard a pending DSD candidate (e.g. user cancels their report).
   */
  const clearPendingDSD = useCallback(async () => {
    setPendingDSD(null);
    if (storageKey) {
      try { await AsyncStorage.removeItem(storageKey); } catch (_) {}
    }
  }, [storageKey]);

  return { offset, loading, calibrate, saveOffset, refetch: fetchOffset, pendingDSD, clearPendingDSD };
}
