/**
 * useUtilityReports — TMMS V2.2
 *
 * Manages community utility report submission and real-time subscriptions.
 * V2.2: ON-only reporting. submitReport always receives 'UTILITY_ON'.
 * The Period 1/2/3 offset is computed automatically at submission time.
 */

import { useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export type TimeOption = 'now' | '5min' | '10min' | '15min' | '20min';

const TIME_OPTION_OFFSETS: Record<TimeOption, number> = {
  now:   0,
  '5min':  5,
  '10min': 10,
  '15min': 15,
  '20min': 20,
};

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between reports

export interface ResyncPoint {
  reportId: number;
  reporterName: string;
  reportedState: 'UTILITY_ON' | 'UTILITY_OFF';
  estimatedTransitionAt: string;
  reporterOffsetState?: string | null;
  reporterOffsetValue?: string | null;
  reporterTimelineAlignment?: string | null;
  generatedOnStartIso?: string | null;
  generatedOnDurationMin?: number | null;
  generatedOnReferenceIso?: string | null;
  generatedOnReferenceKind?: string | null;
  syncedAtIso?: string | null;
  reporterReliability?: number | null;
  reporterUserId?: string;
}

export function useUtilityReports() {
  const { user, profile } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const lastSubmitRef = useRef<number>(0);

  // ── Cooldown state ──────────────────────────────────────────────────────────
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const isCoolingDown = cooldownUntil !== null && Date.now() < cooldownUntil;
  const cooldownLabel = (() => {
    if (!isCoolingDown || !cooldownUntil) return null;
    const remainSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (remainSec <= 0) return null;
    const m = Math.floor(remainSec / 60);
    const s = remainSec % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}ث`;
  })();

  /**
   * V2.2: submitReport — always UTILITY_ON.
   * Returns { selfResync, error } where selfResync is the ResyncPoint to apply
   * immediately for the reporter's own timeline.
   */
  const submitReport = useCallback(async (
    state: 'UTILITY_ON' | 'UTILITY_OFF',
    timeOption: TimeOption,
  ): Promise<{ selfResync: ResyncPoint | null; error: string | null }> => {
    if (!user || !profile) return { selfResync: null, error: 'يجب تسجيل الدخول أولاً' };
    if (isCoolingDown) return { selfResync: null, error: 'يرجى الانتظار قبل إرسال بلاغ جديد' };

    // Throttle: 2s minimum between calls
    const now = Date.now();
    if (now - lastSubmitRef.current < 2000) return { selfResync: null, error: null };
    lastSubmitRef.current = now;

    setSubmitting(true);
    try {
      const minutesBack = TIME_OPTION_OFFSETS[timeOption] ?? 0;
      const estimatedTransitionAt = new Date(Date.now() - minutesBack * 60_000).toISOString();

      // V2.2: always report ON
      const reportedState = 'UTILITY_ON';

      const insertPayload: Record<string, any> = {
        reporter_id: user.id,
        reported_state: reportedState,
        time_option: timeOption,
        estimated_transition_at: estimatedTransitionAt,
        is_active: true,
      };

      const { data: inserted, error: insertErr } = await supabase
        .from('utility_reports')
        .insert(insertPayload)
        .select('id, estimated_transition_at')
        .single();

      if (insertErr || !inserted) {
        return { selfResync: null, error: insertErr?.message ?? 'فشل إرسال البلاغ' };
      }

      // Start cooldown
      setCooldownUntil(Date.now() + COOLDOWN_MS);

      const selfResync: ResyncPoint = {
        reportId: inserted.id,
        reporterName: profile.username ?? profile.email?.split('@')[0] ?? 'أنت',
        reportedState,
        estimatedTransitionAt: inserted.estimated_transition_at,
        syncedAtIso: new Date().toISOString(),
        reporterUserId: user.id,
      };

      return { selfResync, error: null };
    } catch (e: any) {
      return { selfResync: null, error: e?.message ?? 'خطأ غير متوقع' };
    } finally {
      setSubmitting(false);
    }
  }, [user, profile, isCoolingDown]);

  return {
    submitting,
    submitReport,
    isCoolingDown,
    cooldownLabel,
  };
}
