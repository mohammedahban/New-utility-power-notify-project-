/**
 * useUtilityReports — TMMS V2.1 (Final)
 *
 * Handles utility state report submission with Period 1 / Period 2 offset
 * calculation at report time.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TMMS V2.1 RULES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * V2.1 is ON-ONLY. Users only report UTILITY_ON. OFF is handled automatically
 * by the prediction engine.
 *
 * Period 1/Period 2 offset calculation (computed at report time, FINAL):
 *   - Period 1: OFF Progress < 50% → POSITIVE offset
 *     (user turns ON before the expected midpoint of the OFF period)
 *   - Period 2: OFF Progress ≥ 50% → NEGATIVE offset
 *     (user turns ON after the expected midpoint of the OFF period)
 *
 * The offset is FINAL at report time. No recomputation on Growatt events.
 *
 * Cooldown: 15 minutes between reports.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { ResyncPoint } from '../contexts/ResyncContext';

export type TimeOption = 'now' | '5min' | '10min' | '15min' | '20min';
// V2.1: kept for backwards compatibility. Hook internally always submits UTILITY_ON.
export type ReportedState = 'UTILITY_ON' | 'UTILITY_OFF';

export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
export type OffsetValue = number | 'PENDING';

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const TIME_OPTION_MINUTES: Record<TimeOption, number> = {
  now: 0,
  '5min': 5,
  '10min': 10,
  '15min': 15,
  '20min': 20,
};

function durationLabelFromMin(min: number): string {
  if (min <= 0) return '0د';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

interface SubmitResult {
  selfResync: ResyncPoint | null;
  error: string | null;
}

export function useUtilityReports() {
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmitMs, setLastSubmitMs] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Update tick every second for cooldown display
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const isCoolingDown = lastSubmitMs !== null && (now - lastSubmitMs) < COOLDOWN_MS;

  const cooldownLabel: string | null = (() => {
    if (!isCoolingDown || !lastSubmitMs) return null;
    const remainMs = COOLDOWN_MS - (now - lastSubmitMs);
    const m = Math.floor(remainMs / 60000);
    const s = Math.floor((remainMs % 60000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
  })();

  /**
   * Submit a utility state report.
   *
   * V2.1: `state` parameter is accepted for backwards compatibility with
   * existing callers (_layout.tsx GlobalReportModal), but is ignored
   * internally. All reports are treated as UTILITY_ON.
   *
   * Returns selfResync: a ResyncPoint the caller can pass to applyResync()
   * to immediately update the local timeline.
   */
  const submitReport = useCallback(async (
    _state: ReportedState,
    timeOption: TimeOption,
  ): Promise<SubmitResult> => {
    if (!user) return { selfResync: null, error: 'Not authenticated' };
    if (isCoolingDown) return { selfResync: null, error: 'Cooldown active' };

    setSubmitting(true);
    try {
      const minutesAgo = TIME_OPTION_MINUTES[timeOption] ?? 0;
      const nowMs = Date.now();
      const estimatedTransitionAt = new Date(nowMs - minutesAgo * 60_000).toISOString();

      // ── Period 1 / Period 2 offset calculation ────────────────────────────
      // Fetch the latest utility prediction to determine OFF progress.
      // If unavailable, default to NEUTRAL / 0.
      let offsetState: OffsetState = 'NEUTRAL';
      let offsetValue: OffsetValue = 0;
      let timelineAlignment = estimatedTransitionAt;

      try {
        const { data: predRow } = await supabase
          .from('utility_predictions')
          .select('prediction, computed_at')
          .eq('id', 1)
          .maybeSingle();

        if (predRow?.prediction) {
          const pred = predRow.prediction as any;
          const currentState: 'ON' | 'OFF' = pred.currentState ?? 'OFF';
          const lastTransitionAt: string | null = pred.lastTransitionAt ?? null;

          if (currentState === 'OFF' && lastTransitionAt) {
            // Compute elapsed OFF time vs expected OFF duration
            const offStartMs = new Date(lastTransitionAt).getTime();
            const elapsedOffMin = Math.max(0, (nowMs - minutesAgo * 60_000 - offStartMs) / 60_000);

            // Get expected OFF duration from the prediction
            const dayPattern = pred.dayPattern;
            const allPattern = pred.allPattern;
            const expectedOffMin: number = (
              dayPattern?.avgOffMin ??
              allPattern?.avgOffMin ??
              120
            );

            const offProgress = expectedOffMin > 0 ? elapsedOffMin / expectedOffMin : 0;

            if (offProgress < 0.5) {
              // Period 1: first half of OFF → POSITIVE offset
              // offsetValue = how far AFTER the expected OFF midpoint the user turns ON
              // (positive = user turns ON after Growatt)
              const midpointMs = offStartMs + (expectedOffMin / 2) * 60_000;
              const reportMs = nowMs - minutesAgo * 60_000;
              offsetValue = Math.round((reportMs - midpointMs) / 60_000);
              offsetState = 'POSITIVE';
              timelineAlignment = lastTransitionAt;
            } else {
              // Period 2: second half of OFF → NEGATIVE offset
              // offsetValue = T − expected_end = negative (user is before Growatt expected end)
              const expectedEndMs = offStartMs + expectedOffMin * 60_000;
              const reportMs = nowMs - minutesAgo * 60_000;
              offsetValue = Math.round((reportMs - expectedEndMs) / 60_000);
              offsetState = 'NEGATIVE';
              timelineAlignment = lastTransitionAt;
            }
          } else if (currentState === 'ON') {
            // User reporting ON while Growatt is already ON — NEUTRAL
            offsetState = 'NEUTRAL';
            offsetValue = 0;
            timelineAlignment = estimatedTransitionAt;
          }
        }
      } catch (e) {
        console.warn('[useUtilityReports] offset calculation failed (non-fatal):', e);
      }

      // ── Generated ON metadata ─────────────────────────────────────────────
      // In V2.1, every ON report creates a "Generated ON" timeline event.
      // We compute its duration from the predicted ON duration.
      let generatedOnDurationMin: number | null = null;
      let generatedOnReferenceIso: string | null = null;
      let generatedOnReferenceKind: 'completed' | 'active' = 'completed';

      try {
        const { data: predRow } = await supabase
          .from('utility_predictions')
          .select('prediction')
          .eq('id', 1)
          .maybeSingle();

        if (predRow?.prediction) {
          const pred = predRow.prediction as any;
          const dayPattern = pred.dayPattern;
          const allPattern = pred.allPattern;
          generatedOnDurationMin = Math.round(
            dayPattern?.avgOnMin ??
            allPattern?.avgOnMin ??
            120
          );
          // Reference is the most recent completed ON cycle
          const schedule: any[] = pred.daySchedule ?? [];
          const nowUtc = new Date(nowMs - minutesAgo * 60_000);
          const completedOn = schedule
            .filter(s => s.state === 'ON' && s.endIso && new Date(s.endIso).getTime() <= nowUtc.getTime())
            .sort((a, b) => new Date(b.endIso).getTime() - new Date(a.endIso).getTime())[0];
          if (completedOn) {
            generatedOnReferenceIso = completedOn.startIso;
            generatedOnReferenceKind = 'completed';
          }
        }
      } catch (e) {
        console.warn('[useUtilityReports] generated ON metadata failed (non-fatal):', e);
      }

      // ── Insert utility_reports row ────────────────────────────────────────
      const { data: report, error: reportErr } = await supabase
        .from('utility_reports')
        .insert({
          reporter_id: user.id,
          reported_state: 'UTILITY_ON',
          time_option: timeOption,
          estimated_transition_at: estimatedTransitionAt,
          is_active: true,
          reporter_offset_state: offsetState,
          reporter_offset_value: offsetValue,
          reporter_timeline_alignment: timelineAlignment,
          generated_on_start_iso: estimatedTransitionAt,
          generated_on_duration_min: generatedOnDurationMin,
          generated_on_reference_iso: generatedOnReferenceIso,
          generated_on_reference_kind: generatedOnReferenceKind,
        })
        .select('id')
        .single();

      if (reportErr) {
        return { selfResync: null, error: reportErr.message };
      }

      // ── Self-resync: insert into resync_history for the reporter ──────────
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('username')
        .eq('id', user.id)
        .maybeSingle();

      await supabase.from('resync_history').insert({
        user_id: user.id,
        report_id: report.id,
        reporter_id: user.id,
        reporter_username: profile?.username ?? null,
        reported_state: 'UTILITY_ON',
        effective_transition_at: estimatedTransitionAt,
        confirmed_at: new Date().toISOString(),
        source: 'community_resync',
        offset_state: offsetState,
        offset_value: offsetValue,
        timeline_alignment: timelineAlignment,
        generated_on_start_iso: estimatedTransitionAt,
        generated_on_duration_min: generatedOnDurationMin,
        generated_on_reference_iso: generatedOnReferenceIso,
        generated_on_reference_kind: generatedOnReferenceKind,
      });

      // ── Update user_offsets ───────────────────────────────────────────────
      const numericOffset = typeof offsetValue === 'number' ? offsetValue : 0;
      await supabase.from('user_offsets').upsert({
        user_id: user.id,
        offset_minutes: numericOffset,
        offset_state: offsetState,
        offset_value: offsetValue,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

      // ── Reliability: bump total_reports ───────────────────────────────────
      try {
        const { data: rel } = await supabase
          .from('user_reliability')
          .select('total_reports, last_report_at')
          .eq('user_id', user.id)
          .maybeSingle();
        await supabase.from('user_reliability').upsert({
          user_id: user.id,
          total_reports: ((rel as any)?.total_reports ?? 0) + 1,
          last_report_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
      } catch (e) {
        console.warn('[useUtilityReports] reliability update failed (non-fatal):', e);
      }

      setLastSubmitMs(Date.now());

      // ── Build selfResync point ────────────────────────────────────────────
      const selfResync: ResyncPoint = {
        syncedState: 'ON',
        syncedAtIso: estimatedTransitionAt,
        appliedAtIso: new Date().toISOString(),
        reporterName: profile?.username ?? null,
        reporterReliability: null,
        offsetState,
        offsetValue,
        timelineAlignment,
        generatedOnStartIso: estimatedTransitionAt,
        generatedOnDurationMin,
        generatedOnReferenceIso,
        generatedOnReferenceKind,
      };

      return { selfResync, error: null };
    } catch (e: any) {
      console.error('[useUtilityReports] submit error:', e);
      return { selfResync: null, error: e?.message ?? 'Unknown error' };
    } finally {
      setSubmitting(false);
    }
  }, [user, isCoolingDown]);

  return {
    submitting,
    submitReport,
    isCoolingDown,
    cooldownLabel,
  };
}
