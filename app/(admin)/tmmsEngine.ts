/**
 * tmmsEngine.ts — TMMS V2.2 Personal Timeline Replacement Model
 *
 * Pure TypeScript (zero React dependencies). This is the single source of
 * truth for all ATC state machine logic, offset application, schedule slot
 * generation, community transition computation, and report/confirmation
 * ledger helpers.
 *
 * Shared between:
 *   - hooks/useUserPredictions.ts (production user hook)
 *   - app/(admin)/tmmsSimulation.ts (admin simulation/test runner)
 *   - app/(admin)/predictions.tsx (admin debug view)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.2 OPERATIONAL MODES (7)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  NORMAL               — No offset, no community sync. Standard Growatt
 *                         schedule is used as-is.
 *
 *  PREDICTION_RANGE     — The current time is within the expected transition
 *                         window. Community reports are elevated priority.
 *
 *  UNCERTAIN_ZONE       — Negative-offset user: the predicted OFF has ended
 *                         but Growatt hasn't turned ON yet. Waiting time is
 *                         tracked and will be deducted from the next ON.
 *
 *  COMMUNITY_SYNCED     — The user's timeline is derived from a community
 *                         ON report (either self-report or confirmed YES).
 *                         Validation window starts immediately; Growatt
 *                         signal within the window does NOT override.
 *
 *  WAITING_FOR_GROWATT  — The prediction window has passed and no transition
 *                         signal has arrived. Community reports priority is
 *                         maximum.
 *
 *  GRACE_MODE           — Significantly past the expected transition. The
 *                         state is held and the schedule is rebuilt on the
 *                         next Growatt transition.
 *
 *  POSITIVE_OFFSET_PENDING — Positive-offset user: Growatt has already
 *                            transitioned but the user's scheduled time is
 *                            in the future. Short Verification Window shown
 *                            with HH:MM:SS countdown.
 */

// ── Time / format helpers ──────────────────────────────────────────────────

/**
 * Format an ISO timestamp in Yemen local time (Asia/Aden, UTC+3).
 * Returns a concise HH:MM AM/PM string with Arabic suffix.
 */
export function fmtYemenTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      timeZone: 'Asia/Aden',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).replace('AM', ' ص').replace('PM', ' م');
  } catch {
    return iso;
  }
}

/**
 * Format a duration given in minutes to a human-readable Arabic string.
 * Examples: "45 دقيقة", "1س 30د", "3 ساعات"
 */
export function durationLabelFromMin(totalMin: number): string {
  if (totalMin <= 0) return '—';
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) {
    if (h === 1) return 'ساعة';
    if (h === 2) return 'ساعتان';
    return `${h} ساعات`;
  }
  return `${h}س ${m}د`;
}

// ── Core Types ─────────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export type TransitionMode = 'AUTO' | 'MANUAL';

export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
export type OffsetValue = number | 'PENDING';

export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string | null;
  reporterReliability?: number | null;
  offsetState?: OffsetState;
  offsetValue?: OffsetValue;
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

export interface GeneratedOnInfo {
  startIso: string;
  durationMin: number;
  referenceIso: string;
  referenceKind: 'completed' | 'active';
  inheritsReferenceLifecycle: boolean;
}

export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string;
  durationLabel: string | null;
  zone: 'DAY' | 'NIGHT';
  isEstimated: boolean;
  /** V2.2: slot created from a community ON report */
  isGeneratedOn?: boolean;
  /** V2.2: future ON whose time cannot be pinned (PENDING_NEGATIVE) */
  isEstimatedPendingOffset?: boolean;
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
  statusLine: string;
  scheduledAutoTransitionIso?: string | null;
  inValidationWindow?: boolean;
  validationWindowRemainingMin?: number;
  isInUncertainZone?: boolean;
  uncertainZoneElapsedMin?: number;
  onDurationDeductionMin?: number;
  communityElevated?: boolean;
  transitionMode?: TransitionMode;
  overrunMinutes?: number;
}

export interface AccuracyLogEvent {
  predictedTransitionIso: string;
  actualTransitionIso: string;
  targetState: 'ON' | 'OFF';
  offsetMinutes: number;
  exitMode: string;
  errorMinutes: number;
  accuracyScore: number;
}

export interface UserPrediction {
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  daySchedule: ShiftedScheduleSlot[];
  nextTransition: NextTransition | null;
  confidence: number;
  isUnstable: boolean;
  crisisMode?: boolean;
  crisisReason?: string;
  reasoning?: string[];
  atc: ATCState;
  isHoldingState?: boolean;
  isResynced?: boolean;
  communitySyncMeta?: CommunitySyncMeta | null;
  expectedOnDurationLabel?: string | null;
  expectedOffDurationLabel?: string | null;
  dayPattern?: any;
  nightPattern?: any;
  apppe?: any;
  offsetMinutes?: number;
  /** ISO used for elapsed-time anchoring on the Home Screen */
  anchorStartIso?: string | null;
}

// ── Internal helpers ───────────────────────────────────────────────────────

const YEMEN_TZ = 'Asia/Aden';
const VALIDATION_WINDOW_MS  = 20 * 60 * 1000; // 20 min
const PREDICTION_RANGE_MS   = 30 * 60 * 1000; // ±30 min around expected transition
const GRACE_THRESHOLD_MS    = 90 * 60 * 1000; // 90 min overrun → GRACE_MODE

function nowMs() { return Date.now(); }

function shiftIso(iso: string, shiftMs: number): string {
  return new Date(new Date(iso).getTime() + shiftMs).toISOString();
}

function minMs(min: number): number { return min * 60_000; }

function slotDurationMs(slot: { startIso: string; endIso: string | null }): number {
  if (!slot.endIso) return 0;
  return new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime();
}

function buildSlotFormatted(slot: ShiftedScheduleSlot): ShiftedScheduleSlot {
  return {
    ...slot,
    startFormatted: fmtYemenTime(slot.startIso),
    endFormatted: slot.endIso ? fmtYemenTime(slot.endIso) : null,
    shiftedStartFormatted: fmtYemenTime(slot.startIso),
    shiftedEndFormatted: slot.endIso ? fmtYemenTime(slot.endIso) : null,
  };
}

function getZone(iso: string): 'DAY' | 'NIGHT' {
  const h = parseInt(
    new Date(iso).toLocaleString('en-US', { timeZone: YEMEN_TZ, hour: 'numeric', hour12: false }),
    10,
  );
  return h >= 6 && h < 22 ? 'DAY' : 'NIGHT';
}

function buildShiftedSlot(
  raw: { state: 'ON' | 'OFF'; startIso: string; endIso: string | null; durationLabel?: string | null; zone?: string; isEstimated?: boolean },
  shiftMs: number,
): ShiftedScheduleSlot {
  const startIso = shiftMs !== 0 ? shiftIso(raw.startIso, shiftMs) : raw.startIso;
  const endIso   = raw.endIso ? (shiftMs !== 0 ? shiftIso(raw.endIso, shiftMs) : raw.endIso) : null;
  const durationMs = endIso
    ? new Date(endIso).getTime() - new Date(startIso).getTime()
    : null;
  const durationMin = durationMs !== null ? Math.round(durationMs / 60_000) : null;
  const slot: ShiftedScheduleSlot = {
    state: raw.state,
    startIso,
    endIso,
    startFormatted: fmtYemenTime(startIso),
    endFormatted: endIso ? fmtYemenTime(endIso) : null,
    shiftedStartFormatted: fmtYemenTime(startIso),
    shiftedEndFormatted: endIso ? fmtYemenTime(endIso) : null,
    durationLabel: raw.durationLabel ?? (durationMin !== null ? durationLabelFromMin(durationMin) : null),
    zone: (raw.zone as 'DAY' | 'NIGHT') ?? getZone(startIso),
    isEstimated: raw.isEstimated ?? false,
  };
  return slot;
}

// ── Main engine function ────────────────────────────────────────────────────

/**
 * applyOffsetToPrediction
 *
 * Takes a raw Supabase prediction, applies the user's ATC offset, derives
 * the current TMMS operational mode, and returns a fully-resolved
 * UserPrediction ready for the Home and Schedule screens.
 *
 * @param prediction               Raw prediction from utility_predictions table.
 * @param offsetMinutes            User's personal DSD offset in signed minutes.
 * @param resyncPoint              Active community resync point, or null.
 * @param syncMeta                 CommunitySyncMeta (from resync), or null.
 * @param transitionMode           'AUTO' | 'MANUAL'
 * @param anchorStartIso           State anchor ISO (from useStateAnchor), or null.
 * @param frozenCommunityOffset    Pre-computed frozen offset for resync (Rule Q2-A).
 * @param onOffsetCalculated       Callback when a new community offset is computed.
 * @param nowOverride              Inject current time for tests (default: Date.now()).
 * @param onAccuracyEvent          Callback when an accuracy event should be logged.
 */
export function applyOffsetToPrediction(
  prediction: any,
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
  nowOverride?: number,
  onAccuracyEvent?: (event: AccuracyLogEvent) => void,
): UserPrediction {
  const now = nowOverride ?? Date.now();

  // ── 1. Build base schedule from raw prediction ─────────────────────────
  const rawSchedule: any[] = prediction?.daySchedule ?? [];
  const currentState: 'ON' | 'OFF' = prediction?.currentState ?? 'OFF';
  const lastTransitionAt: string | null = prediction?.lastTransitionAt ?? null;
  const confidence: number = prediction?.confidence ?? 0;
  const isUnstable: boolean = prediction?.isUnstable ?? false;
  const crisisMode: boolean = prediction?.apppe?.crisisActive ?? prediction?.apppe?.crisisMode ?? false;
  const crisisReason: string = prediction?.apppe?.crisisReason ?? '';
  const reasoning: string[] = prediction?.reasoning ?? [];

  // ── 2. Determine effective offset ──────────────────────────────────────
  // Community resync overrides the user's stored offset (Rule Q2-A freeze).
  let effectiveOffset = offsetMinutes;
  let isResynced = false;

  if (resyncPoint && syncMeta) {
    isResynced = true;
    if (frozenCommunityOffset !== null) {
      effectiveOffset = frozenCommunityOffset;
    } else {
      // Community offset not yet frozen — compute it now.
      // We measure the time difference between Growatt's lastTransitionAt
      // and the community syncedAtIso. If resync is ON and Growatt is ON,
      // the offset is the delta.
      if (lastTransitionAt) {
        const growattMs = new Date(lastTransitionAt).getTime();
        const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
        const computed = Math.round((syncMs - growattMs) / 60_000);
        effectiveOffset = computed;
        const sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' =
          computed > 0 ? 'POSITIVE' : computed < 0 ? 'NEGATIVE' : 'NEUTRAL';
        onOffsetCalculated?.(computed, {
          sign,
          referenceIso: lastTransitionAt,
          referenceKind: 'completed',
        });
      }
    }
  }

  const shiftMs = minMs(effectiveOffset);

  // ── 3. Shift the schedule by effectiveOffset ───────────────────────────
  let shiftedSchedule: ShiftedScheduleSlot[] = rawSchedule.map(s =>
    buildShiftedSlot(s, shiftMs),
  );

  // ── 4. Determine current state based on resync or Growatt ──────────────
  let derivedCurrentState: 'ON' | 'OFF' = currentState;
  let currentStateStartIso: string | null = null;

  if (resyncPoint && isResynced) {
    // Community sync overrides current state
    derivedCurrentState = resyncPoint.syncedState;
    currentStateStartIso = resyncPoint.syncedAtIso;
  } else if (lastTransitionAt) {
    // Derive from shifted schedule: find which slot contains `now`
    const nowSlot = shiftedSchedule.find(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return now >= start && now < end;
    });
    if (nowSlot) {
      derivedCurrentState = nowSlot.state;
      currentStateStartIso = nowSlot.startIso;
    } else {
      currentStateStartIso = anchorStartIso ?? lastTransitionAt;
    }
  }

  // Anchor for elapsed-time display
  const effectiveAnchor = anchorStartIso ?? currentStateStartIso ?? lastTransitionAt;

  // ── 5. Compute ATC mode ────────────────────────────────────────────────
  const atc = computeATCMode({
    now,
    derivedCurrentState,
    currentStateStartIso,
    lastTransitionAt,
    effectiveOffset,
    shiftedSchedule,
    resyncPoint,
    transitionMode,
    rawPrediction: prediction,
    frozenCommunityOffset,
  });

  // ── 6. Holding state (keeps current state while countdown runs) ────────
  const isHoldingState =
    atc.mode === 'POSITIVE_OFFSET_PENDING' ||
    atc.mode === 'COMMUNITY_SYNCED' ||
    atc.mode === 'UNCERTAIN_ZONE' ||
    atc.mode === 'WAITING_FOR_GROWATT' ||
    atc.mode === 'GRACE_MODE';

  // ── 7. Find next transition from shifted schedule ─────────────────────
  let nextTransition: NextTransition | null = null;

  if (atc.mode !== 'POSITIVE_OFFSET_PENDING') {
    const nextStateWanted: 'ON' | 'OFF' = derivedCurrentState === 'ON' ? 'OFF' : 'ON';
    const nextSlot = shiftedSchedule.find(s => {
      const start = new Date(s.startIso).getTime();
      return s.state === nextStateWanted && start > now;
    }) ?? null;

    if (nextSlot) {
      const minMs_ = new Date(nextSlot.startIso).getTime() - now;
      const minMin = Math.max(0, Math.round(minMs_ / 60_000));
      // Range: ±15 min around expected
      const startRange = new Date(Math.max(now, new Date(nextSlot.startIso).getTime() - 15 * 60_000)).toISOString();
      const endRange = new Date(new Date(nextSlot.startIso).getTime() + 15 * 60_000).toISOString();
      const inWindow = minMin <= 15;
      nextTransition = {
        type: nextStateWanted === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
        rangeStartIso: startRange,
        rangeEndIso: endRange,
        rangeLabel: `${fmtYemenTime(startRange)} — ${fmtYemenTime(endRange)}`,
        minFromNowMin: Math.max(0, minMin - 15),
        maxFromNowMin: minMin + 15,
        waitLabel: durationLabelFromMin(minMin),
        inRangeWindow: inWindow,
      };
    }
  }

  // ── 8. Build typical duration labels ──────────────────────────────────
  const dayPat = prediction?.dayPattern ?? null;
  const nightPat = prediction?.nightPattern ?? null;
  const activePat = (() => {
    const h = parseInt(
      new Date(now).toLocaleString('en-US', { timeZone: YEMEN_TZ, hour: 'numeric', hour12: false }),
      10,
    );
    return h >= 6 && h < 22 ? dayPat : nightPat;
  })();

  const expectedOnDurationLabel = activePat?.avgOnMin != null
    ? durationLabelFromMin(Math.round(activePat.avgOnMin))
    : null;
  const expectedOffDurationLabel = activePat?.avgOffMin != null
    ? durationLabelFromMin(Math.round(activePat.avgOffMin))
    : null;

  // ── 9. Assemble result ────────────────────────────────────────────────
  return {
    currentState: derivedCurrentState,
    currentStateStartIso: effectiveAnchor,
    daySchedule: shiftedSchedule,
    nextTransition,
    confidence,
    isUnstable,
    crisisMode,
    crisisReason,
    reasoning,
    atc,
    isHoldingState,
    isResynced,
    communitySyncMeta: syncMeta,
    expectedOnDurationLabel,
    expectedOffDurationLabel,
    dayPattern: prediction?.dayPattern ?? null,
    nightPattern: prediction?.nightPattern ?? null,
    apppe: prediction?.apppe ?? null,
    offsetMinutes: effectiveOffset,
    anchorStartIso: effectiveAnchor,
  };
}

// ── ATC Mode computation ───────────────────────────────────────────────────

interface ATCComputeArgs {
  now: number;
  derivedCurrentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  lastTransitionAt: string | null;
  effectiveOffset: number;
  shiftedSchedule: ShiftedScheduleSlot[];
  resyncPoint: ResyncPoint | null;
  transitionMode: TransitionMode;
  rawPrediction: any;
  frozenCommunityOffset: number | null;
}

function computeATCMode(args: ATCComputeArgs): ATCState {
  const {
    now, derivedCurrentState, currentStateStartIso, lastTransitionAt,
    effectiveOffset, shiftedSchedule, resyncPoint, transitionMode,
    rawPrediction, frozenCommunityOffset,
  } = args;

  // ── COMMUNITY_SYNCED ─────────────────────────────────────────────────────
  if (resyncPoint) {
    const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
    const appliedMs = new Date(resyncPoint.appliedAtIso).getTime();
    const elapsed = now - appliedMs;
    const inValidationWindow = elapsed < VALIDATION_WINDOW_MS;
    const remainingMin = Math.max(0, Math.round((VALIDATION_WINDOW_MS - elapsed) / 60_000));

    return {
      mode: 'COMMUNITY_SYNCED',
      statusLine: `مزامنة مجتمعية ${inValidationWindow ? '· نافذة التحقق نشطة' : '· مزامنة مؤكدة'}`,
      inValidationWindow,
      validationWindowRemainingMin: remainingMin,
      communityElevated: true,
      transitionMode,
    };
  }

  // Find the next shifted slot that hasn't started yet
  const upcomingSlots = shiftedSchedule.filter(s =>
    new Date(s.startIso).getTime() > now,
  );
  const nextShiftedSlot = upcomingSlots[0] ?? null;

  // Find the current slot
  const currentSlot = shiftedSchedule.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return now >= start && now < end;
  }) ?? null;

  // ── POSITIVE_OFFSET_PENDING ───────────────────────────────────────────────
  // Growatt has already transitioned but user's scheduled time is future.
  // Applies when effectiveOffset > 0 AND the Growatt transition has occurred
  // but the user's shifted start time is in the future.
  if (effectiveOffset > 0 && lastTransitionAt) {
    const growattTransitionMs = new Date(lastTransitionAt).getTime();
    const userScheduledMs = growattTransitionMs + minMs(effectiveOffset);

    // Growatt has transitioned (in the past) but user's time is in the future
    if (growattTransitionMs <= now && userScheduledMs > now) {
      const nextState: 'ON' | 'OFF' = derivedCurrentState === 'ON' ? 'OFF' : 'ON';
      const scheduledIso = new Date(userScheduledMs).toISOString();
      const remainingMin = Math.max(0, (userScheduledMs - now) / 60_000);

      return {
        mode: 'POSITIVE_OFFSET_PENDING',
        statusLine: `نافذة التحقق القصيرة — سيتحوّل إلى ${nextState === 'ON' ? 'تشغيل' : 'طافية'} في ${fmtYemenTime(scheduledIso)}`,
        scheduledAutoTransitionIso: scheduledIso,
        communityElevated: true,
        transitionMode,
        overrunMinutes: Math.round((now - growattTransitionMs) / 60_000),
      };
    }
  }

  // ── UNCERTAIN_ZONE ────────────────────────────────────────────────────────
  // Negative offset: predicted OFF has ended but Growatt hasn't turned ON.
  if (effectiveOffset < 0 && derivedCurrentState === 'OFF') {
    // The reconciledCycleStartIso = lastTransitionAt + negative offset
    // This simulates having started OFF earlier than Growatt.
    const expectedOnSlot = shiftedSchedule.find(s =>
      s.state === 'ON' && new Date(s.startIso).getTime() > now - minMs(60),
    );
    if (expectedOnSlot && new Date(expectedOnSlot.startIso).getTime() <= now) {
      // We're past the expected ON start — in UNCERTAIN_ZONE
      const elapsedMin = Math.round((now - new Date(expectedOnSlot.startIso).getTime()) / 60_000);
      return {
        mode: 'UNCERTAIN_ZONE',
        statusLine: `منطقة غير مؤكدة — وقت الانتظار: ${elapsedMin} دقيقة`,
        isInUncertainZone: true,
        uncertainZoneElapsedMin: elapsedMin,
        onDurationDeductionMin: elapsedMin,
        communityElevated: true,
        transitionMode,
      };
    }
  }

  // ── PREDICTION_RANGE / WAITING_FOR_GROWATT / GRACE_MODE ──────────────────
  if (nextShiftedSlot) {
    const nextStart = new Date(nextShiftedSlot.startIso).getTime();
    const msUntil = nextStart - now;

    if (msUntil >= 0 && msUntil <= PREDICTION_RANGE_MS) {
      // Within prediction range window
      return {
        mode: 'PREDICTION_RANGE',
        statusLine: `نطاق التوقع نشط — التحوّل خلال ${Math.round(msUntil / 60_000)} دقيقة`,
        communityElevated: true,
        transitionMode,
      };
    }

    if (msUntil < 0) {
      const overrunMin = Math.round(-msUntil / 60_000);
      if (-msUntil > GRACE_THRESHOLD_MS) {
        return {
          mode: 'GRACE_MODE',
          statusLine: `تأخر غير معتاد — ${overrunMin} دقيقة فوق النطاق`,
          overrunMinutes: overrunMin,
          communityElevated: true,
          transitionMode,
        };
      }
      return {
        mode: 'WAITING_FOR_GROWATT',
        statusLine: `بانتظار إشارة الحساس — تجاوزنا التوقع بـ ${overrunMin} دقيقة`,
        overrunMinutes: overrunMin,
        communityElevated: true,
        transitionMode,
      };
    }
  }

  // ── NORMAL ────────────────────────────────────────────────────────────────
  return {
    mode: 'NORMAL',
    statusLine: 'الوضع الطبيعي',
    communityElevated: false,
    transitionMode,
  };
}

// ── Report ledger helpers (used by admin tools) ───────────────────────────

export interface ReportLedgerEntry {
  id: number;
  reporter_id: string;
  reported_state: 'UTILITY_ON' | 'UTILITY_OFF';
  estimated_transition_at: string;
  created_at: string;
  is_active: boolean;
  reporter_username?: string | null;
  reporter_offset_state?: OffsetState | null;
  reporter_offset_value?: OffsetValue | null;
  reporter_timeline_alignment?: string | null;
}

export interface ConfirmationLedgerEntry {
  id: number;
  report_id: number;
  responder_id: string;
  response: 'yes' | 'no' | 'ignore';
  response_delay_sec: number;
  created_at: string;
}

/**
 * computeConfirmationBonus — diminishing bonus curve for confirmation
 * responses. Faster confirmation = higher bonus.
 */
export function computeConfirmationBonus(responseDelaySec: number): number {
  if (responseDelaySec <= 60)  return 1.0;
  if (responseDelaySec <= 300) return 0.8;
  if (responseDelaySec <= 600) return 0.6;
  if (responseDelaySec <= 900) return 0.4;
  return 0.2;
}

/**
 * resolveCommunityCycleStart — given a resync point, compute the
 * "reconciledCycleStartIso" used as the elapsed-time anchor.
 *
 * For NEGATIVE offset: backdated = lastTransitionAt + negative offset.
 * For POSITIVE: scheduledAutoTransitionIso.
 * Fallback: resync point syncedAtIso.
 */
export function resolveCommunityCycleStart(
  resyncPoint: ResyncPoint | null,
  lastTransitionAt: string | null,
  offsetMinutes: number,
): string | null {
  if (!resyncPoint) return null;
  if (offsetMinutes < 0 && lastTransitionAt) {
    const backdated = new Date(lastTransitionAt).getTime() + minMs(offsetMinutes);
    return new Date(backdated).toISOString();
  }
  return resyncPoint.syncedAtIso;
}
