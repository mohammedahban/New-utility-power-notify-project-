/**
 * tmmsEngine.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Pure TypeScript simulation engine — zero React dependencies.
 * Mirrors the production logic of hooks/useUserPredictions.ts but accepts
 * an optional `simulatedNowMs` parameter for deterministic time-travel
 * testing in the admin TMMS Debug Simulator.
 *
 * Consumers:
 *   tmmsSimulation.ts  →  TMMSDebugSimulator  (UI)
 *   tmmsSimulation.ts  →  runEngine()         (scenario test runner)
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

export interface ShiftedScheduleSlot extends ScheduleSlot {
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  isResynced?: boolean;
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

export interface DecisionStep {
  step: number;
  label: string;
  detail: string;
}

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

export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName: string | null;
  reporterReliability: number | null;
}

export interface ReportRecord {
  id: string;
  reportedState: 'ON' | 'OFF';
  reportedAtIso: string;
  reporterName: string;
  isFirstHand: boolean;
  appliedAtIso: string;
  confidenceScore: number;
  confirmations: Array<{ confirmerName: string; confirmedAtIso: string }>;
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
  durationSelectionRule: string;
  durationSourceSlot: ShiftedScheduleSlot | null;
  decisionTrace: DecisionStep[];
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

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
}

export interface PatternStats {
  avgOnMin: number | null;
  avgOffMin: number;
  stdDevOnMin: number | null;
  stdDevOffMin: number;
  cycles: number;
}

export interface Prediction {
  currentState: 'ON' | 'OFF';
  currentStateDurationMin: number;
  currentStateDurationLabel: string;
  lastTransitionAt: string | null;
  inverterOffline: boolean;
  nextTransition: ShiftedTransition | null;
  expectedOffRange: { minMin: number; maxMin: number; label: string } | null;
  expectedOnRange: { minMin: number; maxMin: number; label: string } | null;
  daySchedule: ScheduleSlot[];
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  dayPattern: PatternStats | null;
  nightPattern: PatternStats | null;
  allPattern: PatternStats | null;
  cyclesAnalyzed: number;
  dayCyclesAnalyzed: number;
  nightCyclesAnalyzed: number;
  currentPeriod: 'day' | 'night';
  reasoning: string[];
  learningMode: string;
  dataWindowHours: number;
  computedAt: string | null;
  apppe?: {
    version: string;
    crisisActive: boolean;
    crisisReason: string | null;
    crisisShift?: { on: number; off: number };
    driftOffset: number;
    driftSampleCount: number;
    biasRatio: number;
    biasSampleCount: number;
    volatilityLabel: string;
    volatilityEMA: number;
    madOn: number | null;
    madOff: number | null;
    learningStrength: number;
    effectiveWeightedSamples: number;
    predictionQuality?: Record<string, number>;
  };
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

// ── Report helpers ────────────────────────────────────────────────────────────

let _reportIdCounter = 0;

export function createReportRecord(
  state: 'ON' | 'OFF',
  reportedAtIso: string,
  reporterName: string,
  isFirstHand: boolean,
  appliedAtIso: string,
): ReportRecord {
  return {
    id: `rpt_${++_reportIdCounter}_${Date.now()}`,
    reportedState: state,
    reportedAtIso,
    reporterName,
    isFirstHand,
    appliedAtIso,
    confidenceScore: isFirstHand ? 60 : 40,
    confirmations: [],
  };
}

export function findConfirmableReport(
  log: ReportRecord[],
  state: 'ON' | 'OFF',
  nowMs: number,
  windowMs = 2 * 60 * 60_000,
): ReportRecord | null {
  const cutoff = nowMs - windowMs;
  for (let i = log.length - 1; i >= 0; i--) {
    const r = log[i];
    if (r.reportedState !== state) continue;
    if (new Date(r.reportedAtIso).getTime() < cutoff) continue;
    return r;
  }
  return null;
}

export function applyConfirmationToReport(
  record: ReportRecord,
  confirmedAtIso: string,
  confirmerName: string,
): ReportRecord {
  const confirmations = [...record.confirmations, { confirmerName, confirmedAtIso }];
  const baseScore = record.isFirstHand ? 60 : 40;
  const boost = Math.min(35, confirmations.length * 10);
  return { ...record, confirmations, confidenceScore: Math.min(95, baseScore + boost) };
}

// ── Utility helpers ───────────────────────────────────────────────────────────

export function fmtYemenTime(iso: string): string {
  const raw = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return raw.replace('AM', 'ص').replace('PM', 'م');
}

export function durationLabelFromMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

export function getZoneFromIso(iso: string): string {
  const h = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).getUTCHours();
  if (h < 6) return 'Night';
  if (h < 10) return 'Morning';
  if (h < 16) return 'Midday';
  if (h < 20) return 'Evening';
  return 'Late Night';
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

function elapsedLabel(startIso: string | null, nowMs: number): string {
  if (!startIso) return '';
  const elapsedMin = Math.round((nowMs - new Date(startIso).getTime()) / 60_000);
  if (elapsedMin < 1) return 'للتو';
  const eH = Math.floor(elapsedMin / 60);
  const eM = elapsedMin % 60;
  if (eH === 0) return `${elapsedMin}د`;
  if (eM === 0) return `${eH}س`;
  return `${eH}س ${eM}د`;
}

// ── Step 1: Extend master schedule to 48h ────────────────────────────────────

function extendScheduleTo48h(
  masterSlots: ScheduleSlot[],
  prediction: Prediction,
  nowMs: number,
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

  const extOnMin  = realOnMin  ?? prediction.expectedOnRange?.minMin  ?? prediction.allPattern?.avgOnMin  ?? prediction.dayPattern?.avgOnMin  ?? 120;
  const extOffMin = realOffMin ?? prediction.expectedOffRange?.minMin ?? prediction.allPattern?.avgOffMin ?? prediction.dayPattern?.avgOffMin ?? 360;

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

// ── Step 2: Apply offset ──────────────────────────────────────────────────────

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

// ── Community offset computation ──────────────────────────────────────────────

interface CommunityOffsetResult {
  offsetMinutes: number;
  sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  referenceIso: string;
  referenceKind: string;
}

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

function computeCommunityOffset(
  rawSchedule: ScheduleSlot[],
  resync: ResyncPoint,
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
): CommunityOffsetResult | null {
  const startMs = new Date(resync.syncedAtIso).getTime();
  const reportedState = resync.syncedState;

  let referenceIso: string | null;
  let referenceKind: string;

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

interface CommunityTransitionResult {
  effectiveSlots: ShiftedScheduleSlot[];
  generatedCycleStartIso: string;
  generatedCycleEndIso: string;
  generatedCycleState: 'ON' | 'OFF';
  progressRatio: number;
  derivedOffsetMinutes: number;
  offsetSign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  offsetReferenceIso: string | null;
  offsetReferenceKind: string | null;
  isFreshOffsetComputation: boolean;
  durationSelectionRule: string;
  durationSourceSlot: ShiftedScheduleSlot | null;
  decisionTrace: DecisionStep[];
}

function computeCommunityTransition(
  offsetSlots: ShiftedScheduleSlot[],
  resync: ResyncPoint,
  rawSchedule: ScheduleSlot[],
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
  frozenOffsetMinutes: number | null,
  nowMs: number,
): CommunityTransitionResult | null {
  const syncMs = new Date(resync.syncedAtIso).getTime();
  if (syncMs > nowMs + 60_000) return null;

  const syncState: 'ON' | 'OFF'        = resync.syncedState;
  const interruptedState: 'ON' | 'OFF' = syncState === 'ON' ? 'OFF' : 'ON';

  let interruptedSlotIdx = -1;
  for (let i = 0; i < offsetSlots.length; i++) {
    const s = offsetSlots[i];
    if (s.state !== interruptedState) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs   = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (syncMs >= startMs && syncMs <= endMs) {
      interruptedSlotIdx = i;
      break;
    }
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

  const cycleStartMs      = new Date(interruptedSlot.startIso).getTime();
  const cyclePlannedEndMs = new Date(interruptedSlot.endIso).getTime();
  const plannedDurationMs = cyclePlannedEndMs - cycleStartMs;
  if (plannedDurationMs <= 0) return null;

  const elapsedMs     = syncMs - cycleStartMs;
  const progressRatio = elapsedMs / plannedDurationMs;

  const wantsBefore = interruptedState === 'ON' ? true : progressRatio <= 0.5;
  let durationSourceIdx = -1;
  let durationSelectionRule = '';

  if (wantsBefore) {
    for (let i = interruptedSlotIdx - 1; i >= 0; i--) {
      if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) {
        durationSourceIdx = i; break;
      }
    }
    if (durationSourceIdx === -1) {
      for (let i = interruptedSlotIdx + 1; i < offsetSlots.length; i++) {
        if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) {
          durationSourceIdx = i; break;
        }
      }
      durationSelectionRule = durationSourceIdx !== -1 ? 'NEXT_SAME_STATE_FALLBACK' : 'PLANNED_DURATION_FALLBACK';
    } else {
      durationSelectionRule = 'PREV_SAME_STATE';
    }
  } else {
    for (let i = interruptedSlotIdx + 1; i < offsetSlots.length; i++) {
      if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) {
        durationSourceIdx = i; break;
      }
    }
    if (durationSourceIdx === -1) {
      for (let i = interruptedSlotIdx - 1; i >= 0; i--) {
        if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) {
          durationSourceIdx = i; break;
        }
      }
      durationSelectionRule = durationSourceIdx !== -1 ? 'PREV_SAME_STATE_FALLBACK' : 'PLANNED_DURATION_FALLBACK';
    } else {
      durationSelectionRule = 'NEXT_SAME_STATE';
    }
  }

  let selectedDurationMs: number;
  const durationSourceSlot = durationSourceIdx !== -1 ? offsetSlots[durationSourceIdx] : null;
  if (durationSourceSlot?.endIso) {
    selectedDurationMs = new Date(durationSourceSlot.endIso).getTime() - new Date(durationSourceSlot.startIso).getTime();
  } else {
    selectedDurationMs = plannedDurationMs;
    durationSelectionRule = 'PLANNED_DURATION_FALLBACK';
  }

  const generatedCycleStartIso = resync.syncedAtIso;
  const generatedCycleEndMs    = syncMs + selectedDurationMs;
  const generatedCycleEndIso   = new Date(generatedCycleEndMs).toISOString();

  const generatedSlot: ShiftedScheduleSlot = {
    state:                 syncState,
    startIso:              generatedCycleStartIso,
    endIso:                generatedCycleEndIso,
    startFormatted:        fmtYemenTime(generatedCycleStartIso),
    endFormatted:          fmtYemenTime(generatedCycleEndIso),
    shiftedStartFormatted: fmtYemenTime(generatedCycleStartIso),
    shiftedEndFormatted:   fmtYemenTime(generatedCycleEndIso),
    durationLabel:         durationLabelFromMin(Math.round(selectedDurationMs / 60_000)),
    zone:                  getZoneFromIso(generatedCycleStartIso),
    isEstimated:           false,
    isResynced:            true,
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
  let srcIdx         = continuationStartIdx;

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
      state:                 slotState,
      startIso:              slotStartIso,
      endIso:                slotEndIso,
      startFormatted:        fmtYemenTime(slotStartIso),
      endFormatted:          fmtYemenTime(slotEndIso),
      shiftedStartFormatted: fmtYemenTime(slotStartIso),
      shiftedEndFormatted:   fmtYemenTime(slotEndIso),
      durationLabel:         durationLabelFromMin(Math.round(slotDurationMs / 60_000)),
      zone:                  getZoneFromIso(slotStartIso),
      isEstimated:           srcIdx >= offsetSlots.length,
      isResynced:            false,
    });

    currentStartMs = slotEndMs;
    srcIdx++;
  }

  const preCycleSlots = offsetSlots.slice(0, interruptedSlotIdx);

  let offsetMinutesFinal: number;
  let offsetSignFinal: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  let offsetReferenceIsoFinal: string | null;
  let offsetReferenceKindFinal: string | null;
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

  const decisionTrace: DecisionStep[] = [
    { step: 1, label: 'Interrupted slot', detail: `${interruptedState} @ idx ${interruptedSlotIdx}` },
    { step: 2, label: 'Progress ratio', detail: `${(progressRatio * 100).toFixed(1)}%` },
    { step: 3, label: 'Duration rule', detail: durationSelectionRule },
    { step: 4, label: 'Selected duration', detail: durationLabelFromMin(Math.round(selectedDurationMs / 60_000)) },
    { step: 5, label: 'Derived offset', detail: `${offsetMinutesFinal >= 0 ? '+' : ''}${offsetMinutesFinal}م` },
  ];

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
    decisionTrace,
  };
}

// ── ATC state ─────────────────────────────────────────────────────────────────

const VALIDATION_WINDOW_MS = 20 * 60_000;

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

function computeATCState(
  effectiveSlots: ShiftedScheduleSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
  transitionMode: TransitionMode = 'AUTO',
  communityTransition: CommunityTransitionResult | null,
  nowMs: number,
): ATCState {
  if (resyncPoint && communityTransition) {
    const generatedCycleEndMs = new Date(communityTransition.generatedCycleEndIso).getTime();

    if (nowMs < generatedCycleEndMs) {
      const syncedState    = resyncPoint.syncedState;
      const growattDiffers = (syncedState === 'ON') !== (prediction.currentState === 'ON');
      const syncAgeMs      = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
      const inValidationWindow      = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
      const validationRemainingMin  = inValidationWindow ? (VALIDATION_WINDOW_MS - syncAgeMs) / 60_000 : 0;

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

  const halfSpreadMs   = 15 * 60_000;
  const GRACE_PERIOD_MS = 15 * 60_000;

  if (offsetMinutes < 0) {
    let justEndedSlot: ShiftedScheduleSlot | null = null;
    for (let i = 0; i < effectiveSlots.length; i++) {
      const s = effectiveSlots[i];
      if (!s.endIso) continue;
      const endMs = new Date(s.endIso).getTime();
      if (endMs <= nowMs) { justEndedSlot = s; } else { break; }
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

    if (!activeSlotPos?.endIso) return { ...EMPTY_ATC, transitionMode };

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

  // offsetMinutes === 0
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
  transitionMode: TransitionMode,
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
        if (endMs <= nowMs) { heldSlot = s; } else { break; }
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
  nowMs: number,
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

    const rangeStartMs = new Date(earliestIso).getTime();
    const rangeEndMs   = new Date(latestIso).getTime();
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
  nowMs: number,
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
  simulatedNowMs?: number,
): UserPrediction {
  const nowMs    = simulatedNowMs ?? Date.now();
  const offsetMs = offsetMinutes * 60_000;

  const extended     = extendScheduleTo48h(prediction.daySchedule ?? [], prediction, nowMs);
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

  let { state: currentState, startIso: currentStateStartIso } = deriveCurrentStateATC(
    effectiveSlots,
    atcState.mode,
    prediction.currentState,
    resyncPoint ?? null,
    transitionMode,
    communityTransition,
    nowMs,
  );

  let isHolding    = atcShouldHold(atcState.mode);
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

  const durLabel = elapsedLabel(reconciledCycleStartIso ?? currentStateStartIso, nowMs);

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
    crisisMode: (prediction as any).apppe?.crisisActive ?? false,
    crisisReason: (prediction as any).apppe?.crisisReason ?? null,
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
