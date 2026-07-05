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
      // wraps midnight
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
      // Wraps midnight
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

  // First pass: look for ON slots that start after t
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

  // If no ON found after t, wrap around (tomorrow's earliest ON)
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
// Formula: OFF Progress = (Elapsed OFF Time / Expected OFF Duration) x 100
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
//
// This is the CORE V2.2 function implementing the Personal Timeline
// Replacement Model period rules.
//
// Period 1 = During Growatt ON (after start) + first half of following OFF
//   → POSITIVE offset (or NEUTRAL if exactly at ON start = Period 3)
//   → Generated ON replaces the current/previous Growatt ON
//   → Full duration of replaced ON
//
// Period 2 = Second half of OFF (>50%) through before next ON starts
//   → PENDING_NEGATIVE (numeric value unknown until Growatt ON starts)
//   → Generated ON replaces the NEXT upcoming Growatt ON
//   → Full duration of next ON
//
// Period 3 = Exact instant Growatt ON begins
//   → NEUTRAL, offset = 0
//   → Personal Timeline = exact clone of Growatt

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
  // Find what Growatt state the submission falls in
  const offSlot = findCurrentOffSlot(schedule, transitionTimeMin);
  const onSlot = findCurrentOnSlot(schedule, transitionTimeMin);

  // ── Case A: Report during Growatt ON → Period 1 ─────────────────────────
  // V2.2: Period 1 includes the entire Growatt ON duration (after it starts).
  // The Generated ON replaces the current Growatt ON.
  if (onSlot && !offSlot) {
    const onStart = timeToMin(onSlot.start);
    const onEnd = timeToMin(onSlot.end);
    const onDuration = onSlot.durationMin;

    // Check for Period 3: exact instant the Growatt ON state begins
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
        ruleReason: `Period 3 — exact instant Growatt ON begins at ${minToTime(onStart)}. Offset = 0 → NEUTRAL. Personal Timeline = exact clone of Growatt. Generated ON replaces current ON. Duration = ${onDuration} min.`,
      };
    }

    // Period 1: during Growatt ON (after start)
    const offsetMin = transitionTimeMin - onStart;
    // Offset is always positive when T > onStart (during ON)
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
      ruleReason: `Period 1 — report during Growatt ON (${minToTime(onStart)}→${minToTime(onEnd)}). Offset = T - currentOnStart = ${minToTime(transitionTimeMin)} - ${onSlot.start} = ${offsetMin > 0 ? '+' : ''}${offsetMin} min → ${offsetState}. Generated ON replaces current ON. Duration = ${onDuration} min.`,
    };
  }

  // ── Cases B & C: Report during Growatt OFF ──────────────────────────────
  if (!offSlot) {
    return { error: 'No active Growatt state (ON or OFF) found at submission time.' };
  }

  const offProg = calculateOffProgress(offSlot, transitionTimeMin);

  if (offProg.isLessThan50) {
    // ── Period 1: first half of OFF → POSITIVE ───────────────────────────
    // V2.2: Period 1 continues through the first half of the following OFF.
    // The Generated ON replaces the previous Growatt ON.
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
      ruleReason: `Period 1 (<50% of OFF consumed, progress=${Math.round(offProg.progress)}%). Offset = T - prevOnStart = ${minToTime(transitionTimeMin)} - ${prevOn.start} = +${offsetMin} min → POSITIVE. Generated ON replaces prev ON (${prevOn.start}→${prevOn.end}). Duration = ${prevOn.durationMin} min. Following OFF = ${offSlot.start}→${offSlot.end}.`,
    };
  } else {
    // ── Period 2: second half of OFF → PENDING_NEGATIVE ──────────────────
    // V2.2: Period 2 is the second half of OFF. The Generated ON replaces
    // the NEXT upcoming Growatt ON. The exact offset value is initially
    // unknown (PENDING) because the referenced Growatt ON hasn't started yet.
    const nextOn = findNextGrowattOn(schedule, transitionTimeMin);
    if (!nextOn) {
      return { error: 'No next Growatt ON found for Period 2 reference.' };
    }
    const nextOnStart = timeToMin(nextOn.start);

    return {
      offsetState: 'PENDING_NEGATIVE',
      offsetValue: 'PENDING',
      timelineAlignment: minToTime(transitionTimeMin),
      referenceKind: 'next_on',
      referenceSlot: nextOn,
      generatedOnDurationMin: nextOn.durationMin,
      generatedOnReferenceKind: 'active',
      period: 'Period 2 (>50% of OFF)',
      ruleReason: `Period 2 (>50% of OFF consumed, progress=${Math.round(offProg.progress)}%). Generated ON replaces NEXT ON (${nextOn.start}→${nextOn.end}). Duration = ${nextOn.durationMin} min. PENDING_NEGATIVE — waiting for Growatt ON at ${nextOn.start} to resolve offset value. Following OFF = ${nextOn.end}→next. UNCERTAIN_ZONE when predicted OFF ends before Growatt ON.`,
    };
  }
}

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
   * TMMS V2.2:
   *   - Always submits 'UTILITY_ON' (OFF reporting removed)
   *   - Computes Period 1/2/3 offset at submission time per V2.2 rules
   *   - Period 1 → POSITIVE offset, replaces current/previous ON
   *   - Period 2 → PENDING_NEGATIVE, replaces next ON, value resolves later
   *   - Period 3 → NEUTRAL offset = 0
   *   - Stores all V2.2 fields on the utility_reports row
   *   - Returns them in the selfResync ResyncPoint
   *
   * Returns:
   *   reportId   — database ID of the inserted report
   *   selfResync — ResyncPoint with V2.2 fields the reporter should apply
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

    // V2.2: ON-only reporting guard. Reject OFF reports explicitly.
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

    // estimated_transition_at = the absolute timestamp when electricity came on
    const estimatedTransitionAt = new Date(nowMs - offsetMin * 60 * 1000).toISOString();

    // ── V2.2: Fetch the current Growatt schedule to compute Period 1/2/3 ─────
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

    // ── V2.2: Calculate the Period 1/2/3 offset ─────────────────────────────
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

    // V2.2: Extract offset fields (or use defaults if schedule wasn't available)
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

    // ── Insert the report with V2.2 fields ───────────────────────────────────
    const { data, error } = await supabase
      .from('utility_reports')
      .insert({
        reporter_id: user.id,
        reported_state: reportedState,
        time_option: timeOption,
        estimated_transition_at: estimatedTransitionAt,
        is_active: true,
        // V2.2 fields:
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
      // V2.2: If the error is about missing columns, retry without V2.2 fields
      if (error.message.includes('reporter_offset_state') || error.message.includes('generated_on')) {
        console.warn('[useUtilityReports] V2.2 columns not found — retrying without them. Please run the DB migration.');
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

    // ── Helper: finish the submission ───────────────────────────────────────
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
      // Save submission time & start cooldown
      try { await AsyncStorage.setItem(LAST_REPORT_KEY, String(nowMs)); } catch (_) {}
      setCooldownRemainingMs(COOLDOWN_MS);

      // Fetch reporter name and reliability
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

      // V2.2: Build the self-resync point with all V2.2 fields
      const selfResync: ResyncPoint = {
        syncedState: reportedState === 'UTILITY_ON' ? 'ON' : 'OFF',
        syncedAtIso: estimatedTransitionAt,
        appliedAtIso: new Date(nowMs).toISOString(),
        reporterName: selfReporterName ?? 'أنت',
        reporterReliability: selfReporterReliability,
        // V2.2 additions:
        offsetState,
        offsetValue,
        timelineAlignment,
        generatedOnStartIso: estimatedTransitionAt,
        generatedOnDurationMin,
        generatedOnReferenceIso,
        generatedOnReferenceKind: generatedOnReferenceKind ?? 'completed',
        confirmationTime: estimatedTransitionAt,
      };

      // Persist to resync_history with V2.2 fields
      supabase.from('resync_history').insert({
        user_id: user!.id,
        report_id: reportId,
        reporter_id: user!.id,
        reporter_username: null,
        reported_state: reportedState,
        effective_transition_at: estimatedTransitionAt,
        confirmed_at: new Date(nowMs).toISOString(),
        source: 'self_report',
        // V2.2 fields:
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

      // Distribute push notifications to followers (non-blocking)
      supabase.functions.invoke('distribute-resync', {
        body: {
          reportId,
          reporterId: user!.id,
          reportedState,
          estimatedTransitionAt,
          timeOption,
          // V2.2: include offset info so followers can see what they'll clone
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
