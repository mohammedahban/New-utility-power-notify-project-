
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface ReliabilityScore {
  user_id: string;
  total_reports: number;
  accepted_reports: number;
  rejected_reports: number;
  total_responses: number;
  yes_responses: number;
  no_responses: number;
  ignored_notifications: number;
  reliability_score: number;      // 0–100
  community_trust_score: number;  // 0–100
  last_report_at: string | null;
  last_response_at: string | null;
  updated_at: string;
}

export function useReliability(userIds: string[]) {
  const [scores, setScores] = useState<Record<string, ReliabilityScore>>({});
  const [loading, setLoading] = useState(false);

  const fetchScores = useCallback(async () => {
    if (userIds.length === 0) { setScores({}); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from('user_reliability')
      .select('*')
      .in('user_id', userIds);
    if (error) { console.error('[useReliability] error:', error.message); }
    const map: Record<string, ReliabilityScore> = {};
    for (const row of data ?? []) map[row.user_id] = row as ReliabilityScore;
    setScores(map);
    setLoading(false);
  }, [userIds]); 

  useEffect(() => { fetchScores(); }, [fetchScores]);

  return { scores, loading, refresh: fetchScores };
}

export function useMyReliability(userId: string | undefined) {
  const [score, setScore] = useState<ReliabilityScore | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    if (!userId) { setLoading(false); return; }
    const { data, error } = await supabase
      .from('user_reliability')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) console.error('[useMyReliability] error:', error.message);
    setScore(data as ReliabilityScore | null);
    setLoading(false);
  }, [userId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { score, loading, refresh: fetch };
}

/** Badge labels based on reliability score */
export function getReliabilityBadge(score: number): { label: string; color: string } {
  if (score >= 85) return { label: '⭐ Trusted', color: '#22c55e' };
  if (score >= 65) return { label: '✅ Reliable', color: '#38bdf8' };
  if (score >= 45) return { label: '🔵 Active', color: '#818cf8' };
  if (score >= 25) return { label: '🟡 New', color: '#f59e0b' };
  return { label: '⚪ Unknown', color: '#64748b' };
}
