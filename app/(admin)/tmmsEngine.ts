/**
 * TMMS Engine v2 — pure TypeScript, zero React dependencies.
 * ════════════════════════════════════════════════════════════════════════════
 * Implements the full ATC (Automatic Transition Control) state machine,
 * offset application, schedule generation, and community transition logic.
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Public Types ──────────────────────────────────────────────────────────────

export type TransitionMode = 'AUTO' | 'MANUAL';

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export interface ScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string;
  startFormatted: string;
  endFormatted: string;
  durationLabel: string;
  zone: string;
  isEstimated: boolean;
  isLingering?: boolean;
  markerLabel?: string;
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
  scheduledAutoTransitionIso?: string | null;
  backdatedCycleStartIso?: string | null;
  reconciledCycleStartIso?: string | null;
}

export interface CommunityTransitionMeta {
  generatedCycleActive: boolean;
  generatedCycleState: 'ON' | 'OFF' | null;
  generatedCycleStartIso: string;
  generatedCycleEndIso: string;
  offsetSign: 'positive' | 'negative' | 'zero' | null;
  offsetReferenceKind: string | null;
  durationSelectionRule: string | null;
  decisionTrace: DecisionStep[];
}

export interface DecisionStep {
  step: string;
  value?: unknown;
}

export interface UserPrediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string;
  inverterOffline: boolean;
  nextTransition: Prediction['nextTransition'];
  expectedOnRange: { minMin: number; maxMin: number } | null;
  expectedOffRange: { minMin: number; maxMin: number } | null;
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
  atc: ATCState;
  communityTransitionMeta?: CommunityTransitionMeta | null;
  reconciledCycleStartIso?: string | null;
  currentStateStartIso?: string | null;
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
  expectedOnRange: { minMin: number; maxMin: number } | null;
  expectedOffRange: { minMin: number; maxMin: number } | null;
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

// ── Report Record Types ───────────────────────────────────────────────────────

export type TrustLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERIFIED';

export interface ReportConfirmation {
  confirmerName: string;
  confirmedAtIso: string;
  hoursAfterReport: number;
}

export interface ReportRecord {
  id: string;
  state: 'ON' | 'OFF';
  originalReportAtIso: string;
  reporterName: string;
  isAuthoritative: boolean;
  confidenceScore: number;
  trustLevel: TrustLevel;
  confirmations: ReportConfirmation[];
  expiresAtIso: string;
}

// ── Utility Helpers ───────────────────────────────────────────────────────────

export function fmtYemenTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ar-SA', {
      timeZone: 'Asia/Aden',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
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
    const hour = new Date(iso).toLocaleString('en-US', {
      timeZone: 'Asia/Aden',
      hour: 'numeric',
      hour12: false,
    });
    const h = parseInt(hour, 10);
    if (h >= 6 && h < 12) return 'morning';
    if (h >= 12 && h < 18) return 'afternoon';
    if (h >= 18 && h < 22) return 'evening';
    return 'night';
  } catch {
    return 'unknown';
  }
}

// ── Report Helpers ────────────────────────────────────────────────────────────

export function createReportRecord(
  state: 'ON' | 'OFF',
  reportAtIso: string,
  reporterName: string,
  isAuthoritative: boolean,
  nowIso: string,
): ReportRecord {
  const id = `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const expiresMs = new Date(reportAtIso).getTime() + 24 * 60 * 60 * 1000;

  return {
    id,
    state,
    originalReportAtIso: reportAtIso,
    reporterName,
    isAuthoritative,
    confidenceScore: 65,
    trustLevel: 'LOW',
    confirmations: [],
    expiresAtIso: new Date(expiresMs).toISOString(),
  };
}

export function findConfirmableReport(
  reports: ReportRecord[],
  state: 'ON' | 'OFF',
  nowMs: number,
): ReportRecord | null {
  const windowMs = 24 * 60 * 60 * 1000;
  const candidates = reports.filter((r) => {
    if (r.state !== state) return false;
    const reportMs = new Date(r.originalReportAtIso).getTime();
    return nowMs - reportMs <= windowMs;
  });
  if (candidates.length === 0) return null;
  // Most recent first
  return candidates.sort(
    (a, b) =>
      new Date(b.originalReportAtIso).getTime() - new Date(a.originalReportAtIso).getTime(),
  )[0];
}

export function applyConfirmationToReport(
  report: ReportRecord,
  confirmedAtIso: string,
  confirmerName: string,
): ReportRecord {
  const hoursAfterReport =
    (new Date(confirmedAtIso).getTime() - new Date(report.originalReportAtIso).getTime()) /
    3_600_000;

  const confirmation: ReportConfirmation = {
    confirmerName,
    confirmedAtIso,
    hoursAfterReport,
  };

  const updated = {
    ...report,
    confirmations: [...report.confirmations, confirmation],
  };

  // Confidence scoring — diminishing returns
  const n = updated.confirmations.length;
  const bonus = n === 1 ? 15 : n === 2 ? 8 : n === 3 ? 5 : 2;
  const newScore = Math.min(99, report.confidenceScore + bonus);

  // Trust level upgrade
  let trustLevel: TrustLevel = 'LOW';
  if (newScore >= 90) trustLevel = 'VERIFIED';
  else if (newScore >= 80) trustLevel = 'HIGH';
  else if (newScore >= 70) trustLevel = 'MEDIUM';

  return { ...updated, confidenceScore: newScore, trustLevel };
}

// ── Community Transition Logic ────────────────────────────────────────────────

interface CommunityTransitionInput {
  resyncPoint: ResyncPoint;
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  daySchedule: ScheduleSlot[];
  expectedOnRange: { minMin: number; maxMin: number } | null;
  expectedOffRange: { minMin: number; maxMin: number } | null;
  nowMs: number;
}

function computeCommunityTransition(input: CommunityTransitionInput): CommunityTransitionMeta {
  const {
    resyncPoint,
    growattCurrentState,
    growattLastTransitionAt,
    daySchedule,
    expectedOnRange,
    expectedOffRange,
    nowMs,
  } = input;

  const trace: DecisionStep[] = [];
  const syncMs = new Date(resyncPoint.syncedAtIso).getTime();

  // Guard: future report timestamps are ignored
  if (syncMs > nowMs + 60_000) {
    trace.push({ step: 'GUARD_FUTURE_REPORT', value: 'skipped' });
    return {
      generatedCycleActive: false,
      generatedCycleState: null,
      generatedCycleStartIso: resyncPoint.syncedAtIso,
      generatedCycleEndIso: resyncPoint.syncedAtIso,
      offsetSign: null,
      offsetReferenceKind: null,
      durationSelectionRule: null,
      decisionTrace: trace,
    };
  }

  const reportedState = resyncPoint.syncedState;
  const growattTransMs = new Date(growattLastTransitionAt).getTime();
  const growattElapsedMin = (nowMs - growattTransMs) / 60_000;

  trace.push({ step: 'reportedState', value: reportedState });
  trace.push({ step: 'growattCurrentState', value: growattCurrentState });
  trace.push({ step: 'growattElapsedMin', value: Math.round(growattElapsedMin) });

  // ── Duration selection rule (Rule 3) ──────────────────────────────────────

  let durationMin: number;
  let durationSelectionRule: string;
  let referenceKind: string;

  if (reportedState === 'ON') {
    // ON interrupted — always use BEFORE slot duration (avg ON time)
    durationMin = expectedOnRange ? Math.round((expectedOnRange.minMin + expectedOnRange.maxMin) / 2) : 120;
    durationSelectionRule = 'ON_ALWAYS_BEFORE';
    referenceKind = 'GROWATT_ON_START_ACTUAL';
  } else {
    // OFF reported — depends on progress through Growatt's current ON slot
    const progress = expectedOnRange
      ? growattElapsedMin / ((expectedOnRange.minMin + expectedOnRange.maxMin) / 2)
      : 0.5;

    if (progress < 0.5) {
      durationMin = expectedOffRange
        ? Math.round((expectedOffRange.minMin + expectedOffRange.maxMin) / 2)
        : 360;
      durationSelectionRule = 'OFF_PROGRESS_LT_50_BEFORE';
      referenceKind = 'GROWATT_ON_END_EXPECTED';
    } else {
      durationMin = expectedOffRange
        ? Math.round((expectedOffRange.minMin + expectedOffRange.maxMin) / 2)
        : 360;
      durationSelectionRule = 'OFF_PROGRESS_GT_50_AFTER';
      referenceKind = 'GROWATT_OFF_END_EXPECTED';
    }

    // Match state-specific reference kinds for same-state reports
    if (reportedState === 'OFF' && growattCurrentState === 'OFF') {
      referenceKind = 'GROWATT_OFF_START_ACTUAL';
    }
  }

  trace.push({ step: 'durationSelectionRule', value: durationSelectionRule });
  trace.push({ step: 'durationMin', value: durationMin });

  // ── Generated cycle boundaries ────────────────────────────────────────────

  const genStartMs = syncMs;
  const genEndMs = syncMs + durationMin * 60_000;
  const generatedCycleActive = nowMs >= genStartMs && nowMs < genEndMs;

  trace.push({ step: 'generatedCycleActive', value: generatedCycleActive });

  // ── Offset sign ───────────────────────────────────────────────────────────

  let offsetSign: 'positive' | 'negative' | 'zero' | null = null;
  const offsetDiffMin = (syncMs - growattTransMs) / 60_000;
  if (Math.abs(offsetDiffMin) < 1) offsetSign = 'zero';
  else if (offsetDiffMin > 0) offsetSign = 'positive';
  else offsetSign = 'negative';

  trace.push({ step: 'offsetSign', value: offsetSign });

  return {
    generatedCycleActive,
    generatedCycleState: reportedState,
    generatedCycleStartIso: new Date(genStartMs).toISOString(),
    generatedCycleEndIso: new Date(genEndMs).toISOString(),
    offsetSign,
    offsetReferenceKind: referenceKind,
    durationSelectionRule,
    decisionTrace: trace,
  };
}

// ── ATC State Machine ─────────────────────────────────────────────────────────

const PREDICTION_RANGE_WINDOW_MIN = 15;
const GRACE_MODE_WINDOW_MIN = 15;
const WAITING_THRESHOLD_MIN = 30;

function computeATCMode(params: {
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  offsetMinutes: number;
  transitionMode: TransitionMode;
  daySchedule: ScheduleSlot[];
  communityMeta: CommunityTransitionMeta | null;
  nowMs: number;
}): {
  mode: ScheduleStateMode;
  scheduledAutoTransitionIso: string | null;
  backdatedCycleStartIso: string | null;
  reconciledCycleStartIso: string | null;
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string;
} {
  const {
    growattCurrentState,
    growattLastTransitionAt,
    offsetMinutes,
    transitionMode,
    daySchedule,
    communityMeta,
    nowMs,
  } = params;

  const growattTransMs = new Date(growattLastTransitionAt).getTime();

  // ── Community SYNCED takes highest priority ───────────────────────────────
  if (communityMeta && communityMeta.generatedCycleActive) {
    return {
      mode: 'COMMUNITY_SYNCED',
      scheduledAutoTransitionIso: null,
      backdatedCycleStartIso: null,
      reconciledCycleStartIso: null,
      currentState: communityMeta.generatedCycleState ?? growattCurrentState,
      currentStateStartIso: communityMeta.generatedCycleStartIso,
    };
  }

  // ── POSITIVE_OFFSET_PENDING ───────────────────────────────────────────────
  if (offsetMinutes > 0 && transitionMode === 'AUTO') {
    const scheduledMs = growattTransMs + offsetMinutes * 60_000;
    if (nowMs < scheduledMs) {
      // Growatt already flipped but user's scheduled time hasn't come yet
      const prevState: 'ON' | 'OFF' = growattCurrentState === 'ON' ? 'OFF' : 'ON';
      return {
        mode: 'POSITIVE_OFFSET_PENDING',
        scheduledAutoTransitionIso: new Date(scheduledMs).toISOString(),
        backdatedCycleStartIso: null,
        reconciledCycleStartIso: null,
        currentState: prevState,
        currentStateStartIso: growattLastTransitionAt,
      };
    }
  }

  // ── Find the current schedule slot based on user's offset time ─────────────
  const userNowMs = nowMs;
  const userOffsetMs = offsetMinutes * 60_000;

  // Find which slot contains the user's "now"
  let currentSlot: ScheduleSlot | null = null;
  let prevSlot: ScheduleSlot | null = null;

  for (let i = 0; i < daySchedule.length; i++) {
    const s = daySchedule[i];
    const slotStartMs = new Date(s.startIso).getTime() + userOffsetMs;
    const slotEndMs = s.endIso ? new Date(s.endIso).getTime() + userOffsetMs : Infinity;
    if (userNowMs >= slotStartMs && userNowMs < slotEndMs) {
      currentSlot = s;
      if (i > 0) prevSlot = daySchedule[i - 1];
      break;
    }
  }

  // ── NEGATIVE offset: check for UNCERTAIN_ZONE ─────────────────────────────
  if (offsetMinutes < 0 && currentSlot) {
    const slotStartMs = new Date(currentSlot.startIso).getTime() + userOffsetMs;
    const slotEndMs = currentSlot.endIso
      ? new Date(currentSlot.endIso).getTime() + userOffsetMs
      : Infinity;

    // Has the user's shifted slot ended but Growatt hasn't changed yet?
    if (
      userNowMs >= slotEndMs &&
      growattCurrentState === currentSlot.state
    ) {
      const backdatedMs = growattTransMs + offsetMinutes * 60_000;
      return {
        mode: 'UNCERTAIN_ZONE',
        scheduledAutoTransitionIso: null,
        backdatedCycleStartIso: new Date(backdatedMs).toISOString(),
        reconciledCycleStartIso: null,
        currentState: currentSlot.state,
        currentStateStartIso: new Date(backdatedMs).toISOString(),
      };
    }
  }

  // Check for UNCERTAIN_ZONE on negative offset via slot lookup mismatch
  if (offsetMinutes < 0) {
    const adjustedNow = nowMs;
    for (const s of daySchedule) {
      const slotStartMs = new Date(s.startIso).getTime();
      const slotEndMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      const shiftedEnd = slotEndMs + offsetMinutes * 60_000;
      if (
        adjustedNow >= shiftedEnd &&
        adjustedNow < slotEndMs &&
        s.state === growattCurrentState
      ) {
        const backdatedMs = new Date(s.startIso).getTime() + offsetMinutes * 60_000;
        return {
          mode: 'UNCERTAIN_ZONE',
          scheduledAutoTransitionIso: null,
          backdatedCycleStartIso: new Date(backdatedMs).toISOString(),
          reconciledCycleStartIso: null,
          currentState: s.state,
          currentStateStartIso: new Date(backdatedMs).toISOString(),
        };
      }
    }
  }

  // ── NORMAL mode — within schedule ─────────────────────────────────────────
  if (currentSlot) {
    const slotStartMs = new Date(currentSlot.startIso).getTime() + userOffsetMs;
    const slotEndMs = currentSlot.endIso
      ? new Date(currentSlot.endIso).getTime() + userOffsetMs
      : Infinity;
    const remainingMin = (slotEndMs - userNowMs) / 60_000;
    const slotDurMin =
      currentSlot.endIso
        ? (new Date(currentSlot.endIso).getTime() - new Date(currentSlot.startIso).getTime()) /
          60_000
        : 999;

    if (remainingMin <= PREDICTION_RANGE_WINDOW_MIN && remainingMin > 0) {
      return {
        mode: 'PREDICTION_RANGE',
        scheduledAutoTransitionIso: null,
        backdatedCycleStartIso: null,
        reconciledCycleStartIso: null,
        currentState: currentSlot.state,
        currentStateStartIso: new Date(slotStartMs).toISOString(),
      };
    }

    return {
      mode: 'NORMAL',
      scheduledAutoTransitionIso: null,
      backdatedCycleStartIso: null,
      reconciledCycleStartIso: null,
      currentState: currentSlot.state,
      currentStateStartIso: new Date(slotStartMs).toISOString(),
    };
  }

  // ── No current slot — check overrun ───────────────────────────────────────
  // Find the most recent past slot
  const adjustedNow = nowMs;
  let lastSlot: ScheduleSlot | null = null;
  for (const s of daySchedule) {
    const slotEndMs = s.endIso
      ? new Date(s.endIso).getTime() + userOffsetMs
      : Infinity;
    if (slotEndMs <= adjustedNow) {
      lastSlot = s;
    }
  }

  if (lastSlot && lastSlot.endIso) {
    const slotEndMs = new Date(lastSlot.endIso).getTime() + userOffsetMs;
    const overrunMin = (adjustedNow - slotEndMs) / 60_000;

    if (overrunMin <= GRACE_MODE_WINDOW_MIN) {
      return {
        mode: 'GRACE_MODE',
        scheduledAutoTransitionIso: null,
        backdatedCycleStartIso: null,
        reconciledCycleStartIso: null,
        currentState: lastSlot.state,
        currentStateStartIso: new Date(new Date(lastSlot.startIso).getTime() + userOffsetMs).toISOString(),
      };
    }

    if (overrunMin > WAITING_THRESHOLD_MIN) {
      return {
        mode: 'WAITING_FOR_GROWATT',
        scheduledAutoTransitionIso: null,
        backdatedCycleStartIso: null,
        reconciledCycleStartIso: null,
        currentState: lastSlot.state,
        currentStateStartIso: new Date(new Date(lastSlot.startIso).getTime() + userOffsetMs).toISOString(),
      };
    }

    return {
      mode: 'GRACE_MODE',
      scheduledAutoTransitionIso: null,
      backdatedCycleStartIso: null,
      reconciledCycleStartIso: null,
      currentState: lastSlot.state,
      currentStateStartIso: new Date(new Date(lastSlot.startIso).getTime() + userOffsetMs).toISOString(),
    };
  }

  // Fallback
  return {
    mode: 'NORMAL',
    scheduledAutoTransitionIso: null,
    backdatedCycleStartIso: null,
    reconciledCycleStartIso: null,
    currentState: growattCurrentState,
    currentStateStartIso: growattLastTransitionAt,
  };
}

// ── applyOffsetToPrediction ───────────────────────────────────────────────────
// Main entry point: takes a raw Prediction + ATC parameters → UserPrediction

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  stateAnchor: string | null,
  transitionMode: TransitionMode,
  pinnedUserId: string | null,
  frozenCommunityOffsetMinutes: number | null,
  onFreezeOffset: (offsetMin: number) => void,
  nowMsOverride?: number,
): UserPrediction {
  const nowMs = nowMsOverride ?? Date.now();

  // ── Community transition meta ─────────────────────────────────────────────
  let communityMeta: CommunityTransitionMeta | null = null;

  if (resyncPoint) {
    communityMeta = computeCommunityTransition({
      resyncPoint,
      growattCurrentState: prediction.currentState,
      growattLastTransitionAt: prediction.lastTransitionAt,
      daySchedule: prediction.daySchedule,
      expectedOnRange: prediction.expectedOnRange,
      expectedOffRange: prediction.expectedOffRange,
      nowMs,
    });

    // Freeze offset on first computation
    if (frozenCommunityOffsetMinutes === null && communityMeta.generatedCycleActive) {
      const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
      const growattMs = new Date(prediction.lastTransitionAt).getTime();
      const diffMin = Math.round((syncMs - growattMs) / 60_000);
      onFreezeOffset(diffMin);
    }
  }

  // ── ATC state machine ─────────────────────────────────────────────────────
  const atcResult = computeATCMode({
    growattCurrentState: prediction.currentState,
    growattLastTransitionAt: prediction.lastTransitionAt,
    offsetMinutes,
    transitionMode,
    daySchedule: prediction.daySchedule,
    communityMeta,
    nowMs,
  });

  // ── Reconciled cycle start for negative offset ────────────────────────────
  let reconciledCycleStartIso: string | null = null;
  if (offsetMinutes < 0 && atcResult.backdatedCycleStartIso) {
    reconciledCycleStartIso = atcResult.backdatedCycleStartIso;
  } else if (stateAnchor) {
    reconciledCycleStartIso = stateAnchor;
  }

  const atcState: ATCState = {
    mode: atcResult.mode,
    transitionMode,
    scheduledAutoTransitionIso: atcResult.scheduledAutoTransitionIso ?? null,
    backdatedCycleStartIso: atcResult.backdatedCycleStartIso ?? null,
    reconciledCycleStartIso,
  };

  return {
    currentState: atcResult.currentState,
    currentStateDurationMin: Math.round((nowMs - new Date(atcResult.currentStateStartIso).getTime()) / 60_000),
    currentStateDurationLabel: durationLabelFromMin(
      Math.round((nowMs - new Date(atcResult.currentStateStartIso).getTime()) / 60_000),
    ),
    lastTransitionAt: atcResult.currentStateStartIso,
    inverterOffline: prediction.inverterOffline,
    nextTransition: prediction.nextTransition,
    expectedOnRange: prediction.expectedOnRange,
    expectedOffRange: prediction.expectedOffRange,
    daySchedule: prediction.daySchedule,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    dayPattern: prediction.dayPattern,
    nightPattern: prediction.nightPattern,
    allPattern: prediction.allPattern,
    cyclesAnalyzed: prediction.cyclesAnalyzed,
    dayCyclesAnalyzed: prediction.dayCyclesAnalyzed,
    nightCyclesAnalyzed: prediction.nightCyclesAnalyzed,
    currentPeriod: prediction.currentPeriod,
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode,
    dataWindowHours: prediction.dataWindowHours,
    computedAt: prediction.computedAt,
    apppe: prediction.apppe,
    atc: atcState,
    communityTransitionMeta: communityMeta,
    reconciledCycleStartIso,
    currentStateStartIso: atcResult.currentStateStartIso,
  };
}
