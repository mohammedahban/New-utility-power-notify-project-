import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

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

  /**
   * Calibrate offset: user reports the time of a recent power event.
   * We find the nearest matching event in power_events and compute the diff.
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

    // Upsert offset
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
  }, [user, fetchOffset]);

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

  return { offset, loading, calibrate, saveOffset, refetch: fetchOffset };
}
