/**
 * TMMS V2 Engine — Pure TypeScript (zero React dependencies)
 * ════════════════════════════════════════════════════════════════════════════
 * Implements the ATC state machine, offset application, schedule generation,
 * community transition resolution, and the Community Confirmation Timestamp
 * Rule (Group K).
 *
 * All logic here executes identically in production UIs (via useUserPredictions)
 * and in the TMMSDebugSimulator (via tmmsSimulation.ts). Never import React
 * or any React Native primitives here.
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Public types ──────────────────────────────────────────────────────────────

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

export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string | null;
  reporterReliability?: number | null;
}

export interface Prediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string | null;
  inverterOffline: boolean;
  nextTransition: any | null;
  expectedOffRange: { minMin: number; maxMin: number } | null;
  expectedOnRange: { minMin: number; maxMin: number } | null;
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
  computedAt: string | null;
  apppe?: {
    crisisActive?: boolean;
    crisisMode?: boolean;
    crisisReason?: string | null;
    [key: string]: any;
  };
}

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export type TransitionMode = 'AUTO' | 'MANUAL';

export interface ATCState {
  mode: ScheduleStateMode;
  overrunMinutes: number;
  communityElevated: boolean;
  statusLine: string | null;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  transitionMode: TransitionMode;
  scheduledAutoTransitionIso: string | null;
}

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
}

export interface ShiftedTransition {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  rangeLabel: string;
  rangeStartIso: string;
  rangeEndIso: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  waitLabel: string;
  inRangeWindow: boolean;
}

export interface ShiftedScheduleSlot extends ScheduleSlot {
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  isResynced?: boolean;
}

/** Step in the engine decision trace (for the simulator inspector) */
export interface DecisionStep {
  step: number;
  label: string;
  detail: string;
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
  durationSourceSlot: { state: string; durationLabel: string | null } | null;
  decisionTrace: DecisionStep[];
}

export interface UserPrediction {
  atc: ATCState;
  nextTransition: ShiftedTransition | null;
  expectedOffDurationLabel: string | null;
  expectedOnDurationLabel: string | null;
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  currentState: 'ON' | 'OFF';
  currentStateDurationLabel: string;
  currentStateStartIso: string | null;
  daySchedule: ShiftedScheduleSlot[];
  reasoning: string[];
  learningMode: string;
  computedAt: string | null;
  offsetMinutes: number;
  crisisMode: boolean;
  crisisReason: string | null;
  isResynced: boolean;
  resyncedAtIso: string | null;
  isHoldingState: boolean;
  communitySyncMeta: CommunitySyncMeta | null;
  reconciledCycleStartIso: string | null;
  communityTransitionMeta: CommunityTransitionMeta | null;
}

// ── Community Confirmation Ledger types (Group K) ─────────────────────────────

export type TrustLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERIFIED';

export interface Confirmation {
  confirmerName: string | null;
  confirmedAtIso: string;
  hoursAfterReport: number;
  confidenceScoreAfter: number;
}

export interface ReportRecord {
  id: string;
  state: 'ON' | 'OFF';
  originalReportAtIso: string;
  reporterName: string | null;
  processedAtIso: string | null;
  confidenceScore: number;
  trustLevel: TrustLevel;
  confirmations: Confirmation[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fmtYemenTime(iso: string): string {
  const raw = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return raw.replace('AM', 'ص').replace('PM', 'م');
}

export function getZoneFromIso(iso: string): string {
  const h = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).getUTCHours();
  if (h < 6) return 'Night';
  if (h < 10) return 'Morning';
  if (h < 16) return 'Midday';
  if (h < 20) return 'Evening';
  return 'Late Night';
}

export function durationLabelFromMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

function shiftMs(iso: string, deltaMs: number): string {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

function fmtWait(min: number): string {
  if (min <= 0) return 'قريباً';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `~${m}د`;
  if (m === 0) return `~${h}س`;
  return `~${h}س ${m}د`;
}

function arabicDurationRange(minMin: number, maxMin: number): string {
  const fmtSingle = (min: number): string => {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h === 0) return m === 1 ? 'دقيقة' : m === 2 ? 'دقيقتان' : `${m} دقيقة`;
    const hoursAr = h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
    if (m === 0) return hoursAr;
    return `${hoursAr} و ${m} دقيقة`;
  };
  if (Math.round(minMin) === Math.round(maxMin)) return fmtSingle(minMin);
  return `من ${fmtSingle(minMin)} إلى ${fmtSingle(maxMin)}`;
}

function elapsedLabel(startIso: string | null): string {
  if (!startIso) return '';
  const elapsedMin = Math.round((Date.now() - new Date(startIso).getTime()) / 60_000);
  if (elapsedMin < 1) return 'للتو';
  const eH = Math.floor(elapsedMin / 60);
  const eM = elapsedMin % 60;
  if (eH === 0) return `${elapsedMin}د`;
  if (eM === 0) return `${eH}س`;
  return `${eH}س ${eM}د`;
}

// ── Report Ledger helpers (Group K) ───────────────────────────────────────────

const MAX_CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function computeTrustLevel(score: number): TrustLevel {
  if (score >= 90) return 'VERIFIED';
  if (score >= 70) return 'HIGH';
  if (score >= 45) return 'MEDIUM';
  return 'LOW';
}

/**
 * Create a new ReportRecord to add to the persistent ledger.
 */
export function createReportRecord(
  state: 'ON' | 'OFF',
  originalReportAtIso: string,
  reporterName: string | null,
  processImmediately: boolean,
  nowIso: string,
): ReportRecord {
  const initialScore = 55; // base confidence for a single un-confirmed report
  return {
    id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    state,
    originalReportAtIso,
    reporterName,
    processedAtIso: processImmediately ? nowIso : null,
    confidenceScore: initialScore,
    trustLevel: computeTrustLevel(initialScore),
    confirmations: [],
  };
}

/**
 * Find a report in the ledger that a confirmation can be matched to:
 * - same state
 * - within MAX_CONFIRMATION_WINDOW_MS of the confirmation time
 */
export function findConfirmableReport(
  reports: ReportRecord[],
  state: 'ON' | 'OFF',
  confirmAtMs: number,
): ReportRecord | null {
  let best: ReportRecord | null = null;
  let bestDiff = Infinity;
  for (const r of reports) {
    if (r.state !== state) continue;
    const reportMs = new Date(r.originalReportAtIso).getTime();
    const diff = confirmAtMs - reportMs;
    if (diff < 0 || diff > MAX_CONFIRMATION_WINDOW_MS) continue;
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best;
}

/**
 * Apply a confirmation to a report — bumps confidence score only.
 * Per the Confirmation Timestamp Rule, the generated state start (originalReportAtIso)
 * and offset are NEVER touched.
 */
export function applyConfirmationToReport(
  report: ReportRecord,
  confirmedAtIso: string,
  confirmerName: string | null,
): ReportRecord {
  const reportMs = new Date(report.originalReportAtIso).getTime();
  const confirmMs = new Date(confirmedAtIso).getTime();
  const hoursAfterReport = (confirmMs - reportMs) / 3_600_000;

  // Diminishing returns: each confirmation adds less than the previous.
  // First confirm: +15, second: +10, third: +7, fourth+: +4 each (capped at 99).
  const bonuses = [15, 10, 7];
  const idx = report.confirmations.length;
  const bonus = idx < bonuses.length ? bonuses[idx] : 4;
  const newScore = Math.min(99, report.confidenceScore + bonus);

  const newConfirmation: Confirmation = {
    confirmerName,
    confirmedAtIso,
    hoursAfterReport,
    confidenceScoreAfter: newScore,
  };

  return {
    ...report,
    confidenceScore: newScore,
    trustLevel: computeTrustLevel(newScore),
    confirmations: [...report.confirmations, newConfirmation],
  };
}

// ── Core schedule helpers ─────────────────────────────────────────────────────

function extendScheduleTo48h(
  masterSlots: ScheduleSlot[],
  prediction: Prediction,
  nowMs: number = Date.now(),
): ScheduleSlot[] {
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

  const extOnMin  = realOnMin  ?? prediction.expectedOnRange?.minMin  ?? prediction.allPattern?.avgOnMin  ?? 120;
  const extOffMin = realOffMin ?? prediction.expectedOffRange?.minMin ?? prediction.allPattern?.avgOffMin ?? 360;

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

function applyOffsetToSlots(slots: ScheduleSlot[], offsetMs: number): ShiftedScheduleSlot[] {
  return slots.map((slot) => {
    const startIso = shiftMs(slot.startIso, offsetMs);
    const endIso = slot.endIso ? shiftMs(slot.endIso, offsetMs) : null;
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

// ── Rule 5: locate the raw-schedule slot of a given state active at a moment ──
function findActiveSlotInRawSchedule(
  rawSchedule: ScheduleSlot[],
  state: 'ON' | 'OFF',
  atMs: number,
): ScheduleSlot | null {
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs   = new Date(s.endIso).getTime();
    if (atMs >= startMs && atMs <= endMs) return s;
  }
  let bestPast: ScheduleSlot | null = null;
  let bestPastEndMs = -Infinity;
  let bestFuture: ScheduleSlot | null = null;
  let bestFutureStartMs = Infinity;
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs   = new Date(s.endIso).getTime();
    if (endMs <= atMs && endMs > bestPastEndMs) { bestPastEndMs = endMs; bestPast = s; }
    if (startMs > atMs && startMs < bestFutureStartMs) { bestFutureStartMs = startMs; bestFuture = s; }
  }
  return bestPast ?? bestFuture;
}

// ── Rule 4 + Rule 5: compute the offset (sign + magnitude) ───────────────────

interface CommunityOffsetResult {
  offsetMinutes: number;
  sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  referenceIso: string;
  referenceKind:
    | 'GROWATT_ON_START_ACTUAL'
    | 'GROWATT_ON_END_EXPECTED'
    | 'GROWATT_OFF_END_EXPECTED'
    | 'GROWATT_OFF_START_ACTUAL';
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
    referenceIso  = growattLastTransitionAt;
    referenceKind = reportedState === 'ON' ? 'GROWATT_ON_START_ACTUAL' : 'GROWATT_OFF_START_ACTUAL';
  } else {
    const rawActiveSlot = findActiveSlotInRawSchedule(rawSchedule, growattCurrentState, startMs);
    referenceIso  = rawActiveSlot?.endIso ?? null;
    referenceKind = growattCurrentState === 'ON' ? 'GROWATT_ON_END_EXPECTED' : 'GROWATT_OFF_END_EXPECTED';
  }

  if (!referenceIso) return null;

  const referenceMs   = new Date(referenceIso).getTime();
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

// ── Community Transition (Schedule-Based) ─────────────────────────────────────

interface CommunityTransitionResult {
  effectiveSlots: ShiftedScheduleSlot[];
  generatedCycleStartIso: string;
  generatedCycleEndIso: string;
  generatedCycleState: 'ON' | 'OFF';
  progressRatio: number;
  derivedOffsetMinutes: number;
  offsetSign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  offsetReferenceIso: string | null;
  offsetReferenceKind: CommunityOffsetResult['referenceKind'] | null;
  isFreshOffsetComputation: boolean;
  durationSelectionRule: 'OFF_PROGRESS_LT_50_BEFORE' | 'OFF_PROGRESS_GT_50_AFTER' | 'ON_ALWAYS_BEFORE';
  durationSourceSlot: { state: string; durationLabel: string | null } | null;
  decisionTrace: DecisionStep[];
}

function computeCommunityTransition(
  offsetSlots: ShiftedScheduleSlot[],
  resync: ResyncPoint,
  rawSchedule: ScheduleSlot[],
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
  frozenOffsetMinutes: number | null,
  nowMs: number = Date.now(),
): CommunityTransitionResult | null {
  const syncMs = new Date(resync.syncedAtIso).getTime();
  if (syncMs > nowMs + 60_000) return null;

  const trace: DecisionStep[] = [];
  let stepNum = 1;

  const syncState: 'ON' | 'OFF'        = resync.syncedState;
  const interruptedState: 'ON' | 'OFF' = syncState === 'ON' ? 'OFF' : 'ON';

  trace.push({ step: stepNum++, label: `State Confirmed: ${syncState}`, detail: `Interrupted state: ${interruptedState} · Sync at: ${fmtYemenTime(resync.syncedAtIso)}` });

  let interruptedSlotIdx = -1;
  for (let i = 0; i < offsetSlots.length; i++) {
    const s = offsetSlots[i];
    if (s.state !== interruptedState) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs   = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (syncMs >= startMs && syncMs <= endMs) { interruptedSlotIdx = i; break; }
  }
  if (interruptedSlotIdx === -1) {
    for (let i = offsetSlots.length - 1; i >= 0; i--) {
      if (offsetSlots[i].state !== interruptedState) continue;
      if (new Date(offsetSlots[i].startIso).getTime() <= syncMs) { interruptedSlotIdx = i; break; }
    }
  }
  if (interruptedSlotIdx === -1) return null;

  const interruptedSlot = offsetSlots[interruptedSlotIdx];
  if (!interruptedSlot.endIso) return null;

  const cycleStartMs      = new Date(interruptedSlot.startIso).getTime();
  const cyclePlannedEndMs = new Date(interruptedSlot.endIso).getTime();
  const plannedDurationMs = cyclePlannedEndMs - cycleStartMs;
  if (plannedDurationMs <= 0) return null;

  const elapsedMs     = syncMs - cycleStartMs;
  const progressRatio = elapsedMs / plannedDurationMs;

  trace.push({ step: stepNum++, label: `Progress: ${(progressRatio * 100).toFixed(1)}%`, detail: `Elapsed: ${Math.round(elapsedMs / 60000)}m of ${Math.round(plannedDurationMs / 60000)}m planned` });

  const wantsBefore = interruptedState === 'ON' ? true : progressRatio <= 0.5;
  const durationRule: CommunityTransitionResult['durationSelectionRule'] =
    interruptedState === 'ON' ? 'ON_ALWAYS_BEFORE'
    : progressRatio <= 0.5 ? 'OFF_PROGRESS_LT_50_BEFORE' : 'OFF_PROGRESS_GT_50_AFTER';

  trace.push({ step: stepNum++, label: `Duration Rule: ${durationRule}`, detail: wantsBefore ? 'Looking for PREVIOUS same-state slot' : 'Looking for NEXT same-state slot' });

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
  let durationSourceSlot: { state: string; durationLabel: string | null } | null = null;
  if (durationSourceIdx !== -1 && offsetSlots[durationSourceIdx].endIso) {
    const src = offsetSlots[durationSourceIdx];
    selectedDurationMs = new Date(src.endIso!).getTime() - new Date(src.startIso).getTime();
    durationSourceSlot = { state: src.state, durationLabel: src.durationLabel };
  } else {
    selectedDurationMs = plannedDurationMs;
  }

  trace.push({ step: stepNum++, label: `Duration Selected: ${Math.round(selectedDurationMs / 60000)}m`, detail: durationSourceSlot ? `From ${durationSourceSlot.state} slot (${durationSourceSlot.durationLabel})` : 'Fallback: used interrupted slot duration' });

  const generatedCycleStartIso = resync.syncedAtIso;
  const generatedCycleEndMs    = syncMs + selectedDurationMs;
  const generatedCycleEndIso   = new Date(generatedCycleEndMs).toISOString();

  const generatedSlot: ShiftedScheduleSlot = {
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

  let fallbackOnMs  = 120 * 60_000;
  let fallbackOffMs = 360 * 60_000;
  for (const s of offsetSlots) {
    if (!s.endIso) continue;
    const d = new Date(s.endIso).getTime() - new Date(s.startIso).getTime();
    if (d < 5 * 60_000) continue;
    if (s.state === 'ON')  fallbackOnMs  = d;
    else                   fallbackOffMs = d;
  }

  const continuationStartIdx = durationSourceIdx !== -1 ? durationSourceIdx + 1 : interruptedSlotIdx + 1;
  const horizonMs = nowMs + 48 * 60 * 60 * 1000;
  const continuationSlots: ShiftedScheduleSlot[] = [];
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
      slotState      = lastState === 'ON' ? 'OFF' : 'ON';
      slotDurationMs = slotState === 'ON' ? fallbackOnMs : fallbackOffMs;
    }

    const slotStartIso = new Date(currentStartMs).toISOString();
    const slotEndMs    = currentStartMs + slotDurationMs;
    const slotEndIso   = new Date(slotEndMs).toISOString();

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

  let offsetMinutesFinal: number;
  let offsetSignFinal: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  let offsetReferenceIsoFinal: string | null;
  let offsetReferenceKindFinal: CommunityOffsetResult['referenceKind'] | null;
  let isFreshOffsetComputation: boolean;

  if (frozenOffsetMinutes !== null && frozenOffsetMinutes !== undefined) {
    offsetMinutesFinal       = frozenOffsetMinutes;
    offsetSignFinal          = offsetMinutesFinal === 0 ? 'NEUTRAL' : offsetMinutesFinal > 0 ? 'POSITIVE' : 'NEGATIVE';
    offsetReferenceIsoFinal  = null;
    offsetReferenceKindFinal = null;
    isFreshOffsetComputation = false;
  } else {
    const computed = computeCommunityOffset(rawSchedule, resync, growattCurrentState, growattLastTransitionAt);
    if (computed) {
      offsetMinutesFinal       = computed.offsetMinutes;
      offsetSignFinal          = computed.sign;
      offsetReferenceIsoFinal  = computed.referenceIso;
      offsetReferenceKindFinal = computed.referenceKind;
    } else {
      offsetMinutesFinal       = 0;
      offsetSignFinal          = 'NEUTRAL';
      offsetReferenceIsoFinal  = null;
      offsetReferenceKindFinal = null;
    }
    isFreshOffsetComputation = true;
  }

  trace.push({
    step: stepNum++,
    label: `Offset: ${offsetMinutesFinal > 0 ? '+' : ''}${offsetMinutesFinal}m (${offsetSignFinal})`,
    detail: isFreshOffsetComputation
      ? `Reference: ${offsetReferenceKindFinal ?? 'N/A'} · ${offsetReferenceIsoFinal ? fmtYemenTime(offsetReferenceIsoFinal) : '—'}`
      : 'Frozen value reused (Q2-A) — not recomputed',
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
    durationSelectionRule: durationRule,
    durationSourceSlot,
    decisionTrace: trace,
  };
}

// ── ATC State Machine ─────────────────────────────────────────────────────────

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

function computeATCState(
  effectiveSlots: ShiftedScheduleSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
  transitionMode: TransitionMode = 'AUTO',
  communityTransition?: CommunityTransitionResult | null,
  nowMs: number = Date.now(),
): ATCState {
  if (resyncPoint && communityTransition) {
    const generatedCycleEndMs = new Date(communityTransition.generatedCycleEndIso).getTime();

    if (nowMs < generatedCycleEndMs) {
      const syncedState    = resyncPoint.syncedState;
      const growattDiffers = (syncedState === 'ON') !== (prediction.currentState === 'ON');
      const syncAgeMs      = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
      const inValidationWindow     = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
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

    return computeATCState(effectiveSlots, communityTransition.derivedOffsetMinutes, null, prediction, transitionMode, null, nowMs);
  }

  if (resyncPoint) {
    const syncedState    = resyncPoint.syncedState;
    const growattDiffers = (syncedState === 'ON') !== (prediction.currentState === 'ON');
    const syncAgeMs      = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
    const inValidationWindow     = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
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

  const halfSpreadMs = 15 * 60_000;
  const GRACE_PERIOD_MS = 15 * 60_000;

  if (offsetMinutes < 0) {
    let justEndedSlot: ShiftedScheduleSlot | null = null;
    for (let i = 0; i < effectiveSlots.length; i++) {
      const s = effectiveSlots[i];
      if (!s.endIso) continue;
      const endMs = new Date(s.endIso).getTime();
      if (endMs <= nowMs) { justEndedSlot = s; }
      else { break; }
    }

    if (justEndedSlot && justEndedSlot.endIso) {
      const slotEndMs    = new Date(justEndedSlot.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs   = slotEndMs + halfSpreadMs;
      const overrunMs    = Math.max(0, nowMs - rangeEndMs);
      const overrunMin   = overrunMs / 60_000;

      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };
      }

      const expectedNewState: 'ON' | 'OFF' = justEndedSlot.state === 'ON' ? 'OFF' : 'ON';
      const growattAlreadyConfirmed =
        prediction.currentState === expectedNewState &&
        !!prediction.lastTransitionAt &&
        new Date(prediction.lastTransitionAt).getTime() >= rangeStartMs;

      if (nowMs > rangeStartMs) {
        return {
          ...EMPTY_ATC,
          mode: 'UNCERTAIN_ZONE',
          overrunMinutes: overrunMin,
          communityElevated: !growattAlreadyConfirmed,
          statusLine: growattAlreadyConfirmed
            ? null
            : overrunMin < 1
              ? 'نطاق التوقع انتهى — بانتظار تأكيد تغير الحالة'
              : `تجاوزت المدة المتوقعة بـ ${Math.ceil(overrunMin)} دقيقة — بانتظار تأكيد`,
          transitionMode,
        };
      }
    }

    let activeSlotNeg: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const start = new Date(slot.startIso).getTime();
      const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      if (nowMs >= start && nowMs < end) { activeSlotNeg = slot; break; }
    }
    if (activeSlotNeg?.endIso) {
      const slotEndMs    = new Date(activeSlotNeg.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs   = slotEndMs + halfSpreadMs;
      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };
      }
    }

    return { ...EMPTY_ATC, transitionMode };
  }

  if (offsetMinutes > 0) {
    let activeSlotPos: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const start = new Date(slot.startIso).getTime();
      const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      if (nowMs >= start && nowMs < end) { activeSlotPos = slot; break; }
    }

    let nextSlotPos: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      if (new Date(slot.startIso).getTime() > nowMs) { nextSlotPos = slot; break; }
    }

    const scheduleCurrentState = activeSlotPos?.state ?? (nextSlotPos ? (nextSlotPos.state === 'ON' ? 'OFF' : 'ON') : null);
    const growattFlippedAhead =
      scheduleCurrentState !== null &&
      prediction.currentState !== scheduleCurrentState &&
      !!prediction.lastTransitionAt;

    if (growattFlippedAhead && transitionMode === 'AUTO') {
      const offsetMs = offsetMinutes * 60_000;
      const scheduledMs = new Date(prediction.lastTransitionAt!).getTime() + offsetMs;
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

    if (!activeSlotPos || !activeSlotPos.endIso) return { ...EMPTY_ATC, transitionMode };

    const slotEndMs    = new Date(activeSlotPos.endIso).getTime();
    const rangeStartMs = slotEndMs - halfSpreadMs;
    const rangeEndMs   = slotEndMs + halfSpreadMs;
    const overrunMs    = Math.max(0, nowMs - rangeEndMs);
    const overrunMin   = overrunMs / 60_000;

    if (nowMs < rangeStartMs)                         return { ...EMPTY_ATC, transitionMode };
    if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };

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

  let activeSlot: ShiftedScheduleSlot | null = null;
  for (const slot of effectiveSlots) {
    const start = new Date(slot.startIso).getTime();
    const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= start && nowMs < end) { activeSlot = slot; break; }
  }

  if (!activeSlot?.endIso) return { ...EMPTY_ATC, transitionMode };

  const slotEndMs    = new Date(activeSlot.endIso).getTime();
  const rangeStartMs = slotEndMs - halfSpreadMs;
  const rangeEndMs   = slotEndMs + halfSpreadMs;
  const overrunMs    = Math.max(0, nowMs - rangeEndMs);
  const overrunMin   = overrunMs / 60_000;

  if (nowMs < rangeStartMs)                         return { ...EMPTY_ATC, transitionMode };
  if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };

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

function atcShouldHold(mode: ScheduleStateMode): boolean {
  return (
    mode === 'UNCERTAIN_ZONE' ||
    mode === 'WAITING_FOR_GROWATT' ||
    mode === 'PREDICTION_RANGE' ||
    mode === 'GRACE_MODE' ||
    mode === 'POSITIVE_OFFSET_PENDING'
  );
}

function deriveCurrentStateATC(
  effectiveSlots: ShiftedScheduleSlot[],
  atcMode: ScheduleStateMode,
  masterCurrentState: 'ON' | 'OFF',
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  communityTransition?: CommunityTransitionResult | null,
  nowMs: number = Date.now(),
): { state: 'ON' | 'OFF'; startIso: string | null } {
  if (resyncPoint && communityTransition) {
    const generatedCycleEndMs = new Date(communityTransition.generatedCycleEndIso).getTime();
    if (nowMs < generatedCycleEndMs) {
      return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
    }
  } else if (resyncPoint) {
    return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
  }

  const derivePreScheduleState = (): { state: 'ON' | 'OFF'; startIso: string | null } => {
    if (effectiveSlots.length > 0) {
      const preState: 'ON' | 'OFF' = effectiveSlots[0].state === 'ON' ? 'OFF' : 'ON';
      return { state: preState, startIso: null };
    }
    return { state: masterCurrentState, startIso: null };
  };

  if (atcShouldHold(atcMode)) {
    if (atcMode === 'UNCERTAIN_ZONE') {
      let heldSlot: ShiftedScheduleSlot | null = null;
      for (let i = 0; i < effectiveSlots.length; i++) {
        const s = effectiveSlots[i];
        if (!s.endIso) continue;
        const endMs = new Date(s.endIso).getTime();
        if (endMs <= nowMs) { heldSlot = s; }
        else { break; }
      }
      if (heldSlot) return { state: heldSlot.state, startIso: heldSlot.startIso };
      return derivePreScheduleState();
    }

    if (atcMode === 'POSITIVE_OFFSET_PENDING') {
      let best: ShiftedScheduleSlot | null = null;
      for (const slot of effectiveSlots) {
        if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
        else break;
      }
      if (best) return { state: best.state, startIso: best.startIso };
      return derivePreScheduleState();
    }

    let best: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
      else break;
    }
    if (best) return { state: best.state, startIso: best.startIso };
    return derivePreScheduleState();
  }

  let best: ShiftedScheduleSlot | null = null;
  for (const slot of effectiveSlots) {
    if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
    else break;
  }
  if (best) return { state: best.state, startIso: best.startIso };
  return derivePreScheduleState();
}

function deriveNextTransition(
  effectiveSlots: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  prediction: Prediction,
  nowMs: number = Date.now(),
): ShiftedTransition | null {
  const oppositeState: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';

  for (const slot of effectiveSlots) {
    if (slot.state !== oppositeState) continue;
    const slotMs = new Date(slot.startIso).getTime();
    if (slotMs <= nowMs) continue;

    const minFromNow = (slotMs - nowMs) / 60_000;
    let halfSpread = 15;
    if (prediction.nextTransition) {
      halfSpread = Math.max(10, (prediction.nextTransition.maxFromNowMin - prediction.nextTransition.minFromNowMin) / 2);
    }

    const minMin      = Math.max(0, minFromNow - halfSpread);
    const maxMin      = Math.max(0, minFromNow + halfSpread);
    const earliestIso = shiftMs(slot.startIso, -halfSpread * 60_000);
    const latestIso   = shiftMs(slot.startIso, halfSpread * 60_000);

    const rangeStartMs  = new Date(earliestIso).getTime();
    const rangeEndMs    = new Date(latestIso).getTime();
    const inRangeWindow = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

    return {
      type: oppositeState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      rangeLabel: `${fmtYemenTime(earliestIso)} → ${fmtYemenTime(latestIso)}`,
      rangeStartIso: earliestIso,
      rangeEndIso: latestIso,
      minFromNowMin: minMin,
      maxFromNowMin: maxMin,
      waitLabel: `${fmtWait(minMin)} → ${fmtWait(maxMin)}`,
      inRangeWindow,
    };
  }

  return null;
}

function computeReconciledCycleStart(
  growattLastTransitionAt: string | null,
  offsetMs: number,
  heldState: 'ON' | 'OFF',
  masterCurrentState: 'ON' | 'OFF',
  nowMs: number = Date.now(),
): string | null {
  if (heldState === masterCurrentState) return null;
  if (!growattLastTransitionAt) return null;

  const reconciledStartMs = new Date(growattLastTransitionAt).getTime() + offsetMs;
  if (reconciledStartMs >= nowMs) return null;

  return new Date(reconciledStartMs).toISOString();
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  communitySyncMeta?: CommunitySyncMeta | null,
  transitionMode: TransitionMode = 'AUTO',
  heldCycleStartIso?: string | null,
  frozenCommunityOffsetMinutes?: number | null,
  onOffsetCalculated?: (
    offsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
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

      if (communityTransition.isFreshOffsetComputation) {
        onOffsetCalculated?.(communityTransition.derivedOffsetMinutes, {
          sign:          communityTransition.offsetSign,
          referenceIso:  communityTransition.offsetReferenceIso,
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

  let { state: currentState, startIso: currentStateStartIso } =
    deriveCurrentStateATC(
      effectiveSlots,
      atcState.mode,
      prediction.currentState,
      resyncPoint ?? null,
      transitionMode,
      communityTransition,
      nowMs,
    );

  let isHolding = atcShouldHold(atcState.mode);
  let finalAtcState = atcState;
  let reconciledCycleStartIso: string | null = null;

  const effectiveOffsetMinutes = communityTransition ? communityTransition.derivedOffsetMinutes : offsetMinutes;
  const effectiveOffsetMs      = effectiveOffsetMinutes * 60_000;

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
      currentState            = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso    = backdatedStart;
      isHolding               = false;
      finalAtcState           = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, communityElevated: false };
    } else if (prediction.lastTransitionAt) {
      currentState         = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso = prediction.lastTransitionAt;
      isHolding            = false;
      finalAtcState        = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, communityElevated: false };
    }
  }

  if (
    atcState.mode === 'POSITIVE_OFFSET_PENDING' &&
    transitionMode === 'AUTO' &&
    atcState.scheduledAutoTransitionIso
  ) {
    const scheduledMs = new Date(atcState.scheduledAutoTransitionIso).getTime();
    if (scheduledMs <= nowMs) {
      const newState = prediction.currentState as 'ON' | 'OFF';
      reconciledCycleStartIso = atcState.scheduledAutoTransitionIso;
      currentState            = newState;
      currentStateStartIso    = atcState.scheduledAutoTransitionIso;
      isHolding               = false;
      finalAtcState           = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, scheduledAutoTransitionIso: null };
    }
  }

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
      currentState            = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso    = backdatedStart;
      isHolding               = false;
      finalAtcState           = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, communityElevated: false };
    }
  }

  const nextTransition = prediction.isUnstable
    ? null
    : deriveNextTransition(effectiveSlots, currentState, prediction, nowMs);

  const durLabel = elapsedLabel(reconciledCycleStartIso ?? currentStateStartIso);

  let finalDaySchedule = [...effectiveSlots];
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
    });
  }

  return {
    nextTransition,
    expectedOffDurationLabel: prediction.expectedOffRange
      ? arabicDurationRange(prediction.expectedOffRange.minMin, prediction.expectedOffRange.maxMin)
      : null,
    expectedOnDurationLabel: prediction.expectedOnRange
      ? arabicDurationRange(prediction.expectedOnRange.minMin, prediction.expectedOnRange.maxMin)
      : null,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    currentState,
    currentStateDurationLabel: durLabel,
    currentStateStartIso,
    daySchedule: finalDaySchedule,
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode ?? 'prior_only',
    computedAt: prediction.computedAt ?? null,
    offsetMinutes,
    crisisMode: prediction.apppe?.crisisActive ?? prediction.apppe?.crisisMode ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    isResynced: hasResync,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    atc: finalAtcState,
    isHoldingState: isHolding,
    reconciledCycleStartIso,
    communitySyncMeta: communitySyncMeta
      ?? (resyncPoint ? {
          reporterName: resyncPoint.reporterName ?? null,
          reporterReliability: resyncPoint.reporterReliability ?? null,
          syncedAtIso: resyncPoint.syncedAtIso,
          syncedState: resyncPoint.syncedState,
        } : null),
    communityTransitionMeta: communityTransition
      ? {
          progressRatio:            communityTransition.progressRatio,
          generatedCycleStartIso:   communityTransition.generatedCycleStartIso,
          generatedCycleEndIso:     communityTransition.generatedCycleEndIso,
          generatedCycleState:      communityTransition.generatedCycleState,
          generatedCycleActive:     nowMs < new Date(communityTransition.generatedCycleEndIso).getTime(),
          offsetMinutes:            communityTransition.derivedOffsetMinutes,
          offsetSign:               communityTransition.offsetSign,
          offsetReferenceIso:       communityTransition.offsetReferenceIso,
          offsetReferenceKind:      communityTransition.offsetReferenceKind,
          isFreshOffsetComputation: communityTransition.isFreshOffsetComputation,
          durationSelectionRule:    communityTransition.durationSelectionRule,
          durationSourceSlot:       communityTransition.durationSourceSlot,
          decisionTrace:            communityTransition.decisionTrace,
        }
      : null,
  };
}
