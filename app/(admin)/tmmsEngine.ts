/**
 * TMMS V2 Engine — pure TypeScript, no React, no DOM.
 * This is the authoritative TMMS logic used by both the production app
 * (via hooks/useUserPredictions.ts) and the admin debug simulator
 * (via TMMSDebugSimulator.tsx / tmmsSimulation.ts).
 *
 * Exports used by tmmsSimulation.ts and TMMSDebugSimulator.tsx.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TransitionMode = 'AUTO' | 'MANUAL';
export type TrustLevel = 'VERIFIED' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
  isResynced?: boolean;
}

export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string;
  reporterReliability?: number;
}

export interface DecisionStep {
  step: number;
  label: string;
  detail: string;
}

export interface Prediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string | null;
  inverterOffline: boolean;
  nextTransition: any | null;
  expectedOffRange: { minMin: number; maxMin: number; label: string } | null;
  expectedOnRange: { minMin: number; maxMin: number; label: string } | null;
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
  currentPeriod: string;
  reasoning: string[];
  learningMode: string;
  dataWindowHours: number;
  computedAt: string;
}

export interface CommunityTransitionMeta {
  progressRatio: number;
  generatedCycleStartIso: string;
  generatedCycleEndIso: string;
  generatedCycleState: 'ON' | 'OFF';
  generatedCycleActive: boolean;
  offsetMinutes: number;
  offsetSign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  offsetReferenceIso: string | null;
  offsetReferenceKind: string | null;
  isFreshOffsetComputation: boolean;
  durationSelectionRule: 'OFF_PROGRESS_LT_50_BEFORE' | 'OFF_PROGRESS_GT_50_AFTER' | 'ON_ALWAYS_BEFORE';
  durationSourceSlot: { state: 'ON' | 'OFF'; durationLabel: string } | null;
  decisionTrace: DecisionStep[];
}

export interface ATCState {
  mode:
    | 'NORMAL'
    | 'PREDICTION_RANGE'
    | 'UNCERTAIN_ZONE'
    | 'COMMUNITY_SYNCED'
    | 'WAITING_FOR_GROWATT'
    | 'GRACE_MODE'
    | 'POSITIVE_OFFSET_PENDING';
  overrunMinutes: number;
  communityElevated: boolean;
  statusLine: string | null;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  transitionMode: TransitionMode;
  scheduledAutoTransitionIso: string | null;
}

export interface UserPrediction extends Prediction {
  atc: ATCState;
  isHoldingState: boolean;
  currentStateStartIso: string | null;
  reconciledCycleStartIso: string | null;
  isResynced: boolean;
  resyncedAtIso: string | null;
  communitySyncMeta: any | null;
  communityTransitionMeta: CommunityTransitionMeta | null;
  // Convenience aliases surfaced from apppe
  crisisMode?: boolean;
  crisisReason?: string | null;
  offsetMinutes?: number;
  expectedOnDurationLabel?: string | null;
  expectedOffDurationLabel?: string | null;
}

export interface ReportRecord {
  id: string;
  state: 'ON' | 'OFF';
  originalReportAtIso: string;
  processedAtIso: string | null;
  reporterName: string;
  confidenceScore: number;
  trustLevel: TrustLevel;
  confirmations: Array<{
    confirmerName: string;
    hoursAfterReport: number;
    confidenceScoreAfter: number;
  }>;
}

// ── Utility helpers ──────────────────────────────────────────────────────────

const YEMEN_OFFSET_MS = 3 * 60 * 60 * 1000;

export function fmtYemenTime(iso: string): string {
  const raw = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return raw.replace('AM', 'ص').replace('PM', 'م');
}

export function getZoneFromIso(iso: string): string {
  const h = new Date(new Date(iso).getTime() + YEMEN_OFFSET_MS).getUTCHours();
  if (h < 6) return 'Night';
  if (h < 10) return 'Morning';
  if (h < 16) return 'Midday';
  if (h < 20) return 'Evening';
  return 'Late Night';
}

export function durationLabelFromMin(min: number): string {
  if (!min || min <= 0) return '0د';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

export function fmtYemenWithDate(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

// ── Report record helpers ─────────────────────────────────────────────────────

const MAX_CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function scoreToTrust(score: number): TrustLevel {
  if (score >= 90) return 'VERIFIED';
  if (score >= 70) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

let reportIdCounter = 0;

export function createReportRecord(
  state: 'ON' | 'OFF',
  reportAtIso: string,
  reporterName: string,
  processed: boolean = true,
  nowIso?: string,
): ReportRecord {
  reportIdCounter += 1;
  const baseScore = 55;
  return {
    id: `rep_${reportIdCounter}_${Date.now()}`,
    state,
    originalReportAtIso: reportAtIso,
    processedAtIso: processed ? (nowIso ?? reportAtIso) : null,
    reporterName,
    confidenceScore: baseScore,
    trustLevel: scoreToTrust(baseScore),
    confirmations: [],
  };
}

export function findConfirmableReport(
  reports: ReportRecord[],
  state: 'ON' | 'OFF',
  atMs: number,
): ReportRecord | null {
  // Find the most recent matching report within the confirmation window
  let best: ReportRecord | null = null;
  let bestMs = -Infinity;

  for (const r of reports) {
    if (r.state !== state) continue;
    const reportMs = new Date(r.originalReportAtIso).getTime();
    const age = atMs - reportMs;
    if (age < 0 || age > MAX_CONFIRMATION_WINDOW_MS) continue;
    if (reportMs > bestMs) {
      bestMs = reportMs;
      best = r;
    }
  }

  return best;
}

export function applyConfirmationToReport(
  report: ReportRecord,
  confirmAtIso: string,
  confirmerName: string,
): ReportRecord {
  const hoursAfterReport =
    (new Date(confirmAtIso).getTime() - new Date(report.originalReportAtIso).getTime()) / 3_600_000;

  // Confidence increases with each confirmation, capped at 95
  const increment = Math.max(5, 15 - report.confirmations.length * 3);
  const newScore = Math.min(95, report.confidenceScore + increment);
  const newTrust = scoreToTrust(newScore);

  return {
    ...report,
    confidenceScore: newScore,
    trustLevel: newTrust,
    confirmations: [
      ...report.confirmations,
      {
        confirmerName,
        hoursAfterReport: Math.round(hoursAfterReport * 10) / 10,
        confidenceScoreAfter: newScore,
      },
    ],
  };
}

// ── Community offset computation (Rule 4 + Rule 5) ───────────────────────────

export interface CommunityOffsetResult {
  offsetMinutes: number;
  sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  referenceIso: string;
  referenceKind:
    | 'GROWATT_ON_START_ACTUAL'
    | 'GROWATT_ON_END_EXPECTED'
    | 'GROWATT_OFF_END_EXPECTED'
    | 'GROWATT_OFF_START_ACTUAL';
}

function findActiveSlotInRawSchedule(
  rawSchedule: ScheduleSlot[],
  state: 'ON' | 'OFF',
  atMs: number,
): ScheduleSlot | null {
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs = new Date(s.endIso).getTime();
    if (atMs >= startMs && atMs <= endMs) return s;
  }
  let best: ScheduleSlot | null = null;
  let bestDist = Infinity;
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const dist = Math.abs(new Date(s.startIso).getTime() - atMs);
    if (dist < bestDist) { bestDist = dist; best = s; }
  }
  return best;
}

export function computeCommunityOffset(
  rawSchedule: ScheduleSlot[],
  resync: ResyncPoint,
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
): CommunityOffsetResult | null {
  const startMs = new Date(resync.syncedAtIso).getTime();
  const reportedState = resync.syncedState;

  let referenceIso: string | null;
  let referenceKind: CommunityOffsetResult['referenceKind'];

  if (growattCurrentState === reportedState) {
    referenceIso = growattLastTransitionAt;
    referenceKind =
      reportedState === 'ON' ? 'GROWATT_ON_START_ACTUAL' : 'GROWATT_OFF_START_ACTUAL';
  } else {
    const rawActiveSlot = findActiveSlotInRawSchedule(
      rawSchedule,
      growattCurrentState,
      startMs,
    );
    referenceIso = rawActiveSlot?.endIso ?? null;
    referenceKind =
      growattCurrentState === 'ON' ? 'GROWATT_ON_END_EXPECTED' : 'GROWATT_OFF_END_EXPECTED';
  }

  if (!referenceIso) return null;

  const referenceMs = new Date(referenceIso).getTime();
  const offsetMsExact = startMs - referenceMs;
  const sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' =
    offsetMsExact === 0 ? 'NEUTRAL' : offsetMsExact > 0 ? 'POSITIVE' : 'NEGATIVE';

  return {
    offsetMinutes: Math.round(offsetMsExact / 60_000),
    sign,
    referenceIso,
    referenceKind,
  };
}

// ── Schedule-Based Community Transition ──────────────────────────────────────

interface ShiftedSlot extends ScheduleSlot {
  isResynced: boolean;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string | null;
}

interface CommunityTransitionResult {
  effectiveSlots: ShiftedSlot[];
  generatedCycleStartIso: string;
  generatedCycleEndIso: string;
  generatedCycleState: 'ON' | 'OFF';
  progressRatio: number;
  derivedOffsetMinutes: number;
  offsetSign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  offsetReferenceIso: string | null;
  offsetReferenceKind: CommunityOffsetResult['referenceKind'] | null;
  isFreshOffsetComputation: boolean;
  durationSelectionRule: CommunityTransitionMeta['durationSelectionRule'];
  durationSourceSlot: CommunityTransitionMeta['durationSourceSlot'];
  decisionTrace: DecisionStep[];
}

function computeCommunityTransition(
  offsetSlots: ShiftedSlot[],
  resync: ResyncPoint,
  rawSchedule: ScheduleSlot[],
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
  frozenOffsetMinutes: number | null,
  nowMs: number,
): CommunityTransitionResult | null {
  const syncMs = new Date(resync.syncedAtIso).getTime();
  if (syncMs > nowMs + 60_000) return null;

  const syncState: 'ON' | 'OFF' = resync.syncedState;
  const interruptedState: 'ON' | 'OFF' = syncState === 'ON' ? 'OFF' : 'ON';
  const trace: DecisionStep[] = [];
  let traceStep = 1;

  // Step 1: Find interrupted slot
  let interruptedSlotIdx = -1;
  for (let i = 0; i < offsetSlots.length; i++) {
    const s = offsetSlots[i];
    if (s.state !== interruptedState) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (syncMs >= startMs && syncMs <= endMs) { interruptedSlotIdx = i; break; }
  }
  if (interruptedSlotIdx === -1) {
    for (let i = offsetSlots.length - 1; i >= 0; i--) {
      if (offsetSlots[i].state !== interruptedState) continue;
      if (new Date(offsetSlots[i].startIso).getTime() <= syncMs) {
        interruptedSlotIdx = i;
        break;
      }
    }
  }
  if (interruptedSlotIdx === -1) return null;

  const interruptedSlot = offsetSlots[interruptedSlotIdx];
  if (!interruptedSlot.endIso) return null;

  trace.push({
    step: traceStep++,
    label: 'Interrupted Slot Located',
    detail: `${interruptedState} slot ${fmtYemenTime(interruptedSlot.startIso)} → ${fmtYemenTime(interruptedSlot.endIso)}`,
  });

  // Step 3: Exact progress ratio
  const cycleStartMs = new Date(interruptedSlot.startIso).getTime();
  const cyclePlannedEndMs = new Date(interruptedSlot.endIso).getTime();
  const plannedDurationMs = cyclePlannedEndMs - cycleStartMs;
  if (plannedDurationMs <= 0) return null;

  const elapsedMs = syncMs - cycleStartMs;
  const progressRatio = elapsedMs / plannedDurationMs;

  trace.push({
    step: traceStep++,
    label: 'Progress Ratio',
    detail: `${(progressRatio * 100).toFixed(1)}% of ${durationLabelFromMin(Math.round(plannedDurationMs / 60_000))}`,
  });

  // Step 5 (Rule 3): Duration selection
  const wantsBefore = interruptedState === 'ON' ? true : progressRatio <= 0.5;
  let durationSelectionRule: CommunityTransitionMeta['durationSelectionRule'];
  if (interruptedState === 'ON') {
    durationSelectionRule = 'ON_ALWAYS_BEFORE';
  } else if (progressRatio <= 0.5) {
    durationSelectionRule = 'OFF_PROGRESS_LT_50_BEFORE';
  } else {
    durationSelectionRule = 'OFF_PROGRESS_GT_50_AFTER';
  }

  let durationSourceIdx = -1;
  if (wantsBefore) {
    for (let i = interruptedSlotIdx - 1; i >= 0; i--) {
      if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) { durationSourceIdx = i; break; }
    }
    if (durationSourceIdx === -1) {
      for (let i = interruptedSlotIdx + 1; i < offsetSlots.length; i++) {
        if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) { durationSourceIdx = i; break; }
      }
    }
  } else {
    for (let i = interruptedSlotIdx + 1; i < offsetSlots.length; i++) {
      if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) { durationSourceIdx = i; break; }
    }
    if (durationSourceIdx === -1) {
      for (let i = interruptedSlotIdx - 1; i >= 0; i--) {
        if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) { durationSourceIdx = i; break; }
      }
    }
  }

  let selectedDurationMs: number;
  let durationSourceSlot: CommunityTransitionMeta['durationSourceSlot'] = null;

  if (durationSourceIdx !== -1 && offsetSlots[durationSourceIdx].endIso) {
    const src = offsetSlots[durationSourceIdx];
    selectedDurationMs = new Date(src.endIso!).getTime() - new Date(src.startIso).getTime();
    durationSourceSlot = { state: src.state, durationLabel: durationLabelFromMin(Math.round(selectedDurationMs / 60_000)) };
  } else {
    selectedDurationMs = plannedDurationMs;
    durationSourceSlot = null;
  }

  trace.push({
    step: traceStep++,
    label: `Duration Rule: ${durationSelectionRule}`,
    detail: `Selected duration: ${durationLabelFromMin(Math.round(selectedDurationMs / 60_000))}`,
  });

  // Step 6: Build generated cycle
  const generatedCycleStartIso = resync.syncedAtIso;
  const generatedCycleEndMs = syncMs + selectedDurationMs;
  const generatedCycleEndIso = new Date(generatedCycleEndMs).toISOString();

  const generatedSlot: ShiftedSlot = {
    state: syncState,
    startIso: generatedCycleStartIso,
    endIso: generatedCycleEndIso,
    startFormatted: fmtYemenTime(generatedCycleStartIso),
    endFormatted: fmtYemenTime(generatedCycleEndIso),
    shiftedStartFormatted: fmtYemenTime(generatedCycleStartIso),
    shiftedEndFormatted: fmtYemenTime(generatedCycleEndIso),
    durationLabel: durationLabelFromMin(Math.round(selectedDurationMs / 60_000)),
    zone: getZoneFromIso(generatedCycleStartIso),
    isEstimated: false,
    isResynced: true,
  };

  trace.push({
    step: traceStep++,
    label: 'Generated Cycle Created',
    detail: `${syncState} from ${fmtYemenTime(generatedCycleStartIso)} to ${fmtYemenTime(generatedCycleEndIso)}`,
  });

  // Step 7: Rebuild logical continuation
  let fallbackOnMs = 120 * 60_000;
  let fallbackOffMs = 360 * 60_000;
  for (const s of offsetSlots) {
    if (!s.endIso) continue;
    const d = new Date(s.endIso).getTime() - new Date(s.startIso).getTime();
    if (d < 5 * 60_000) continue;
    if (s.state === 'ON') fallbackOnMs = d;
    else fallbackOffMs = d;
  }

  const continuationStartIdx = durationSourceIdx !== -1 ? durationSourceIdx + 1 : interruptedSlotIdx + 1;
  const horizonMs = nowMs + 48 * 60 * 60 * 1000;
  const continuationSlots: ShiftedSlot[] = [];
  let currentStartMs = generatedCycleEndMs;
  let srcIdx = continuationStartIdx;

  while (currentStartMs < horizonMs && continuationSlots.length < 24) {
    let slotDurationMs: number;
    let slotState: 'ON' | 'OFF';

    if (srcIdx < offsetSlots.length) {
      const src = offsetSlots[srcIdx];
      if (!src.endIso) { srcIdx++; continue; }
      slotDurationMs = new Date(src.endIso).getTime() - new Date(src.startIso).getTime();
      if (slotDurationMs <= 0) { srcIdx++; continue; }
      slotState = src.state;
    } else {
      const lastState = continuationSlots.length > 0
        ? continuationSlots[continuationSlots.length - 1].state
        : syncState;
      slotState = lastState === 'ON' ? 'OFF' : 'ON';
      slotDurationMs = slotState === 'ON' ? fallbackOnMs : fallbackOffMs;
    }

    const slotStartIso = new Date(currentStartMs).toISOString();
    const slotEndMs = currentStartMs + slotDurationMs;
    const slotEndIso = new Date(slotEndMs).toISOString();

    continuationSlots.push({
      state: slotState,
      startIso: slotStartIso,
      endIso: slotEndIso,
      startFormatted: fmtYemenTime(slotStartIso),
      endFormatted: fmtYemenTime(slotEndIso),
      shiftedStartFormatted: fmtYemenTime(slotStartIso),
      shiftedEndFormatted: fmtYemenTime(slotEndIso),
      durationLabel: durationLabelFromMin(Math.round(slotDurationMs / 60_000)),
      zone: getZoneFromIso(slotStartIso),
      isEstimated: srcIdx >= offsetSlots.length,
      isResynced: false,
    });

    currentStartMs = slotEndMs;
    srcIdx++;
  }

  const preCycleSlots = offsetSlots.slice(0, interruptedSlotIdx);

  // Rule 4+5: Offset calculation
  let offsetMinutesFinal: number;
  let offsetSignFinal: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  let offsetReferenceIsoFinal: string | null;
  let offsetReferenceKindFinal: CommunityOffsetResult['referenceKind'] | null;
  let isFreshOffsetComputation: boolean;

  if (frozenOffsetMinutes !== null && frozenOffsetMinutes !== undefined) {
    offsetMinutesFinal = frozenOffsetMinutes;
    offsetSignFinal = offsetMinutesFinal === 0 ? 'NEUTRAL' : offsetMinutesFinal > 0 ? 'POSITIVE' : 'NEGATIVE';
    offsetReferenceIsoFinal = null;
    offsetReferenceKindFinal = null;
    isFreshOffsetComputation = false;
  } else {
    const computed = computeCommunityOffset(rawSchedule, resync, growattCurrentState, growattLastTransitionAt);
    if (computed) {
      offsetMinutesFinal = computed.offsetMinutes;
      offsetSignFinal = computed.sign;
      offsetReferenceIsoFinal = computed.referenceIso;
      offsetReferenceKindFinal = computed.referenceKind;
    } else {
      offsetMinutesFinal = 0;
      offsetSignFinal = 'NEUTRAL';
      offsetReferenceIsoFinal = null;
      offsetReferenceKindFinal = null;
    }
    isFreshOffsetComputation = true;
  }

  trace.push({
    step: traceStep++,
    label: `Offset Calculation (${isFreshOffsetComputation ? 'fresh' : 'frozen'})`,
    detail: `${offsetMinutesFinal >= 0 ? '+' : ''}${offsetMinutesFinal}m → ${offsetSignFinal}`,
  });

  return {
    effectiveSlots: [...preCycleSlots, generatedSlot, ...continuationSlots],
    generatedCycleStartIso,
    generatedCycleEndIso,
    generatedCycleState: syncState,
    progressRatio,
    derivedOffsetMinutes: offsetMinutesFinal,
    offsetSign: offsetSignFinal,
    offsetReferenceIso: offsetReferenceIsoFinal,
    offsetReferenceKind: offsetReferenceKindFinal,
    isFreshOffsetComputation,
    durationSelectionRule,
    durationSourceSlot,
    decisionTrace: trace,
  };
}

// ── ATC State Engine ──────────────────────────────────────────────────────────

const EMPTY_ATC: ATCState = {
  mode: 'NORMAL',
  overrunMinutes: 0,
  communityElevated: false,
  statusLine: null,
  inValidationWindow: false,
  validationWindowRemainingMin: 0,
  transitionMode: 'AUTO',
  scheduledAutoTransitionIso: null,
};

const VALIDATION_WINDOW_MS = 20 * 60_000;
const GRACE_PERIOD_MS = 15 * 60_000;

function computeATCState(
  effectiveSlots: ShiftedSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
  transitionMode: TransitionMode,
  communityTransition: CommunityTransitionResult | null,
  nowMs: number,
): ATCState {
  const halfSpreadMs = 15 * 60_000;

  // Phase A: inside generated cycle
  if (resyncPoint && communityTransition) {
    const generatedCycleEndMs = new Date(communityTransition.generatedCycleEndIso).getTime();
    if (nowMs < generatedCycleEndMs) {
      const syncedState = resyncPoint.syncedState;
      const growattDiffers = prediction.currentState !== syncedState;
      const syncAgeMs = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
      const inValidationWindow = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
      const validationRemainingMin = inValidationWindow ? (VALIDATION_WINDOW_MS - syncAgeMs) / 60_000 : 0;
      return {
        mode: 'COMMUNITY_SYNCED',
        overrunMinutes: 0,
        communityElevated: inValidationWindow,
        statusLine: inValidationWindow
          ? `نافذة التحقق نشطة — الحساس يُشير لتغيير · ${Math.ceil(validationRemainingMin)} د`
          : null,
        inValidationWindow,
        validationWindowRemainingMin: validationRemainingMin,
        transitionMode,
        scheduledAutoTransitionIso: null,
      };
    }
    // Phase B: after generated cycle — recurse with derived offset
    return computeATCState(
      effectiveSlots,
      communityTransition.derivedOffsetMinutes,
      null,
      prediction,
      transitionMode,
      null,
      nowMs,
    );
  }

  // Legacy resync
  if (resyncPoint) {
    const syncedState = resyncPoint.syncedState;
    const growattDiffers = prediction.currentState !== syncedState;
    const syncAgeMs = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
    const inValidationWindow = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
    const validationRemainingMin = inValidationWindow ? (VALIDATION_WINDOW_MS - syncAgeMs) / 60_000 : 0;
    return {
      mode: 'COMMUNITY_SYNCED',
      overrunMinutes: 0,
      communityElevated: inValidationWindow,
      statusLine: inValidationWindow
        ? `نافذة التحقق نشطة — الحساس يُشير لتغيير · ${Math.ceil(validationRemainingMin)} د`
        : null,
      inValidationWindow,
      validationWindowRemainingMin: validationRemainingMin,
      transitionMode,
      scheduledAutoTransitionIso: null,
    };
  }

  // User A: negative offset
  if (offsetMinutes < 0) {
    let justEndedSlot: ShiftedSlot | null = null;
    for (let i = 0; i < effectiveSlots.length; i++) {
      const s = effectiveSlots[i];
      if (!s.endIso) continue;
      if (new Date(s.endIso).getTime() <= nowMs) justEndedSlot = s;
      else break;
    }

    if (justEndedSlot && justEndedSlot.endIso) {
      const slotEndMs = new Date(justEndedSlot.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs = slotEndMs + halfSpreadMs;
      const overrunMs = Math.max(0, nowMs - rangeEndMs);
      const overrunMin = overrunMs / 60_000;

      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };
      }
      if (nowMs > rangeStartMs) {
        return {
          ...EMPTY_ATC,
          mode: 'UNCERTAIN_ZONE',
          overrunMinutes: overrunMin,
          communityElevated: true,
          statusLine: overrunMin < 1
            ? 'نطاق التوقع انتهى — بانتظار تأكيد تغير الحالة'
            : `تجاوزت المدة المتوقعة بـ ${Math.ceil(overrunMin)} دقيقة — بانتظار تأكيد`,
          transitionMode,
        };
      }
    }

    let activeSlot: ShiftedSlot | null = null;
    for (const slot of effectiveSlots) {
      const start = new Date(slot.startIso).getTime();
      const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      if (nowMs >= start && nowMs < end) { activeSlot = slot; break; }
    }
    if (activeSlot?.endIso) {
      const slotEndMs = new Date(activeSlot.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs = slotEndMs + halfSpreadMs;
      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };
      }
    }
    return { ...EMPTY_ATC, transitionMode };
  }

  // User B: positive offset
  if (offsetMinutes > 0) {
    let activeSlotPos: ShiftedSlot | null = null;
    for (const slot of effectiveSlots) {
      const start = new Date(slot.startIso).getTime();
      const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      if (nowMs >= start && nowMs < end) { activeSlotPos = slot; break; }
    }
    let nextSlotPos: ShiftedSlot | null = null;
    for (const slot of effectiveSlots) {
      if (new Date(slot.startIso).getTime() > nowMs) { nextSlotPos = slot; break; }
    }
    const scheduleCurrentState = activeSlotPos?.state ?? (nextSlotPos ? (nextSlotPos.state === 'ON' ? 'OFF' : 'ON') : null);
    const growattFlippedAhead =
      scheduleCurrentState !== null &&
      prediction.currentState !== scheduleCurrentState &&
      !!prediction.lastTransitionAt;

    if (growattFlippedAhead && transitionMode === 'AUTO') {
      const scheduledMs = new Date(prediction.lastTransitionAt!).getTime() + offsetMinutes * 60_000;
      const scheduledAutoTransitionIso = new Date(scheduledMs).toISOString();
      return {
        ...EMPTY_ATC,
        mode: 'POSITIVE_OFFSET_PENDING',
        statusLine: scheduledMs > nowMs
          ? `سيتم تغيير حالتك تلقائياً في ${fmtYemenTime(scheduledAutoTransitionIso)} · بعد ${Math.round((scheduledMs - nowMs) / 60_000)} د`
          : null,
        scheduledAutoTransitionIso,
        transitionMode,
      };
    }

    if (!activeSlotPos?.endIso) return { ...EMPTY_ATC, transitionMode };
    const slotEndMs = new Date(activeSlotPos.endIso).getTime();
    const rangeStartMs = slotEndMs - halfSpreadMs;
    const rangeEndMs = slotEndMs + halfSpreadMs;
    const overrunMs = Math.max(0, nowMs - rangeEndMs);
    const overrunMin = overrunMs / 60_000;

    if (nowMs < rangeStartMs) return { ...EMPTY_ATC, transitionMode };
    if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
      return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };
    }
    return {
      ...EMPTY_ATC,
      mode: 'WAITING_FOR_GROWATT',
      overrunMinutes: overrunMin,
      communityElevated: transitionMode === 'MANUAL',
      statusLine: transitionMode === 'MANUAL'
        ? 'وضع يدوي — بانتظار بلاغك أو تأكيد مجتمعي'
        : 'بانتظار تأكيد الحساس الرئيسي أو بلاغ مجتمعي',
      transitionMode,
    };
  }

  // User C: neutral offset
  let activeSlot: ShiftedSlot | null = null;
  for (const slot of effectiveSlots) {
    const start = new Date(slot.startIso).getTime();
    const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= start && nowMs < end) { activeSlot = slot; break; }
  }
  if (!activeSlot?.endIso) return { ...EMPTY_ATC, transitionMode };

  const slotEndMs = new Date(activeSlot.endIso).getTime();
  const rangeStartMs = slotEndMs - halfSpreadMs;
  const rangeEndMs = slotEndMs + halfSpreadMs;
  const overrunMs = Math.max(0, nowMs - rangeEndMs);
  const overrunMin = overrunMs / 60_000;

  if (nowMs < rangeStartMs) return { ...EMPTY_ATC, transitionMode };
  if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
    return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };
  }
  if (overrunMs <= GRACE_PERIOD_MS) {
    return {
      ...EMPTY_ATC,
      mode: 'GRACE_MODE',
      overrunMinutes: overrunMin,
      statusLine: 'تأخر غير معتاد — لا يزال التشغيل مستمراً خارج النطاق المتوقع',
      transitionMode,
    };
  }
  return {
    ...EMPTY_ATC,
    mode: 'WAITING_FOR_GROWATT',
    overrunMinutes: overrunMin,
    communityElevated: true,
    statusLine: transitionMode === 'MANUAL'
      ? 'وضع يدوي — بانتظار بلاغك أو تأكيد مجتمعي لإنهاء الدورة'
      : 'النمط الحالي ممتد بشكل غير معتاد — بانتظار تأكيد تغير الحالة',
    transitionMode,
  };
}

function atcShouldHold(mode: ATCState['mode']): boolean {
  return (
    mode === 'UNCERTAIN_ZONE' ||
    mode === 'WAITING_FOR_GROWATT' ||
    mode === 'PREDICTION_RANGE' ||
    mode === 'GRACE_MODE' ||
    mode === 'POSITIVE_OFFSET_PENDING'
  );
}

function deriveCurrentStateATC(
  effectiveSlots: ShiftedSlot[],
  atcMode: ATCState['mode'],
  masterCurrentState: 'ON' | 'OFF',
  resyncPoint: ResyncPoint | null,
  communityTransition: CommunityTransitionResult | null,
  nowMs: number,
): { state: 'ON' | 'OFF'; startIso: string | null } {
  if (resyncPoint && communityTransition) {
    const generatedCycleEndMs = new Date(communityTransition.generatedCycleEndIso).getTime();
    if (nowMs < generatedCycleEndMs) {
      return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
    }
  } else if (resyncPoint) {
    return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
  }

  const derivePreSchedule = (): { state: 'ON' | 'OFF'; startIso: string | null } => {
    if (effectiveSlots.length > 0) {
      return { state: effectiveSlots[0].state === 'ON' ? 'OFF' : 'ON', startIso: null };
    }
    return { state: masterCurrentState, startIso: null };
  };

  if (atcShouldHold(atcMode)) {
    if (atcMode === 'UNCERTAIN_ZONE') {
      let heldSlot: ShiftedSlot | null = null;
      for (let i = 0; i < effectiveSlots.length; i++) {
        const s = effectiveSlots[i];
        if (!s.endIso) continue;
        if (new Date(s.endIso).getTime() <= nowMs) heldSlot = s;
        else break;
      }
      if (heldSlot) return { state: heldSlot.state, startIso: heldSlot.startIso };
      return derivePreSchedule();
    }
    let best: ShiftedSlot | null = null;
    for (const slot of effectiveSlots) {
      if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
      else break;
    }
    if (best) return { state: best.state, startIso: best.startIso };
    return derivePreSchedule();
  }

  let best: ShiftedSlot | null = null;
  for (const slot of effectiveSlots) {
    if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
    else break;
  }
  if (best) return { state: best.state, startIso: best.startIso };
  return derivePreSchedule();
}

function computeReconciledCycleStart(
  growattLastTransitionAt: string | null,
  offsetMs: number,
  heldState: 'ON' | 'OFF',
  masterCurrentState: 'ON' | 'OFF',
  nowMs: number,
): string | null {
  if (heldState === masterCurrentState) return null;
  if (!growattLastTransitionAt) return null;
  const reconciledStartMs = new Date(growattLastTransitionAt).getTime() + offsetMs;
  if (reconciledStartMs >= nowMs) return null;
  return new Date(reconciledStartMs).toISOString();
}

// ── Schedule extension helpers ────────────────────────────────────────────────

function extendScheduleTo48h(masterSlots: ScheduleSlot[], prediction: Prediction, nowMs: number): ScheduleSlot[] {
  if (masterSlots.length === 0) return [];

  let realOnMin: number | null = null;
  let realOffMin: number | null = null;
  for (let i = masterSlots.length - 1; i >= 0; i--) {
    const s = masterSlots[i];
    if (!s.endIso) continue;
    const durMin = (new Date(s.endIso).getTime() - new Date(s.startIso).getTime()) / 60_000;
    if (durMin < 5) continue;
    if (s.state === 'ON' && realOnMin === null) realOnMin = durMin;
    if (s.state === 'OFF' && realOffMin === null) realOffMin = durMin;
    if (realOnMin !== null && realOffMin !== null) break;
  }

  const extOnMin = realOnMin ?? prediction.expectedOnRange?.minMin ?? 120;
  const extOffMin = realOffMin ?? prediction.expectedOffRange?.minMin ?? 360;

  const horizonMs = nowMs + 48 * 60 * 60 * 1000;
  const slots: ScheduleSlot[] = [...masterSlots];

  while (slots.length < 40) {
    const last = slots[slots.length - 1];
    if (!last.endIso) break;
    const lastEndMs = new Date(last.endIso).getTime();
    if (lastEndMs >= horizonMs) break;

    const nextState: 'ON' | 'OFF' = last.state === 'ON' ? 'OFF' : 'ON';
    const durationMin = nextState === 'OFF' ? extOffMin : extOnMin;
    const nextStartIso = last.endIso;
    const nextEndMs = lastEndMs + durationMin * 60_000;
    const nextEndIso = new Date(nextEndMs).toISOString();

    slots.push({
      state: nextState,
      startIso: nextStartIso,
      endIso: nextEndIso,
      startFormatted: fmtYemenTime(nextStartIso),
      endFormatted: fmtYemenTime(nextEndIso),
      durationLabel: durationLabelFromMin(Math.round(durationMin)),
      zone: getZoneFromIso(nextStartIso),
      isEstimated: true,
    });
  }

  return slots;
}

function applyOffsetToSlots(slots: ScheduleSlot[], offsetMs: number): ShiftedSlot[] {
  return slots.map((slot) => {
    const startIso = new Date(new Date(slot.startIso).getTime() + offsetMs).toISOString();
    const endIso = slot.endIso
      ? new Date(new Date(slot.endIso).getTime() + offsetMs).toISOString()
      : null;
    return {
      ...slot,
      startIso,
      endIso,
      startFormatted: fmtYemenTime(startIso),
      endFormatted: endIso ? fmtYemenTime(endIso) : null,
      shiftedStartFormatted: fmtYemenTime(startIso),
      shiftedEndFormatted: endIso ? fmtYemenTime(endIso) : null,
      isResynced: false,
    };
  });
}

// ── Main applyOffsetToPrediction pipeline ────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  communitySyncMeta?: any,
  transitionMode: TransitionMode = 'AUTO',
  heldCycleStartIso?: string | null,
  frozenCommunityOffsetMinutes?: number | null,
  onOffsetCalculated?: (...args: any[]) => void,
  nowMs: number = Date.now(),
  _unused?: any,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;

  const extended = extendScheduleTo48h(prediction.daySchedule ?? [], prediction, nowMs);
  let effectiveSlots = applyOffsetToSlots(extended, offsetMs);

  const hasResync = !!resyncPoint;
  let communityTransition: CommunityTransitionResult | null = null;

  if (resyncPoint) {
    communityTransition = computeCommunityTransition(
      effectiveSlots,
      resyncPoint,
      extended,
      prediction.currentState,
      prediction.lastTransitionAt,
      frozenCommunityOffsetMinutes ?? null,
      nowMs,
    );
    if (communityTransition) {
      effectiveSlots = communityTransition.effectiveSlots;
      if (communityTransition.isFreshOffsetComputation && onOffsetCalculated) {
        onOffsetCalculated(communityTransition.derivedOffsetMinutes, {
          sign: communityTransition.offsetSign,
          referenceIso: communityTransition.offsetReferenceIso,
          referenceKind: communityTransition.offsetReferenceKind,
        });
      }
    }
  }

  const atcState = computeATCState(
    effectiveSlots,
    offsetMinutes,
    resyncPoint ?? null,
    prediction,
    transitionMode,
    communityTransition,
    nowMs,
  );

  let { state: currentState, startIso: currentStateStartIso } = deriveCurrentStateATC(
    effectiveSlots,
    atcState.mode,
    prediction.currentState,
    resyncPoint ?? null,
    communityTransition,
    nowMs,
  );

  let isHolding = atcShouldHold(atcState.mode);
  let finalAtcState = atcState;
  let reconciledCycleStartIso: string | null = null;

  const effectiveOffsetMinutes = communityTransition
    ? communityTransition.derivedOffsetMinutes
    : offsetMinutes;
  const effectiveOffsetMs = effectiveOffsetMinutes * 60_000;

  // User A exit: UNCERTAIN_ZONE
  if (
    atcState.mode === 'UNCERTAIN_ZONE' &&
    transitionMode === 'AUTO' &&
    prediction.currentState !== currentState
  ) {
    const backdatedStart = computeReconciledCycleStart(
      prediction.lastTransitionAt,
      effectiveOffsetMs,
      currentState,
      prediction.currentState,
      nowMs,
    );
    if (backdatedStart) {
      reconciledCycleStartIso = backdatedStart;
      currentState = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso = backdatedStart;
      isHolding = false;
      finalAtcState = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, communityElevated: false };
    } else if (prediction.lastTransitionAt) {
      currentState = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso = prediction.lastTransitionAt;
      isHolding = false;
      finalAtcState = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, communityElevated: false };
    }
  }

  // User B exit: POSITIVE_OFFSET_PENDING
  if (
    atcState.mode === 'POSITIVE_OFFSET_PENDING' &&
    transitionMode === 'AUTO' &&
    atcState.scheduledAutoTransitionIso
  ) {
    const scheduledMs = new Date(atcState.scheduledAutoTransitionIso).getTime();
    if (scheduledMs <= nowMs) {
      const newState = prediction.currentState as 'ON' | 'OFF';
      reconciledCycleStartIso = atcState.scheduledAutoTransitionIso;
      currentState = newState;
      currentStateStartIso = atcState.scheduledAutoTransitionIso;
      isHolding = false;
      finalAtcState = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, scheduledAutoTransitionIso: null };
    }
  }

  // User C exit: WAITING_FOR_GROWATT / GRACE_MODE
  if (
    (atcState.mode === 'WAITING_FOR_GROWATT' || atcState.mode === 'GRACE_MODE') &&
    transitionMode === 'AUTO' &&
    prediction.currentState !== currentState
  ) {
    const backdatedStart = computeReconciledCycleStart(
      prediction.lastTransitionAt,
      effectiveOffsetMs,
      currentState,
      prediction.currentState,
      nowMs,
    );
    if (backdatedStart) {
      reconciledCycleStartIso = backdatedStart;
      currentState = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso = backdatedStart;
      isHolding = false;
      finalAtcState = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, communityElevated: false };
    }
  }

  // Build next transition
  let nextTransition: any = null;
  if (!prediction.isUnstable) {
    const oppositeState: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';
    for (const slot of effectiveSlots) {
      if (slot.state !== oppositeState) continue;
      const slotMs = new Date(slot.startIso).getTime();
      if (slotMs <= nowMs) continue;
      const minFromNow = (slotMs - nowMs) / 60_000;
      const halfSpread = 15;
      const earliestIso = new Date(slotMs - halfSpread * 60_000).toISOString();
      const latestIso = new Date(slotMs + halfSpread * 60_000).toISOString();
      nextTransition = {
        type: oppositeState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
        rangeLabel: `${fmtYemenTime(earliestIso)} → ${fmtYemenTime(latestIso)}`,
        rangeStartIso: earliestIso,
        rangeEndIso: latestIso,
        minFromNowMin: Math.max(0, minFromNow - halfSpread),
        maxFromNowMin: Math.max(0, minFromNow + halfSpread),
        waitLabel: `~${Math.round(minFromNow)}د`,
        inRangeWindow: nowMs >= new Date(earliestIso).getTime() && nowMs <= new Date(latestIso).getTime(),
      };
      break;
    }
  }

  // POSITIVE_OFFSET_PENDING: inject synthetic lingering slot
  let finalDaySchedule: ShiftedSlot[] = [...effectiveSlots];
  if (finalAtcState.mode === 'POSITIVE_OFFSET_PENDING' && finalAtcState.scheduledAutoTransitionIso) {
    const currentStart = reconciledCycleStartIso ?? currentStateStartIso ?? new Date(nowMs).toISOString();
    finalDaySchedule.unshift({
      state: currentState,
      startIso: currentStart,
      endIso: finalAtcState.scheduledAutoTransitionIso,
      startFormatted: fmtYemenTime(currentStart),
      endFormatted: fmtYemenTime(finalAtcState.scheduledAutoTransitionIso),
      shiftedStartFormatted: fmtYemenTime(currentStart),
      shiftedEndFormatted: fmtYemenTime(finalAtcState.scheduledAutoTransitionIso),
      durationLabel: '',
      zone: getZoneFromIso(currentStart),
      isEstimated: true,
      isResynced: false,
    });
  }

  return {
    ...prediction,
    daySchedule: finalDaySchedule as any,
    atc: finalAtcState,
    isHoldingState: isHolding,
    currentState,
    currentStateStartIso,
    currentStateDurationLabel: '',
    reconciledCycleStartIso,
    isResynced: hasResync,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    communitySyncMeta: communitySyncMeta ?? null,
    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    offsetMinutes,
    expectedOnDurationLabel: prediction.expectedOnRange?.label ?? null,
    expectedOffDurationLabel: prediction.expectedOffRange?.label ?? null,
    communityTransitionMeta: communityTransition
      ? {
          progressRatio: communityTransition.progressRatio,
          generatedCycleStartIso: communityTransition.generatedCycleStartIso,
          generatedCycleEndIso: communityTransition.generatedCycleEndIso,
          generatedCycleState: communityTransition.generatedCycleState,
          generatedCycleActive: nowMs < new Date(communityTransition.generatedCycleEndIso).getTime(),
          offsetMinutes: communityTransition.derivedOffsetMinutes,
          offsetSign: communityTransition.offsetSign,
          offsetReferenceIso: communityTransition.offsetReferenceIso,
          offsetReferenceKind: communityTransition.offsetReferenceKind,
          isFreshOffsetComputation: communityTransition.isFreshOffsetComputation,
          durationSelectionRule: communityTransition.durationSelectionRule,
          durationSourceSlot: communityTransition.durationSourceSlot,
          decisionTrace: communityTransition.decisionTrace,
        }
      : null,
  } as UserPrediction;
}
