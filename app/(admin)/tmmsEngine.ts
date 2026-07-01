/**
 * tmmsEngine.ts — TMMS V2.1 ATC State Machine (Pure TypeScript)
 *
 * Zero React dependencies. This file is the single source of truth for all
 * ATC state machine logic, offset application, schedule generation,
 * community transition resolution, and report ledger helpers.
 *
 * Consumed by:
 *   - hooks/useUserPredictions.ts  (production UI)
 *   - app/(admin)/tmmsSimulation.ts (admin debug/test tool)
 *   - app/(admin)/predictions.tsx  (per-offset simulation)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ATC OPERATIONAL MODES (ScheduleStateMode)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  NORMAL                — Growatt + community drive transitions normally.
 *  PREDICTION_RANGE      — Now within the predicted transition window.
 *                          Community reports carry elevated priority.
 *  UNCERTAIN_ZONE        — Growatt has held the current state beyond the
 *                          predicted end. Accumulating overrun time.
 *  COMMUNITY_SYNCED      — The user's timeline is on a community branch
 *                          (reporter or YES-approver). Growatt disagreements
 *                          surface as validation-window warnings, not as
 *                          instant state changes.
 *  WAITING_FOR_GROWATT   — Past the UNCERTAIN_ZONE threshold. Engine has
 *                          exceeded the prediction range. Waiting for Growatt
 *                          or community confirmation.
 *  GRACE_MODE            — Growatt flipped but the ATC is in a brief grace
 *                          period before accepting the transition (prevents
 *                          noise-driven false transitions).
 *  POSITIVE_OFFSET_PENDING — User has a positive offset (their scheduled
 *                          transition time is in the future). Growatt has
 *                          already flipped but the user's state is held.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Transition Mode — controls how Growatt signals are weighted */
export type TransitionMode = 'AUTO' | 'MANUAL';

/** ATC operational mode */
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

/** Raw Growatt inverter prediction from Supabase (utility_predictions table) */
export interface Prediction {
  id: number;
  computed_at: string;
  analysis_window_hours?: number;
  prediction: PredictionPayload;
}

export interface PredictionPayload {
  currentState: 'ON' | 'OFF';
  lastTransitionAt: string;
  confidence: number;
  stabilityScore: number;
  stabilityLabel: string;
  learningMode: 'learned' | 'hybrid' | 'estimated';
  daySchedule: RawScheduleSlot[];
  nextTransitionMinutes: number | null;
  nextTransitionRange?: { minMin: number; maxMin: number } | null;
  expectedOnDurationMin?: number | null;
  expectedOffDurationMin?: number | null;
  reasoning?: string[];
  isUnstable?: boolean;
  crisisMode?: boolean;
  crisisReason?: string;
  crisisActive?: boolean;
  // APPPE v4 quality factors
  qualityFactors?: {
    dataQuantity: number;
    stability: number;
    driftStability: number;
    biasStability: number;
    volatility: number;
    crisis: number;
  };
  driftOffset?: number;
  biasRatio?: number;
  volatilityEMA?: number;
}

export interface RawScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso?: string | null;
  isEstimated?: boolean;
  zone?: string;
  durationLabel?: string;
  startFormatted?: string;
  endFormatted?: string;
}

/** Schedule slot after offset/resync shift */
export interface ShiftedScheduleSlot extends RawScheduleSlot {
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string;
  isResynced?: boolean;
}

/** Community sync metadata for the PersonalStatusCard */
export interface CommunitySyncMeta {
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
  reporterName: string | null;
  reporterReliability: number | null;
}

/** Community resync point (from AsyncStorage / ResyncContext) */
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

/** ATC state info attached to UserPrediction */
export interface ATCInfo {
  mode: ScheduleStateMode;
  statusLine: string;
  transitionMode: TransitionMode;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  communityElevated: boolean;
  overrunMinutes: number;
  scheduledAutoTransitionIso?: string | null;
}

/** Engine output: the fully-resolved user prediction */
export interface UserPrediction {
  // Core state
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string;
  resyncedAtIso?: string | null;
  isResynced: boolean;
  isHoldingState: boolean;

  // ATC info
  atc: ATCInfo;

  // Prediction / schedule
  daySchedule: ShiftedScheduleSlot[];
  nextTransition: NextTransition | null;
  confidence: number;
  stabilityScore: number;
  stabilityLabel: string;
  learningMode: 'learned' | 'hybrid' | 'estimated';
  isUnstable: boolean;
  crisisMode: boolean;
  crisisReason?: string;
  offsetMinutes: number;
  computedAt: string;

  // Expected durations (human-readable)
  expectedOnDurationLabel?: string | null;
  expectedOffDurationLabel?: string | null;
  reasoning?: string[];

  // Community sync
  communitySyncMeta: CommunitySyncMeta | null;

  // APPPE v4 quality
  apppe?: any;
  qualityFactors?: any;
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

/** Accuracy log event emitted when an ATC mode exits */
export interface AccuracyLogEvent {
  predictedTransitionIso: string;
  actualTransitionIso: string;
  targetState: 'ON' | 'OFF';
  offsetMinutes: number;
  exitMode: ScheduleStateMode;
  errorMinutes: number;
  accuracyScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Format an ISO timestamp to Yemen local time (HH:MM AM/PM) */
export function fmtYemenTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

/** Convert minutes to a human-readable duration label in Arabic */
export function durationLabelFromMin(minutes: number): string {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) {
    if (h === 1) return 'ساعة';
    if (h === 2) return 'ساعتان';
    return `${h} ساعات`;
  }
  return `${h} س و ${m} د`;
}

/** Get the APPPE zone tag for an ISO timestamp (Yemen time) */
export function getZoneFromIso(iso: string): string {
  const hour = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Aden' })).getHours();
  if (hour >= 5 && hour < 12) return 'MORNING';
  if (hour >= 12 && hour < 17) return 'AFTERNOON';
  if (hour >= 17 && hour < 21) return 'EVENING';
  return 'NIGHT';
}

// ─────────────────────────────────────────────────────────────────────────────
// ATC CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Minutes beyond predicted end before entering UNCERTAIN_ZONE */
const UNCERTAIN_ZONE_THRESHOLD_MIN = 10;
/** Minutes beyond UNCERTAIN_ZONE before entering WAITING_FOR_GROWATT */
const WAITING_FOR_GROWATT_THRESHOLD_MIN = 45;
/** Validation window for COMMUNITY_SYNCED mode (minutes) */
const COMMUNITY_VALIDATION_WINDOW_MIN = 20;
/** Grace mode duration (minutes) — brief hold before accepting Growatt flip */
const GRACE_MODE_DURATION_MIN = 5;

// ─────────────────────────────────────────────────────────────────────────────
// CORE ENGINE FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * applyOffsetToPrediction
 *
 * Takes the raw Growatt/APPPE prediction, applies the user's personal offset
 * and any active community resync point, and returns a fully-resolved
 * UserPrediction with ATC mode, shifted schedule, and next-transition data.
 *
 * This is the single source of truth for all TMMS V2.1 ATC logic.
 *
 * @param prediction             Raw prediction from Supabase (utility_predictions)
 * @param offsetMinutes          User's personal DSD offset in minutes (signed)
 * @param resyncPoint            Active community resync point, or null
 * @param syncMeta               CommunitySyncMeta for UI display, or null
 * @param transitionMode         'AUTO' | 'MANUAL'
 * @param anchorStartIso         Anchor start ISO (from useStateAnchor), or null
 * @param frozenCommunityOffset  Pre-computed frozen community offset, or null
 * @param onOffsetCalculated     Callback when a new community offset is computed
 * @param nowMs                  Current time in milliseconds (for testability)
 * @param onAccuracyEvent        Callback when an accuracy event should be logged
 */
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  syncMeta: CommunitySyncMeta | null,
  transitionMode: TransitionMode,
  anchorStartIso: string | null,
  frozenCommunityOffset: number | null,
  onOffsetCalculated?: (
    computedOffsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
  nowMs: number = Date.now(),
  onAccuracyEvent?: (event: AccuracyLogEvent) => void,
): UserPrediction {
  const payload = prediction.prediction;
  const computedAt = prediction.computed_at;
  const rawGrowattState = payload.currentState;
  const rawLastTransitionAt = payload.lastTransitionAt;

  // ── Build the raw schedule ───────────────────────────────────────────────
  const rawSlots: RawScheduleSlot[] = (payload.daySchedule ?? []).map((s) => ({
    ...s,
    startFormatted: fmtYemenTime(s.startIso),
    endFormatted: s.endIso ? fmtYemenTime(s.endIso) : undefined,
    zone: s.zone ?? getZoneFromIso(s.startIso),
    durationLabel: (() => {
      if (!s.endIso) return undefined;
      const dur = (new Date(s.endIso).getTime() - new Date(s.startIso).getTime()) / 60_000;
      return durationLabelFromMin(dur);
    })(),
  }));

  // ── Determine the effective offset ─────────────────────────────────────
  // Priority: frozen community offset → personal DSD offset
  const effectiveOffset = frozenCommunityOffset !== null
    ? frozenCommunityOffset
    : offsetMinutes;

  // ── COMMUNITY_SYNCED branch ──────────────────────────────────────────────
  if (resyncPoint) {
    return buildCommunitySyncedPrediction(
      payload,
      rawSlots,
      resyncPoint,
      syncMeta,
      transitionMode,
      effectiveOffset,
      frozenCommunityOffset,
      onOffsetCalculated,
      nowMs,
      computedAt,
      onAccuracyEvent,
    );
  }

  // ── Personal offset branch ───────────────────────────────────────────────
  return buildPersonalOffsetPrediction(
    payload,
    rawSlots,
    effectiveOffset,
    transitionMode,
    anchorStartIso,
    nowMs,
    computedAt,
    onAccuracyEvent,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSONAL OFFSET BRANCH
// ─────────────────────────────────────────────────────────────────────────────

function buildPersonalOffsetPrediction(
  payload: PredictionPayload,
  rawSlots: RawScheduleSlot[],
  offsetMinutes: number,
  transitionMode: TransitionMode,
  anchorStartIso: string | null,
  nowMs: number,
  computedAt: string,
  onAccuracyEvent?: (event: AccuracyLogEvent) => void,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;
  const growattState = payload.currentState;
  const growattTransitionMs = new Date(payload.lastTransitionAt).getTime();

  // Apply offset to all schedule slots
  const shiftedSlots: ShiftedScheduleSlot[] = rawSlots.map((s) => {
    const shiftedStart = new Date(new Date(s.startIso).getTime() + offsetMs).toISOString();
    const shiftedEnd = s.endIso
      ? new Date(new Date(s.endIso).getTime() + offsetMs).toISOString()
      : null;
    return {
      ...s,
      startIso: shiftedStart,
      endIso: shiftedEnd ?? undefined,
      shiftedStartFormatted: fmtYemenTime(shiftedStart),
      shiftedEndFormatted: shiftedEnd ? fmtYemenTime(shiftedEnd) : undefined,
    };
  });

  // Determine the user's current state & start time (shifted)
  const shiftedTransitionMs = growattTransitionMs + offsetMs;
  let currentState: 'ON' | 'OFF' = growattState;
  let currentStateStartIso = new Date(shiftedTransitionMs).toISOString();

  // ── POSITIVE OFFSET PENDING check ─────────────────────────────────────────
  // When the user has a positive offset, their scheduled transition time is
  // in the future even though Growatt has already flipped. Hold the PREVIOUS
  // state until the scheduled time.
  const isPositiveOffsetPending = offsetMinutes > 0 && shiftedTransitionMs > nowMs;

  if (isPositiveOffsetPending) {
    // The user holds the state BEFORE the Growatt flip
    currentState = growattState === 'ON' ? 'OFF' : 'ON';
    // currentStateStartIso for the HELD state: use the slot before the flip
    const heldSlot = shiftedSlots.find((s) => {
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return s.state === currentState && end > nowMs - offsetMs * 2 && new Date(s.startIso).getTime() <= nowMs;
    });
    currentStateStartIso = heldSlot?.startIso ?? anchorStartIso ?? new Date(nowMs - offsetMs).toISOString();

    // Inject a synthetic "holding" slot at the front
    const scheduledTransitionIso = new Date(shiftedTransitionMs).toISOString();
    const synthetic: ShiftedScheduleSlot = {
      state: currentState,
      startIso: currentStateStartIso,
      endIso: scheduledTransitionIso,
      startFormatted: fmtYemenTime(currentStateStartIso),
      endFormatted: fmtYemenTime(scheduledTransitionIso),
      shiftedStartFormatted: fmtYemenTime(currentStateStartIso),
      shiftedEndFormatted: fmtYemenTime(scheduledTransitionIso),
      zone: getZoneFromIso(currentStateStartIso),
      durationLabel: durationLabelFromMin(offsetMinutes),
      isEstimated: false,
    };
    shiftedSlots.unshift(synthetic);

    const atc: ATCInfo = {
      mode: 'POSITIVE_OFFSET_PENDING',
      statusLine: `الحساس الرئيسي حوّل حالته — تغييرك المجدول بعد ${offsetMinutes} دقيقة`,
      transitionMode,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      communityElevated: false,
      overrunMinutes: 0,
      scheduledAutoTransitionIso: scheduledTransitionIso,
    };

    const nextTransition = buildNextTransition(shiftedSlots, currentState, nowMs);

    return {
      currentState,
      currentStateStartIso,
      isResynced: false,
      isHoldingState: true,
      atc,
      daySchedule: shiftedSlots,
      nextTransition,
      confidence: payload.confidence ?? 50,
      stabilityScore: payload.stabilityScore ?? 50,
      stabilityLabel: payload.stabilityLabel ?? 'Stable',
      learningMode: payload.learningMode ?? 'estimated',
      isUnstable: payload.isUnstable ?? false,
      crisisMode: payload.crisisMode ?? payload.crisisActive ?? false,
      crisisReason: payload.crisisReason,
      offsetMinutes,
      computedAt,
      expectedOnDurationLabel: payload.expectedOnDurationMin
        ? durationLabelFromMin(payload.expectedOnDurationMin)
        : null,
      expectedOffDurationLabel: payload.expectedOffDurationMin
        ? durationLabelFromMin(payload.expectedOffDurationMin)
        : null,
      reasoning: payload.reasoning,
      communitySyncMeta: null,
      resyncedAtIso: null,
      qualityFactors: payload.qualityFactors,
    };
  }

  // ── Negative offset — UNCERTAIN_ZONE with backdated start ─────────────────
  const hasNegativeOffset = offsetMinutes < 0;
  let reconciledCycleStartIso: string | null = null;
  if (hasNegativeOffset) {
    reconciledCycleStartIso = new Date(growattTransitionMs + offsetMs).toISOString();
    currentStateStartIso = reconciledCycleStartIso;
  }

  // ── Determine ATC mode based on current slot progress ─────────────────────
  const activeSlot = shiftedSlots.find((s) => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;

  const atc = derivePersonalAtcMode(
    currentState,
    activeSlot,
    shiftedSlots,
    transitionMode,
    nowMs,
  );

  const nextTransition = buildNextTransition(shiftedSlots, currentState, nowMs);

  return {
    currentState,
    currentStateStartIso: anchorStartIso ?? currentStateStartIso,
    isResynced: false,
    isHoldingState: atc.mode !== 'NORMAL',
    atc,
    daySchedule: shiftedSlots,
    nextTransition,
    confidence: payload.confidence ?? 50,
    stabilityScore: payload.stabilityScore ?? 50,
    stabilityLabel: payload.stabilityLabel ?? 'Stable',
    learningMode: payload.learningMode ?? 'estimated',
    isUnstable: payload.isUnstable ?? false,
    crisisMode: payload.crisisMode ?? payload.crisisActive ?? false,
    crisisReason: payload.crisisReason,
    offsetMinutes,
    computedAt,
    expectedOnDurationLabel: payload.expectedOnDurationMin
      ? durationLabelFromMin(payload.expectedOnDurationMin)
      : null,
    expectedOffDurationLabel: payload.expectedOffDurationMin
      ? durationLabelFromMin(payload.expectedOffDurationMin)
      : null,
    reasoning: payload.reasoning,
    communitySyncMeta: null,
    resyncedAtIso: null,
    qualityFactors: payload.qualityFactors,
  };
}

function derivePersonalAtcMode(
  currentState: 'ON' | 'OFF',
  activeSlot: ShiftedScheduleSlot | null,
  allSlots: ShiftedScheduleSlot[],
  transitionMode: TransitionMode,
  nowMs: number,
): ATCInfo {
  if (!activeSlot || !activeSlot.endIso) {
    return {
      mode: 'NORMAL',
      statusLine: 'الحالة الطبيعية',
      transitionMode,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      communityElevated: false,
      overrunMinutes: 0,
    };
  }

  const endMs = new Date(activeSlot.endIso).getTime();
  const overrunMin = Math.max(0, (nowMs - endMs) / 60_000);

  // Slot end is in the past — we're in overrun
  if (nowMs > endMs) {
    if (overrunMin < UNCERTAIN_ZONE_THRESHOLD_MIN) {
      return {
        mode: 'PREDICTION_RANGE',
        statusLine: 'نطاق التوقع نشط — التغيير محتمل الآن',
        transitionMode,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        communityElevated: true,
        overrunMinutes: overrunMin,
      };
    }
    if (overrunMin < UNCERTAIN_ZONE_THRESHOLD_MIN + WAITING_FOR_GROWATT_THRESHOLD_MIN) {
      return {
        mode: 'UNCERTAIN_ZONE',
        statusLine: `تجاوزنا نطاق التوقع بـ ${Math.ceil(overrunMin)} دقيقة`,
        transitionMode,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        communityElevated: true,
        overrunMinutes: overrunMin,
      };
    }
    return {
      mode: 'WAITING_FOR_GROWATT',
      statusLine: 'بانتظار تأكيد من Growatt أو المجتمع',
      transitionMode,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      communityElevated: true,
      overrunMinutes: overrunMin,
    };
  }

  // Approaching slot end (within 15 min)
  const minToEnd = (endMs - nowMs) / 60_000;
  if (minToEnd <= 15) {
    return {
      mode: 'PREDICTION_RANGE',
      statusLine: 'نطاق التوقع يبدأ قريباً',
      transitionMode,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      communityElevated: false,
      overrunMinutes: 0,
    };
  }

  return {
    mode: 'NORMAL',
    statusLine: 'الحالة الطبيعية',
    transitionMode,
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
    communityElevated: false,
    overrunMinutes: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMUNITY SYNCED BRANCH
// ─────────────────────────────────────────────────────────────────────────────

function buildCommunitySyncedPrediction(
  payload: PredictionPayload,
  rawSlots: RawScheduleSlot[],
  resyncPoint: ResyncPoint,
  syncMeta: CommunitySyncMeta | null,
  transitionMode: TransitionMode,
  effectiveOffset: number,
  frozenCommunityOffset: number | null,
  onOffsetCalculated?: (
    computedOffsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
  nowMs: number,
  computedAt: string,
  onAccuracyEvent?: (event: AccuracyLogEvent) => void,
): UserPrediction {
  const syncedAtMs = new Date(resyncPoint.syncedAtIso).getTime();
  const syncedState = resyncPoint.syncedState;

  // Compute the community offset if not yet frozen
  if (frozenCommunityOffset === null && onOffsetCalculated) {
    const growattTransitionMs = new Date(payload.lastTransitionAt).getTime();
    const computedOffset = Math.round((syncedAtMs - growattTransitionMs) / 60_000);
    const sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' =
      computedOffset > 0 ? 'POSITIVE' : computedOffset < 0 ? 'NEGATIVE' : 'NEUTRAL';
    onOffsetCalculated(computedOffset, {
      sign,
      referenceIso: payload.lastTransitionAt,
      referenceKind: 'completed',
    });
  }

  const offsetMs = effectiveOffset * 60_000;

  // Build the shifted schedule from the resync point
  const shiftedSlots: ShiftedScheduleSlot[] = rawSlots.map((s) => {
    const shiftedStart = new Date(new Date(s.startIso).getTime() + offsetMs).toISOString();
    const shiftedEnd = s.endIso
      ? new Date(new Date(s.endIso).getTime() + offsetMs).toISOString()
      : null;
    return {
      ...s,
      startIso: shiftedStart,
      endIso: shiftedEnd ?? undefined,
      shiftedStartFormatted: fmtYemenTime(shiftedStart),
      shiftedEndFormatted: shiftedEnd ? fmtYemenTime(shiftedEnd) : undefined,
      isResynced: true,
    };
  });

  // Mark the resynced slot
  const resyncedSlotIdx = shiftedSlots.findIndex(
    (s) => s.state === syncedState && Math.abs(new Date(s.startIso).getTime() - syncedAtMs) < 30 * 60_000,
  );
  if (resyncedSlotIdx >= 0) {
    shiftedSlots[resyncedSlotIdx] = { ...shiftedSlots[resyncedSlotIdx], isResynced: true };
  }

  // Determine whether we're in the validation window
  const ageMs = nowMs - syncedAtMs;
  const inValidationWindow = ageMs < COMMUNITY_VALIDATION_WINDOW_MIN * 60_000;
  const validationWindowRemainingMin = inValidationWindow
    ? Math.ceil((COMMUNITY_VALIDATION_WINDOW_MIN * 60_000 - ageMs) / 60_000)
    : 0;

  const atc: ATCInfo = {
    mode: 'COMMUNITY_SYNCED',
    statusLine: 'تمت مزامنة الحالة مجتمعياً',
    transitionMode,
    inValidationWindow,
    validationWindowRemainingMin,
    communityElevated: false,
    overrunMinutes: 0,
  };

  const nextTransition = buildNextTransition(shiftedSlots, syncedState, nowMs);

  return {
    currentState: syncedState,
    currentStateStartIso: resyncPoint.syncedAtIso,
    resyncedAtIso: resyncPoint.syncedAtIso,
    isResynced: true,
    isHoldingState: false,
    atc,
    daySchedule: shiftedSlots,
    nextTransition,
    confidence: payload.confidence ?? 50,
    stabilityScore: payload.stabilityScore ?? 50,
    stabilityLabel: payload.stabilityLabel ?? 'Stable',
    learningMode: payload.learningMode ?? 'estimated',
    isUnstable: payload.isUnstable ?? false,
    crisisMode: payload.crisisMode ?? payload.crisisActive ?? false,
    crisisReason: payload.crisisReason,
    offsetMinutes: effectiveOffset,
    computedAt,
    expectedOnDurationLabel: payload.expectedOnDurationMin
      ? durationLabelFromMin(payload.expectedOnDurationMin)
      : null,
    expectedOffDurationLabel: payload.expectedOffDurationMin
      ? durationLabelFromMin(payload.expectedOffDurationMin)
      : null,
    reasoning: payload.reasoning,
    communitySyncMeta: syncMeta,
    qualityFactors: payload.qualityFactors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEXT TRANSITION BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildNextTransition(
  slots: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  nowMs: number,
): NextTransition | null {
  const nextState = currentState === 'ON' ? 'OFF' : 'ON';
  const nextSlot = slots.find(
    (s) => s.state === nextState && new Date(s.startIso).getTime() > nowMs - 5 * 60_000,
  );
  if (!nextSlot) return null;

  const startMs = new Date(nextSlot.startIso).getTime();
  const endMs = nextSlot.endIso ? new Date(nextSlot.endIso).getTime() : startMs + 60 * 60_000;
  const minFromNow = Math.max(0, (startMs - nowMs) / 60_000);
  const maxFromNow = Math.max(0, (endMs - nowMs) / 60_000);
  const inRangeWindow = nowMs >= startMs - 5 * 60_000 && nowMs <= endMs;

  const waitMin = Math.round(minFromNow);
  const waitH = Math.floor(waitMin / 60);
  const waitM = waitMin % 60;
  const waitLabel = waitH > 0
    ? `${waitH} س و ${waitM} د`
    : `${waitM} دقيقة`;

  return {
    type: nextState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
    rangeStartIso: nextSlot.startIso,
    rangeEndIso: nextSlot.endIso ?? new Date(endMs).toISOString(),
    rangeLabel: `${fmtYemenTime(nextSlot.startIso)} — ${nextSlot.endIso ? fmtYemenTime(nextSlot.endIso) : '…'}`,
    minFromNowMin: minFromNow,
    maxFromNowMin: maxFromNow,
    waitLabel,
    inRangeWindow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEDGER HELPERS (for admin/community features)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a diminishing bonus score for a confirmed report.
 * Used by the reliability engine to reward early confirmations more.
 */
export function computeConfirmationBonus(
  confirmationDelayMin: number,
  reporterReliabilityScore: number,
): number {
  const maxBonus = 10;
  const decayFactor = Math.exp(-confirmationDelayMin / 30);
  const reliabilityWeight = Math.max(0.5, reporterReliabilityScore / 100);
  return Math.round(maxBonus * decayFactor * reliabilityWeight * 10) / 10;
}

/**
 * Compute a trust-level score from reliability metrics.
 * Returns 'high' | 'medium' | 'low'.
 */
export function getTrustLevel(
  reliabilityScore: number,
  acceptedReports: number,
): 'high' | 'medium' | 'low' {
  if (reliabilityScore >= 75 && acceptedReports >= 5) return 'high';
  if (reliabilityScore >= 50 && acceptedReports >= 2) return 'medium';
  return 'low';
}
