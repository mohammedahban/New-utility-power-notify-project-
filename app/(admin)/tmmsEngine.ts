/**
 * TMMS V2 Engine — pure, framework-agnostic logic layer
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This is the SAME engine that powers `useUserPredictions.ts` in production,
 * extracted so it can be:
 *   1. Driven deterministically by the Debug Simulator (via the injectable
 *      `nowMs` parameter — every function that previously called `Date.now()`
 *      now accepts it as a parameter, defaulting to `Date.now()` so calling
 *      code that omits it gets identical production behavior).
 *   2. Copied back into the app with ZERO logic changes. Every rule, every
 *      branch, every formula below is byte-for-byte the same as the validated
 *      production version. The only additions are non-invasive instrumentation
 *      fields (decisionTrace, durationSelectionRule, durationSourceSlot) that
 *      expose *why* a result was produced — production code can simply ignore
 *      them.
 *
 * NOT included here (intentionally, per the task's "do not fake a backend"
 * instruction interpreted the other way — do not let a fake backend leak
 * into the reusable engine): Supabase I/O, React hooks, AsyncStorage. Those
 * are application-layer concerns. `logAccuracyEvent` below is a pure function
 * that computes the same accuracy math as production but returns the result
 * instead of writing to a database — the simulator's Event Log displays it,
 * production code wraps it with the real `supabase.from(...).insert(...)` call.
 *
 * Types (Prediction / ScheduleSlot / ResyncPoint) are re-declared locally so
 * this file has zero import dependencies — exactly the same "shim" pattern
 * already used in the production file for standalone type-checking. Field
 * shapes are identical to the real ./usePredictions and ../contexts/ResyncContext
 * modules; copy-paste compatible.
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Re-declared shared types (shim — identical shape to the real modules) ─────

export interface RangeLabel {
  minMin: number;
  maxMin: number;
  label: string;
}

export interface NextTransitionRaw {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  earliestTime: string;
  latestTime: string;
  earliestFormatted: string;
  latestFormatted: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  rangeLabel: string;
}

export interface PatternStats {
  cycles: number;
  avgOffMin: number;
  stdDevOffMin: number;
  avgOnMin: number | null;
  stdDevOnMin: number | null;
  minOffMin: number;
  maxOffMin: number;
  minOnMin: number | null;
  maxOnMin: number | null;
}

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
  nextTransition: NextTransitionRaw | null;
  expectedOffRange: RangeLabel | null;
  expectedOnRange: RangeLabel | null;
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
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  dataWindowHours: number;
  computedAt: string;
  apppe?: {
    version: string;
    crisisActive: boolean;
    crisisReason: string | null;
    crisisMode?: boolean;
    [key: string]: any;
  };
}

export interface ResyncPoint {
  syncedState: 'ON' | 'OFF';
  syncedAtIso: string;
  appliedAtIso: string;
  reporterName?: string | null;
  reporterReliability?: number | null;
}

// ── Public types ──────────────────────────────────────────────────────────────

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
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  isResynced?: boolean;
}

/** Single step of the Transition Decision Inspector trace (Section 9) */
export interface DecisionStep {
  step: number;
  label: string;
  detail: string;
}

/** Rule 5 reference-time case that fired (Section 8 — Offset Calculation Inspector) */
export type OffsetReferenceKind =
  | 'GROWATT_ON_START_ACTUAL'
  | 'GROWATT_ON_END_EXPECTED'
  | 'GROWATT_OFF_END_EXPECTED'
  | 'GROWATT_OFF_START_ACTUAL';

export interface CommunityOffsetResult {
  offsetMinutes: number;
  sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  referenceIso: string;
  referenceKind: OffsetReferenceKind;
}

export interface CommunityTransitionResult {
  effectiveSlots: ShiftedScheduleSlot[];
  generatedCycleStartIso: string;
  generatedCycleEndIso: string;
  generatedCycleState: 'ON' | 'OFF';
  progressRatio: number;
  derivedOffsetMinutes: number;
  offsetSign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  offsetReferenceIso: string | null;
  offsetReferenceKind: OffsetReferenceKind | null;
  isFreshOffsetComputation: boolean;
  // ── Debug instrumentation (additive — production code can ignore) ─────────
  /** Which Rule 3 branch fired for duration selection */
  durationSelectionRule: 'OFF_PROGRESS_LT_50_BEFORE' | 'OFF_PROGRESS_GT_50_AFTER' | 'ON_ALWAYS_BEFORE';
  /** The exact schedule slot the duration was borrowed from (null = last-resort fallback) */
  durationSourceSlot: { state: 'ON' | 'OFF'; startIso: string; endIso: string; durationLabel: string } | null;
  /** Step-by-step trace matching the Transition Decision Inspector (Section 9) */
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
  communityTransitionMeta: {
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
    durationSelectionRule: CommunityTransitionResult['durationSelectionRule'];
    durationSourceSlot: CommunityTransitionResult['durationSourceSlot'];
    decisionTrace: DecisionStep[];
  } | null;
}

/** Accuracy-log event — same math as production's logClientAccuracy, returned not persisted */
export interface AccuracyLogEvent {
  predictedTransitionIso: string;
  actualTransitionIso: string;
  targetState: 'ON' | 'OFF';
  offsetMinutes: number;
  exitMode: 'UNCERTAIN_ZONE' | 'POSITIVE_OFFSET_PENDING';
  errorMinutes: number;
  accuracyScore: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function shiftMs(iso: string, deltaMs: number): string {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

// Western numerals + Arabic AM/PM suffix, LTR (spec §20)
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

function fmtWait(min: number): string {
  if (min <= 0) return 'قريباً';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `~${m}د`;
  if (m === 0) return `~${h}س`;
  return `~${h}س ${m}د`;
}

export function durationLabelFromMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

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

// ── Step 1: Extend master schedule to 48h ────────────────────────────────────
export function extendScheduleTo48h(
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
export function applyOffsetToSlots(slots: ScheduleSlot[], offsetMs: number): ShiftedScheduleSlot[] {
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

// ── Rule 5: locate the RAW-schedule slot of a given state active at a moment ──
export function findActiveSlotInRawSchedule(
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
  let best: ScheduleSlot | null = null;
  let bestDist = Infinity;
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const dist = Math.abs(new Date(s.startIso).getTime() - atMs);
    if (dist < bestDist) { bestDist = dist; best = s; }
  }
  return best;
}

// ── Compute expected end of current Growatt state using schedule durations ──────
function computeExpectedStateEnd(
  rawSchedule: ScheduleSlot[],
  state: 'ON' | 'OFF',
  transitionTimeIso: string,
): { endIso: string; durationMin: number } | null {
  const transitionMs = new Date(transitionTimeIso).getTime();

  // First, try to find a schedule slot of the given state that contains the transition time
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs = new Date(s.endIso).getTime();
    if (transitionMs >= startMs && transitionMs < endMs) {
      return { endIso: s.endIso, durationMin: (endMs - startMs) / 60_000 };
    }
  }

  // If no containing slot, find the next slot of the same state and borrow its duration
  let bestSlot: ScheduleSlot | null = null;
  let bestStartMs = Infinity;
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const sStartMs = new Date(s.startIso).getTime();
    if (sStartMs >= transitionMs && sStartMs < bestStartMs) {
      bestStartMs = sStartMs;
      bestSlot = s;
    }
  }

  if (bestSlot && bestSlot.endIso) {
    const durationMs = new Date(bestSlot.endIso).getTime() - new Date(bestSlot.startIso).getTime();
    const expectedEndMs = transitionMs + durationMs;
    return { endIso: new Date(expectedEndMs).toISOString(), durationMin: durationMs / 60_000 };
  }

  return null;
}

// ── Rule 4 + Rule 5: compute the offset (sign + magnitude) ─────────────────────
export function computeCommunityOffset(
  rawSchedule: ScheduleSlot[],
  resync: ResyncPoint,
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
): CommunityOffsetResult | null {
  const startMs = new Date(resync.syncedAtIso).getTime();
  const reportedState = resync.syncedState;

  let referenceIso: string | null = null;
  let referenceKind: OffsetReferenceKind = growattCurrentState === 'ON' ? 'GROWATT_ON_END_EXPECTED' : 'GROWATT_OFF_END_EXPECTED';

  if (growattCurrentState === reportedState) {
    // Report matches current Growatt state → reference is the actual transition start
    referenceIso  = growattLastTransitionAt;
    referenceKind = reportedState === 'ON' ? 'GROWATT_ON_START_ACTUAL' : 'GROWATT_OFF_START_ACTUAL';
  } else if (growattLastTransitionAt) {
    // Report differs from Growatt state → reference is expected end of current Growatt state
    const expectedEnd = computeExpectedStateEnd(rawSchedule, growattCurrentState, growattLastTransitionAt);
    referenceIso = expectedEnd?.endIso ?? null;
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

// ── TMMS V2: Schedule-Based Community Transition (Rules 1-9) ──────────────────
export function computeCommunityTransition(
  offsetSlots: ShiftedScheduleSlot[],
  resync: ResyncPoint,
  rawSchedule: ScheduleSlot[],
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
  frozenOffsetMinutes: number | null,
  nowMs: number = Date.now(),
): CommunityTransitionResult | null {
  const trace: DecisionStep[] = [];
  let stepN = 0;
  const pushStep = (label: string, detail: string) => { stepN++; trace.push({ step: stepN, label, detail }); };

  const syncMs = new Date(resync.syncedAtIso).getTime();
  pushStep('Report/Confirmation Accepted', `${resync.syncedState} reported at ${resync.syncedAtIso}`);

  if (syncMs > nowMs + 60_000) {
    pushStep('Rejected', 'syncedAtIso is in the future — report ignored');
    return null;
  }

  const syncState: 'ON' | 'OFF'        = resync.syncedState;
  const interruptedState: 'ON' | 'OFF' = syncState === 'ON' ? 'OFF' : 'ON';

  // ── Step 1: Locate the interrupted cycle ──────────────────────────────────
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
    // Fallback 1: find the last interrupted-state slot that starts before syncMs
    for (let i = offsetSlots.length - 1; i >= 0; i--) {
      if (offsetSlots[i].state !== interruptedState) continue;
      if (new Date(offsetSlots[i].startIso).getTime() <= syncMs) {
        interruptedSlotIdx = i;
        break;
      }
    }
  }
  if (interruptedSlotIdx === -1) {
    // Fallback 2: find the NEXT interrupted-state slot that starts after syncMs
    // (report arrived before the interrupted cycle even started — preemptive report)
    for (let i = 0; i < offsetSlots.length; i++) {
      if (offsetSlots[i].state !== interruptedState) continue;
      if (new Date(offsetSlots[i].startIso).getTime() > syncMs) {
        interruptedSlotIdx = i;
        break;
      }
    }
  }
  if (interruptedSlotIdx === -1) {
    pushStep('Rejected', `No ${interruptedState} cycle found to interrupt`);
    return null;
  }

  const interruptedSlot = offsetSlots[interruptedSlotIdx];
  if (!interruptedSlot.endIso) {
    pushStep('Rejected', 'Interrupted slot has no planned end — cannot compute progress');
    return null;
  }

  pushStep(
    `Current ${interruptedState} Cycle Ended`,
    `${interruptedSlot.startFormatted} → ${interruptedSlot.endFormatted} terminated early at ${fmtYemenTime(resync.syncedAtIso)}`,
  );

  // ── Step 3: Exact progress ratio (ms precision, no rounding) ─────────────
  const cycleStartMs      = new Date(interruptedSlot.startIso).getTime();
  const cyclePlannedEndMs = new Date(interruptedSlot.endIso).getTime();
  const plannedDurationMs = cyclePlannedEndMs - cycleStartMs;
  if (plannedDurationMs <= 0) {
    pushStep('Rejected', 'Interrupted slot has non-positive duration');
    return null;
  }

  const elapsedMs     = syncMs - cycleStartMs;
  const progressRatio = elapsedMs / plannedDurationMs; // exact — never rounded

  pushStep(
    `Generated ${syncState} Created`,
    `Progress at interruption: ${(progressRatio * 100).toFixed(1)}%`,
  );

  // ── Step 5 (Rule 3): Select new-cycle duration from the schedule ─────────
  let durationSourceIdx = -1;
  const wantsBefore = interruptedState === 'ON' ? true : progressRatio <= 0.5;
  const durationSelectionRule: CommunityTransitionResult['durationSelectionRule'] =
    interruptedState === 'ON' ? 'ON_ALWAYS_BEFORE' : (progressRatio <= 0.5 ? 'OFF_PROGRESS_LT_50_BEFORE' : 'OFF_PROGRESS_GT_50_AFTER');

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
  let durationSourceSlot: CommunityTransitionResult['durationSourceSlot'] = null;
  if (durationSourceIdx !== -1 && offsetSlots[durationSourceIdx].endIso) {
    const src = offsetSlots[durationSourceIdx];
    selectedDurationMs = new Date(src.endIso!).getTime() - new Date(src.startIso).getTime();
    durationSourceSlot = { state: src.state, startIso: src.startIso, endIso: src.endIso!, durationLabel: src.durationLabel ?? '' };
  } else {
    selectedDurationMs = plannedDurationMs;
  }

  pushStep(
    'Duration Selected',
    `Rule: ${durationSelectionRule} → ${durationLabelFromMin(Math.round(selectedDurationMs / 60_000))}` +
      (durationSourceSlot ? ` (from ${durationSourceSlot.state} ${fmtYemenTime(durationSourceSlot.startIso)}→${fmtYemenTime(durationSourceSlot.endIso)})` : ' (fallback: interrupted cycle\'s own duration)'),
  );

  // ── Step 6: Build the full independent generated cycle ────────────────────
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

  // ── Step 7: Rebuild logical schedule continuation ─────────────────────────
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

  // ── Rule 4 + Rule 5: Offset calculation (fully independent of Step 5) ────
  let offsetMinutesFinal: number;
  let offsetSignFinal: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  let offsetReferenceIsoFinal: string | null;
  let offsetReferenceKindFinal: OffsetReferenceKind | null;
  let isFreshOffsetComputation: boolean;

  if (frozenOffsetMinutes !== null && frozenOffsetMinutes !== undefined) {
    offsetMinutesFinal       = frozenOffsetMinutes;
    offsetSignFinal          = offsetMinutesFinal === 0 ? 'NEUTRAL' : offsetMinutesFinal > 0 ? 'POSITIVE' : 'NEGATIVE';
    offsetReferenceIsoFinal  = null;
    offsetReferenceKindFinal = null;
    isFreshOffsetComputation = false;
    pushStep('Offset Reused (Frozen)', `${offsetMinutesFinal > 0 ? '+' : ''}${offsetMinutesFinal}m — ${offsetSignFinal} (computed once previously, never recalculated — Q2-A)`);
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
    pushStep(
      'Offset Calculated',
      `${offsetMinutesFinal > 0 ? '+' : ''}${offsetMinutesFinal}m — ${offsetSignFinal}` +
        (offsetReferenceKindFinal ? ` (ref: ${offsetReferenceKindFinal} @ ${offsetReferenceIsoFinal ? fmtYemenTime(offsetReferenceIsoFinal) : '?'})` : ' (insufficient data — defaulted to NEUTRAL)'),
    );
  }

  pushStep(
    `User Entered ${offsetSignFinal === 'NEGATIVE' ? 'Negative' : offsetSignFinal === 'POSITIVE' ? 'Positive' : 'Neutral'} Offset Path`,
    offsetSignFinal === 'NEGATIVE'
      ? 'Will enter UNCERTAIN_ZONE once the continuation cycle ends'
      : offsetSignFinal === 'POSITIVE'
        ? 'Will enter verification window (POSITIVE_OFFSET_PENDING) once the continuation cycle ends'
        : 'Will continue normal synchronized logic once the continuation cycle ends',
  );

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

// ── Validation Window (20 min) — Growatt changed while sync is active ─────────
export const VALIDATION_WINDOW_MS = 20 * 60_000;

// ── ATC Decision Engine (User A / B / C) ───────────────────────────────────────
export function computeATCState(
  effectiveSlots: ShiftedScheduleSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
  transitionMode: TransitionMode = 'AUTO',
  communityTransition?: CommunityTransitionResult | null,
  nowMs: number = Date.now(),
): ATCState {
  // ── Community Sync path (TMMS V2) ─────────────────────────────────────────
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

    // Phase B: generated cycle ended → apply the already-computed offset (Rule 9)
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

  const halfSpreadMs = 15 * 60_000;
  const GRACE_PERIOD_MS = 15 * 60_000;

  // ── USER A: NEGATIVE OFFSET ────────────────────────────────────────────────
  if (offsetMinutes < 0) {
    let justEndedSlot: ShiftedScheduleSlot | null = null;

    for (let i = 0; i < effectiveSlots.length; i++) {
      const s = effectiveSlots[i];
      if (!s.endIso) continue;
      const endMs = new Date(s.endIso).getTime();
      if (endMs <= nowMs) {
        justEndedSlot = s;
      } else {
        break;
      }
    }

    if (justEndedSlot && justEndedSlot.endIso) {
      const slotEndMs = new Date(justEndedSlot.endIso).getTime();
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
      const slotEndMs   = new Date(activeSlotNeg.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs   = slotEndMs + halfSpreadMs;
      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };
      }
    }

    return { ...EMPTY_ATC, transitionMode };
  }

  // ── USER B: POSITIVE OFFSET ────────────────────────────────────────────────
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
          ? ` سيتم   تغيير   حالتك   تلقائياً   في  ${fmtYemenTime(scheduledAutoTransitionIso)} ·  بعد  ${Math.round((scheduledMs - nowMs) / 60_000)} د `
          : null,
        scheduledAutoTransitionIso,
        transitionMode,
      };
    }

    if (!activeSlotPos || !activeSlotPos.endIso) {
      return { ...EMPTY_ATC, transitionMode };
    }

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

  // ── USER C: NEUTRAL OFFSET (= 0) ──────────────────────────────────────────
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

export function atcShouldHold(mode: ScheduleStateMode): boolean {
  return (
    mode === 'UNCERTAIN_ZONE' ||
    mode === 'WAITING_FOR_GROWATT' ||
    mode === 'PREDICTION_RANGE' ||
    mode === 'GRACE_MODE' ||
    mode === 'POSITIVE_OFFSET_PENDING'
  );
}

// ── Derive next transition ────────────────────────────────────────────────────
export function deriveNextTransition(
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

// ── ATC-aware current state derivation ───────────────────────────────────────
export function deriveCurrentStateATC(
  effectiveSlots: ShiftedScheduleSlot[],
  atcMode: ScheduleStateMode,
  masterCurrentState: 'ON' | 'OFF',
  resyncPoint: ResyncPoint | null,
  _transitionMode: TransitionMode = 'AUTO',
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

// ── Human-friendly Arabic duration range label (spec §23) ────────────────────
export function arabicDurationRange(minMin: number, maxMin: number): string {
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

// ── Duration label from startIso ──────────────────────────────────────────────
export function elapsedLabel(startIso: string | null, nowMs: number = Date.now()): string {
  if (!startIso) return '';
  const elapsedMin = Math.round((nowMs - new Date(startIso).getTime()) / 60_000);
  if (elapsedMin < 1) return 'للتو';
  const eH = Math.floor(elapsedMin / 60);
  const eM = elapsedMin % 60;
  if (eH === 0) return `${elapsedMin}د`;
  if (eM === 0) return `${eH}س`;
  return `${eH}س ${eM}د`;
}

// ── Lost-Time Reconciliation (spec §CYCLE CONTINUITY RULE) ──────────────────
export function computeReconciledCycleStart(
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

// ── Accuracy event math (pure — caller decides how/whether to persist) ───────
export function computeAccuracyLogEvent(
  predictedTransitionIso: string,
  actualTransitionIso: string,
  targetState: 'ON' | 'OFF',
  offsetMinutes: number,
  exitMode: 'UNCERTAIN_ZONE' | 'POSITIVE_OFFSET_PENDING',
): AccuracyLogEvent {
  const MAX_ALLOWED_ERROR_MIN = 150;
  const predictedMs = new Date(predictedTransitionIso).getTime();
  const actualMs    = new Date(actualTransitionIso).getTime();
  const errorMin    = Math.abs((actualMs - predictedMs) / 60_000);
  const accuracyScore = Math.max(0, 100 - (errorMin / MAX_ALLOWED_ERROR_MIN) * 100);

  return {
    predictedTransitionIso,
    actualTransitionIso,
    targetState,
    offsetMinutes,
    exitMode,
    errorMinutes: Math.round(errorMin * 100) / 100,
    accuracyScore: Math.round(accuracyScore * 100) / 100,
  };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  communitySyncMeta?: CommunitySyncMeta | null,
  transitionMode: TransitionMode = 'AUTO',
  _heldCycleStartIso?: string | null,
  frozenCommunityOffsetMinutes?: number | null,
  onOffsetCalculated?: (
    offsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
  /** Injectable "now" — the Debug Simulator's Advance Time control sets this */
  nowMs: number = Date.now(),
  /** Called for every accuracy event the pipeline produces (UNCERTAIN_ZONE / POSITIVE_OFFSET_PENDING exits) */
  onAccuracyEvent?: (event: AccuracyLogEvent) => void,
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

  // ── USER A EXIT: UNCERTAIN_ZONE → Growatt confirmed (AUTO mode) ───────────
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

      if (prediction.lastTransitionAt) {
        onAccuracyEvent?.(computeAccuracyLogEvent(
          backdatedStart, prediction.lastTransitionAt, prediction.currentState as 'ON' | 'OFF', effectiveOffsetMinutes, 'UNCERTAIN_ZONE',
        ));
      }
    } else if (prediction.lastTransitionAt) {
      currentState         = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso = prediction.lastTransitionAt;
      isHolding            = false;
      finalAtcState        = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, communityElevated: false };
    }
  }

  // ── USER B EXIT: POSITIVE_OFFSET_PENDING → scheduled time has passed ──────
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

      if (prediction.lastTransitionAt) {
        onAccuracyEvent?.(computeAccuracyLogEvent(
          atcState.scheduledAutoTransitionIso, prediction.lastTransitionAt, newState, effectiveOffsetMinutes, 'POSITIVE_OFFSET_PENDING',
        ));
      }
    }
  }

  // ── USER C / NEUTRAL EXIT: WAITING_FOR_GROWATT / GRACE_MODE ──────────────
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
