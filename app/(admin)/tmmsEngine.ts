/**
 * TMMS Engine V2 — pure TypeScript, zero React dependencies.
 * ════════════════════════════════════════════════════════════════════════════
 * Implements:
 *   • ATC state machine (7 modes)
 *   • Offset application & reconciliation
 *   • Community transition logic (generated cycles, offset calc)
 *   • Report / confirmation ledger helpers
 *   • Utility formatters
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Core types ────────────────────────────────────────────────────────────────

export type TransitionMode = 'AUTO' | 'MANUAL';

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'POSITIVE_OFFSET_PENDING'
  | 'COMMUNITY_SYNCED'
  | 'GRACE_MODE'
  | 'WAITING_FOR_GROWATT';

export interface ScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string;
  startFormatted: string;
  endFormatted: string;
  durationLabel: string;
  zone: string;
  isEstimated: boolean;
}

export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string;
  reporterReliability?: number;
}

export interface ATCState {
  mode: ScheduleStateMode;
  transitionMode: TransitionMode;
  scheduledAutoTransitionIso: string | null;
  modeReason?: string;
}

export interface DecisionStep {
  step: string;
  value: unknown;
}

export interface Confirmation {
  confirmerName: string;
  confirmedAtIso: string;
  hoursAfterReport: number;
  bonusScore: number;
}

export type TrustLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERIFIED';

export interface ReportRecord {
  id: string;
  state: 'ON' | 'OFF';
  originalReportAtIso: string;
  reporterName: string;
  confirmations: Confirmation[];
  confidenceScore: number;
  trustLevel: TrustLevel;
  isActive: boolean;
}

export interface CommunityTransitionMeta {
  generatedCycleActive: boolean;
  generatedCycleStartIso: string;
  generatedCycleEndIso: string;
  generatedCycleState: 'ON' | 'OFF';
  offsetSign: 'POSITIVE' | 'NEGATIVE' | 'ZERO' | null;
  offsetReferenceKind: string | null;
  offsetReferenceIso: string | null;
  durationSelectionRule: string | null;
  computedOffsetMin: number | null;
  decisionTrace: DecisionStep[];
}

export interface Prediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string;
  inverterOffline: boolean;
  nextTransition: {
    type: 'UTILITY_ON' | 'UTILITY_OFF';
    rangeLabel: string;
    rangeStartIso: string;
    rangeEndIso: string;
    minFromNowMin: number;
    maxFromNowMin: number;
    waitLabel: string;
    inRangeWindow: boolean;
  } | null;
  expectedOffRange: { minMin: number; maxMin: number } | null;
  expectedOnRange: { minMin: number; maxMin: number } | null;
  daySchedule: ScheduleSlot[];
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  dayPattern: { avgOnMin: number; avgOffMin: number } | null;
  nightPattern: { avgOnMin: number; avgOffMin: number } | null;
  allPattern: { avgOnMin: number; avgOffMin: number } | null;
  cyclesAnalyzed: number;
  dayCyclesAnalyzed: number;
  nightCyclesAnalyzed: number;
  currentPeriod: string;
  reasoning: string[];
  learningMode: string;
  dataWindowHours: number;
  computedAt: string;
  apppe: {
    crisisActive: boolean;
    crisisMode: boolean;
    crisisReason: string | null;
  };
}

export interface UserPrediction extends Prediction {
  atc: ATCState;
  currentStateStartIso: string;
  reconciledCycleStartIso: string | null;
  communityTransitionMeta: CommunityTransitionMeta | null;
}

// ── Utility formatters ────────────────────────────────────────────────────────

export function fmtYemenTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ar-SA', {
      timeZone: 'Asia/Aden',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function durationLabelFromMin(minutes: number): string {
  if (minutes <= 0) return '0د';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}د`;
  if (m === 0) return `${h}س`;
  return `${h}س ${m}د`;
}

export function getZoneFromIso(iso: string): string {
  try {
    const hour = new Date(iso).getHours();
    return hour >= 6 && hour < 18 ? 'day' : 'night';
  } catch {
    return 'day';
  }
}

// ── Trust level helper ────────────────────────────────────────────────────────

function trustFromScore(score: number): TrustLevel {
  if (score >= 90) return 'VERIFIED';
  if (score >= 75) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  return 'LOW';
}

// ── Report ledger helpers ─────────────────────────────────────────────────────

let _reportSeq = 0;
function newReportId(): string {
  return `rpt_${Date.now()}_${(++_reportSeq).toString(36)}`;
}

export function createReportRecord(
  state: 'ON' | 'OFF',
  nowIso: string,
  reporterName: string,
  isVerified: boolean,
  _appliedAtIso: string,
): ReportRecord {
  const baseScore = isVerified ? 70 : 55;
  return {
    id: newReportId(),
    state,
    originalReportAtIso: nowIso,
    reporterName,
    confirmations: [],
    confidenceScore: baseScore,
    trustLevel: trustFromScore(baseScore),
    isActive: true,
  };
}

/** Finds a report matching `state` that was created within 24 hours of `confirmMs`. */
export function findConfirmableReport(
  reports: ReportRecord[],
  state: 'ON' | 'OFF',
  confirmMs: number,
): ReportRecord | null {
  const windowMs = 24 * 60 * 60 * 1000;
  // Most recent matching report first
  const candidates = [...reports]
    .filter(r => r.state === state && r.isActive)
    .filter(r => {
      const reportMs = new Date(r.originalReportAtIso).getTime();
      return confirmMs - reportMs <= windowMs && confirmMs >= reportMs;
    })
    .sort((a, b) =>
      new Date(b.originalReportAtIso).getTime() - new Date(a.originalReportAtIso).getTime()
    );
  return candidates[0] ?? null;
}

/** Bumps confidence on a report and records the confirmation. Caps at 99. */
export function applyConfirmationToReport(
  report: ReportRecord,
  confirmedAtIso: string,
  confirmerName: string,
): ReportRecord {
  const reportMs = new Date(report.originalReportAtIso).getTime();
  const confirmMs = new Date(confirmedAtIso).getTime();
  const hoursAfterReport = Math.max(0, (confirmMs - reportMs) / 3_600_000);

  // Diminishing returns: first confirm = 15pts, each subsequent = 8pts, capped at 3pts floor
  const existingCount = report.confirmations.length;
  const bonus = Math.max(3, 15 - existingCount * 7);

  const newScore = Math.min(99, report.confidenceScore + bonus);

  const confirmation: Confirmation = {
    confirmerName,
    confirmedAtIso,
    hoursAfterReport,
    bonusScore: bonus,
  };

  return {
    ...report,
    confidenceScore: newScore,
    trustLevel: trustFromScore(newScore),
    confirmations: [...report.confirmations, confirmation],
  };
}

// ── Schedule slot lookup ──────────────────────────────────────────────────────

function findSlotAt(slots: ScheduleSlot[], ms: number): ScheduleSlot | null {
  for (const s of slots) {
    const st = new Date(s.startIso).getTime();
    const en = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (ms >= st && ms < en) return s;
  }
  return null;
}

/** Returns the slot ending AFTER `ms` (first future slot boundary). */
function findNextSlotBoundary(slots: ScheduleSlot[], ms: number): ScheduleSlot | null {
  for (const s of slots) {
    const st = new Date(s.startIso).getTime();
    if (st > ms) return s;
  }
  return null;
}

// ── Community transition logic ────────────────────────────────────────────────

/**
 * Compute community transition meta given:
 *   • resyncPoint  — the anchoring event
 *   • prediction   — raw Growatt prediction with schedule
 *   • nowMs        — simulated clock
 *   • frozenOffset — previously computed offset (null = compute fresh)
 *
 * Returns { meta, computedOffsetMin, wasFresh }.
 */
function computeCommunityTransition(
  resyncPoint: ResyncPoint,
  prediction: Prediction,
  nowMs: number,
  frozenOffset: number | null,
): {
  meta: CommunityTransitionMeta;
  computedOffsetMin: number | null;
} {
  const trace: DecisionStep[] = [];

  const syncMs = new Date(resyncPoint.syncedAtIso).getTime();

  // Guard: resync point is in the future — ignore it
  if (syncMs > nowMs + 60_000) {
    return {
      meta: {
        generatedCycleActive: false,
        generatedCycleStartIso: resyncPoint.syncedAtIso,
        generatedCycleEndIso: resyncPoint.syncedAtIso,
        generatedCycleState: resyncPoint.syncedState,
        offsetSign: null,
        offsetReferenceKind: null,
        offsetReferenceIso: null,
        durationSelectionRule: null,
        computedOffsetMin: null,
        decisionTrace: [{ step: 'GUARD_FUTURE_RESYNC', value: resyncPoint.syncedAtIso }],
      },
      computedOffsetMin: null,
    };
  }

  const reportedState = resyncPoint.syncedState;
  const growattState = prediction.currentState;
  const growattLastTransitionMs = new Date(prediction.lastTransitionAt).getTime();

  trace.push({ step: 'REPORTED_STATE', value: reportedState });
  trace.push({ step: 'GROWATT_STATE', value: growattState });
  trace.push({ step: 'SYNC_MS', value: syncMs });

  // ── Duration selection (Rule 3) ───────────────────────────────────────────
  // Determine how long the generated cycle should last.
  let durationMs = 0;
  let durationRule: string | null = null;
  let offsetReferenceKind: string | null = null;
  let offsetReferenceIso: string | null = null;

  const onDurMin = prediction.allPattern?.avgOnMin ?? prediction.dayPattern?.avgOnMin ?? 120;
  const offDurMin = prediction.allPattern?.avgOffMin ?? prediction.dayPattern?.avgOffMin ?? 360;

  if (reportedState === 'ON') {
    // ON interruption: always use "before" ON slot duration
    durationMs = onDurMin * 60_000;
    durationRule = 'ON_ALWAYS_BEFORE';
    trace.push({ step: 'DURATION_RULE', value: durationRule });

    // Offset reference: where does Growatt say ON started?
    if (growattState === 'ON') {
      // Same state — reference the actual Growatt ON start
      offsetReferenceKind = 'GROWATT_ON_START_ACTUAL';
      offsetReferenceIso = prediction.lastTransitionAt;
    } else {
      // Growatt is OFF, so ON ended — reference Growatt ON end (= OFF start)
      offsetReferenceKind = 'GROWATT_ON_END_ACTUAL';
      offsetReferenceIso = prediction.lastTransitionAt;
    }
  } else {
    // OFF interruption: rule depends on progress through ON slot
    if (growattState === 'ON') {
      const elapsedMs = nowMs - growattLastTransitionMs;
      const elapsedMin = elapsedMs / 60_000;
      const progress = elapsedMin / Math.max(1, onDurMin);

      trace.push({ step: 'OFF_PROGRESS', value: progress });

      if (progress < 0.5) {
        durationMs = offDurMin * 60_000;
        durationRule = 'OFF_PROGRESS_LT_50_BEFORE';
        // Reference: expected ON end
        const expectedOnEndMs = growattLastTransitionMs + onDurMin * 60_000;
        offsetReferenceKind = 'GROWATT_ON_END_EXPECTED';
        offsetReferenceIso = new Date(expectedOnEndMs).toISOString();
      } else {
        durationMs = offDurMin * 60_000;
        durationRule = 'OFF_PROGRESS_GT_50_AFTER';
        offsetReferenceKind = 'GROWATT_ON_END_EXPECTED';
        const expectedOnEndMs = growattLastTransitionMs + onDurMin * 60_000;
        offsetReferenceIso = new Date(expectedOnEndMs).toISOString();
      }
    } else {
      // Growatt is also OFF — same state
      durationMs = offDurMin * 60_000;
      durationRule = 'OFF_SAME_STATE';
      offsetReferenceKind = 'GROWATT_OFF_START_ACTUAL';
      offsetReferenceIso = prediction.lastTransitionAt;
    }
  }

  trace.push({ step: 'DURATION_MS', value: durationMs });
  trace.push({ step: 'OFFSET_REFERENCE_KIND', value: offsetReferenceKind });

  const generatedCycleStartIso = resyncPoint.syncedAtIso;
  const generatedCycleEndMs = syncMs + durationMs;
  const generatedCycleEndIso = new Date(generatedCycleEndMs).toISOString();
  const generatedCycleActive = nowMs < generatedCycleEndMs;

  trace.push({ step: 'GENERATED_CYCLE_ACTIVE', value: generatedCycleActive });

  // ── Offset calculation (Rules 4+5) ────────────────────────────────────────
  let computedOffsetMin: number | null = frozenOffset;

  if (frozenOffset === null && offsetReferenceIso !== null) {
    const refMs = new Date(offsetReferenceIso).getTime();
    const diffMs = syncMs - refMs;
    computedOffsetMin = Math.round(diffMs / 60_000);

    // Determine sign
    trace.push({ step: 'COMPUTED_OFFSET_MIN', value: computedOffsetMin });
  }

  const offsetSign: CommunityTransitionMeta['offsetSign'] =
    computedOffsetMin === null ? null :
    computedOffsetMin > 0 ? 'POSITIVE' :
    computedOffsetMin < 0 ? 'NEGATIVE' : 'ZERO';

  return {
    meta: {
      generatedCycleActive,
      generatedCycleStartIso,
      generatedCycleEndIso,
      generatedCycleState: reportedState,
      offsetSign,
      offsetReferenceKind,
      offsetReferenceIso,
      durationSelectionRule: durationRule,
      computedOffsetMin,
      decisionTrace: trace,
    },
    computedOffsetMin,
  };
}

// ── Main ATC state machine ────────────────────────────────────────────────────

const PREDICTION_RANGE_MIN = 15;  // ±15 min around slot boundary
const GRACE_THRESHOLD_MIN  = 30;  // overrun ≤ 30 min = GRACE, > 30 = WAITING

/**
 * Apply offset logic to a raw Growatt prediction.
 *
 * @param prediction        Raw APPPE prediction
 * @param offsetMinutes     User's time offset (negative = behind Growatt)
 * @param resyncPoint       Community resync anchor (null = none)
 * @param _stateAnchor      Unused (reserved for future use)
 * @param transitionMode    'AUTO' | 'MANUAL'
 * @param _pinnedTiming     Unused
 * @param frozenOffset      Previously frozen community offset
 * @param setFrozenOffset   Callback to persist new frozen offset
 * @param nowMs             Simulated clock (defaults to Date.now())
 */
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  _stateAnchor: unknown,
  transitionMode: TransitionMode,
  _pinnedTiming: unknown,
  frozenOffset: number | null,
  setFrozenOffset: (min: number) => void,
  nowMs: number = Date.now(),
): UserPrediction {

  const trace: DecisionStep[] = [];
  const schedule = prediction.daySchedule;
  const growattState = prediction.currentState;
  const growattLastTransitionMs = new Date(prediction.lastTransitionAt).getTime();

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Community transition (highest priority when active)
  // ─────────────────────────────────────────────────────────────────────────
  if (resyncPoint) {
    const { meta, computedOffsetMin } = computeCommunityTransition(
      resyncPoint, prediction, nowMs, frozenOffset,
    );

    // Freeze the offset if we freshly computed it
    if (computedOffsetMin !== null && frozenOffset === null) {
      setFrozenOffset(computedOffsetMin);
    }

    if (meta.generatedCycleActive) {
      const currentState = meta.generatedCycleState;
      const currentStateStartIso = meta.generatedCycleStartIso;

      const atc: ATCState = {
        mode: 'COMMUNITY_SYNCED',
        transitionMode,
        scheduledAutoTransitionIso: null,
        modeReason: 'active generated cycle from community report',
      };

      return {
        ...prediction,
        currentState,
        currentStateStartIso,
        atc,
        reconciledCycleStartIso: null,
        communityTransitionMeta: meta,
      };
    }

    // Generated cycle ended — fall through to normal ATC with community meta attached
    const communityMeta = meta;

    // Continue to normal ATC logic below, but attach the meta
    return _computeNormalATC(
      prediction, offsetMinutes, transitionMode, nowMs,
      growattState, growattLastTransitionMs, schedule, trace, communityMeta,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Normal ATC (no active community resync)
  // ─────────────────────────────────────────────────────────────────────────
  return _computeNormalATC(
    prediction, offsetMinutes, transitionMode, nowMs,
    growattState, growattLastTransitionMs, schedule, trace, null,
  );
}

function _computeNormalATC(
  prediction: Prediction,
  offsetMinutes: number,
  transitionMode: TransitionMode,
  nowMs: number,
  growattState: 'ON' | 'OFF',
  growattLastTransitionMs: number,
  schedule: ScheduleSlot[],
  trace: DecisionStep[],
  communityMeta: CommunityTransitionMeta | null,
): UserPrediction {
  // The user's effective clock relative to Growatt
  const userNowMs = nowMs - offsetMinutes * 60_000;

  // Find the Growatt current slot
  const growattSlot = findSlotAt(schedule, nowMs);
  // Find the user-adjusted current slot
  const userSlot = findSlotAt(schedule, userNowMs);

  trace.push({ step: 'OFFSET_MIN', value: offsetMinutes });
  trace.push({ step: 'GROWATT_STATE', value: growattState });
  trace.push({ step: 'GROWATT_SLOT_STATE', value: growattSlot?.state ?? null });
  trace.push({ step: 'USER_SLOT_STATE', value: userSlot?.state ?? null });

  // ── Positive offset: Growatt has already flipped, user hasn't yet ─────────
  if (offsetMinutes > 0 && transitionMode === 'AUTO') {
    // Check if Growatt flipped WITHIN the last offsetMinutes
    const msSinceGrowattFlip = nowMs - growattLastTransitionMs;
    const offsetMs = offsetMinutes * 60_000;

    if (msSinceGrowattFlip >= 0 && msSinceGrowattFlip < offsetMs) {
      // User is still "holding" the previous state
      const heldState: 'ON' | 'OFF' = growattState === 'ON' ? 'OFF' : 'ON';
      const scheduledAutoTransitionIso = new Date(growattLastTransitionMs + offsetMs).toISOString();

      const atc: ATCState = {
        mode: 'POSITIVE_OFFSET_PENDING',
        transitionMode,
        scheduledAutoTransitionIso,
        modeReason: `holding ${heldState} until +${offsetMinutes}min offset elapses`,
      };

      trace.push({ step: 'MODE', value: 'POSITIVE_OFFSET_PENDING' });

      return {
        ...prediction,
        currentState: heldState,
        currentStateStartIso: prediction.lastTransitionAt,
        atc,
        reconciledCycleStartIso: null,
        communityTransitionMeta: communityMeta,
      };
    }
  }

  // ── Negative offset: user's slot may have already ended ──────────────────
  if (offsetMinutes < 0) {
    const absOffset = Math.abs(offsetMinutes);
    // User's adjusted slot end: Growatt slot end - |offset|
    if (growattSlot?.endIso) {
      const growattSlotEndMs = new Date(growattSlot.endIso).getTime();
      const userSlotEndMs = growattSlotEndMs - absOffset * 60_000;

      if (nowMs >= userSlotEndMs && growattState === growattSlot.state) {
        // User's slot has ended but Growatt hasn't transitioned yet → UNCERTAIN_ZONE
        const reconciledCycleStartIso = new Date(growattLastTransitionMs - absOffset * 60_000).toISOString();

        const atc: ATCState = {
          mode: 'UNCERTAIN_ZONE',
          transitionMode,
          scheduledAutoTransitionIso: null,
          modeReason: `user slot ended ${Math.round((nowMs - userSlotEndMs) / 60_000)}min ago`,
        };

        trace.push({ step: 'MODE', value: 'UNCERTAIN_ZONE' });

        return {
          ...prediction,
          currentState: growattState, // held state
          currentStateStartIso: prediction.lastTransitionAt,
          atc,
          reconciledCycleStartIso,
          communityTransitionMeta: communityMeta,
        };
      }
    } else if (!growattSlot) {
      // No current slot found — we may be in a gap (overrun) → UNCERTAIN_ZONE
      const atc: ATCState = {
        mode: 'UNCERTAIN_ZONE',
        transitionMode,
        scheduledAutoTransitionIso: null,
        modeReason: 'no current growatt slot, negative offset',
      };

      return {
        ...prediction,
        currentState: growattState,
        currentStateStartIso: prediction.lastTransitionAt,
        atc,
        reconciledCycleStartIso: new Date(growattLastTransitionMs - Math.abs(offsetMinutes) * 60_000).toISOString(),
        communityTransitionMeta: communityMeta,
      };
    }
  }

  // ── Check schedule slot overrun ───────────────────────────────────────────
  if (growattSlot?.endIso) {
    const slotEndMs = new Date(growattSlot.endIso).getTime();
    const overrunMs = nowMs - slotEndMs;

    if (overrunMs > 0) {
      const overrunMin = overrunMs / 60_000;
      trace.push({ step: 'OVERRUN_MIN', value: overrunMin });

      if (overrunMin > GRACE_THRESHOLD_MIN) {
        const atc: ATCState = {
          mode: 'WAITING_FOR_GROWATT',
          transitionMode,
          scheduledAutoTransitionIso: null,
          modeReason: `overrun ${Math.round(overrunMin)}min > ${GRACE_THRESHOLD_MIN}min threshold`,
        };
        trace.push({ step: 'MODE', value: 'WAITING_FOR_GROWATT' });

        return {
          ...prediction,
          currentState: growattState,
          currentStateStartIso: prediction.lastTransitionAt,
          atc,
          reconciledCycleStartIso: null,
          communityTransitionMeta: communityMeta,
        };
      } else {
        const atc: ATCState = {
          mode: 'GRACE_MODE',
          transitionMode,
          scheduledAutoTransitionIso: null,
          modeReason: `overrun ${Math.round(overrunMin)}min within grace period`,
        };
        trace.push({ step: 'MODE', value: 'GRACE_MODE' });

        return {
          ...prediction,
          currentState: growattState,
          currentStateStartIso: prediction.lastTransitionAt,
          atc,
          reconciledCycleStartIso: null,
          communityTransitionMeta: communityMeta,
        };
      }
    }
  } else if (!growattSlot) {
    // No slot found at all — use WAITING_FOR_GROWATT
    const atc: ATCState = {
      mode: 'WAITING_FOR_GROWATT',
      transitionMode,
      scheduledAutoTransitionIso: null,
      modeReason: 'no slot found at current time',
    };
    return {
      ...prediction,
      currentState: growattState,
      currentStateStartIso: prediction.lastTransitionAt,
      atc,
      reconciledCycleStartIso: null,
      communityTransitionMeta: communityMeta,
    };
  }

  // ── Check PREDICTION_RANGE (near slot boundary) ───────────────────────────
  if (growattSlot?.endIso) {
    const slotEndMs = new Date(growattSlot.endIso).getTime();
    const minToEnd = (slotEndMs - nowMs) / 60_000;

    if (minToEnd <= PREDICTION_RANGE_MIN && minToEnd > 0) {
      const atc: ATCState = {
        mode: 'PREDICTION_RANGE',
        transitionMode,
        scheduledAutoTransitionIso: growattSlot.endIso,
        modeReason: `${Math.round(minToEnd)}min to next transition`,
      };
      trace.push({ step: 'MODE', value: 'PREDICTION_RANGE' });

      return {
        ...prediction,
        currentState: growattState,
        currentStateStartIso: prediction.lastTransitionAt,
        atc,
        reconciledCycleStartIso: null,
        communityTransitionMeta: communityMeta,
      };
    }
  }

  // ── Default: NORMAL ───────────────────────────────────────────────────────
  trace.push({ step: 'MODE', value: 'NORMAL' });

  const atc: ATCState = {
    mode: 'NORMAL',
    transitionMode,
    scheduledAutoTransitionIso: growattSlot?.endIso ?? null,
    modeReason: 'aligned with Growatt schedule',
  };

  return {
    ...prediction,
    currentState: growattState,
    currentStateStartIso: prediction.lastTransitionAt,
    atc,
    reconciledCycleStartIso: null,
    communityTransitionMeta: communityMeta,
  };
}
