/**
 * useUtilityReports — TMMS V2.2 Personal Timeline Replacement Model
 *
 * Handles submitting utility transition reports.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.2 CHANGES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  1. ON-ONLY REPORTING (unchanged from V2.1)
 *     The `reportedState` parameter is kept for backwards compatibility but
 *     V2.2 always submits 'UTILITY_ON'.
 *
 *  2. PERIOD 1 / PERIOD 2 / PERIOD 3 OFFSET CALCULATION AT SUBMISSION TIME
 *     When a reporter submits a report, the hook:
 *       a. Fetches the current Growatt schedule
 *       b. Determines which TMMS Period the submission falls into:
 *
 *          Period 1 = During Growatt ON (after it starts) OR first half of
 *                     the following Growatt OFF (<50% consumed)
 *            → POSITIVE offset (or NEUTRAL if exactly at ON start)
 *            → Generated ON replaces the current/previous Growatt ON
 *            → Generated ON receives full duration of replaced ON
 *            → Following OFF receives full duration of original following OFF
 *            → Offset Value = GeneratedONstart - ReplacedONstart
 *
 *          Period 2 = Second half of Growatt OFF (>50% consumed) through
 *                     immediately before next Growatt ON starts
 *            → PENDING_NEGATIVE (initially — exact value unknown)
 *            → Generated ON replaces the NEXT upcoming Growatt ON
 *            → Generated ON receives full duration of next ON
 *            → Following OFF receives full duration of OFF after replaced next ON
 *            → Offset auto-resolves to NEGATIVE when Growatt ON begins:
 *              offsetValue = GeneratedONstart - ActualGrowattONstart
 *
 *          Period 3 = Exact instant the Growatt ON state begins
 *            → NEUTRAL offset
 *            → Offset Value = 0
 *            → Personal Timeline = exact clone of Growatt
 *
 *       c. The offset is FINAL at report time for Period 1 and Period 3.
 *          For Period 2, the state (PENDING_NEGATIVE) is final but the numeric
 *          value resolves when Growatt turns ON.
 *
 *  3. GENERATED ON CREATION
 *     Every accepted ON report creates a permanent Generated ON event:
 *       - Ends current OFF
 *       - Creates Generated ON as current state
 *       - Chooses duration from the replaced Growatt ON
 *       - Calculates Offset per Period rules
 *       - Rebuilds today's remaining timeline
 *       - Rebuilds future schedules
 *
 *  4. NEXT OFF RULE
 *     Immediately after Generated ON ends, the next OFF begins automatically
 *     with the FULL duration of the OFF that originally followed the replaced
 *     Growatt ON (Period 1) or the replaced next ON (Period 2).
 *
 * Original (V2 / V2.1) responsibilities preserved unchanged:
 *   - Cooldown timer (30 min between reports)
 *   - distribute-resync edge function invocation
 *   - resync_history persistence
 *   - Reporter name/reliability fetch
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { ResyncPoint, OffsetState, OffsetValue } from '../contexts/ResyncContext';

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

// ── V2.2: Schedule slot interface ──────────────────────────────────────────
interface ScheduleSlot {
  state: 'ON' | 'OFF';
  start: string;  // ISO timestamp or 'HH:MM'
  end: string;
  durationMin: number;
}

// ── V2.2: Time helpers ─────────────────────────────────────────────────────
function timeToMin(hhmm: string): number {
  if (typeof hhmm !== 'string') return hhmm;
  // Handle both 'HH:MM' and ISO timestamps
  if (hhmm.includes('T')) {
    const d = new Date(hhmm);
    return d.getHours() * 60 + d.getMinutes();
  }
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minToTime(min: number): string {
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── V2.2: Find the current Growatt OFF slot ────────────────────────────────
function findCurrentOffSlot(schedule: ScheduleSlot[], t: number): ScheduleSlot | null {
  for (const slot of schedule) {
    if (slot.state !== 'OFF') continue;
    const start = timeToMin(slot.start);
    const end = timeToMin(slot.end);
    if (start < end) {
      if (t >= start && t < end) return slot;
    } else {
      if (t >= start || t < end) return slot;
    }
  }
  return null;
}

// ── V2.2: Find the current Growatt ON slot ─────────────────────────────────
function findCurrentOnSlot(schedule: ScheduleSlot[], t: number): ScheduleSlot | null {
  for (const slot of schedule) {
    if (slot.state !== 'ON') continue;
    const start = timeToMin(slot.start);
    const end = timeToMin(slot.end);
    if (start < end) {
      if (t >= start && t < end) return slot;
    } else {
      if (t >= start || t < end) return slot;
    }
  }
  return null;
}

// ── V2.2: Find the previous Growatt ON (most recently ended) ───────────────
function findPreviousGrowattOn(schedule: ScheduleSlot[], t: number): ScheduleSlot | null {
  let prev: ScheduleSlot | null = null;
  let prevEndMin = -1;
  for (const slot of schedule) {
    if (slot.state !== 'ON') continue;
    const start = timeToMin(slot.start);
    const end = timeToMin(slot.end);
    let hasEnded: boolean;
    let endedAt: number;
    if (end > start) {
      hasEnded = end <= t;
      endedAt = end;
    } else {
      const isActive = t >= start || t < end;
      hasEnded = !isActive;
      endedAt = end;
    }
    if (hasEnded && endedAt > prevEndMin) {
      prev = slot;
      prevEndMin = endedAt;
    }
  }
  return prev;
}

// ── V2.2: Find the next Growatt ON (upcoming) ──────────────────────────────
function findNextGrowattOn(schedule: ScheduleSlot[], t: number): ScheduleSlot | null {
  let next: ScheduleSlot | null = null;
  let nextStartMin = Infinity;

  for (const slot of schedule) {
    if (slot.state !== 'ON') continue;
    const start = timeToMin(slot.start);
    const end = timeToMin(slot.end);
    let startsAfter: boolean;
    if (end > start) {
      startsAfter = start > t;
    } else {
      const isActive = t >= start || t < end;
      startsAfter = !isActive;
    }
    if (startsAfter && start < nextStartMin) {
      next = slot;
      nextStartMin = start;
    }
  }

  if (!next) {
    for (const slot of schedule) {
      if (slot.state !== 'ON') continue;
      const start = timeToMin(slot.start);
      if (start < nextStartMin) {
        next = slot;
        nextStartMin = start;
      }
    }
  }

  return next;
}

// ── V2.2: Calculate OFF Progress ───────────────────────────────────────────
function calculateOffProgress(offSlot: ScheduleSlot, t: number) {
  const start = timeToMin(offSlot.start);
  const end = timeToMin(offSlot.end);
  const expectedDuration = end > start ? end - start : (1440 - start) + end;
  let elapsed: number;
  if (end > start) {
    elapsed = t >= start && t < end ? t - start : 0;
  } else {
    if (t >= start) elapsed = t - start;
    else if (t < end) elapsed = (1440 - start) + t;
    else elapsed = 0;
  }
  return {
    elapsed,
    expectedDuration,
    progress: expectedDuration > 0 ? (elapsed / expectedDuration) * 100 : 0,
    isLessThan50: (elapsed / expectedDuration) * 100 < 50,
    isGreaterThan50: (elapsed / expectedDuration) * 100 >= 50,
  };
}

// ── V2.2: Calculate Reporter Offset (Period 1 / Period 2 / Period 3) ───────
interface ReporterOffsetResult {
  offsetState: OffsetState;
  offsetValue: OffsetValue;
  timelineAlignment: string;
  referenceKind: 'previous_on' | 'next_on' | 'current_on';
  referenceSlot: ScheduleSlot | null;
  generatedOnDurationMin: number;
  generatedOnReferenceKind: 'completed' | 'active';
  period: string;
  ruleReason: string;
}

function calculateReporterOffset(
  schedule: ScheduleSlot[],
  transitionTimeMin: number,
): ReporterOffsetResult | { error: string } {
  const offSlot = findCurrentOffSlot(schedule, transitionTimeMin);
  const onSlot = findCurrentOnSlot(schedule, transitionTimeMin);

  if (onSlot && !offSlot) {
    const onStart = timeToMin(onSlot.start);
    const onEnd = timeToMin(onSlot.end);
    const onDuration = onSlot.durationMin;

    if (transitionTimeMin === onStart) {
      return {
        offsetState: 'NEUTRAL',
        offsetValue: 0,
        timelineAlignment: minToTime(onStart),
        referenceKind: 'current_on',
        referenceSlot: onSlot,
        generatedOnDurationMin: onDuration,
        generatedOnReferenceKind: 'active',
        period: 'Period 3 (exact ON start)',
        ruleReason: `Period 3 — exact instant Growatt ON begins at ${minToTime(onStart)}. Offset = 0 → NEUTRAL.`,
      };
    }

    const offsetMin = transitionTimeMin - onStart;
    const offsetState: OffsetState = offsetMin > 0 ? 'POSITIVE' : offsetMin < 0 ? 'NEGATIVE' : 'NEUTRAL';

    return {
      offsetState,
      offsetValue: offsetMin,
      timelineAlignment: minToTime(onStart),
      referenceKind: 'current_on',
      referenceSlot: onSlot,
      generatedOnDurationMin: onDuration,
      generatedOnReferenceKind: 'active',
      period: 'Period 1 (during Growatt ON)',
      ruleReason: `Period 1 — report during Growatt ON (${minToTime(onStart)}→${minToTime(onEnd)}). Offset = ${offsetMin > 0 ? '+' : ''}${offsetMin} min → ${offsetState}.`,
    };
  }

  if (!offSlot) {
    return { error: 'No active Growatt state (ON or OFF) found at submission time.' };
  }

  const offProg = calculateOffProgress(offSlot, transitionTimeMin);

  if (offProg.isLessThan50) {
    const prevOn = findPreviousGrowattOn(schedule, transitionTimeMin);
    if (!prevOn) {
      return { error: 'No previous Growatt ON found for Period 1 reference.' };
    }
    const prevOnStart = timeToMin(prevOn.start);
    const offsetMin = transitionTimeMin - prevOnStart;

    return {
      offsetState: 'POSITIVE',
      offsetValue: offsetMin,
      timelineAlignment: minToTime(prevOnStart),
      referenceKind: 'previous_on',
      referenceSlot: prevOn,
      generatedOnDurationMin: prevOn.durationMin,
      generatedOnReferenceKind: 'completed',
      period: 'Period 1 (<50% of OFF)',
      ruleReason: `Period 1 (<50% of OFF consumed, progress=${Math.round(offProg.progress)}%). Offset = +${offsetMin} min → POSITIVE.`,
    };
  } else {
    const nextOn = findNextGrowattOn(schedule, transitionTimeMin);
    if (!nextOn) {
      return { error: 'No next Growatt ON found for Period 2 reference.' };
    }

    return {
      offsetState: 'PENDING_NEGATIVE',
      offsetValue: 'PENDING',
      timelineAlignment: minToTime(transitionTimeMin),
      referenceKind: 'next_on',
      referenceSlot: nextOn,
      generatedOnDurationMin: nextOn.durationMin,
      generatedOnReferenceKind: 'active',
      period: 'Period 2 (>50% of OFF)',
      ruleReason: `Period 2 (>50% of OFF consumed, progress=${Math.round(offProg.progress)}%). PENDING_NEGATIVE — waiting for Growatt ON to resolve.`,
    };
  }
}

export function useUtilityReports() {
  const { user } = useAuth();
  const [myReports, setMyReports] = useState<UtilityReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const submitReport = useCallback(async (
    reportedState: ReportedState,
    timeOption: TimeOption,
  ): Promise<{
    reportId: number | null;
    selfResync: ResyncPoint | null;
    error: string | null;
  }> => {
    if (!user) return { reportId: null, selfResync: null, error: 'Not authenticated' };

    if (reportedState !== 'UTILITY_ON') {
      return {
        reportId: null,
        selfResync: null,
        error: 'TMMS V2.2: OFF reporting is not supported. Only ON reports are accepted.',
      };
    }

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
    const estimatedTransitionAt = new Date(nowMs - offsetMin * 60 * 1000).toISOString();

    let schedule: ScheduleSlot[] = [];
    try {
      const { data: predData } = await supabase
        .from('predictions')
        .select('day_schedule, schedule')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (predData) {
        const rawSchedule = predData.day_schedule || predData.schedule;
        if (Array.isArray(rawSchedule)) {
          schedule = rawSchedule.map((s: any) => ({
            state: s.state,
            start: s.start || s.startFormatted || s.start_time || '',
            end: s.end || s.endFormatted || s.end_time || '',
            durationMin: s.durationMin || s.duration_min || 0,
          }));
        }
      }
    } catch (e) {
      console.warn('[useUtilityReports] Failed to fetch schedule for offset calculation:', e);
    }

    const transitionDate = new Date(estimatedTransitionAt);
    const transitionTimeMin = transitionDate.getHours() * 60 + transitionDate.getMinutes();

    let v22Offset: ReporterOffsetResult | { error: string } | null = null;
    if (schedule.length > 0) {
      v22Offset = calculateReporterOffset(schedule, transitionTimeMin);
      if ('error' in v22Offset) {
        console.warn('[useUtilityReports] Offset calculation error:', v22Offset.error);
        v22Offset = null;
      }
    }

    const offsetState: OffsetState = v22Offset && !('error' in v22Offset) ? v22Offset.offsetState : 'NEUTRAL';
    const offsetValue: OffsetValue = v22Offset && !('error' in v22Offset) ? v22Offset.offsetValue : 0;
    const timelineAlignment: string = v22Offset && !('error' in v22Offset)
      ? v22Offset.timelineAlignment
      : estimatedTransitionAt;
    const generatedOnDurationMin: number | null = v22Offset && !('error' in v22Offset)
      ? v22Offset.generatedOnDurationMin
      : null;
    const generatedOnReferenceIso: string | null = v22Offset && !('error' in v22Offset) && v22Offset.referenceSlot
      ? v22Offset.referenceSlot.start
      : null;
    const generatedOnReferenceKind: 'completed' | 'active' | null = v22Offset && !('error' in v22Offset)
      ? v22Offset.generatedOnReferenceKind
      : null;

    const { data, error } = await supabase
      .from('utility_reports')
      .insert({
        reporter_id: user.id,
        reported_state: reportedState,
        time_option: timeOption,
        estimated_transition_at: estimatedTransitionAt,
        is_active: true,
        reporter_offset_state: offsetState,
        reporter_offset_value: offsetValue,
        reporter_timeline_alignment: timelineAlignment,
        generated_on_start_iso: estimatedTransitionAt,
        generated_on_duration_min: generatedOnDurationMin,
        generated_on_reference_iso: generatedOnReferenceIso,
        generated_on_reference_kind: generatedOnReferenceKind ?? 'completed',
      })
      .select('id')
      .single();

    if (error) {
      setSubmitting(false);
      if (error.message.includes('reporter_offset_state') || error.message.includes('generated_on')) {
        console.warn('[useUtilityReports] V2.2 columns not found — retrying without them.');
        const { data: retryData, error: retryError } = await supabase
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

        if (retryError) {
          setSubmitting(false);
          return { reportId: null, selfResync: null, error: retryError.message };
        }
        const retryReportId = retryData?.id ?? null;
        return finishSubmission(retryReportId, estimatedTransitionAt, nowMs, offsetState, offsetValue, timelineAlignment, generatedOnDurationMin, generatedOnReferenceIso, generatedOnReferenceKind, reportedState);
      }
      return { reportId: null, selfResync: null, error: error.message };
    }

    const reportId = data?.id ?? null;
    return finishSubmission(reportId, estimatedTransitionAt, nowMs, offsetState, offsetValue, timelineAlignment, generatedOnDurationMin, generatedOnReferenceIso, generatedOnReferenceKind, reportedState);

    async function finishSubmission(
      reportId: number | null,
      estimatedTransitionAt: string,
      nowMs: number,
      offsetState: OffsetState,
      offsetValue: OffsetValue,
      timelineAlignment: string,
      generatedOnDurationMin: number | null,
      generatedOnReferenceIso: string | null,
      generatedOnReferenceKind: 'completed' | 'active' | null,
      reportedState: ReportedState,
    ): Promise<{ reportId: number | null; selfResync: ResyncPoint | null; error: string | null }> {
      try { await AsyncStorage.setItem(LAST_REPORT_KEY, String(nowMs)); } catch (_) {}
      setCooldownRemainingMs(COOLDOWN_MS);

      let selfReporterName: string | null = null;
      let selfReporterReliability: number | null = null;
      try {
        const [{ data: profData }, { data: relData }] = await Promise.all([
          supabase.from('user_profiles').select('username').eq('id', user!.id).maybeSingle(),
          supabase.from('user_reliability').select('reliability_score').eq('user_id', user!.id).maybeSingle(),
        ]);
        selfReporterName = profData?.username ?? null;
        selfReporterReliability = relData ? Math.round(relData.reliability_score ?? 50) : null;
      } catch (_) {}

      const selfResync: ResyncPoint = {
        syncedState: reportedState === 'UTILITY_ON' ? 'ON' : 'OFF',
        syncedAtIso: estimatedTransitionAt,
        appliedAtIso: new Date(nowMs).toISOString(),
        reporterName: selfReporterName ?? 'أنت',
        reporterReliability: selfReporterReliability,
        offsetState,
        offsetValue,
        timelineAlignment,
        generatedOnStartIso: estimatedTransitionAt,
        generatedOnDurationMin,
        generatedOnReferenceIso,
        generatedOnReferenceKind: generatedOnReferenceKind ?? 'completed',
        confirmationTime: estimatedTransitionAt,
      };

      supabase.from('resync_history').insert({
        user_id: user!.id,
        report_id: reportId,
        reporter_id: user!.id,
        reporter_username: null,
        reported_state: reportedState,
        effective_transition_at: estimatedTransitionAt,
        confirmed_at: new Date(nowMs).toISOString(),
        source: 'self_report',
        offset_state: offsetState,
        offset_value: offsetValue,
        timeline_alignment: timelineAlignment,
        generated_on_start_iso: estimatedTransitionAt,
        generated_on_duration_min: generatedOnDurationMin,
        generated_on_reference_iso: generatedOnReferenceIso,
        generated_on_reference_kind: generatedOnReferenceKind ?? 'completed',
      }).then(({ error: histErr }) => {
        if (histErr) {
          console.warn('[useUtilityReports] history insert error:', histErr.message);
          if (histErr.message.includes('offset_state') || histErr.message.includes('generated_on')) {
            supabase.from('resync_history').insert({
              user_id: user!.id,
              report_id: reportId,
              reporter_id: user!.id,
              reporter_username: null,
              reported_state: reportedState,
              effective_transition_at: estimatedTransitionAt,
              confirmed_at: new Date(nowMs).toISOString(),
              source: 'self_report',
            }).then(({ error: retryHistErr }) => {
              if (retryHistErr) console.warn('[useUtilityReports] history retry error:', retryHistErr.message);
            });
          }
        }
      });

      supabase.functions.invoke('distribute-resync', {
        body: {
          reportId,
          reporterId: user!.id,
          reportedState,
          estimatedTransitionAt,
          timeOption,
          offsetState,
          offsetValue,
        },
      }).catch(e => {
        console.warn('[useUtilityReports] distribute-resync invoke failed (non-fatal):', e);
      });

      await fetchMyReports();
      setSubmitting(false);

      return { reportId, selfResync, error: null };
    }
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
