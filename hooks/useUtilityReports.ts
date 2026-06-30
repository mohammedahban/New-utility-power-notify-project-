/**
 * useUtilityReports
 *
 * Handles submitting community utility-state reports to the database.
 * Includes a per-user cooldown (5 minutes) to prevent spam.
 *
 * Returns a selfResync ResyncPoint so the caller can immediately apply
 * the report as the user's own community sync without waiting for
 * distribute-resync to fan it out.
 */

import { useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { ResyncPoint } from '../contexts/ResyncContext';

export type TimeOption = 'now' | '5min' | '10min' | '15min' | '20min';
export type ReportedState = 'UTILITY_ON' | 'UTILITY_OFF';

const TIME_OPTION_MINUTES: Record<TimeOption, number> = {
  now:   0,
  '5min':  5,
  '10min': 10,
  '15min': 15,
  '20min': 20,
};

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function formatCooldown(remainingMs: number): string {
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')} دقيقة`;
  return `${s} ثانية`;
}

export interface SubmitReportResult {
  selfResync: ResyncPoint | null;
  error: string | null;
}

export function useUtilityReports() {
  const { user, profile } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [lastReportAt, setLastReportAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Tick every second so cooldownLabel stays live
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTick = useCallback(() => {
    if (tickRef.current) return;
    tickRef.current = setInterval(() => {
      setNow(Date.now());
    }, 1000);
  }, []);
  const stopTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const remainingMs = lastReportAt ? Math.max(0, COOLDOWN_MS - (now - lastReportAt)) : 0;
  const isCoolingDown = remainingMs > 0;
  const cooldownLabel = isCoolingDown ? formatCooldown(remainingMs) : null;

  // Stop tick when cooldown expires
  if (!isCoolingDown && tickRef.current) stopTick();

  const submitReport = useCallback(async (
    state: ReportedState,
    timeOption: TimeOption,
  ): Promise<SubmitReportResult> => {
    if (!user) return { selfResync: null, error: 'يجب تسجيل الدخول أولاً' };
    if (isCoolingDown) return { selfResync: null, error: 'انتظر انتهاء فترة الانتظار' };

    setSubmitting(true);
    try {
      const minutesAgo = TIME_OPTION_MINUTES[timeOption];
      const estimatedTransitionAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();

      const { data, error } = await supabase
        .from('utility_reports')
        .insert({
          reporter_id: user.id,
          reported_state: state,
          time_option: timeOption,
          estimated_transition_at: estimatedTransitionAt,
          is_active: true,
        })
        .select()
        .single();

      if (error) {
        return { selfResync: null, error: error.message };
      }

      // Mark cooldown start
      const reportedAt = Date.now();
      setLastReportAt(reportedAt);
      startTick();

      // Build a ResyncPoint for the reporter's own timeline
      const selfResync: ResyncPoint = {
        syncedState: state === 'UTILITY_ON' ? 'ON' : 'OFF',
        syncedAtIso: estimatedTransitionAt,
        appliedAtIso: new Date().toISOString(),
        reporterName: profile?.username ?? null,
        reporterReliability: null,
      };

      return { selfResync, error: null };
    } catch (err: any) {
      return { selfResync: null, error: err?.message ?? 'فشل إرسال البلاغ' };
    } finally {
      setSubmitting(false);
    }
  }, [user, profile, isCoolingDown, startTick]);

  return {
    submitting,
    submitReport,
    isCoolingDown,
    cooldownLabel,
  };
}
