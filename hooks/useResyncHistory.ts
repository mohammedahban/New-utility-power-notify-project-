import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface ResyncEvent {
  id: number;
  user_id: string;
  report_id: number | null;
  reporter_id: string | null;
  reporter_username: string | null;
  reported_state: 'UTILITY_ON' | 'UTILITY_OFF';
  effective_transition_at: string;
  confirmed_at: string;
  source: string;
  // joined
  recipient_username?: string | null;
  yes_count?: number;
  reporter_reliability?: number;
}

/**
 * Admin-level hook — fetches ALL resync_history entries across all users,
 * enriched with reporter reliability and YES confirmation counts.
 */
export function useAdminResyncHistory(limit = 20) {
  const [events, setEvents] = useState<ResyncEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('resync_history')
        .select('*')
        .order('confirmed_at', { ascending: false })
        .limit(limit);

      if (error) { console.error('[useAdminResyncHistory] fetch error:', error.message); setLoading(false); return; }

      const rows = (data ?? []) as ResyncEvent[];
      if (rows.length === 0) { setEvents([]); setLoading(false); return; }

      // Collect all unique reporter_ids and user_ids
      const reporterIds = [...new Set(rows.map(r => r.reporter_id).filter(Boolean) as string[])];
      const userIds = [...new Set(rows.map(r => r.user_id))];
      const reportIds = [...new Set(rows.map(r => r.report_id).filter(Boolean) as number[])];
      const allIds = [...new Set([...reporterIds, ...userIds])];

      const [profilesRes, reliabilityRes, responsesRes] = await Promise.all([
        allIds.length > 0
          ? supabase.from('user_profiles').select('id, username').in('id', allIds)
          : Promise.resolve({ data: [] }),
        reporterIds.length > 0
          ? supabase.from('user_reliability').select('user_id, reliability_score').in('user_id', reporterIds)
          : Promise.resolve({ data: [] }),
        reportIds.length > 0
          ? supabase.from('resync_responses').select('report_id').eq('response', 'yes').in('report_id', reportIds)
          : Promise.resolve({ data: [] }),
      ]);

      const usernameMap: Record<string, string | null> = {};
      for (const p of profilesRes.data ?? []) usernameMap[p.id] = p.username;

      const reliabilityMap: Record<string, number> = {};
      for (const r of reliabilityRes.data ?? []) reliabilityMap[r.user_id] = r.reliability_score;

      // Count YES responses per report
      const yesMap: Record<number, number> = {};
      for (const r of responsesRes.data ?? []) {
        yesMap[r.report_id] = (yesMap[r.report_id] ?? 0) + 1;
      }

      const enriched = rows.map(r => ({
        ...r,
        recipient_username: usernameMap[r.user_id] ?? null,
        reporter_username: r.reporter_username ?? (r.reporter_id ? usernameMap[r.reporter_id] : null),
        yes_count: r.report_id ? (yesMap[r.report_id] ?? 0) : 0,
        reporter_reliability: r.reporter_id ? (reliabilityMap[r.reporter_id] ?? 50) : null,
      }));

      setEvents(enriched);
    } catch (err) {
      console.error('[useAdminResyncHistory] error:', err);
    }
    setLoading(false);
  }, [limit]);

  useEffect(() => { fetch(); }, [fetch]);

  return { events, loading, refresh: fetch };
}

/**
 * Hook to count unreviewed community_conflicts — used for badge display.
 */
export function useUnreviewedConflictsCount() {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(async () => {
    const { count: n, error } = await supabase
      .from('community_conflicts')
      .select('*', { count: 'exact', head: true })
      .is('reviewed_at', null);
    if (!error) setCount(n ?? 0);
  }, []);

  useEffect(() => { fetchCount(); }, [fetchCount]);

  // Realtime listener
  useEffect(() => {
    const ch = supabase
      .channel(`conflicts_count_${Math.random()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'community_conflicts' }, () => fetchCount())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [fetchCount]);

  return { count, refresh: fetchCount };
}
