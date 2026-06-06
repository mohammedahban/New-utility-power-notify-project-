/**
 * useUtilityReports
 *
 * Handles submitting utility transition reports.
 *
 * After a successful submit:
 * 1. The report is stored in utility_reports.
 * 2. The distribute-resync edge function is called to notify followers.
 * 3. A self-resync result is returned so the caller can immediately
 *    update the ResyncContext for the reporter themselves.
 *
 * Self-resync logic:
 *   syncedAtIso = now - selectedOffsetMinutes
 *   syncedState = reportedState === 'UTILITY_ON' ? 'ON' : 'OFF'
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { ResyncPoint } from '../contexts/ResyncContext';

export type TimeOption = 'now' | '5min' | '10min' | '15min' | '20min';
export type ReportedState = 'UTILITY_ON' | 'UTILITY_OFF';

export interface UtilityReport {
  id: number;
  reporter_id: string;
  reported_state: ReportedState;
  time_option: TimeOption;
  estimated_transition_at: string;
  created_at: string;
  is_active: boolean;
  reporter_username?: string | null;
}

const TIME_OFFSETS_MIN: Record<TimeOption, number> = {
  now: 0,
  '5min': 5,
  '10min': 10,
  '15min': 15,
  '20min': 20,
};

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const LAST_REPORT_KEY = 'utility_report_last_submitted_at';

export function useUtilityReports() {
  const { user } = useAuth();
  const [myReports, setMyReports] = useState<UtilityReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Cooldown state
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load last submission time from storage and start countdown if needed
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(LAST_REPORT_KEY);
        if (stored) {
          const lastAt = parseInt(stored, 10);
          const elapsed = Date.now() - lastAt;
          const remaining = COOLDOWN_MS - elapsed;
          if (remaining > 0) setCooldownRemainingMs(remaining);
        }
      } catch (_) {}
    })();
  }, []);

  // Countdown timer
  useEffect(() => {
    if (cooldownRemainingMs <= 0) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCooldownRemainingMs(prev => {
        const next = prev - 1000;
        if (next <= 0) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [cooldownRemainingMs > 0]);

  const fetchMyReports = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('utility_reports')
      .select('*')
      .eq('reporter_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) console.error('[useUtilityReports] fetch error:', error.message);
    setMyReports((data ?? []) as UtilityReport[]);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchMyReports(); }, [fetchMyReports]);

  /**
   * Submit a utility transition report.
   *
   * Returns:
   *   reportId   — database ID of the inserted report
   *   selfResync — ResyncPoint the reporter should apply to their own schedule
   *   error      — error message string, or null on success
   */
  const submitReport = useCallback(async (
    reportedState: ReportedState,
    timeOption: TimeOption,
  ): Promise<{
    reportId: number | null;
    selfResync: ResyncPoint | null;
    error: string | null;
  }> => {
    if (!user) return { reportId: null, selfResync: null, error: 'Not authenticated' };

    if (cooldownRemainingMs > 0) {
      const mins = Math.ceil(cooldownRemainingMs / 60000);
      return {
        reportId: null,
        selfResync: null,
        error: `Please wait ${mins} minute${mins !== 1 ? 's' : ''} before submitting another report.`,
      };
    }

    setSubmitting(true);

    const offsetMin = TIME_OFFSETS_MIN[timeOption];
    const nowMs = Date.now();

    // estimated_transition_at is the absolute timestamp when the event
    // actually occurred (now minus the selected time offset)
    const estimatedTransitionAt = new Date(nowMs - offsetMin * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('utility_reports')
      .insert({
        reporter_id: user.id,
        reported_state: reportedState,
        time_option: timeOption,
        estimated_transition_at: estimatedTransitionAt,
        is_active: true,
      })
      .select('id')
      .single();

    if (error) {
      setSubmitting(false);
      return { reportId: null, selfResync: null, error: error.message };
    }

    const reportId = data?.id ?? null;

    // Save submission time & start cooldown
    try { await AsyncStorage.setItem(LAST_REPORT_KEY, String(nowMs)); } catch (_) {}
    setCooldownRemainingMs(COOLDOWN_MS);

    // Build the self-resync point:
    //   syncedState = ON if UTILITY_ON reported, OFF otherwise
    //   syncedAtIso = estimated_transition_at (when the event actually happened)
    const selfResync: ResyncPoint = {
      syncedState: reportedState === 'UTILITY_ON' ? 'ON' : 'OFF',
      syncedAtIso: estimatedTransitionAt,
      appliedAtIso: new Date(nowMs).toISOString(),
    };

    // Also persist to resync_history for the reporter themselves
    supabase.from('resync_history').insert({
      user_id: user.id,
      report_id: reportId,
      reporter_id: user.id,
      reporter_username: null, // will be resolved by display layer
      reported_state: reportedState,
      effective_transition_at: estimatedTransitionAt,
      confirmed_at: new Date(nowMs).toISOString(),
      source: 'self_report',
    }).then(({ error: histErr }) => {
      if (histErr) console.warn('[useUtilityReports] history insert error:', histErr.message);
    });

    // Distribute push notifications to followers (non-blocking)
    supabase.functions.invoke('distribute-resync', {
      body: {
        reportId,
        reporterId: user.id,
        reportedState,
        estimatedTransitionAt,
        timeOption,
      },
    }).catch(e => {
      console.warn('[useUtilityReports] distribute-resync invoke failed (non-fatal):', e);
    });

    await fetchMyReports();
    setSubmitting(false);

    return { reportId, selfResync, error: null };
  }, [user, fetchMyReports, cooldownRemainingMs]);

  const cooldownLabel = cooldownRemainingMs > 0
    ? (() => {
        const totalSec = Math.ceil(cooldownRemainingMs / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
      })()
    : null;

  return {
    myReports,
    loading,
    submitting,
    submitReport,
    refresh: fetchMyReports,
    isCoolingDown: cooldownRemainingMs > 0,
    cooldownLabel,
    cooldownRemainingMs,
  };
}
