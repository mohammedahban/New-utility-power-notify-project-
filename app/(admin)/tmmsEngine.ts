/**
 * tmmsEngine.ts — TMMS V2.1 Final Engine
 *
 * Dependency-free TypeScript — shared between the production hook
 * (hooks/useUserPredictions.ts) and admin tooling without circular imports.
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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPORTS
 * ═══════════════════════════════════════════════════════════════════════════
 *   Types:       Prediction, ScheduleSlot, ResyncPoint, UserPrediction,
 *                CommunitySyncMeta, ShiftedScheduleSlot, ATCInfo,
 *                ScheduleStateMode, TransitionMode, AccuracyLogEvent,
 *                NextTransition
 *   Functions:   applyOffsetToPrediction (+ admin helpers)
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── TYPES ───────────────────────────────────────────────────────────────────

export type TransitionMode = 'AUTO' | 'MANUAL';

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

/** Raw schedule slot from APPPE / predictions table */
export interface ScheduleSlot {
  state: 'ON' | 'OFF';
  start: string;       // 'HH:MM' Yemen local
  end: string;         // 'HH:MM' Yemen local
  durationMin: number;
  zone?: 'DAY' | 'NIGHT';
  isEstimated?: boolean;
}

/** Community resync point (stored in ResyncContext + AsyncStorage) */
export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string | null;
  reporterReliability?: number | null;
  // V2.1 additions
  offsetState?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
  offsetValue?: number | 'PENDING';
  timelineAlignment?: string;
  generatedOnStartIso?: string;
  generatedOnDurationMin?: number | null;
  generatedOnReferenceIso?: string | null;
  generatedOnReferenceKind?: 'completed' | 'active' | null;
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
  durationLabel: string;
  zone: 'DAY' | 'NIGHT';
  isEstimated: boolean;
  isResynced?: boolean;
}

export interface ATCInfo {
  mode: ScheduleStateMode;
  transitionMode: TransitionMode;
  statusLine: string;
  overrunMinutes: number;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso: string | null;
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

export interface AccuracyLogEvent {
  predictedTransitionIso: string;
  actualTransitionIso: string;
  targetState: 'UTILITY_ON' | 'UTILITY_OFF';
  offsetMinutes: number;
  exitMode: string;
  errorMinutes: number;
  accuracyScore: number;
}

/** Raw APPPE prediction from Supabase (matches usePredictions output) */
export interface Prediction {
  id?: number;
  computedAt?: string;
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  currentState: 'ON' | 'OFF';
  learningMode: 'learned' | 'hybrid' | 'estimated';
  daySchedule: ScheduleSlot[];
  nextTransition?: NextTransition | null;
  expectedOnDurationLabel?: string;
  expectedOffDurationLabel?: string;
  crisisMode?: boolean | null;
  crisisReason?: string | null;
  reasoning?: string[];
  offsetMinutes?: number;
  resyncedAtIso?: string | null;
  currentStateStartIso?: string | null;
  isResynced?: boolean;
  isHoldingState?: boolean;
  apppe?: {
    crisisActive?: boolean;
    crisisReason?: string;
    crisisMode?: boolean;
    [key: string]: any;
  };
  [key: string]: any;
}

/** Engine output — consumed by hooks/useUserPredictions and the UI */
export interface UserPrediction extends Prediction {
  atc: ATCInfo;
  communitySyncMeta: CommunitySyncMeta | null;
  daySchedule: ShiftedScheduleSlot[];
  currentStateStartIso: string | null;
  offsetMinutes: number;
  nextTransition: NextTransition | null;
  // V2.1 fields
  offsetState?: string;
  offsetValue?: number | string;
  timelineAlignment?: string;
  generatedOnInfo?: any;
  isPendingNegative?: boolean;
  isGeneratedOnCurrent?: boolean;
  pendingNegativeResolutionIso?: string | null;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const YEMEN_OFFSET_MS = 3 * 60 * 60 * 1000;

export function fmtYemenTime(iso: string): string {
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

export function durationLabelFromMin(min: number): string {
  if (min <= 0) return '0د';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

export function arabicDurationRange(min: number): string {
  return durationLabelFromMin(min);
}

export function getZoneFromIso(iso: string): 'DAY' | 'NIGHT' {
  const h = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', hour12: false,
  });
  const hour = parseInt(h, 10);
  return hour >= 6 && hour < 20 ? 'DAY' : 'NIGHT';
}

function hmToIso(hhmm: string, nowMs: number): string {
  const yemenNowMs = nowMs + YEMEN_OFFSET_MS;
  const yemenDate = new Date(yemenNowMs);
  const yemenMidnightMs = yemenNowMs - (
    yemenDate.getUTCHours() * 3600000 +
    yemenDate.getUTCMinutes() * 60000 +
    yemenDate.getUTCSeconds() * 1000 +
    yemenDate.getUTCMilliseconds()
  );
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(yemenMidnightMs - YEMEN_OFFSET_MS + h * 3600000 + m * 60000).toISOString();
}

function buildShiftedSlot(
  raw: ScheduleSlot,
  offsetMs: number,
  nowMs: number,
  isResynced = false,
): ShiftedScheduleSlot {
  const startIso = hmToIso(raw.start, nowMs);
  const endIso = raw.end ? hmToIso(raw.end, nowMs) : null;

  // Handle midnight wrap
  let adjustedEndIso = endIso;
  if (adjustedEndIso && new Date(adjustedEndIso).getTime() <= new Date(startIso).getTime()) {
    adjustedEndIso = new Date(new Date(adjustedEndIso).getTime() + 24 * 3600000).toISOString();
  }

  const shiftedStartIso = new Date(new Date(startIso).getTime() + offsetMs).toISOString();
  const shiftedEndIso = adjustedEndIso
    ? new Date(new Date(adjustedEndIso).getTime() + offsetMs).toISOString()
    : null;

  return {
    state: raw.state,
    startIso: shiftedStartIso,
    endIso: shiftedEndIso,
    startFormatted: fmtYemenTime(startIso),
    endFormatted: adjustedEndIso ? fmtYemenTime(adjustedEndIso) : null,
    shiftedStartFormatted: fmtYemenTime(shiftedStartIso),
    shiftedEndFormatted: shiftedEndIso ? fmtYemenTime(shiftedEndIso) : null,
    durationLabel: durationLabelFromMin(raw.durationMin),
    zone: raw.zone ?? getZoneFromIso(startIso),
    isEstimated: raw.isEstimated ?? false,
    isResynced,
  };
}

// ─── ATC STATE MACHINE ───────────────────────────────────────────────────────

const PREDICTION_RANGE_MIN = 15;
const GRACE_MODE_MAX_MIN = 30;
const VALIDATION_WINDOW_MIN = 20;

function computeATCMode(
  shiftedSlots: ShiftedScheduleSlot[],
  growattCurrentState: 'ON' | 'OFF',
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  nowMs: number,
): {
  mode: ScheduleStateMode;
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  isHoldingState: boolean;
  overrunMinutes: number;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso: string | null;
  statusLine: string;
} {
  const offsetMs = offsetMinutes * 60_000;

  const activeSlot = shiftedSlots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;

  // ── COMMUNITY_SYNCED ─────────────────────────────────────────────────────
  if (resyncPoint) {
    const syncedMs = new Date(resyncPoint.syncedAtIso).getTime();
    const durationMin = resyncPoint.generatedOnDurationMin ?? 0;
    const cycleEndMs = syncedMs + durationMin * 60_000;
    const inWindow = nowMs < cycleEndMs;
    const validationWindowRemainingMin = inWindow
      ? Math.max(0, (cycleEndMs - nowMs) / 60_000) : 0;

    if (inWindow || durationMin === 0) {
      return {
        mode: 'COMMUNITY_SYNCED',
        currentState: resyncPoint.syncedState,
        currentStateStartIso: resyncPoint.syncedAtIso,
        isHoldingState: true,
        overrunMinutes: 0,
        communityElevated: true,
        inValidationWindow: inWindow,
        validationWindowRemainingMin,
        scheduledAutoTransitionIso: durationMin > 0 ? new Date(cycleEndMs).toISOString() : null,
        statusLine: 'الحالة مُزامَنة مجتمعياً',
      };
    }
  }

  // ── POSITIVE_OFFSET_PENDING ──────────────────────────────────────────────
  if (offsetMinutes > 0 && activeSlot === null) {
    const nextSlot = shiftedSlots
      .filter(s => new Date(s.startIso).getTime() > nowMs)
      .sort((a, b) => new Date(a.startIso).getTime() - new Date(b.startIso).getTime())[0] ?? null;

    if (nextSlot && nextSlot.state !== growattCurrentState) {
      const scheduledAutoTransitionIso = nextSlot.startIso;
      return {
        mode: 'POSITIVE_OFFSET_PENDING',
        currentState: growattCurrentState === 'ON' ? 'OFF' : 'ON',
        currentStateStartIso: null,
        isHoldingState: true,
        overrunMinutes: 0,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso,
        statusLine: `تغيير تلقائي مجدول في ${fmtYemenTime(scheduledAutoTransitionIso)}`,
      };
    }
  }

  // ── NEGATIVE OFFSET: UNCERTAIN_ZONE ──────────────────────────────────────
  if (offsetMinutes < 0 && activeSlot === null) {
    const recentlyEnded = shiftedSlots
      .filter(s => s.endIso && new Date(s.endIso).getTime() <= nowMs)
      .sort((a, b) => new Date(b.endIso!).getTime() - new Date(a.endIso!).getTime())[0] ?? null;

    if (recentlyEnded) {
      const slotEndMs = new Date(recentlyEnded.endIso!).getTime();
      const overrunMin = Math.round((nowMs - slotEndMs) / 60_000);
      const backedStartIso = new Date(slotEndMs + offsetMs).toISOString();

      if (overrunMin <= GRACE_MODE_MAX_MIN) {
        return {
          mode: overrunMin <= 5 ? 'GRACE_MODE' : 'UNCERTAIN_ZONE',
          currentState: recentlyEnded.state,
          currentStateStartIso: backedStartIso,
          isHoldingState: true,
          overrunMinutes: overrunMin,
          communityElevated: overrunMin >= PREDICTION_RANGE_MIN,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          scheduledAutoTransitionIso: null,
          statusLine: overrunMin <= 5
            ? `مهلة المزامنة — تجاوزنا الجدول بـ ${overrunMin} دقيقة`
            : `غير مؤكد — تجاوزنا الجدول بـ ${overrunMin} دقيقة`,
        };
      } else {
        return {
          mode: 'WAITING_FOR_GROWATT',
          currentState: growattCurrentState,
          currentStateStartIso: null,
          isHoldingState: false,
          overrunMinutes: overrunMin,
          communityElevated: true,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          scheduledAutoTransitionIso: null,
          statusLine: `بانتظار تأكيد Growatt — تأخير ${overrunMin} دقيقة`,
        };
      }
    }
  }

  // ── PREDICTION_RANGE ─────────────────────────────────────────────────────
  if (activeSlot?.endIso) {
    const endMs = new Date(activeSlot.endIso).getTime();
    const minutesUntilEnd = (endMs - nowMs) / 60_000;
    if (minutesUntilEnd >= 0 && minutesUntilEnd <= PREDICTION_RANGE_MIN) {
      return {
        mode: 'PREDICTION_RANGE',
        currentState: activeSlot.state,
        currentStateStartIso: activeSlot.startIso,
        isHoldingState: false,
        overrunMinutes: 0,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
        statusLine: `نطاق التوقع — ${Math.round(minutesUntilEnd)} دقيقة للتغيير المتوقع`,
      };
    }
  }

  // ── NORMAL ───────────────────────────────────────────────────────────────
  return {
    mode: 'NORMAL',
    currentState: activeSlot ? activeSlot.state : growattCurrentState,
    currentStateStartIso: activeSlot ? activeSlot.startIso : null,
    isHoldingState: false,
    overrunMinutes: 0,
    communityElevated: false,
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
    scheduledAutoTransitionIso: null,
    statusLine: '',
  };
}

// ─── MAIN ENGINE FUNCTION ───────────────────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  communitySyncMeta: CommunitySyncMeta | null = null,
  transitionMode: TransitionMode = 'AUTO',
  anchorStartIso: string | null = null,
  frozenCommunityOffset: number | null = null,
  onOffsetCalculated?: (
    computedOffsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
  nowMs: number = Date.now(),
  onAccuracyEvent?: (event: AccuracyLogEvent) => void,
): UserPrediction {
  const rawSlots: ScheduleSlot[] = prediction.daySchedule ?? [];
  const offsetMs = offsetMinutes * 60_000;

  // ── 1. Build shifted schedule ──────────────────────────────────────────────
  const shiftedSlots: ShiftedScheduleSlot[] = rawSlots.map(raw =>
    buildShiftedSlot(raw, offsetMs, nowMs),
  );

  // ── 2. Run ATC state machine ───────────────────────────────────────────────
  const atcResult = computeATCMode(
    shiftedSlots,
    prediction.currentState,
    offsetMinutes,
    resyncPoint,
    transitionMode,
    nowMs,
  );

  // ── 3. Inject synthetic slot for POSITIVE_OFFSET_PENDING ───────────────────
  let finalSlots = [...shiftedSlots];
  if (atcResult.mode === 'POSITIVE_OFFSET_PENDING' && atcResult.scheduledAutoTransitionIso) {
    const heldState: 'ON' | 'OFF' = atcResult.currentState;
    const fmt = (iso: string) => fmtYemenTime(iso);
    const nowIso = new Date(nowMs).toISOString();
    finalSlots = [{
      state: heldState,
      startIso: nowIso,
      endIso: atcResult.scheduledAutoTransitionIso,
      startFormatted: fmt(nowIso),
      endFormatted: fmt(atcResult.scheduledAutoTransitionIso),
      shiftedStartFormatted: fmt(nowIso),
      shiftedEndFormatted: fmt(atcResult.scheduledAutoTransitionIso),
      durationLabel: durationLabelFromMin(
        Math.round((new Date(atcResult.scheduledAutoTransitionIso).getTime() - nowMs) / 60_000),
      ),
      zone: getZoneFromIso(nowIso),
      isEstimated: false,
    }, ...shiftedSlots];
  }

  // ── 4. Inject synthetic slot for COMMUNITY_SYNCED ──────────────────────────
  if (atcResult.mode === 'COMMUNITY_SYNCED' && resyncPoint) {
    const syncedMs = new Date(resyncPoint.syncedAtIso).getTime();
    const durationMin = resyncPoint.generatedOnDurationMin ?? 60;
    const cycleEndIso = new Date(syncedMs + durationMin * 60_000).toISOString();
    const fmt = (iso: string) => fmtYemenTime(iso);
    const alreadyFirst = finalSlots.length > 0 &&
      Math.abs(new Date(finalSlots[0].startIso).getTime() - syncedMs) < 60_000;
    if (!alreadyFirst) {
      finalSlots = [{
        state: resyncPoint.syncedState,
        startIso: resyncPoint.syncedAtIso,
        endIso: cycleEndIso,
        startFormatted: fmt(resyncPoint.syncedAtIso),
        endFormatted: fmt(cycleEndIso),
        shiftedStartFormatted: fmt(resyncPoint.syncedAtIso),
        shiftedEndFormatted: fmt(cycleEndIso),
        durationLabel: durationLabelFromMin(durationMin),
        zone: getZoneFromIso(resyncPoint.syncedAtIso),
        isEstimated: false,
        isResynced: true,
      }, ...shiftedSlots];
    }
  }

  // ── 5. Compute community offset (Rule Q2-A) ───────────────────────────────
  if (resyncPoint && frozenCommunityOffset === null && onOffsetCalculated) {
    const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
    const referenceSlot = rawSlots.find(s => {
      const startMs = new Date(hmToIso(s.start, nowMs)).getTime();
      const endMs = s.end ? new Date(hmToIso(s.end, nowMs)).getTime() : Infinity;
      return s.state === resyncPoint.syncedState && syncMs >= startMs && syncMs < endMs;
    }) ?? rawSlots.find(s => s.state === resyncPoint.syncedState) ?? null;

    if (referenceSlot) {
      const refStartMs = new Date(hmToIso(referenceSlot.start, nowMs)).getTime();
      const computedOffset = Math.round((syncMs - refStartMs) / 60_000);
      const sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' =
        computedOffset > 0 ? 'POSITIVE' : computedOffset < 0 ? 'NEGATIVE' : 'NEUTRAL';
      onOffsetCalculated(computedOffset, {
        sign,
        referenceIso: hmToIso(referenceSlot.start, nowMs),
        referenceKind: 'completed',
      });
    }
  }

  // ── 6. Build next-transition ───────────────────────────────────────────────
  const targetState: 'ON' | 'OFF' = atcResult.currentState === 'ON' ? 'OFF' : 'ON';
  const nextSlotForTransition = finalSlots.find(s =>
    s.state === targetState && new Date(s.startIso).getTime() > nowMs,
  ) ?? null;

  let nextTransition: NextTransition | null = null;
  if (nextSlotForTransition) {
    const rangeStartMs = new Date(nextSlotForTransition.startIso).getTime();
    const minFromNowMin = Math.max(0, (rangeStartMs - nowMs) / 60_000);
    const originalNt = prediction.nextTransition;
    const rangeWidthMs = originalNt
      ? (originalNt.maxFromNowMin - originalNt.minFromNowMin) * 60_000
      : 30 * 60_000;
    const rangeEndMs = rangeStartMs + rangeWidthMs;

    nextTransition = {
      type: targetState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      rangeStartIso: nextSlotForTransition.startIso,
      rangeEndIso: new Date(rangeEndMs).toISOString(),
      rangeLabel: nextSlotForTransition.shiftedStartFormatted ?? fmtYemenTime(nextSlotForTransition.startIso),
      minFromNowMin,
      maxFromNowMin: minFromNowMin + rangeWidthMs / 60_000,
      waitLabel: durationLabelFromMin(Math.round(minFromNowMin)),
      inRangeWindow: minFromNowMin <= 0,
    };
  } else if (prediction.nextTransition) {
    nextTransition = prediction.nextTransition;
  }

  // ── 7. Determine V2.1 fields ──────────────────────────────────────────────
  const isGeneratedOnCurrent = !!resyncPoint &&
    resyncPoint.syncedState === 'ON' &&
    resyncPoint.generatedOnStartIso !== undefined;
  const generatedOnInfo = isGeneratedOnCurrent ? {
    startIso: resyncPoint!.generatedOnStartIso!,
    durationMin: resyncPoint!.generatedOnDurationMin ?? 0,
    referenceIso: resyncPoint!.generatedOnReferenceIso ?? resyncPoint!.syncedAtIso,
    referenceKind: (resyncPoint!.generatedOnReferenceKind ?? 'completed') as 'completed' | 'active',
    inheritsReferenceLifecycle: false,
  } : null;

  // ── 8. Assemble UserPrediction ─────────────────────────────────────────────
  const atcInfo: ATCInfo = {
    mode: atcResult.mode,
    transitionMode,
    statusLine: atcResult.statusLine,
    overrunMinutes: atcResult.overrunMinutes,
    communityElevated: atcResult.communityElevated,
    inValidationWindow: atcResult.inValidationWindow,
    validationWindowRemainingMin: atcResult.validationWindowRemainingMin,
    scheduledAutoTransitionIso: atcResult.scheduledAutoTransitionIso,
  };

  return {
    ...prediction,
    atc: atcInfo,
    communitySyncMeta,
    daySchedule: finalSlots,
    currentState: atcResult.currentState,
    currentStateStartIso: atcResult.currentStateStartIso,
    isHoldingState: atcResult.isHoldingState,
    isResynced: !!resyncPoint,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    offsetMinutes,
    nextTransition,
    crisisMode: prediction.apppe?.crisisActive ?? prediction.crisisMode ?? null,
    crisisReason: prediction.apppe?.crisisReason ?? prediction.crisisReason ?? null,
    // V2.1 fields
    offsetState: resyncPoint?.offsetState,
    offsetValue: resyncPoint?.offsetValue,
    timelineAlignment: resyncPoint?.timelineAlignment,
    generatedOnInfo,
    isPendingNegative: false,
    isGeneratedOnCurrent,
    pendingNegativeResolutionIso: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD HELPER EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export function extendScheduleTo48h(schedule: ShiftedScheduleSlot[]): ShiftedScheduleSlot[] {
  if (!schedule?.length) return schedule;
  const extended: ShiftedScheduleSlot[] = [...schedule];
  for (const slot of schedule) {
    const startMs = new Date(slot.startIso).getTime();
    const endMs = slot.endIso ? new Date(slot.endIso).getTime() : startMs + 120 * 60_000;
    extended.push({
      ...slot,
      startIso: new Date(startMs + 86400000).toISOString(),
      endIso: new Date(endMs + 86400000).toISOString(),
      startFormatted: fmtYemenTime(new Date(startMs + 86400000).toISOString()),
      endFormatted: fmtYemenTime(new Date(endMs + 86400000).toISOString()),
      shiftedStartFormatted: fmtYemenTime(new Date(startMs + 86400000).toISOString()),
      shiftedEndFormatted: fmtYemenTime(new Date(endMs + 86400000).toISOString()),
    });
  }
  return extended;
}

export function applyOffsetToSlots(schedule: ShiftedScheduleSlot[], offsetMinutes: number): ShiftedScheduleSlot[] {
  const offsetMs = offsetMinutes * 60_000;
  return schedule.map(slot => {
    const startMs = new Date(slot.startIso).getTime();
    const endMs = slot.endIso ? new Date(slot.endIso).getTime() : null;
    const sStart = new Date(startMs + offsetMs).toISOString();
    const sEnd = endMs !== null ? new Date(endMs + offsetMs).toISOString() : null;
    return {
      ...slot,
      startIso: sStart,
      endIso: sEnd,
      shiftedStartFormatted: fmtYemenTime(sStart),
      shiftedEndFormatted: sEnd ? fmtYemenTime(sEnd) : null,
    };
  });
}

export function computeCommunityOffset(
  resyncPoint: ResyncPoint | null,
  frozenOffset: number | null,
  fallbackOffset: number,
): number {
  if (frozenOffset !== null) return frozenOffset;
  if (resyncPoint?.offsetValue !== undefined && resyncPoint.offsetValue !== null) {
    return typeof resyncPoint.offsetValue === 'string' ? 0 : resyncPoint.offsetValue;
  }
  return fallbackOffset;
}

export function computeCommunityTransition(
  resyncPoint: ResyncPoint | null,
): { transitionIso: string | null; state: 'ON' | 'OFF' | null } {
  if (!resyncPoint) return { transitionIso: null, state: null };
  return { transitionIso: resyncPoint.syncedAtIso, state: resyncPoint.syncedState };
}

export function computeATCStateExport(
  offsetMin: number, isResynced: boolean, transitionMode: TransitionMode,
  schedule: ShiftedScheduleSlot[], nowMs: number, currentState: 'ON' | 'OFF',
): ATCInfo {
  const result = computeATCMode(schedule, currentState, offsetMin, null, transitionMode, nowMs);
  return {
    mode: result.mode, transitionMode, statusLine: result.statusLine,
    overrunMinutes: result.overrunMinutes, communityElevated: result.communityElevated,
    inValidationWindow: result.inValidationWindow,
    validationWindowRemainingMin: result.validationWindowRemainingMin,
    scheduledAutoTransitionIso: result.scheduledAutoTransitionIso,
  };
}

export function deriveCurrentStateATC(
  schedule: ShiftedScheduleSlot[], nowMs: number, resyncPoint: ResyncPoint | null,
): { state: 'ON' | 'OFF'; startIso: string | null } {
  if (resyncPoint?.syncedState === 'ON') {
    const syncedMs = new Date(resyncPoint.syncedAtIso).getTime();
    const dur = resyncPoint.generatedOnDurationMin ?? 120;
    if (nowMs >= syncedMs && nowMs < syncedMs + dur * 60_000) {
      return { state: 'ON', startIso: resyncPoint.syncedAtIso };
    }
  }
  for (const slot of schedule) {
    const start = new Date(slot.startIso).getTime();
    const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= start && nowMs < end) return { state: slot.state, startIso: slot.startIso };
  }
  return { state: 'OFF', startIso: null };
}

export function deriveNextTransitionExport(
  schedule: ShiftedScheduleSlot[], currentState: 'ON' | 'OFF', nowMs: number,
  isHolding: boolean, scheduledAutoTransitionIso: string | null,
): NextTransition | null {
  if (isHolding && scheduledAutoTransitionIso) {
    const ms = new Date(scheduledAutoTransitionIso).getTime();
    const min = Math.max(0, (ms - nowMs) / 60_000);
    return {
      type: (currentState === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON') as 'UTILITY_ON' | 'UTILITY_OFF',
      rangeStartIso: scheduledAutoTransitionIso, rangeEndIso: scheduledAutoTransitionIso,
      rangeLabel: fmtYemenTime(scheduledAutoTransitionIso),
      minFromNowMin: min, maxFromNowMin: min, waitLabel: '', inRangeWindow: min <= 0,
    };
  }
  const target = currentState === 'ON' ? 'OFF' : 'ON';
  for (const slot of schedule) {
    if (slot.state !== target) continue;
    const startMs = new Date(slot.startIso).getTime();
    if (startMs > nowMs) {
      const min = (startMs - nowMs) / 60_000;
      return {
        type: target === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
        rangeStartIso: slot.startIso, rangeEndIso: slot.endIso ?? slot.startIso,
        rangeLabel: slot.shiftedStartFormatted ?? fmtYemenTime(slot.startIso),
        minFromNowMin: Math.max(0, min), maxFromNowMin: Math.max(0, min),
        waitLabel: '', inRangeWindow: min <= 0,
      };
    }
  }
  return null;
}

export function computeReconciledCycleStart(growattTransitionIso: string, offsetMinutes: number): string {
  return new Date(new Date(growattTransitionIso).getTime() + offsetMinutes * 60_000).toISOString();
}

export function computeAccuracyLogEvent(
  predictedTransitionIso: string, actualTransitionIso: string,
  targetState: 'UTILITY_ON' | 'UTILITY_OFF', offsetMinutes: number, exitMode: string,
): AccuracyLogEvent {
  const errorMin = Math.round((new Date(actualTransitionIso).getTime() - new Date(predictedTransitionIso).getTime()) / 60_000);
  return {
    predictedTransitionIso, actualTransitionIso, targetState, offsetMinutes, exitMode,
    errorMinutes: errorMin, accuracyScore: Math.max(0, Math.min(100, 100 - Math.abs(errorMin))),
  };
}

// ─── Type re-exports for backwards compat ───────────────────────────────────
export type { ScheduleStateMode as ATCMode };
