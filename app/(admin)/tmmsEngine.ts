/**
 * TMMS V2 Engine — pure TypeScript, zero React dependencies
 * ════════════════════════════════════════════════════════════════════════════
 * Implements the full ATC (Adaptive Transition Controller) state machine,
 * community transition resolution, offset application, and schedule
 * generation logic.
 *
 * This file has NO React/Expo imports — it runs identically in the
 * production app (via hooks/useUserPredictions.ts), the debug simulator
 * (TMMSDebugSimulator.tsx), and simulation scenarios (tmmsSimulation.ts).
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Core types (mirrored from hooks/usePredictions to avoid circular imports) ─

export interface ScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
}

export interface Prediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string | null;
  inverterOffline: boolean;
  nextTransition: any | null;
  expectedOffRange: any | null;
  expectedOnRange: any | null;
  daySchedule: ScheduleSlot[];
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  dayPattern: any | null;
  nightPattern: any | null;
  allPattern: any | null;
  cyclesAnalyzed: number;
  dayCyclesAnalyzed: number;
  nightCyclesAnalyzed: number;
  currentPeriod: 'day' | 'night';
  reasoning: string[];
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  dataWindowHours: number;
  computedAt: string;
  apppe?: {
    version: string;
    crisisActive: boolean;
    crisisReason: string | null;
    driftOffset: number;
    driftSampleCount: number;
    biasRatio: number;
    biasSampleCount: number;
    volatilityEMA: number;
    volatilityLabel: string;
    crisisShift: { off: number; on: number };
    learningStrength: number;
    effectiveWeightedSamples: number;
    effectiveWeightedSamplesOn: number;
    madOff: number;
    madOn: number | null;
    predictionQuality: {
      dataQuantityFactor: number;
      stabilityFactor: number;
      driftStabilityFactor: number;
      biasStabilityFactor: number;
      volatilityFactor: number;
      crisisFactor: number;
    };
    historySource: string;
    rangeWasClamped: boolean;
    [key: string]: any;
  };
  [key: string]: any;
}

// ── Types ──────────────────────────────────────────────────────────────────

export type TransitionMode = 'AUTO' | 'MANUAL';

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string | null;
  reporterReliability?: number | null;
}

export interface ATCState {
  mode: ScheduleStateMode;
  statusLine: string;
  transitionMode: TransitionMode;
  overrunMinutes: number;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso: string | null;
}

export interface DecisionStep {
  step: number;
  label: string;
  detail: string;
}

export interface CommunityTransitionMeta {
  generatedCycleState: 'ON' | 'OFF';
  generatedCycleStartIso: string;
  generatedCycleEndIso: string;
  generatedCycleActive: boolean;
  offsetMinutes: number;
  offsetSign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  offsetReferenceKind: string | null;
  offsetReferenceIso: string | null;
  isFreshOffsetComputation: boolean;
  durationSelectionRule: 'OFF_PROGRESS_LT_50_BEFORE' | 'OFF_PROGRESS_GT_50_AFTER' | 'ON_ALWAYS_BEFORE';
  progressRatio: number;
  durationSourceSlot: { state: 'ON' | 'OFF'; durationLabel: string | null } | null;
  decisionTrace: DecisionStep[];
}

export interface ShiftedScheduleSlot extends ScheduleSlot {
  isResynced: boolean;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string | null;
}

export interface UserPrediction {
  // Core state
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  nextTransition: {
    type: 'UTILITY_ON' | 'UTILITY_OFF';
    rangeStartIso: string;
    rangeEndIso: string;
    rangeLabel: string;
    minFromNowMin: number;
    maxFromNowMin: number;
    waitLabel: string;
    inRangeWindow: boolean;
  } | null;
  daySchedule: ShiftedScheduleSlot[];

  // Quality metrics
  confidence: number;
  stabilityScore: number;
  stabilityLabel: string;
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  computedAt: string;

  // Duration hints (Arabic labels)
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;

  // ATC controller state
  atc: ATCState;
  isHoldingState: boolean;
  isResynced: boolean;
  isUnstable: boolean;

  // Offset info
  offsetMinutes: number;

  // Community sync
  resyncedAtIso: string | null;
  reconciledCycleStartIso: string | null;
  communitySyncMeta: {
    syncedAtIso: string;
    reporterName: string | null;
    reporterReliability: number | null;
  } | null;
  communityTransitionMeta: CommunityTransitionMeta | null;

  // Crisis / reasoning
  crisisMode: boolean;
  crisisReason: string | null;
  reasoning: string[];

  // For POSITIVE_OFFSET_PENDING (compatibility)
  [key: string]: any;
}

export type TrustLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERIFIED';

export interface ConfirmationRecord {
  confirmerName: string | null;
  confirmedAtIso: string;
  hoursAfterReport: number;
  confidenceScoreAfter: number;
}

export interface ReportRecord {
  id: string;
  state: 'ON' | 'OFF';
  originalReportAtIso: string;
  processedAtIso: string | null;
  reporterName: string;
  confidenceScore: number;
  trustLevel: TrustLevel;
  confirmations: ConfirmationRecord[];
}

// ── Utility helpers ────────────────────────────────────────────────────────

export function fmtYemenTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'Asia/Aden',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).replace('AM', ' ص').replace('PM', ' م');
  } catch {
    return iso.slice(11, 16);
  }
}

export function getZoneFromIso(iso: string): string {
  try {
    const hour = new Date(iso).getUTCHours() + 3; // Yemen is UTC+3
    const h = ((hour % 24) + 24) % 24;
    if (h >= 6 && h < 12) return 'MORNING';
    if (h >= 12 && h < 18) return 'AFTERNOON';
    if (h >= 18 && h < 22) return 'EVENING';
    return 'NIGHT';
  } catch {
    return 'DAY';
  }
}

export function durationLabelFromMin(minutes: number): string {
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.round(Math.abs(minutes) % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h}س ${m}د`;
}

// ── Report ledger helpers ──────────────────────────────────────────────────

const CONFIDENCE_BASE = 40;
const CONFIDENCE_PER_CONFIRM = 15;
const MAX_CONFIDENCE = 100;
const MAX_CONFIRMATION_WINDOW_MS = 24 * 3600 * 1000;

function confidenceToTrust(score: number): TrustLevel {
  if (score >= 90) return 'VERIFIED';
  if (score >= 70) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

export function createReportRecord(
  state: 'ON' | 'OFF',
  originalReportAtIso: string,
  reporterName: string,
  processed: boolean,
  nowIso: string,
): ReportRecord {
  return {
    id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    state,
    originalReportAtIso,
    processedAtIso: processed ? nowIso : null,
    reporterName,
    confidenceScore: CONFIDENCE_BASE,
    trustLevel: confidenceToTrust(CONFIDENCE_BASE),
    confirmations: [],
  };
}

export function findConfirmableReport(
  reports: ReportRecord[],
  state: 'ON' | 'OFF',
  eventAtMs: number,
): ReportRecord | null {
  // Find the most recent unprocessed or processed report for this state
  // within the confirmation window (24h)
  const matching = reports
    .filter(r => {
      if (r.state !== state) return false;
      const reportMs = new Date(r.originalReportAtIso).getTime();
      return (eventAtMs - reportMs) <= MAX_CONFIRMATION_WINDOW_MS && (eventAtMs - reportMs) >= 0;
    })
    .sort((a, b) => new Date(b.originalReportAtIso).getTime() - new Date(a.originalReportAtIso).getTime());

  return matching[0] ?? null;
}

export function applyConfirmationToReport(
  record: ReportRecord,
  confirmedAtIso: string,
  confirmerName: string,
): ReportRecord {
  const reportMs = new Date(record.originalReportAtIso).getTime();
  const confirmMs = new Date(confirmedAtIso).getTime();
  const hoursAfterReport = (confirmMs - reportMs) / 3600_000;
  const newScore = Math.min(MAX_CONFIDENCE, record.confidenceScore + CONFIDENCE_PER_CONFIRM);
  const confirmation: ConfirmationRecord = {
    confirmerName,
    confirmedAtIso,
    hoursAfterReport,
    confidenceScoreAfter: newScore,
  };
  return {
    ...record,
    confidenceScore: newScore,
    trustLevel: confidenceToTrust(newScore),
    confirmations: [...record.confirmations, confirmation],
  };
}

// ── Community offset calculation ────────────────────────────────────────────

export interface CommunityOffsetResult {
  offsetMinutes: number;
  sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  referenceKind: string;
  referenceIso: string;
}

/**
 * computeCommunityOffset — Rule 4/5.
 *
 * Given the schedule slots, resync point, Growatt's current state, and
 * Growatt's last-transition time, computes the user's time offset relative
 * to the Growatt reference event.
 */
export function computeCommunityOffset(
  slots: ScheduleSlot[],
  resyncPoint: ResyncPoint,
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string,
  nowMs?: number,
): CommunityOffsetResult | null {
  const reportedState = resyncPoint.syncedState;
  const reportAtMs = new Date(resyncPoint.syncedAtIso).getTime();
  const now = nowMs ?? Date.now();

  // Find the slot active at the report time
  const activeSlot = slots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return reportAtMs >= start && reportAtMs < end;
  });

  if (reportedState === growattCurrentState) {
    // Report is same-state as Growatt's current state
    const growattTransitionMs = new Date(growattLastTransitionAt).getTime();

    if (growattCurrentState === 'ON') {
      // Reference: Growatt ON Start (actual)
      const offset = Math.round((reportAtMs - growattTransitionMs) / 60_000);
      return {
        offsetMinutes: offset,
        sign: offset > 0 ? 'POSITIVE' : offset < 0 ? 'NEGATIVE' : 'NEUTRAL',
        referenceKind: 'GROWATT_ON_START_ACTUAL',
        referenceIso: growattLastTransitionAt,
      };
    } else {
      // Reference: Growatt OFF Start (actual)
      const offset = Math.round((reportAtMs - growattTransitionMs) / 60_000);
      return {
        offsetMinutes: offset,
        sign: offset > 0 ? 'POSITIVE' : offset < 0 ? 'NEGATIVE' : 'NEUTRAL',
        referenceKind: 'GROWATT_OFF_START_ACTUAL',
        referenceIso: growattLastTransitionAt,
      };
    }
  } else {
    // Report is opposite-state from Growatt current state
    if (growattCurrentState === 'OFF') {
      // Growatt is OFF, user reports ON → reference is OFF END (expected)
      const offSlot = slots.find(s => {
        const start = new Date(s.startIso).getTime();
        const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
        return s.state === 'OFF' && reportAtMs >= start && reportAtMs < end;
      }) ?? slots.find(s => s.state === 'OFF' && new Date(s.startIso).getTime() <= now);

      const referenceMs = offSlot?.endIso
        ? new Date(offSlot.endIso).getTime()
        : now;
      const referenceIso = offSlot?.endIso ?? new Date(now).toISOString();
      const offset = Math.round((reportAtMs - referenceMs) / 60_000);
      return {
        offsetMinutes: offset,
        sign: offset > 0 ? 'POSITIVE' : offset < 0 ? 'NEGATIVE' : 'NEUTRAL',
        referenceKind: 'GROWATT_OFF_END_EXPECTED',
        referenceIso,
      };
    } else {
      // Growatt is ON, user reports OFF → reference is ON END (expected)
      const onSlot = slots.find(s => {
        const start = new Date(s.startIso).getTime();
        const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
        return s.state === 'ON' && reportAtMs >= start && reportAtMs < end;
      }) ?? slots.find(s => s.state === 'ON' && new Date(s.startIso).getTime() <= now);

      const referenceMs = onSlot?.endIso
        ? new Date(onSlot.endIso).getTime()
        : now;
      const referenceIso = onSlot?.endIso ?? new Date(now).toISOString();
      const offset = Math.round((reportAtMs - referenceMs) / 60_000);
      return {
        offsetMinutes: offset,
        sign: offset > 0 ? 'POSITIVE' : offset < 0 ? 'NEGATIVE' : 'NEUTRAL',
        referenceKind: 'GROWATT_ON_END_EXPECTED',
        referenceIso,
      };
    }
  }
}

// ── Community transition computation ──────────────────────────────────────

interface CommunityTransitionInput {
  slots: ScheduleSlot[];
  resyncPoint: ResyncPoint;
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  frozenOffsetMinutes: number | null;
  nowMs: number;
}

function computeCommunityTransition(input: CommunityTransitionInput): {
  meta: CommunityTransitionMeta;
  generatedSlots: ShiftedScheduleSlot[];
} | null {
  const { slots, resyncPoint, growattCurrentState, growattLastTransitionAt, frozenOffsetMinutes, nowMs } = input;
  const reportedState = resyncPoint.syncedState;
  const reportAtMs = new Date(resyncPoint.syncedAtIso).getTime();

  // Reject reports timestamped in the future
  if (reportAtMs > nowMs + 60_000) return null;

  const trace: DecisionStep[] = [];
  let stepNum = 1;
  const addStep = (label: string, detail: string) => {
    trace.push({ step: stepNum++, label, detail });
  };

  addStep('Report Received', `State: ${reportedState}, Time: ${fmtYemenTime(resyncPoint.syncedAtIso)}`);

  // Find the schedule slot active at the report time
  const activeAtReport = slots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return reportAtMs >= start && reportAtMs < end;
  });

  if (!activeAtReport) {
    addStep('Error', 'No matching schedule slot found at report time');
    return null;
  }

  addStep('Active Slot Found', `${activeAtReport.state} slot ${fmtYemenTime(activeAtReport.startIso)} → ${activeAtReport.endIso ? fmtYemenTime(activeAtReport.endIso) : '…'}`);

  // Determine duration selection rule
  let durationSelectionRule: CommunityTransitionMeta['durationSelectionRule'];
  let durationSourceSlot: { state: 'ON' | 'OFF'; durationLabel: string | null } | null = null;
  let generatedDurationMs: number;
  let progressRatio = 0;

  const slotStartMs = new Date(activeAtReport.startIso).getTime();
  const slotEndMs = activeAtReport.endIso ? new Date(activeAtReport.endIso).getTime() : Infinity;
  const slotDurMs = isFinite(slotEndMs) ? slotEndMs - slotStartMs : 60 * 60_000;
  progressRatio = slotDurMs > 0 ? (reportAtMs - slotStartMs) / slotDurMs : 0;

  const activeSlotIdx = slots.indexOf(activeAtReport);

  if (reportedState === activeAtReport.state) {
    // Confirming the CURRENT state — same-state report
    // For ON slots interrupted: always use PREVIOUS slot duration
    // For OFF slots: use 50% progress rule
    if (activeAtReport.state === 'OFF') {
      if (progressRatio < 0.5) {
        durationSelectionRule = 'OFF_PROGRESS_LT_50_BEFORE';
        // Find previous ON slot
        const prevOnSlot = slots.slice(0, activeSlotIdx).reverse().find(s => s.state === 'ON');
        if (prevOnSlot && prevOnSlot.endIso) {
          generatedDurationMs = new Date(prevOnSlot.endIso).getTime() - new Date(prevOnSlot.startIso).getTime();
          durationSourceSlot = { state: 'ON', durationLabel: prevOnSlot.durationLabel };
        } else {
          generatedDurationMs = 120 * 60_000; // 2h fallback
        }
        addStep('Duration Rule', `OFF progress ${(progressRatio * 100).toFixed(1)}% < 50% → using previous ON duration`);
      } else {
        durationSelectionRule = 'OFF_PROGRESS_GT_50_AFTER';
        // Find next ON slot
        const nextOnSlot = slots.slice(activeSlotIdx + 1).find(s => s.state === 'ON');
        if (nextOnSlot && nextOnSlot.endIso) {
          generatedDurationMs = new Date(nextOnSlot.endIso).getTime() - new Date(nextOnSlot.startIso).getTime();
          durationSourceSlot = { state: 'ON', durationLabel: nextOnSlot.durationLabel };
        } else {
          generatedDurationMs = 120 * 60_000; // 2h fallback
        }
        addStep('Duration Rule', `OFF progress ${(progressRatio * 100).toFixed(1)}% ≥ 50% → using next ON duration`);
      }
    } else {
      // ON slot being confirmed as ON → use previous OFF duration
      durationSelectionRule = 'ON_ALWAYS_BEFORE';
      const prevOffSlot = slots.slice(0, activeSlotIdx).reverse().find(s => s.state === 'OFF');
      if (prevOffSlot && prevOffSlot.endIso) {
        generatedDurationMs = new Date(prevOffSlot.endIso).getTime() - new Date(prevOffSlot.startIso).getTime();
        durationSourceSlot = { state: 'OFF', durationLabel: prevOffSlot.durationLabel };
      } else {
        generatedDurationMs = 360 * 60_000; // 6h fallback
      }
      addStep('Duration Rule', `ON slot → always using previous OFF duration (no 50% rule)`);
    }
  } else {
    // Reporting the OPPOSITE state from what the schedule shows
    if (activeAtReport.state === 'ON') {
      // Growatt says ON, user reports OFF → ON interrupted
      durationSelectionRule = 'ON_ALWAYS_BEFORE';
      const prevOffSlot = slots.slice(0, activeSlotIdx).reverse().find(s => s.state === 'OFF');
      if (prevOffSlot && prevOffSlot.endIso) {
        generatedDurationMs = new Date(prevOffSlot.endIso).getTime() - new Date(prevOffSlot.startIso).getTime();
        durationSourceSlot = { state: 'OFF', durationLabel: prevOffSlot.durationLabel };
      } else {
        generatedDurationMs = 360 * 60_000;
      }
      addStep('Duration Rule', `ON interrupted → always previous OFF duration`);
    } else {
      // Growatt says OFF, user reports ON → OFF interrupted
      if (progressRatio < 0.5) {
        durationSelectionRule = 'OFF_PROGRESS_LT_50_BEFORE';
        const prevOnSlot = slots.slice(0, activeSlotIdx).reverse().find(s => s.state === 'ON');
        if (prevOnSlot && prevOnSlot.endIso) {
          generatedDurationMs = new Date(prevOnSlot.endIso).getTime() - new Date(prevOnSlot.startIso).getTime();
          durationSourceSlot = { state: 'ON', durationLabel: prevOnSlot.durationLabel };
        } else {
          generatedDurationMs = 120 * 60_000;
        }
      } else {
        durationSelectionRule = 'OFF_PROGRESS_GT_50_AFTER';
        const nextOnSlot = slots.slice(activeSlotIdx + 1).find(s => s.state === 'ON');
        if (nextOnSlot && nextOnSlot.endIso) {
          generatedDurationMs = new Date(nextOnSlot.endIso).getTime() - new Date(nextOnSlot.startIso).getTime();
          durationSourceSlot = { state: 'ON', durationLabel: nextOnSlot.durationLabel };
        } else {
          generatedDurationMs = 120 * 60_000;
        }
      }
      addStep('Duration Rule', `OFF interrupted, progress=${(progressRatio * 100).toFixed(1)}%`);
    }
  }

  // Build the generated slot
  const generatedCycleStartMs = reportAtMs;
  const generatedCycleEndMs = generatedCycleStartMs + generatedDurationMs;
  const generatedCycleStartIso = resyncPoint.syncedAtIso;
  const generatedCycleEndIso = new Date(generatedCycleEndMs).toISOString();
  const generatedCycleState = reportedState;
  const generatedCycleActive = nowMs >= generatedCycleStartMs && nowMs < generatedCycleEndMs;

  addStep('Generated State', `${generatedCycleState} from ${fmtYemenTime(generatedCycleStartIso)} to ${fmtYemenTime(generatedCycleEndIso)}`);

  // Compute offset
  let offsetResult: CommunityOffsetResult | null = null;
  let isFreshOffsetComputation = false;

  if (frozenOffsetMinutes !== null) {
    // Reuse frozen offset (Q2-A)
    offsetResult = {
      offsetMinutes: frozenOffsetMinutes,
      sign: frozenOffsetMinutes > 0 ? 'POSITIVE' : frozenOffsetMinutes < 0 ? 'NEGATIVE' : 'NEUTRAL',
      referenceKind: null as any,
      referenceIso: null as any,
    };
    addStep('Offset Reuse', `Frozen offset ${frozenOffsetMinutes}m reused (Q2-A)`);
  } else {
    offsetResult = computeCommunityOffset(
      slots, resyncPoint, growattCurrentState, growattLastTransitionAt, nowMs,
    );
    isFreshOffsetComputation = true;
    if (offsetResult) {
      addStep('Offset Calculated', `${offsetResult.offsetMinutes > 0 ? '+' : ''}${offsetResult.offsetMinutes}m (${offsetResult.sign}) ref=${offsetResult.referenceKind}`);
    }
  }

  const offsetMinutes = offsetResult?.offsetMinutes ?? 0;
  const offsetSign = offsetResult?.sign ?? 'NEUTRAL';

  // Build the generated ShiftedScheduleSlot
  const genSlot: ShiftedScheduleSlot = {
    state: generatedCycleState,
    startIso: generatedCycleStartIso,
    endIso: generatedCycleEndIso,
    startFormatted: fmtYemenTime(generatedCycleStartIso),
    endFormatted: fmtYemenTime(generatedCycleEndIso),
    durationLabel: durationLabelFromMin(generatedDurationMs / 60_000),
    zone: getZoneFromIso(generatedCycleStartIso),
    isEstimated: false,
    isResynced: true,
    shiftedStartFormatted: fmtYemenTime(generatedCycleStartIso),
    shiftedEndFormatted: fmtYemenTime(generatedCycleEndIso),
  };

  // Build continuation slots after the generated slot
  const continuationSlots: ShiftedScheduleSlot[] = [];
  let contState: 'ON' | 'OFF' = generatedCycleState === 'ON' ? 'OFF' : 'ON';
  let contStartMs = generatedCycleEndMs;
  const horizonMs = nowMs + 48 * 3600_000;

  // Find the position in the original schedule to continue from
  // Use the slot AFTER the active-at-report slot, matching the state
  let schedIdx = activeSlotIdx + 1;
  // Skip to a slot of the correct continuation state
  while (schedIdx < slots.length && slots[schedIdx].state !== contState) schedIdx++;

  let loopCount = 0;
  const schedLen = slots.length;

  while (contStartMs < horizonMs && loopCount < 50) {
    loopCount++;
    const templateSlot = schedLen > 0 ? slots[schedIdx % schedLen] : null;
    const durMs = templateSlot?.endIso
      ? new Date(templateSlot.endIso).getTime() - new Date(templateSlot.startIso).getTime()
      : 2 * 3600_000;
    const contEndMs = contStartMs + durMs;
    const contStartIso = new Date(contStartMs).toISOString();
    const contEndIso = new Date(contEndMs).toISOString();
    continuationSlots.push({
      state: contState,
      startIso: contStartIso,
      endIso: contEndIso,
      startFormatted: fmtYemenTime(contStartIso),
      endFormatted: fmtYemenTime(contEndIso),
      durationLabel: durationLabelFromMin(durMs / 60_000),
      zone: getZoneFromIso(contStartIso),
      isEstimated: false,
      isResynced: false,
      shiftedStartFormatted: fmtYemenTime(contStartIso),
      shiftedEndFormatted: fmtYemenTime(contEndIso),
    });
    contState = contState === 'ON' ? 'OFF' : 'ON';
    contStartMs = contEndMs;
    schedIdx++;
  }

  const meta: CommunityTransitionMeta = {
    generatedCycleState,
    generatedCycleStartIso,
    generatedCycleEndIso,
    generatedCycleActive,
    offsetMinutes,
    offsetSign,
    offsetReferenceKind: offsetResult?.referenceKind ?? null,
    offsetReferenceIso: offsetResult?.referenceIso ?? null,
    isFreshOffsetComputation,
    durationSelectionRule: durationSelectionRule!,
    progressRatio,
    durationSourceSlot,
    decisionTrace: trace,
  };

  return { meta, generatedSlots: [genSlot, ...continuationSlots] };
}

// ── ATC State Machine ──────────────────────────────────────────────────────

interface ATCInput {
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string | null;
  userCurrentState: 'ON' | 'OFF';
  userScheduleSlots: ShiftedScheduleSlot[];
  offsetMinutes: number;
  transitionMode: TransitionMode;
  communityMeta: CommunityTransitionMeta | null;
  isResynced: boolean;
  nowMs: number;
  anchorStartIso: string | null;
}

interface ATCOutput {
  atc: ATCState;
  isHoldingState: boolean;
  reconciledCycleStartIso: string | null;
  currentStateStartIso: string | null;
}

function computeATCState(input: ATCInput): ATCOutput {
  const {
    growattCurrentState, growattLastTransitionAt, userCurrentState,
    userScheduleSlots, offsetMinutes, transitionMode, communityMeta,
    isResynced, nowMs, anchorStartIso,
  } = input;

  let reconciledCycleStartIso: string | null = null;
  let currentStateStartIso: string | null = anchorStartIso;

  // Find the schedule slot active at nowMs
  const activeSlot = userScheduleSlots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });

  if (activeSlot) {
    currentStateStartIso = activeSlot.startIso;
  }

  const activeSlotEndMs = activeSlot?.endIso ? new Date(activeSlot.endIso).getTime() : null;
  const overrunMs = activeSlotEndMs ? Math.max(0, nowMs - activeSlotEndMs) : 0;
  const overrunMinutes = overrunMs / 60_000;

  // ── COMMUNITY_SYNCED ───────────────────────────────────────────────────────
  if (isResynced && communityMeta?.generatedCycleActive) {
    return {
      atc: {
        mode: 'COMMUNITY_SYNCED',
        statusLine: 'تم ضبط جدولك عبر بلاغ مجتمعي',
        transitionMode,
        overrunMinutes: 0,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
      isHoldingState: false,
      reconciledCycleStartIso: null,
      currentStateStartIso: communityMeta.generatedCycleStartIso,
    };
  }

  // ── POSITIVE_OFFSET_PENDING ────────────────────────────────────────────────
  // Growatt has already transitioned, but user's scheduled time is still future
  if (
    offsetMinutes > 0 &&
    growattCurrentState !== userCurrentState &&
    growattLastTransitionAt
  ) {
    const growattTransitionMs = new Date(growattLastTransitionAt).getTime();
    const scheduledAutoTransitionMs = growattTransitionMs + offsetMinutes * 60_000;

    if (scheduledAutoTransitionMs > nowMs) {
      const remainMin = Math.round((scheduledAutoTransitionMs - nowMs) / 60_000);
      return {
        atc: {
          mode: 'POSITIVE_OFFSET_PENDING',
          statusLine: `سيتم التحديث تلقائياً خلال ${remainMin} دقيقة`,
          transitionMode,
          overrunMinutes: 0,
          communityElevated: true,
          inValidationWindow: true,
          validationWindowRemainingMin: remainMin,
          scheduledAutoTransitionIso: new Date(scheduledAutoTransitionMs).toISOString(),
        },
        isHoldingState: true,
        reconciledCycleStartIso: null,
        currentStateStartIso,
      };
    } else {
      // Scheduled time has already passed — reconcile immediately
      reconciledCycleStartIso = new Date(scheduledAutoTransitionMs).toISOString();
      return {
        atc: {
          mode: 'NORMAL',
          statusLine: '',
          transitionMode,
          overrunMinutes: 0,
          communityElevated: false,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          scheduledAutoTransitionIso: null,
        },
        isHoldingState: false,
        reconciledCycleStartIso,
        currentStateStartIso: reconciledCycleStartIso,
      };
    }
  }

  // ── UNCERTAIN_ZONE ─────────────────────────────────────────────────────────
  // Negative offset users whose schedule slot has overrun the prediction range
  const PREDICTION_RANGE_BUFFER_MIN = 15;
  if (activeSlotEndMs && overrunMinutes > PREDICTION_RANGE_BUFFER_MIN) {
    return {
      atc: {
        mode: 'UNCERTAIN_ZONE',
        statusLine: `تجاوزت المدة بـ ${Math.ceil(overrunMinutes)} دقيقة — بانتظار تأكيد`,
        transitionMode,
        overrunMinutes,
        communityElevated: true,
        inValidationWindow: true,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
      isHoldingState: true,
      reconciledCycleStartIso: null,
      currentStateStartIso,
    };
  }

  // ── PREDICTION_RANGE ───────────────────────────────────────────────────────
  if (activeSlotEndMs && overrunMinutes > 0 && overrunMinutes <= PREDICTION_RANGE_BUFFER_MIN) {
    return {
      atc: {
        mode: 'PREDICTION_RANGE',
        statusLine: 'في نطاق التوقع — التغيير متوقع قريباً',
        transitionMode,
        overrunMinutes,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
      isHoldingState: true,
      reconciledCycleStartIso: null,
      currentStateStartIso,
    };
  }

  // ── WAITING_FOR_GROWATT ────────────────────────────────────────────────────
  // When in MANUAL mode and no Growatt confirmation
  if (transitionMode === 'MANUAL') {
    return {
      atc: {
        mode: 'WAITING_FOR_GROWATT',
        statusLine: 'وضع يدوي — بانتظار تأكيد',
        transitionMode,
        overrunMinutes,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
      isHoldingState: false,
      reconciledCycleStartIso: null,
      currentStateStartIso,
    };
  }

  // ── NORMAL ─────────────────────────────────────────────────────────────────
  return {
    atc: {
      mode: 'NORMAL',
      statusLine: '',
      transitionMode,
      overrunMinutes: 0,
      communityElevated: false,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    },
    isHoldingState: false,
    reconciledCycleStartIso: null,
    currentStateStartIso,
  };
}

// ── Next transition finder ─────────────────────────────────────────────────

function findNextTransition(
  slots: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  nowMs: number,
): UserPrediction['nextTransition'] {
  const targetState: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';

  const nextSlot = slots.find(s => {
    return s.state === targetState && new Date(s.startIso).getTime() > nowMs;
  });

  if (!nextSlot) return null;

  const startMs = new Date(nextSlot.startIso).getTime();
  const minFromNowMin = Math.max(0, (startMs - nowMs) / 60_000);

  // Provide a small range window (±15 minutes)
  const rangeStartMs = Math.max(nowMs, startMs - 15 * 60_000);
  const rangeEndMs = startMs + 15 * 60_000;
  const rangeStartIso = new Date(rangeStartMs).toISOString();
  const rangeEndIso = new Date(rangeEndMs).toISOString();

  return {
    type: targetState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
    rangeStartIso,
    rangeEndIso,
    rangeLabel: `${fmtYemenTime(rangeStartIso)} — ${fmtYemenTime(rangeEndIso)}`,
    minFromNowMin,
    maxFromNowMin: minFromNowMin + 30,
    waitLabel: minFromNowMin < 60
      ? `${Math.round(minFromNowMin)} دقيقة`
      : `${Math.round(minFromNowMin / 60)} ساعة`,
    inRangeWindow: nowMs >= rangeStartMs && nowMs <= rangeEndMs,
  };
}

// ── Duration label builder ─────────────────────────────────────────────────

function buildDurationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `~${m} دقيقة`;
  if (m === 0) return h === 1 ? '~ساعة' : h === 2 ? '~ساعتان' : `~${h} ساعات`;
  return `~${h}س ${m}د`;
}

// ── Main engine entry point ────────────────────────────────────────────────

/**
 * applyOffsetToPrediction — the main TMMS V2 engine function.
 *
 * Takes a raw Prediction (from APPPE / Growatt) and applies:
 *   1. Community resync point (if any) → generates shifted schedule
 *   2. User time offset → shifts all schedule times
 *   3. ATC state machine → determines current operational mode
 *
 * Returns a fully-computed UserPrediction for UI consumption.
 */
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number = 0,
  resyncPoint: ResyncPoint | null = null,
  communitySyncMeta: any = null,
  transitionMode: TransitionMode = 'AUTO',
  anchorStartIso: string | null = null,
  frozenCommunityOffsetMinutes: number | null = null,
  onCommunityOffsetComputed?: (offsetMinutes: number) => void,
  nowMs: number = Date.now(),
): UserPrediction {
  const growattCurrentState = prediction.currentState;
  const growattLastTransitionAt = prediction.lastTransitionAt ?? null;
  const baseSlots = (prediction.daySchedule ?? []) as ScheduleSlot[];

  // ── Step 1: Apply community resync ──────────────────────────────────────
  let communityMeta: CommunityTransitionMeta | null = null;
  let effectiveSlots: ShiftedScheduleSlot[] = baseSlots.map(s => ({
    ...s,
    isResynced: false,
    shiftedStartFormatted: fmtYemenTime(s.startIso),
    shiftedEndFormatted: s.endIso ? fmtYemenTime(s.endIso) : null,
  }));
  let isResynced = false;

  if (resyncPoint) {
    const transitionResult = computeCommunityTransition({
      slots: baseSlots,
      resyncPoint,
      growattCurrentState,
      growattLastTransitionAt: growattLastTransitionAt ?? new Date(nowMs).toISOString(),
      frozenOffsetMinutes: frozenCommunityOffsetMinutes,
      nowMs,
    });

    if (transitionResult) {
      communityMeta = transitionResult.meta;
      isResynced = true;

      if (communityMeta.isFreshOffsetComputation && onCommunityOffsetComputed) {
        onCommunityOffsetComputed(communityMeta.offsetMinutes);
      }

      // Build the pre-cycle slots (before the generated slot)
      const reportAtMs = new Date(resyncPoint.syncedAtIso).getTime();
      const preCycleSlots: ShiftedScheduleSlot[] = baseSlots
        .filter(s => new Date(s.startIso).getTime() < reportAtMs)
        .map(s => ({
          ...s,
          isResynced: false,
          shiftedStartFormatted: fmtYemenTime(s.startIso),
          shiftedEndFormatted: s.endIso ? fmtYemenTime(s.endIso) : null,
        }));

      effectiveSlots = [...preCycleSlots, ...transitionResult.generatedSlots];
    }
  }

  // ── Step 2: Apply user offset to non-resynced slots ──────────────────────
  const offsetMs = offsetMinutes * 60_000;
  const shiftedSlots: ShiftedScheduleSlot[] = effectiveSlots.map(s => {
    if (s.isResynced) return s; // generated slots keep their computed times
    const shiftedStartMs = new Date(s.startIso).getTime() + offsetMs;
    const shiftedEndMs = s.endIso ? new Date(s.endIso).getTime() + offsetMs : null;
    const shiftedStartIso = new Date(shiftedStartMs).toISOString();
    const shiftedEndIso = shiftedEndMs ? new Date(shiftedEndMs).toISOString() : null;
    return {
      ...s,
      startIso: shiftedStartIso,
      endIso: shiftedEndIso,
      shiftedStartFormatted: fmtYemenTime(shiftedStartIso),
      shiftedEndFormatted: shiftedEndIso ? fmtYemenTime(shiftedEndIso) : null,
    };
  });

  // ── Step 3: Determine current user state ────────────────────────────────
  let userCurrentState: 'ON' | 'OFF' = growattCurrentState;
  let userCurrentStateStartIso: string | null = growattLastTransitionAt;

  // If resynced and generated cycle is active, use generated state
  if (communityMeta?.generatedCycleActive) {
    userCurrentState = communityMeta.generatedCycleState;
    userCurrentStateStartIso = communityMeta.generatedCycleStartIso;
  } else {
    // Find active slot in shifted schedule
    const activeShiftedSlot = shiftedSlots.find(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= start && nowMs < end;
    });
    if (activeShiftedSlot) {
      userCurrentState = activeShiftedSlot.state;
      userCurrentStateStartIso = activeShiftedSlot.startIso;
    }
  }

  // For POSITIVE_OFFSET_PENDING: user holds the OLD state
  const rawGrowattState = growattCurrentState;
  if (offsetMinutes > 0 && growattLastTransitionAt) {
    const growattTransitionMs = new Date(growattLastTransitionAt).getTime();
    const scheduledMs = growattTransitionMs + offsetMinutes * 60_000;
    if (scheduledMs > nowMs) {
      // Growatt has transitioned but user hasn't yet — hold user's previous state
      userCurrentState = growattCurrentState === 'ON' ? 'OFF' : 'ON';
    }
  }

  // ── Step 4: Inject synthetic slot for POSITIVE_OFFSET_PENDING ──────────
  // If the user is holding the old state, inject a synthetic "current" slot
  // at the front of the schedule
  let finalSlots = shiftedSlots;
  if (
    offsetMinutes > 0 &&
    growattLastTransitionAt &&
    !communityMeta?.generatedCycleActive
  ) {
    const growattTransitionMs = new Date(growattLastTransitionAt).getTime();
    const scheduledMs = growattTransitionMs + offsetMinutes * 60_000;
    if (scheduledMs > nowMs) {
      const heldState: 'ON' | 'OFF' = growattCurrentState === 'ON' ? 'OFF' : 'ON';
      const syntheticSlot: ShiftedScheduleSlot = {
        state: heldState,
        startIso: userCurrentStateStartIso ?? new Date(nowMs - 60_000).toISOString(),
        endIso: new Date(scheduledMs).toISOString(),
        startFormatted: fmtYemenTime(userCurrentStateStartIso ?? new Date(nowMs).toISOString()),
        endFormatted: fmtYemenTime(new Date(scheduledMs).toISOString()),
        durationLabel: durationLabelFromMin(offsetMinutes),
        zone: getZoneFromIso(new Date(nowMs).toISOString()),
        isEstimated: false,
        isResynced: false,
        shiftedStartFormatted: fmtYemenTime(userCurrentStateStartIso ?? new Date(nowMs).toISOString()),
        shiftedEndFormatted: fmtYemenTime(new Date(scheduledMs).toISOString()),
      };
      finalSlots = [syntheticSlot, ...shiftedSlots.filter(s => new Date(s.startIso).getTime() >= scheduledMs)];
    }
  }

  // ── Step 5: Run ATC state machine ────────────────────────────────────────
  const atcOutput = computeATCState({
    growattCurrentState,
    growattLastTransitionAt,
    userCurrentState,
    userScheduleSlots: finalSlots,
    offsetMinutes,
    transitionMode,
    communityMeta,
    isResynced,
    nowMs,
    anchorStartIso,
  });

  // ── Step 6: Find next transition ────────────────────────────────────────
  const isHolding = atcOutput.isHoldingState;
  const isUnstable = prediction.isUnstable ?? false;
  let nextTransition: UserPrediction['nextTransition'] = null;

  if (!isHolding || atcOutput.atc.mode === 'POSITIVE_OFFSET_PENDING') {
    nextTransition = findNextTransition(finalSlots, userCurrentState, nowMs);
  }

  // ── Step 7: Duration labels ──────────────────────────────────────────────
  const onSlots = finalSlots.filter(s => s.state === 'ON' && s.endIso);
  const offSlots = finalSlots.filter(s => s.state === 'OFF' && s.endIso);

  const avgDurMin = (arr: ShiftedScheduleSlot[]) => {
    if (arr.length === 0) return null;
    const total = arr.reduce((sum, s) => {
      const dur = (new Date(s.endIso!).getTime() - new Date(s.startIso).getTime()) / 60_000;
      return sum + dur;
    }, 0);
    return total / arr.length;
  };

  const avgOnMin = avgDurMin(onSlots);
  const avgOffMin = avgDurMin(offSlots);

  const expectedOnDurationLabel = avgOnMin !== null ? buildDurationLabel(avgOnMin) : null;
  const expectedOffDurationLabel = avgOffMin !== null ? buildDurationLabel(avgOffMin) : null;

  // ── Step 8: Community sync meta ──────────────────────────────────────────
  const commSyncMeta = resyncPoint ? {
    syncedAtIso: resyncPoint.syncedAtIso,
    reporterName: resyncPoint.reporterName ?? null,
    reporterReliability: resyncPoint.reporterReliability ?? null,
  } : communitySyncMeta ? {
    syncedAtIso: communitySyncMeta.syncedAtIso ?? new Date(nowMs).toISOString(),
    reporterName: communitySyncMeta.reporterName ?? null,
    reporterReliability: communitySyncMeta.reporterReliability ?? null,
  } : null;

  // ── Assemble final UserPrediction ────────────────────────────────────────
  return {
    currentState: userCurrentState,
    currentStateStartIso: atcOutput.currentStateStartIso ?? userCurrentStateStartIso,
    nextTransition,
    daySchedule: finalSlots,

    confidence: prediction.confidence ?? 0,
    stabilityScore: prediction.stabilityScore ?? 0,
    stabilityLabel: prediction.stabilityLabel ?? 'Unknown',
    learningMode: prediction.learningMode ?? 'prior_only',
    computedAt: prediction.computedAt ?? new Date(nowMs).toISOString(),

    expectedOnDurationLabel,
    expectedOffDurationLabel,

    atc: atcOutput.atc,
    isHoldingState: isHolding,
    isResynced,
    isUnstable,

    offsetMinutes,

    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    reconciledCycleStartIso: atcOutput.reconciledCycleStartIso,
    communitySyncMeta: commSyncMeta,
    communityTransitionMeta: communityMeta,

    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    reasoning: prediction.reasoning ?? [],

    // Extra fields passed through for compatibility
    apppe: prediction.apppe,
  };
}
