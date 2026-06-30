/**
 * tmmsEngine.ts — TMMS V2.1 Final Engine
 *
 * The single source of truth for all transition logic, offset calculation,
 * schedule manipulation, and ATC state derivation.
 *
 * Shared between:
 *   - hooks/useUserPredictions.ts (production hook)
 *   - The TMMS V2.1 Debug Simulator (vanilla JS port)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TMMS V2.1 FINAL RULES (Period 1 / Period 2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Period 1 = first half of OFF (<50% consumed) → POSITIVE offset
 *   - Generated ON replaces the Growatt ON located IN this period (prev ON)
 *   - Generated ON duration = that Growatt ON's duration
 *   - Offset value = T − prevOnStart (positive)
 *   - Offset is ADDED (push) to start/end of EACH state (ON and OFF)
 *   - Verification Window: true
 *
 * Period 2 = second half of OFF (>50% consumed) → NEGATIVE offset
 *   - Generated ON replaces the Growatt ON located JUST AFTER this period (next ON)
 *   - Generated ON duration = that Growatt ON's duration
 *   - Offset value = T − nextOnStart (negative)
 *   - Offset is DECLINED (pull) from start/end of EACH state (ON and OFF)
 *   - UNCERTAIN_ZONE: true
 *
 * The offset state AND value are computed ONCE at report time and are FINAL.
 * No recomputation, no flipping, no pending state.
 *
 * Reports can be submitted at ANY time — during Growatt OFF (Period 1/Period 2)
 * OR during Growatt ON (confirming/extending the current ON).
 *
 * The Generated ON slot itself is NOT shifted — it keeps its actual report time.
 * ALL other slots (ON and OFF) are shifted by the offset value.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FILE LOCATION: app/(admin)/tmmsEngine.ts
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── TYPE EXPORTS ───────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'COMMUNITY_SYNCED'
  | 'UNCERTAIN_ZONE'
  | 'WAITING_FOR_GROWATT'
  | 'PREDICTION_RANGE'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export type TransitionMode = 'AUTO' | 'MANUAL';

export interface ResyncPoint {
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
  reporterName?: string | null;
  reporterReliability?: number | null;
  // V2.1 additions (optional — set by useUtilityReports / useResyncNotifications)
  offsetState?: string;
  offsetValue?: number | string;
  timelineAlignment?: string;
  generatedOnStartIso?: string;
  generatedOnDurationMin?: number | null;
  generatedOnReferenceIso?: string | null;
  generatedOnReferenceKind?: string | null;
  confirmationTime?: string;
}

export interface CommunitySyncMeta {
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
  reporterName: string | null;
  reporterReliability: number | null;
}

export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
  isResynced?: boolean;
}

export interface AccuracyLogEvent {
  predictedTransitionIso: string;
  actualTransitionIso: string;
  targetState: 'UTILITY_ON' | 'UTILITY_OFF';
  offsetMinutes: number;
  exitMode: string;
  errorMinutes: number;
  accuracyScore: number;
}

export interface NextTransition {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  rangeStartIso: string;
  rangeEndIso: string;
  rangeLabel: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  waitLabel: string;
  inRangeWindow: boolean;
}

export interface ATCState {
  mode: ScheduleStateMode;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  overrunMinutes: number;
  transitionMode: TransitionMode;
  communityElevated: boolean;
  statusLine: string;
  scheduledAutoTransitionIso: string | null;
}

export interface UserPrediction {
  daySchedule: ShiftedScheduleSlot[];
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  nextTransition: NextTransition | null;
  isHoldingState: boolean;
  isResynced: boolean;
  resyncedAtIso: string | null;
  computedAt: string;
  confidence: number;
  stabilityScore: number;
  stabilityLabel: string;
  learningMode: string;
  isUnstable: boolean;
  communitySyncMeta: CommunitySyncMeta | null;
  offsetMinutes: number;
  crisisMode: boolean | null;
  crisisReason: string | null;
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;
  atc: ATCState;
  reasoning: string[];
  // V2.1 fields (optional — set by useUserPredictions V2.1 layer)
  offsetState?: string;
  offsetValue?: number | string;
  timelineAlignment?: string;
  generatedOnInfo?: any;
  pendingNegativeResolutionIso?: string | null;
  isPendingNegative?: boolean;
  isGeneratedOnCurrent?: boolean;
}

// ─── TIME HELPERS ───────────────────────────────────────────────────────────

function fmtYemenTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'Asia/Aden',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).replace('AM', ' ص').replace('PM', ' م');
  } catch {
    return iso;
  }
}

function fmtDurationLabel(min: number): string {
  if (min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h}س`;
  return `${h}س ${m}د`;
}

function arabicDurationRange(min: number): string {
  if (min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h}س ${m}د`;
}

// ─── SCHEDULE HELPERS ───────────────────────────────────────────────────────

interface RawSlot {
  state: 'ON' | 'OFF';
  startIso?: string;
  endIso?: string | null;
  start?: string;
  end?: string | null;
  startFormatted?: string;
  endFormatted?: string | null;
  durationMin?: number;
  durationLabel?: string | null;
  zone?: string;
  isEstimated?: boolean;
  isResynced?: boolean;
}

function normalizeSlot(raw: RawSlot, index: number): ShiftedScheduleSlot {
  const startIso = raw.startIso || raw.start || '';
  const endIso = raw.endIso || raw.end || null;

  // Compute duration if not provided
  let durationMin = raw.durationMin || 0;
  if (!durationMin && startIso && endIso) {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      durationMin = Math.round((endMs - startMs) / 60_000);
    }
  }

  // Determine zone based on hour
  let zone = raw.zone || 'NIGHT';
  if (!raw.zone && startIso) {
    const h = new Date(startIso).getHours();
    if (h >= 5 && h < 12) zone = 'MORNING';
    else if (h >= 12 && h < 17) zone = 'AFTERNOON';
    else if (h >= 17 && h < 21) zone = 'EVENING';
    else zone = 'NIGHT';
  }

  const startFmt = raw.startFormatted || fmtYemenTime(startIso);
  const endFmt = raw.endFormatted || (endIso ? fmtYemenTime(endIso) : null);

  return {
    state: raw.state,
    startIso,
    endIso,
    startFormatted: startFmt,
    endFormatted: endFmt,
    shiftedStartFormatted: startFmt,
    shiftedEndFormatted: endFmt,
    durationLabel: raw.durationLabel || fmtDurationLabel(durationMin),
    zone,
    isEstimated: raw.isEstimated || false,
    isResynced: raw.isResynced || false,
  };
}

// ─── OFFSET APPLICATION ─────────────────────────────────────────────────────

/**
 * Apply the offset to ALL slots in the schedule.
 *
 * V2.1 FINAL:
 *   - Positive offset → ADD (push) to start AND end of EACH state (ON and OFF)
 *   - Negative offset → DECLINE (pull) from start AND end of EACH state
 *   - The Generated ON slot (if present) is NOT shifted
 *
 * @param schedule     The raw schedule slots
 * @param offsetMin    The offset in signed minutes
 * @param resyncPoint  If present, the Generated ON info for slot replacement
 * @returns Shifted schedule with all slots offset applied
 */
function applyOffsetToAllSlots(
  schedule: ShiftedScheduleSlot[],
  offsetMin: number,
  resyncPoint: ResyncPoint | null,
): ShiftedScheduleSlot[] {
  return schedule.map(slot => {
    // V2.1: Don't shift the Generated ON slot — it keeps its actual report time.
    // The Generated ON is identified by matching its startIso to the resync's
    // syncedAtIso (which is the Generated ON start time).
    const isGeneratedOn = resyncPoint &&
      resyncPoint.syncedState === 'ON' &&
      slot.startIso === resyncPoint.syncedAtIso;

    if (isGeneratedOn) {
      // Mark as resynced but don't shift
      return { ...slot, isResynced: true };
    }

    // Shift both start and end by the offset
    const startMs = new Date(slot.startIso).getTime();
    const shiftedStartMs = startMs + offsetMin * 60_000;
    const shiftedStartIso = new Date(shiftedStartMs).toISOString();

    let shiftedEndIso: string | null = null;
    let shiftedEndFormatted: string | null = null;
    if (slot.endIso) {
      const endMs = new Date(slot.endIso).getTime();
      shiftedEndIso = new Date(endMs + offsetMin * 60_000).toISOString();
      shiftedEndFormatted = fmtYemenTime(shiftedEndIso);
    }

    return {
      ...slot,
      startIso: shiftedStartIso,
      endIso: shiftedEndIso,
      shiftedStartFormatted: fmtYemenTime(shiftedStartIso),
      shiftedEndFormatted,
      isResynced: resyncPoint ? true : slot.isResynced,
    };
  });
}

// ─── CURRENT STATE DERIVATION ───────────────────────────────────────────────

function deriveCurrentState(
  schedule: ShiftedScheduleSlot[],
  nowMs: number,
  resyncPoint: ResyncPoint | null,
): { state: 'ON' | 'OFF'; startIso: string | null } {
  // If we have a resync point and the Generated ON is still active, use it
  if (resyncPoint && resyncPoint.syncedState === 'ON') {
    const genOnStartMs = new Date(resyncPoint.syncedAtIso).getTime();
    const genOnDuration = resyncPoint.generatedOnDurationMin ?? 120; // default 2h
    const genOnEndMs = genOnStartMs + genOnDuration * 60_000;
    if (nowMs >= genOnStartMs && nowMs < genOnEndMs) {
      return { state: 'ON', startIso: resyncPoint.syncedAtIso };
    }
  }

  // Find the slot that contains "now"
  for (const slot of schedule) {
    const startMs = new Date(slot.startIso).getTime();
    const endMs = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= startMs && nowMs < endMs) {
      return { state: slot.state, startIso: slot.startIso };
    }
  }

  // Default: find the next upcoming slot's state (assume OFF if next is ON)
  for (const slot of schedule) {
    const startMs = new Date(slot.startIso).getTime();
    if (startMs > nowMs) {
      return { state: slot.state === 'ON' ? 'OFF' : 'ON', startIso: null };
    }
  }

  return { state: 'OFF', startIso: null };
}

// ─── NEXT TRANSITION DERIVATION ─────────────────────────────────────────────

function deriveNextTransition(
  schedule: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  nowMs: number,
  isHolding: boolean,
  scheduledAutoTransitionIso: string | null,
): NextTransition | null {
  // For POSITIVE_OFFSET_PENDING with a scheduled auto-transition, build from it
  if (isHolding && scheduledAutoTransitionIso) {
    const scheduledMs = new Date(scheduledAutoTransitionIso).getTime();
    const minFromNow = Math.max(0, (scheduledMs - nowMs) / 60_000);
    const nextState = currentState === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON';
    return {
      type: nextState as 'UTILITY_ON' | 'UTILITY_OFF',
      rangeStartIso: scheduledAutoTransitionIso,
      rangeEndIso: scheduledAutoTransitionIso,
      rangeLabel: fmtYemenTime(scheduledAutoTransitionIso),
      minFromNowMin: minFromNow,
      maxFromNowMin: minFromNow,
      waitLabel: '',
      inRangeWindow: minFromNow <= 0,
    };
  }

  // Find the next slot whose state differs from current
  const targetState = currentState === 'ON' ? 'OFF' : 'ON';
  for (const slot of schedule) {
    if (slot.state !== targetState) continue;
    const startMs = new Date(slot.startIso).getTime();
    if (startMs <= nowMs) continue;

    const minFromNow = (startMs - nowMs) / 60_000;
    const endMs = slot.endIso ? new Date(slot.endIso).getTime() : startMs + 120 * 60_000;
    const maxFromNow = (endMs - nowMs) / 60_000;

    // Estimate a range window (±15 min around the predicted start)
    const rangeWindowMs = 15 * 60_000;
    const rangeStartMs = startMs - rangeWindowMs;
    const rangeEndMs = startMs + rangeWindowMs;
    const inRangeWindow = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

    return {
      type: targetState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      rangeStartIso: new Date(rangeStartMs).toISOString(),
      rangeEndIso: new Date(rangeEndMs).toISOString(),
      rangeLabel: fmtYemenTime(new Date(startMs).toISOString()),
      minFromNowMin: Math.max(0, minFromNow),
      maxFromNowMin: Math.max(0, maxFromNow),
      waitLabel: '',
      inRangeWindow,
    };
  }

  return null;
}

// ─── ATC STATE COMPUTATION ──────────────────────────────────────────────────

function computeATCState(
  offsetMin: number,
  isResynced: boolean,
  transitionMode: TransitionMode,
  schedule: ShiftedScheduleSlot[],
  nowMs: number,
  currentState: 'ON' | 'OFF',
): ATCState {
  // Determine mode based on offset and resync state
  let mode: ScheduleStateMode = 'NORMAL';

  if (isResynced) {
    mode = 'COMMUNITY_SYNCED';
  } else if (offsetMin > 0) {
    // Positive offset — check if we're in POSITIVE_OFFSET_PENDING
    // (Growatt has transitioned but user's scheduled time is future)
    const currentSlot = schedule.find(s => {
      const startMs = new Date(s.startIso).getTime();
      const endMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= startMs && nowMs < endMs;
    });
    if (currentSlot && currentSlot.state !== currentState) {
      mode = 'POSITIVE_OFFSET_PENDING';
    } else {
      mode = 'NORMAL';
    }
  } else if (offsetMin < 0) {
    // Negative offset — check if we're past the expected end (UNCERTAIN_ZONE)
    const currentSlot = schedule.find(s => {
      const startMs = new Date(s.startIso).getTime();
      const endMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= startMs && nowMs < endMs;
    });
    if (currentSlot && currentSlot.state === 'OFF') {
      const offEndMs = currentSlot.endIso ? new Date(currentSlot.endIso).getTime() : 0;
      if (offEndMs > 0 && nowMs >= offEndMs - 5 * 60_000) {
        mode = 'UNCERTAIN_ZONE';
      } else {
        mode = 'NORMAL';
      }
    } else {
      mode = 'NORMAL';
    }
  }

  // Compute verification window
  const inValidationWindow = mode === 'COMMUNITY_SYNCED' || mode === 'POSITIVE_OFFSET_PENDING';
  const validationWindowRemainingMin = inValidationWindow ? 20 : 0; // 20 min window

  // Compute overrun (for UNCERTAIN_ZONE)
  let overrunMinutes = 0;
  if (mode === 'UNCERTAIN_ZONE') {
    const currentSlot = schedule.find(s => {
      const startMs = new Date(s.startIso).getTime();
      const endMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= startMs && nowMs < endMs;
    });
    if (currentSlot && currentSlot.endIso) {
      const endMs = new Date(currentSlot.endIso).getTime();
      overrunMinutes = Math.max(0, Math.ceil((nowMs - endMs) / 60_000));
    }
  }

  // Compute scheduled auto-transition (for POSITIVE_OFFSET_PENDING)
  let scheduledAutoTransitionIso: string | null = null;
  if (mode === 'POSITIVE_OFFSET_PENDING') {
    // The scheduled transition is when the user's offset says the state should change
    const targetState = currentState === 'ON' ? 'OFF' : 'ON';
    for (const slot of schedule) {
      if (slot.state !== targetState) continue;
      const startMs = new Date(slot.startIso).getTime();
      if (startMs > nowMs) {
        scheduledAutoTransitionIso = slot.startIso;
        break;
      }
    }
  }

  // Status line
  const statusLines: Record<ScheduleStateMode, string> = {
    NORMAL: 'طبيعي',
    COMMUNITY_SYNCED: 'مزامنة مجتمعية',
    UNCERTAIN_ZONE: 'بانتظار تأكيد',
    WAITING_FOR_GROWATT: 'بانتظار Growatt',
    PREDICTION_RANGE: 'نطاق التوقع نشط',
    GRACE_MODE: 'مهلة المزامنة',
    POSITIVE_OFFSET_PENDING: 'تغيير تلقائي مجدول',
  };

  return {
    mode,
    inValidationWindow,
    validationWindowRemainingMin,
    overrunMinutes,
    transitionMode,
    communityElevated: mode === 'UNCERTAIN_ZONE' || mode === 'WAITING_FOR_GROWATT',
    statusLine: statusLines[mode] || mode,
    scheduledAutoTransitionIso,
  };
}

// ─── HOLDING STATE DETECTION ────────────────────────────────────────────────

function isHoldingState(
  mode: ScheduleStateMode,
  currentState: 'ON' | 'OFF',
  schedule: ShiftedScheduleSlot[],
  nowMs: number,
): boolean {
  if (mode === 'POSITIVE_OFFSET_PENDING' || mode === 'UNCERTAIN_ZONE' ||
      mode === 'WAITING_FOR_GROWATT' || mode === 'GRACE_MODE') {
    return true;
  }
  // Check if we're past the end of the current slot but haven't transitioned
  const currentSlot = schedule.find(s => {
    const startMs = new Date(s.startIso).getTime();
    const endMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= startMs && nowMs < endMs;
  });
  if (!currentSlot && schedule.length > 0) {
    // Between slots — might be holding
    return true;
  }
  return false;
}

// ─── DURATION LABELS ────────────────────────────────────────────────────────

function computeDurationLabels(
  schedule: ShiftedScheduleSlot[],
  apppe?: any,
): { onLabel: string | null; offLabel: string | null } {
  // Try to get from APPPE data first
  if (apppe?.expectedOnDurationMin) {
    return {
      onLabel: arabicDurationRange(apppe.expectedOnDurationMin),
      offLabel: apppe?.expectedOffDurationMin ? arabicDurationRange(apppe.expectedOffDurationMin) : null,
    };
  }

  // Compute from schedule averages
  const onSlots = schedule.filter(s => s.state === 'ON' && s.endIso);
  const offSlots = schedule.filter(s => s.state === 'OFF' && s.endIso);

  const avgOn = onSlots.length > 0
    ? onSlots.reduce((sum, s) => {
        const ms = new Date(s.endIso!).getTime() - new Date(s.startIso).getTime();
        return sum + ms / 60_000;
      }, 0) / onSlots.length
    : 0;

  const avgOff = offSlots.length > 0
    ? offSlots.reduce((sum, s) => {
        const ms = new Date(s.endIso!).getTime() - new Date(s.startIso).getTime();
        return sum + ms / 60_000;
      }, 0) / offSlots.length
    : 0;

  return {
    onLabel: avgOn > 0 ? arabicDurationRange(Math.round(avgOn)) : null,
    offLabel: avgOff > 0 ? arabicDurationRange(Math.round(avgOff)) : null,
  };
}

// ─── MAIN ENGINE FUNCTION ───────────────────────────────────────────────────

/**
 * applyOffsetToPrediction
 *
 * Takes a raw prediction from Supabase, applies the user's offset and
 * community resync, builds the shifted schedule, computes the ATC state,
 * and returns a complete UserPrediction.
 *
 * V2.1 FINAL:
 *   - Offset applies to ALL states (ON and OFF) — push for positive, pull for negative
 *   - Generated ON REPLACES the corresponding Growatt ON (not just inserted)
 *   - Generated ON is NOT shifted — keeps actual report time
 *   - Offset is FINAL at report time — no recomputation
 *   - POSITIVE → Verification Window: true
 *   - NEGATIVE → UNCERTAIN_ZONE: true
 *
 * @param prediction                 Raw prediction from usePredictions/Supabase
 * @param offsetMinutes              User's personal offset in minutes
 * @param resyncPoint                Active community resync point, or null
 * @param communitySyncMeta          Display data for community sync, or null
 * @param transitionMode             'AUTO' or 'MANUAL'
 * @param heldCycleStartIso          Anchor start (from useStateAnchor, instrumentation)
 * @param frozenCommunityOffsetMinutes  Frozen community offset (Rule Q2-A)
 * @param onOffsetCalculated         Callback when a fresh community offset is computed
 * @param nowMs                      Current time in milliseconds
 * @param onAccuracyEvent            Callback for accuracy events
 * @returns Complete UserPrediction
 */
export function applyOffsetToPrediction(
  prediction: any,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  communitySyncMeta: CommunitySyncMeta | null,
  transitionMode: TransitionMode,
  heldCycleStartIso: string | null,
  frozenCommunityOffsetMinutes: number | null,
  onOffsetCalculated?: (
    offset: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
  nowMs: number,
  onAccuracyEvent?: (event: AccuracyLogEvent) => void,
): UserPrediction {
  // ── 1. Determine the effective offset ──────────────────────────────────────
  // Use frozen community offset if available, otherwise the user's personal offset
  let effectiveOffset = frozenCommunityOffsetMinutes ?? offsetMinutes;

  // If we have a resyncPoint with V2.1 offset data, use it
  if (resyncPoint?.offsetValue !== undefined && resyncPoint.offsetValue !== null) {
    const v21Value = typeof resyncPoint.offsetValue === 'string'
      ? 0 // PENDING → 0 placeholder (shouldn't happen in V2.1 Final)
      : resyncPoint.offsetValue;
    effectiveOffset = v21Value;

    // Fire the onOffsetCalculated callback if this is a fresh community offset
    if (frozenCommunityOffsetMinutes === null && onOffsetCalculated) {
      const sign = v21Value > 0 ? 'POSITIVE' : v21Value < 0 ? 'NEGATIVE' : 'NEUTRAL';
      onOffsetCalculated(v21Value, {
        sign,
        referenceIso: resyncPoint.timelineAlignment ?? resyncPoint.syncedAtIso,
        referenceKind: resyncPoint.generatedOnReferenceKind ?? null,
      });
    }
  }

  // ── 2. Build the raw schedule from the prediction ──────────────────────────
  const rawSchedule: RawSlot[] = prediction?.daySchedule ||
    prediction?.schedule ||
    prediction?.slots ||
    [];
  let schedule: ShiftedScheduleSlot[] = rawSchedule.map((s: RawSlot, i: number) => normalizeSlot(s, i));

  // If no schedule from prediction, try to build from prediction fields
  if (schedule.length === 0 && prediction?.nextTransition) {
    // Build a minimal schedule from the next transition
    const nt = prediction.nextTransition;
    const nowIso = new Date(nowMs).toISOString();
    schedule = [
      {
        state: nt.type === 'UTILITY_ON' ? 'OFF' : 'ON',
        startIso: nowIso,
        endIso: nt.rangeStartIso,
        startFormatted: fmtYemenTime(nowIso),
        endFormatted: fmtYemenTime(nt.rangeStartIso),
        shiftedStartFormatted: fmtYemenTime(nowIso),
        shiftedEndFormatted: fmtYemenTime(nt.rangeStartIso),
        durationLabel: '—',
        zone: 'NIGHT',
        isEstimated: true,
      },
      {
        state: nt.type === 'UTILITY_ON' ? 'ON' : 'OFF',
        startIso: nt.rangeStartIso,
        endIso: nt.rangeEndIso,
        startFormatted: fmtYemenTime(nt.rangeStartIso),
        endFormatted: fmtYemenTime(nt.rangeEndIso),
        shiftedStartFormatted: fmtYemenTime(nt.rangeStartIso),
        shiftedEndFormatted: fmtYemenTime(nt.rangeEndIso),
        durationLabel: '—',
        zone: 'NIGHT',
        isEstimated: true,
      },
    ];
  }

  // ── 3. Apply the offset to ALL slots ───────────────────────────────────────
  // V2.1 FINAL: Offset is applied to ALL states (ON and OFF).
  // Positive → push forward, Negative → pull backward.
  // The Generated ON (if resynced) is NOT shifted — it keeps its actual time.
  schedule = applyOffsetToAllSlots(schedule, effectiveOffset, resyncPoint);

  // ── 4. Determine current state ─────────────────────────────────────────────
  const { state: currentState, startIso: currentStateStartIso } =
    deriveCurrentState(schedule, nowMs, resyncPoint);

  const isResynced = !!resyncPoint;

  // ── 5. Compute ATC state ───────────────────────────────────────────────────
  const atc = computeATCState(
    effectiveOffset,
    isResynced,
    transitionMode,
    schedule,
    nowMs,
    currentState,
  );

  // ── 6. Determine holding state ─────────────────────────────────────────────
  const holding = isHoldingState(atc.mode, currentState, schedule, nowMs);

  // ── 7. Derive next transition ──────────────────────────────────────────────
  const nextTransition = deriveNextTransition(
    schedule,
    currentState,
    nowMs,
    holding && atc.mode === 'POSITIVE_OFFSET_PENDING',
    atc.scheduledAutoTransitionIso,
  );

  // ── 8. Compute duration labels ─────────────────────────────────────────────
  const apppe = prediction?.appppe || prediction?.apppe;
  const { onLabel, offLabel } = computeDurationLabels(schedule, apppe);

  // ── 9. Build reasoning ─────────────────────────────────────────────────────
  const reasoning: string[] = [];
  if (isResynced && resyncPoint) {
    reasoning.push(`تمت مزامنة الجدول عبر بلاغ مجتمعي من ${resyncPoint.reporterName ?? 'مجهول'}`);
  }
  if (effectiveOffset !== 0) {
    reasoning.push(`الفارق الزمني: ${effectiveOffset > 0 ? '+' : ''}${effectiveOffset} دقيقة`);
  }
  if (atc.mode === 'UNCERTAIN_ZONE') {
    reasoning.push('النظام في وضع عدم اليقين — بانتظار تأكيد التحوّل');
  }
  if (atc.mode === 'POSITIVE_OFFSET_PENDING') {
    reasoning.push('تحويل تلقائي مجدول — سيتم التحديث في الوقت المحدد');
  }

  // ── 10. Determine Generated ON info ────────────────────────────────────────
  const isGeneratedOnCurrent = isResynced &&
    resyncPoint?.syncedState === 'ON' &&
    resyncPoint?.generatedOnStartIso !== undefined;
  const generatedOnInfo = isGeneratedOnCurrent ? {
    startIso: resyncPoint!.generatedOnStartIso!,
    durationMin: resyncPoint!.generatedOnDurationMin ?? 0,
    referenceIso: resyncPoint!.generatedOnReferenceIso ?? resyncPoint!.syncedAtIso,
    referenceKind: (resyncPoint!.generatedOnReferenceKind ?? 'completed') as 'completed' | 'active',
    inheritsReferenceLifecycle: false,
  } : null;

  // ── 11. Build the final UserPrediction ─────────────────────────────────────
  const result: UserPrediction = {
    daySchedule: schedule,
    currentState,
    currentStateStartIso,
    nextTransition,
    isHoldingState: holding,
    isResynced,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    computedAt: new Date(nowMs).toISOString(),
    confidence: prediction?.confidence ?? 50,
    stabilityScore: prediction?.stabilityScore ?? 50,
    stabilityLabel: prediction?.stabilityLabel ?? 'Stable',
    learningMode: prediction?.learningMode ?? 'estimated',
    isUnstable: prediction?.isUnstable ?? false,
    communitySyncMeta,
    offsetMinutes: effectiveOffset,
    crisisMode: prediction?.crisisMode ?? (prediction?.appppe?.crisisMode ?? null),
    crisisReason: prediction?.crisisReason ?? (prediction?.appppe?.crisisReason ?? null),
    expectedOnDurationLabel: onLabel,
    expectedOffDurationLabel: offLabel,
    atc,
    reasoning,
    // V2.1 fields:
    offsetState: resyncPoint?.offsetState,
    offsetValue: resyncPoint?.offsetValue,
    timelineAlignment: resyncPoint?.timelineAlignment,
    generatedOnInfo,
    pendingNegativeResolutionIso: null, // V2.1 Final: never produced
    isPendingNegative: false, // V2.1 Final: never produced
    isGeneratedOnCurrent,
  };

  return result;
}
