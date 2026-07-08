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

export type TimeOption =
  | 'now' | '5min' | '10min' | '15min' | '20min'
  | '30min' | '1h' | '1.5h' | '2h' | '2.5h' | '3h'
  | '3.5h' | '4h' | '4.5h' | '5h' | '5.5h' | '6h';
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
  '30min': 30,
  '1h': 60,
  '1.5h': 90,
  '2h': 120,
  '2.5h': 150,
  '3h': 180,
  '3.5h': 210,
  '4h': 240,
  '4.5h': 270,
  '5h': 300,
  '5.5h': 330,
  '6h': 360,
};

const COOLDOWN_MS = 0; // V2.3 (Issue 3): cooldown removed — users can submit reports back-to-back.
//                  The previous 30-minute cooldown was a UX throttle, not a
//                  correctness safeguard. Removing it eliminates the "allow
//                  period after every new submitted report" the user
//                  complained about in Issue 3. The database RLS policy
//                  (see supabase/migrations/20260708000000_drop_report_cooldown.sql)
//                  has been updated to match — no 20-minute throttle either.
const LAST_REPORT_KEY = 'utility_report_last_submitted_at';

// ── V2.3 (Issue 1C): Schedule slot interface ──────────────────────────────
// V2.3: the schedule helpers now use ABSOLUTE MILLISECOND timestamps
// instead of minutes-of-day. The previous minutes-of-day approach broke
// across midnight (e.g. an ON slot that started at 22:00 yesterday and a
// report submitted at 11:15 today produced offset = 675 − 1320 = −645
// minutes instead of +795 minutes), and it also confused "previous ON"
// vs "next ON" lookups when slots wrapped midnight. Absolute ms makes the
// math unambiguous and matches the engine's ISO-based math exactly.
interface ScheduleSlot {
  state: 'ON' | 'OFF';
  start: string;  // ISO timestamp or 'HH:MM'
  end: string;
  durationMin: number;
}

// ── V2.3: Time helpers (absolute ms based) ──────────────────────────────────
// Convert any slot start/end value to an absolute epoch-ms timestamp.
// - ISO strings (the modern format from utility_predictions) parse directly.
// - 'HH:MM' strings (legacy) are interpreted as TODAY at that time; if the
//   resulting timestamp is more than 12h in the future, we roll it back a
//   day so a slot that ends e.g. at 02:00 is correctly placed in the past.
function toMs(value: string | number, nowMs: number = Date.now()): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  if (value.includes('T')) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  // 'HH:MM' legacy format
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const today = new Date(nowMs);
  today.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  let ms = today.getTime();
  // If the slot time is > 12h in the future, assume it actually belongs to yesterday
  if (ms - nowMs > 12 * 3600_000) ms -= 24 * 3600_000;
  return ms;
}

// Backwards-compat: keep timeToMin for any code that still uses it, but it
// now delegates to toMs and returns minutes-since-epoch (number, can be huge).
// Callers that compare two values returned by timeToMin still get correct
// ordering because both are on the same absolute scale.
function timeToMin(hhmm: string): number {
  const ms = toMs(hhmm);
  if (ms === null) return NaN;
  return ms / 60_000;
}

function minToTime(min: number): string {
  // V2.3: `min` is now absolute minutes since epoch — convert to ISO and
  // format as HH:MM in Asia/Aden for display.
  try {
    const d = new Date(min * 60_000);
    return d.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Aden', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    const m = ((min % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
}

// ── V2.3: Find the current Growatt OFF slot (absolute ms) ────────────────
function findCurrentOffSlot(schedule: ScheduleSlot[], tMs: number): ScheduleSlot | null {
  for (const slot of schedule) {
    if (slot.state !== 'OFF') continue;
    const start = toMs(slot.start, tMs);
    const end = toMs(slot.end, tMs);
    if (start === null || end === null) continue;
    if (tMs >= start && tMs < end) return slot;
  }
  return null;
}

// ── V2.3: Find the current Growatt ON slot (absolute ms) ───────────────────
function findCurrentOnSlot(schedule: ScheduleSlot[], tMs: number): ScheduleSlot | null {
  for (const slot of schedule) {
    if (slot.state !== 'ON') continue;
    const start = toMs(slot.start, tMs);
    const end = toMs(slot.end, tMs);
    if (start === null || end === null) continue;
    if (tMs >= start && tMs < end) return slot;
  }
  return null;
}

// ── V2.3: Find the previous Growatt ON (most recently ended) (absolute ms) ──
// V2.3 fix: the previous minutes-of-day version picked the wrong slot when
// ON slots crossed midnight (e.g. yesterday's 22:00-23:00 ON would beat
// today's 06:00-07:00 ON because 1380 > 420). Using absolute ms makes the
// "most recently ended" comparison unambiguous.
function findPreviousGrowattOn(schedule: ScheduleSlot[], tMs: number): ScheduleSlot | null {
  let prev: ScheduleSlot | null = null;
  let prevEndMs = -Infinity;
  for (const slot of schedule) {
    if (slot.state !== 'ON') continue;
    const start = toMs(slot.start, tMs);
    const end = toMs(slot.end, tMs);
    if (start === null || end === null) continue;
    // Has ended before tMs
    if (end <= tMs && end > prevEndMs) {
      prev = slot;
      prevEndMs = end;
    }
  }
  return prev;
}

// ── V2.3: Find the next Growatt ON (upcoming) (absolute ms) ──────────────────
function findNextGrowattOn(schedule: ScheduleSlot[], tMs: number): ScheduleSlot | null {
  let next: ScheduleSlot | null = null;
  let nextStartMs = Infinity;
  for (const slot of schedule) {
    if (slot.state !== 'ON') continue;
    const start = toMs(slot.start, tMs);
    const end = toMs(slot.end, tMs);
    if (start === null || end === null) continue;
    // Not currently active and starts after tMs
    const isActive = tMs >= start && tMs < end;
    if (!isActive && start > tMs && start < nextStartMs) {
      next = slot;
      nextStartMs = start;
    }
  }
  // If no future ON found, pick the earliest ON slot in the schedule
  // (will be yesterday's ON in absolute ms terms — caller should handle).
  if (!next) {
    for (const slot of schedule) {
      if (slot.state !== 'ON') continue;
      const start = toMs(slot.start, tMs);
      if (start === null) continue;
      if (start < nextStartMs) {
        next = slot;
        nextStartMs = start;
      }
    }
  }
  return next;
}

// ── V2.3: Calculate OFF Progress (absolute ms) ──────────────────────────────
// Formula: OFF Progress = (Elapsed OFF Time / Expected OFF Duration) x 100
function calculateOffProgress(offSlot: ScheduleSlot, tMs: number) {
  const start = toMs(offSlot.start, tMs);
  const end = toMs(offSlot.end, tMs);
  if (start === null || end === null) {
    return { elapsed: 0, expectedDuration: 0, progress: 0, isLessThan50: true, isGreaterThan50: false };
  }
  const expectedDuration = Math.max(1, (end - start) / 60_000);
  const elapsed = Math.max(0, Math.min(expectedDuration, (tMs - start) / 60_000));
  const progress = (elapsed / expectedDuration) * 100;
  return {
    elapsed,
    expectedDuration,
    progress,
    isLessThan50: progress < 50,
    isGreaterThan50: progress >= 50,
  };
}

// ── V2.3 (Issue 1C): Calculate Reporter Offset ───────────────────────────────
//
// V2.3 changes:
//   - The function now takes an ABSOLUTE MS timestamp instead of
//     minutes-of-day. This fixes Issue 1C: the previous minutes-of-day
//     math produced wrong offset signs whenever a Growatt ON slot
//     wrapped midnight.
//   - For Period 1 (<50% OFF), the offset is calculated from the START
//     time of the previous Growatt ON slot (which is the Growatt ON
//     STATE START TIME — exactly what the user requested in Issue 1C).
//     Previously, the math happened to compute the same value when the
//     ON slot didn't cross midnight, but produced nonsense otherwise.
//   - `timelineAlignment` is now returned as an ISO timestamp string
//     (the START of the reference Growatt ON). The engine and Home
//     Screen already accept ISO strings for this field, so no downstream
//     changes are needed.
//
// Period 1 = During Growatt ON (after start) + first half of following OFF
//   → POSITIVE offset (or NEUTRAL if exactly at ON start = Period 3)
//   → Generated ON replaces the current/previous Growatt ON
//   → Full duration of replaced ON
//   → Offset Value = GeneratedONstart - ReplacedONstart   (Issue 1C)
//
// Period 2 = Second half of OFF (>50%) through before next ON starts
//   → PENDING_NEGATIVE (numeric value unknown until Growatt ON starts)
//   → Generated ON replaces the NEXT upcoming Growatt ON
//   → Full duration of next ON
//   → Offset auto-resolves to NEGATIVE when Growatt ON begins:
//     offsetValue = GeneratedONstart - ActualGrowattONstart
//
// Period 3 = Exact instant Growatt ON begins
//   → NEUTRAL, offset = 0
//   → Personal Timeline = exact clone of Growatt

interface ReporterOffsetResult {
  offsetState: OffsetState;
  offsetValue: OffsetValue;
  timelineAlignment: string;          // ISO timestamp of the reference ON start
  referenceKind: 'previous_on' | 'next_on' | 'current_on';
  referenceSlot: ScheduleSlot | null;
  generatedOnDurationMin: number;
  generatedOnReferenceKind: 'completed' | 'active';
  period: string;
  ruleReason: string;
}

function calculateReporterOffset(
  schedule: ScheduleSlot[],
  transitionMs: number,
): ReporterOffsetResult | { error: string } {
  // Find what Growatt state the submission falls in
  const offSlot = findCurrentOffSlot(schedule, transitionMs);
  const onSlot = findCurrentOnSlot(schedule, transitionMs);

  // ── Case A: Report during Growatt ON → Period 1 (or Period 3) ────────────
  if (onSlot && !offSlot) {
    const onStartMs = toMs(onSlot.start, transitionMs)!;
    const onEndMs = toMs(onSlot.end, transitionMs)!;
    const onDuration = onSlot.durationMin || Math.round((onEndMs - onStartMs) / 60_000);
    const onStartIso = new Date(onStartMs).toISOString();

    // Period 3: exact instant the Growatt ON state begins (within 1 minute tolerance)
    if (Math.abs(transitionMs - onStartMs) < 60_000) {
      return {
        offsetState: 'NEUTRAL',
        offsetValue: 0,
        timelineAlignment: onStartIso,
        referenceKind: 'current_on',
        referenceSlot: onSlot,
        generatedOnDurationMin: onDuration,
        generatedOnReferenceKind: 'active',
        period: 'Period 3 (exact ON start)',
        ruleReason: `Period 3 — exact instant Growatt ON begins at ${onStartIso}. Offset = 0 → NEUTRAL. Personal Timeline = exact clone of Growatt. Generated ON replaces current ON. Duration = ${onDuration} min.`,
      };
    }

    // Period 1: during Growatt ON (after start).
    // V2.3 (Issue 1C): offset is computed from the Growatt ON START TIME,
    // i.e. `transitionMs - onStartMs`. This is always positive when the
    // report happens during an active ON slot (T > onStart).
    const offsetMin = Math.round((transitionMs - onStartMs) / 60_000);
    const offsetState: OffsetState = offsetMin > 0 ? 'POSITIVE' : offsetMin < 0 ? 'NEGATIVE' : 'NEUTRAL';

    return {
      offsetState,
      offsetValue: offsetMin,
      timelineAlignment: onStartIso,
      referenceKind: 'current_on',
      referenceSlot: onSlot,
      generatedOnDurationMin: onDuration,
      generatedOnReferenceKind: 'active',
      period: 'Period 1 (during Growatt ON)',
      ruleReason: `Period 1 — report during Growatt ON (${onStartIso} → ${new Date(onEndMs).toISOString()}). Offset = T - currentOnStart = ${offsetMin > 0 ? '+' : ''}${offsetMin} min → ${offsetState}. Generated ON replaces current ON. Duration = ${onDuration} min.`,
    };
  }

  // ── Cases B & C: Report during Growatt OFF ──────────────────────────────
  if (!offSlot) {
    return { error: 'No active Growatt state (ON or OFF) found at submission time.' };
  }

  const offProg = calculateOffProgress(offSlot, transitionMs);

  if (offProg.isLessThan50) {
    // ── Period 1: first half of OFF → POSITIVE ───────────────────────────
    // V2.3 (Issue 1C): the offset is calculated FROM THE GROWATT ON STATE
    // START TIME (the START of the previous Growatt ON, not its END).
    // The user explicitly requested this in Issue 1C: "OFFSET VALUE
    // CALCULATED FROM THE GROWATT ON STATE START TIME NOT FROM END GROWATT
    // ON STATE DURATION".
    const prevOn = findPreviousGrowattOn(schedule, transitionMs);
    if (!prevOn) {
      return { error: 'No previous Growatt ON found for Period 1 reference.' };
    }
    const prevOnStartMs = toMs(prevOn.start, transitionMs)!;
    const prevOnEndMs = toMs(prevOn.end, transitionMs)!;
    const prevOnStartIso = new Date(prevOnStartMs).toISOString();
    const prevOnDuration = prevOn.durationMin || Math.round((prevOnEndMs - prevOnStartMs) / 60_000);

    // Offset = T - prevOnStart  (always positive: T is during the OFF that follows)
    const offsetMin = Math.round((transitionMs - prevOnStartMs) / 60_000);

    return {
      offsetState: 'POSITIVE',
      offsetValue: offsetMin,
      timelineAlignment: prevOnStartIso,
      referenceKind: 'previous_on',
      referenceSlot: prevOn,
      generatedOnDurationMin: prevOnDuration,
      generatedOnReferenceKind: 'completed',
      period: 'Period 1 (<50% of OFF)',
      ruleReason: `Period 1 (<50% of OFF consumed, progress=${Math.round(offProg.progress)}%). Offset = T - prevOnStart = ${offsetMin > 0 ? '+' : ''}${offsetMin} min → POSITIVE. Generated ON replaces prev ON (${prevOnStartIso} → ${new Date(prevOnEndMs).toISOString()}). Duration = ${prevOnDuration} min.`,
    };
  } else {
    // ── Period 2: second half of OFF → PENDING_NEGATIVE ──────────────────
    // The Generated ON replaces the NEXT upcoming Growatt ON. The exact
    // offset value is initially unknown (PENDING) because the referenced
    // Growatt ON hasn't started yet.
    //
    // V2.3 (Issue 1A, part 2): if Growatt is ALREADY ON at submission
    // time (e.g. the schedule was stale, or the user submitted just after
    // Growatt flipped), we resolve the pending value IMMEDIATELY using
    // the most recent UTILITY_ON power_event — see resolvePendingOffsetNow
    // in submitReport below.
    const nextOn = findNextGrowattOn(schedule, transitionMs);
    if (!nextOn) {
      return { error: 'No next Growatt ON found for Period 2 reference.' };
    }
    const nextOnStartMs = toMs(nextOn.start, transitionMs)!;
    const nextOnEndMs = toMs(nextOn.end, transitionMs)!;
    const nextOnStartIso = new Date(nextOnStartMs).toISOString();
    const nextOnDuration = nextOn.durationMin || Math.round((nextOnEndMs - nextOnStartMs) / 60_000);

    return {
      offsetState: 'PENDING_NEGATIVE',
      offsetValue: 'PENDING',
      timelineAlignment: new Date(transitionMs).toISOString(),
      referenceKind: 'next_on',
      referenceSlot: nextOn,
      generatedOnDurationMin: nextOnDuration,
      generatedOnReferenceKind: 'active',
      period: 'Period 2 (>50% of OFF)',
      ruleReason: `Period 2 (>50% of OFF consumed, progress=${Math.round(offProg.progress)}%). Generated ON replaces NEXT ON (${nextOnStartIso} → ${new Date(nextOnEndMs).toISOString()}). Duration = ${nextOnDuration} min. PENDING_NEGATIVE — will resolve immediately if Growatt is already ON, otherwise waits for Growatt ON.`,
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
      // V2.3 (Issue 3): cooldown is now always 0 — this branch is kept for
      // backwards compatibility with any in-flight state from before the
      // upgrade, but it should never fire under V2.3.
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
      // FIX (#3): the schedule lives in `utility_predictions` (row id=1,
      // JSON column `prediction.daySchedule`). The previous query targeted
      // a non-existent `predictions` table, so the schedule was ALWAYS
      // empty — Period 1/2/3 offsets silently defaulted to NEUTRAL and
      // generated_on_duration_min was stored as NULL, which made the
      // Generated ON cycle hold forever (no automatic ON→OFF).
      const { data: predData } = await supabase
        .from('utility_predictions')
        .select('prediction')
        .eq('id', 1)
        .maybeSingle();

      const rawSchedule = (predData?.prediction as any)?.daySchedule;
      if (Array.isArray(rawSchedule)) {
        schedule = rawSchedule.map((s: any) => {
          const startIso = s.startIso ?? s.start ?? s.start_time ?? '';
          const endIso = s.endIso ?? s.end ?? s.end_time ?? '';
          let durationMin = s.durationMin || s.duration_min || 0;
          if (!durationMin && startIso && endIso) {
            const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
            if (Number.isFinite(ms) && ms > 0) durationMin = Math.round(ms / 60_000);
          }
          return { state: s.state, start: startIso, end: endIso, durationMin };
        });
      }
    } catch (e) {
      console.warn('[useUtilityReports] Failed to fetch schedule for offset calculation:', e);
    }

    // ── V2.3 (Issue 1C): Calculate the Period 1/2/3 offset using ABSOLUTE MS ──
    // The previous minutes-of-day math was buggy across midnight and produced
    // wrong offset signs. Now we pass the absolute epoch-ms timestamp.
    const transitionMs = new Date(estimatedTransitionAt).getTime();

    let v22Offset: ReporterOffsetResult | { error: string } | null = null;
    if (schedule.length > 0) {
      v22Offset = calculateReporterOffset(schedule, transitionMs);
      if ('error' in v22Offset) {
        console.warn('[useUtilityReports] Offset calculation error:', v22Offset.error);
        v22Offset = null;
      }
    }

    // V2.2: Extract offset fields (or use defaults if schedule wasn't available)
    let offsetState: OffsetState = v22Offset && !('error' in v22Offset) ? v22Offset.offsetState : 'NEUTRAL';
    let offsetValue: OffsetValue = v22Offset && !('error' in v22Offset) ? v22Offset.offsetValue : 0;
    let timelineAlignment: string = v22Offset && !('error' in v22Offset)
      ? v22Offset.timelineAlignment
      : estimatedTransitionAt;
    const generatedOnDurationMin: number | null = v22Offset && !('error' in v22Offset)
      ? v22Offset.generatedOnDurationMin
      : null;
    let generatedOnReferenceIso: string | null = v22Offset && !('error' in v22Offset) && v22Offset.referenceSlot
      ? v22Offset.referenceSlot.start
      : null;
    const generatedOnReferenceKind: 'completed' | 'active' | null = v22Offset && !('error' in v22Offset)
      ? v22Offset.generatedOnReferenceKind
      : null;

    // ── V2.3 (Issue 1A, part 2): Resolve PENDING_NEGATIVE immediately ────────
    // If the report was classified as PENDING_NEGATIVE (Period 2), the
    // numeric offset value is normally resolved later when a NEW
    // UTILITY_ON power_event arrives. But if Growatt is ALREADY ON at
    // submission time — e.g. because the schedule was stale, or the user
    // submitted just after Growatt flipped — no new event will arrive, and
    // the offset would stay PENDING forever (the bug the user reported).
    //
    // Fix: query `inverter_state` for the current Growatt state. If it's ON,
    // query the most recent UTILITY_ON power_event and compute the offset
    // as `transitionMs - growattOnMs`. This makes the offset resolve
    // immediately, matching the user's expectation that "when a user
    // reports changing state while the Growatt state is ON the logic can
    // detect it".
    if (offsetState === 'PENDING_NEGATIVE') {
      try {
        const { data: invRow } = await supabase
          .from('inverter_state')
          .select('utility_on, last_polled')
          .eq('id', 1)
          .maybeSingle();
        if (invRow?.utility_on === true) {
          // Growatt is ON — find the most recent UTILITY_ON event timestamp
          const { data: onEvent } = await supabase
            .from('power_events')
            .select('occurred_at')
            .eq('event_type', 'UTILITY_ON')
            .order('occurred_at', { ascending: false })
            .limit(1);
          const growattOnIso = onEvent?.[0]?.occurred_at;
          if (growattOnIso) {
            const growattOnMs = new Date(growattOnIso).getTime();
            if (Number.isFinite(growattOnMs)) {
              const resolvedOffsetMin = Math.round((transitionMs - growattOnMs) / 60_000);
              offsetState = 'NEGATIVE';
              offsetValue = resolvedOffsetMin;
              timelineAlignment = growattOnIso;
              generatedOnReferenceIso = growattOnIso;
              console.info(
                '[useUtilityReports] PENDING_NEGATIVE resolved immediately: ' +
                `T=${estimatedTransitionAt}, GrowattON=${growattOnIso}, ` +
                `offset=${resolvedOffsetMin} min`,
              );
            }
          }
        }
      } catch (e) {
        // Non-fatal — the PENDING_NEGATIVE state will be resolved later by
        // the useGrowattOnWatcher in useResyncNotifications when the next
        // UTILITY_ON event arrives.
        console.warn('[useUtilityReports] Failed to check current Growatt state for immediate resolution:', e);
      }
    }

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
