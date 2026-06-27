/**
 * TMMS V2 Simulation Layer
 * ════════════════════════════════════════════════════════════════════════════
 * Built ON TOP of tmmsEngine.ts — never reimplements TMMS logic. Every report,
 * confirmation, and offset calculation in this file is executed by calling the
 * real engine functions (applyOffsetToPrediction, which internally calls
 * computeCommunityTransition / computeATCState / etc). This layer only
 * supplies: schedule construction helpers, a controllable "world" clock,
 * Growatt simulation, and the 15 predefined scenarios with automatic
 * verification.
 * ════════════════════════════════════════════════════════════════════════════
 */
import {
  applyOffsetToPrediction,
  fmtYemenTime,
  getZoneFromIso,
  durationLabelFromMin,
  type Prediction,
  type ScheduleSlot,
  type ResyncPoint,
  type UserPrediction,
  type TransitionMode,
  type DecisionStep,
} from './tmmsEngine';

// ── Engine public API — re-exported as single integration point ───────────────
//
// Every consumer (useUserPredictions.ts, TMMSDebugSimulator.tsx, and the two
// admin route pages) imports from THIS module instead of from tmmsEngine.ts
// directly.  tmmsEngine.ts stays a pure, framework-free engine file.  This
// module becomes the single wiring point:
//
//   tmmsEngine.ts  ──►  tmmsSimulation.ts  ──►  all consumers
//
// Types that this file itself does not use internally are still re-exported
// here so that downstream consumers (useUserPredictions, TMMSDebugSimulator)
// can reach them without going back to tmmsEngine.ts.

export {
  applyOffsetToPrediction,
  fmtYemenTime,
  getZoneFromIso,
  durationLabelFromMin,
} from './tmmsEngine';

export type {
  // Types used internally by this file
  Prediction,
  ScheduleSlot,
  ResyncPoint,
  UserPrediction,
  TransitionMode,
  DecisionStep,
  // Types needed by downstream consumers (useUserPredictions / TMMSDebugSimulator)
  ShiftedScheduleSlot,
  CommunitySyncMeta,
  ScheduleStateMode,
  AccuracyLogEvent,
} from './tmmsEngine';

// ── Schedule template (what Section 1's Schedule Builder edits) ───────────────

export interface ScheduleEntryTemplate {
  id: string;
  state: 'ON' | 'OFF';
  durationMin: number;
}

export function buildScheduleSlots(
  template: ScheduleEntryTemplate[],
  anchorIso: string,
  horizonMs: number,
): ScheduleSlot[] {
  if (template.length === 0) return [];
  const slots: ScheduleSlot[] = [];
  let t = new Date(anchorIso).getTime();
  let idx = 0;
  while (t < horizonMs && slots.length < 80) {
    const entry = template[idx % template.length];
    const startIso = new Date(t).toISOString();
    const endMs = t + entry.durationMin * 60_000;
    const endIso = new Date(endMs).toISOString();
    slots.push({
      state: entry.state,
      startIso,
      endIso,
      startFormatted: fmtYemenTime(startIso),
      endFormatted: fmtYemenTime(endIso),
      durationLabel: durationLabelFromMin(entry.durationMin),
      zone: getZoneFromIso(startIso),
      isEstimated: false,
    });
    t = endMs;
    idx++;
  }
  return slots;
}

export const DEFAULT_TEMPLATE: ScheduleEntryTemplate[] = [
  { id: 't1', state: 'ON',  durationMin: 120 },
  { id: 't2', state: 'OFF', durationMin: 360 },
  { id: 't3', state: 'ON',  durationMin: 180 },
  { id: 't4', state: 'OFF', durationMin: 300 },
];

// ── World state ─────────────────────────────────────────────────────────────

export interface SimEvent {
  id: string;
  simTimeIso: string;
  action: string;
  decision: string | null;
  result: string | null;
  kind: 'info' | 'report' | 'confirm' | 'growatt' | 'offset' | 'zone' | 'error' | 'time';
}

export interface SimWorld {
  scheduleTemplate: ScheduleEntryTemplate[];
  scheduleAnchorIso: string;
  simulatedNowMs: number;
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  offsetMinutes: number;
  /** Frozen Rule 4/5 offset for the active resync, if computed (Q2-A) */
  frozenCommunityOffsetMinutes: number | null;
  resyncPoint: ResyncPoint | null;
  transitionMode: TransitionMode;
  eventLog: SimEvent[];
  lastResult: UserPrediction | null;
  lastDecisionTrace: DecisionStep[];
}

let eventIdCounter = 0;
function makeEvent(world: SimWorld, kind: SimEvent['kind'], action: string, decision: string | null = null, result: string | null = null): SimEvent {
  eventIdCounter += 1;
  return {
    id: `evt_${eventIdCounter}_${Date.now()}`,
    simTimeIso: new Date(world.simulatedNowMs).toISOString(),
    action,
    decision,
    result,
    kind,
  };
}

export function createInitialWorld(nowMs: number = Date.now()): SimWorld {
  const anchor = new Date(nowMs - 3 * 3600 * 1000).toISOString(); // schedule started 3h ago
  const base: SimWorld = {
    scheduleTemplate: DEFAULT_TEMPLATE,
    scheduleAnchorIso: anchor,
    simulatedNowMs: nowMs,
    growattCurrentState: 'ON',
    growattLastTransitionAt: anchor,
    offsetMinutes: 0,
    frozenCommunityOffsetMinutes: null,
    resyncPoint: null,
    transitionMode: 'AUTO',
    eventLog: [makeEvent({ simulatedNowMs: nowMs } as SimWorld, 'info', 'Simulator initialized', null, 'Default schedule: ON 2h → OFF 6h → ON 3h → OFF 5h')],
    lastResult: null,
    lastDecisionTrace: [],
  };
  // Run the real engine once immediately so every panel has data to show on
  // first mount, instead of staying blank until the first user action.
  return refreshResult(base);
}

// ── Build the Prediction object the engine expects, from world state ─────────
export function worldToPrediction(world: SimWorld): Prediction {
  const horizonMs = world.simulatedNowMs + 48 * 3600 * 1000;
  const daySchedule = buildScheduleSlots(world.scheduleTemplate, world.scheduleAnchorIso, horizonMs);
  return {
    currentState: world.growattCurrentState,
    currentStateDurationMin: 0,
    currentStateDurationLabel: '',
    lastTransitionAt: world.growattLastTransitionAt,
    inverterOffline: false,
    nextTransition: null,
    expectedOffRange: null,
    expectedOnRange: null,
    daySchedule,
    confidence: 1,
    confidenceLabel: 'High',
    isUnstable: false,
    stabilityScore: 1,
    stabilityLabel: 'Stable',
    dayPattern: null,
    nightPattern: null,
    allPattern: null,
    cyclesAnalyzed: 0,
    dayCyclesAnalyzed: 0,
    nightCyclesAnalyzed: 0,
    currentPeriod: 'day',
    reasoning: [],
    learningMode: 'prior_only',
    dataWindowHours: 48,
    computedAt: new Date(world.simulatedNowMs).toISOString(),
  };
}

/** Run the REAL engine pipeline against the current world state. Pure — does not mutate world. */
export function runEngine(world: SimWorld): UserPrediction {
  const prediction = worldToPrediction(world);
  return applyOffsetToPrediction(
    prediction,
    world.offsetMinutes,
    world.resyncPoint,
    null,
    world.transitionMode,
    null,
    world.frozenCommunityOffsetMinutes,
    undefined,
    world.simulatedNowMs,
    undefined,
  );
}

/** Re-run the engine and cache the result + decision trace on the world (called after every action) */
function refreshResult(world: SimWorld): SimWorld {
  const result = runEngine(world);
  return {
    ...world,
    lastResult: result,
    lastDecisionTrace: result.communityTransitionMeta?.decisionTrace ?? world.lastDecisionTrace,
  };
}

// ── Actions (Sections 2, 4, 5, 11) ─────────────────────────────────────────────

export function advanceTime(world: SimWorld, minutes: number): SimWorld {
  const newNowMs = world.simulatedNowMs + minutes * 60_000;
  const next: SimWorld = { ...world, simulatedNowMs: newNowMs };
  next.eventLog = [...world.eventLog, makeEvent(next, 'time', `Advanced time +${minutes}m`, null, fmtYemenTime(new Date(newNowMs).toISOString()))];
  return refreshResult(next);
}

export function setSimulatedNow(world: SimWorld, nowMs: number): SimWorld {
  const next: SimWorld = { ...world, simulatedNowMs: nowMs };
  next.eventLog = [...world.eventLog, makeEvent(next, 'time', 'Time set directly', null, fmtYemenTime(new Date(nowMs).toISOString()))];
  return refreshResult(next);
}

export function forceGrowattState(world: SimWorld, state: 'ON' | 'OFF'): SimWorld {
  if (state === world.growattCurrentState) return world;
  const next: SimWorld = {
    ...world,
    growattCurrentState: state,
    growattLastTransitionAt: new Date(world.simulatedNowMs).toISOString(),
  };
  next.eventLog = [...world.eventLog, makeEvent(next, 'growatt', `Growatt forced ${state}`, null, `at ${fmtYemenTime(next.growattLastTransitionAt)}`)];
  return refreshResult(next);
}

export function resetWorld(nowMs: number = Date.now()): SimWorld {
  return createInitialWorld(nowMs);
}

export function setTransitionMode(world: SimWorld, mode: TransitionMode): SimWorld {
  const next: SimWorld = { ...world, transitionMode: mode };
  next.eventLog = [...world.eventLog, makeEvent(next, 'info', `Mode switched to ${mode}`)];
  return refreshResult(next);
}

export function setSchedule(world: SimWorld, template: ScheduleEntryTemplate[]): SimWorld {
  const next: SimWorld = { ...world, scheduleTemplate: template };
  next.eventLog = [...world.eventLog, makeEvent(next, 'info', 'Schedule updated', null, template.map(t => `${t.state} ${t.durationMin}m`).join(' → '))];
  return refreshResult(next);
}

/**
 * Section 5: Report / Confirm. Builds a ResyncPoint at `reportAtMs` (defaults
 * to "now") and runs it through the REAL engine. If the engine produces a
 * fresh Rule 4/5 offset (isFreshOffsetComputation), it is frozen into the
 * world immediately (Q3-A: persist immediately; Q2-A: never recompute).
 *
 * IMPORTANT: `world.simulatedNowMs` must already be at or after `reportAtMs`
 * before calling this — computeCommunityTransition rejects reports timestamped
 * in the future relative to "now". Call setSimulatedNow first if needed.
 */
export function submitReportOrConfirm(
  world: SimWorld,
  state: 'ON' | 'OFF',
  kind: 'report' | 'confirm',
  reportAtMs?: number,
  reporterName: string = kind === 'report' ? 'Simulated User' : 'Simulated Confirmer',
): SimWorld {
  const syncedAtIso = new Date(reportAtMs ?? world.simulatedNowMs).toISOString();
  const resyncPoint: ResyncPoint = {
    syncedState: state,
    syncedAtIso,
    appliedAtIso: new Date(world.simulatedNowMs).toISOString(),
    reporterName,
    reporterReliability: 90,
  };

  let next: SimWorld = { ...world, resyncPoint, frozenCommunityOffsetMinutes: null };
  const result = runEngine(next); // FRESH computation — full detail (referenceKind etc.)
  const meta = result.communityTransitionMeta;

  const log: SimEvent[] = [
    ...world.eventLog,
    makeEvent(next, kind, `${kind === 'report' ? 'Report' : 'Confirmation'} ${state} received`, null, `synced at ${fmtYemenTime(syncedAtIso)}`),
  ];

  if (meta) {
    for (const step of meta.decisionTrace) {
      log.push(makeEvent(next, step.label.includes('Offset') ? 'offset' : 'info', step.label, null, step.detail));
    }
    if (meta.isFreshOffsetComputation) {
      // Freeze NOW (Q3-A: persist immediately). We still return the FRESH
      // `result` (computed above, before freezing) as lastResult, since that
      // carries the full referenceKind/referenceIso detail the Offset
      // Inspector needs. Subsequent engine calls (advanceTime, etc.) will
      // automatically reuse the frozen value via runEngine()/refreshResult().
      next = { ...next, frozenCommunityOffsetMinutes: meta.offsetMinutes };
      log.push(makeEvent(next, 'offset', 'Offset frozen & persisted', null, `${meta.offsetMinutes > 0 ? '+' : ''}${meta.offsetMinutes}m (${meta.offsetSign}) — will never recompute (Q2-A)`));
    }
  } else {
    log.push(makeEvent(next, 'error', 'No generated cycle created', null, 'No matching interrupted cycle found in schedule'));
  }

  return {
    ...next,
    eventLog: log,
    lastResult: result,
    lastDecisionTrace: meta?.decisionTrace ?? next.lastDecisionTrace,
  };
}

// ── Scenario Runner (Section 14) ───────────────────────────────────────────────

export interface ScenarioResult {
  pass: boolean;
  actual: string;
  expected: string;
  world: SimWorld;
}

export interface ScenarioDef {
  id: number;
  name: string;
  description: string;
  expected: string;
  run: () => ScenarioResult;
}

function freshBase(nowMs: number): { world: SimWorld; anchor: string } {
  // 24h gap comfortably covers every report-time offset used below, so no
  // scenario can accidentally compute a report timestamp in the future
  // relative to the world clock (computeCommunityTransition rejects those).
  const anchor = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  let world = createInitialWorld(nowMs);
  world = { ...world, scheduleAnchorIso: anchor, growattLastTransitionAt: anchor, eventLog: [] };
  return { world, anchor };
}

/** Find the slot immediately AFTER the generated (isResynced) slot in a result's daySchedule */
function findContinuationFirstSlot(result: UserPrediction | null) {
  if (!result) return null;
  const slots = result.daySchedule;
  const genIdx = slots.findIndex(s => (s as any).isResynced === true);
  if (genIdx === -1 || genIdx + 1 >= slots.length) return null;
  return slots[genIdx + 1];
}

const SCENARIOS_BASE_NOW = Date.now();

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 1,
    name: 'OFF Progress < 50% → Report ON',
    description: 'Interrupt an OFF cycle before the halfway point and report ON.',
    expected: 'Previous ON duration used (2h)',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      // OFF slot starts at anchor+2h, lasts 6h. Report at anchor+3h (1h elapsed of 6h = 16.7%)
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 180 * 60_000);
      world = submitReportOrConfirm(world, 'ON', 'report');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 120 && meta?.durationSelectionRule === 'OFF_PROGRESS_LT_50_BEFORE';
      return { pass, actual: `${durMin}min, rule=${meta?.durationSelectionRule}`, expected: '120min, OFF_PROGRESS_LT_50_BEFORE', world };
    },
  },
  {
    id: 2,
    name: 'OFF Progress > 50% → Report ON',
    description: 'Interrupt an OFF cycle after the halfway point and report ON.',
    expected: 'Next ON duration used (3h)',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      // OFF slot anchor+2h to anchor+8h. Report at anchor+6h (4h of 6h = 66.7%)
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 360 * 60_000);
      world = submitReportOrConfirm(world, 'ON', 'report');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 180 && meta?.durationSelectionRule === 'OFF_PROGRESS_GT_50_AFTER';
      return { pass, actual: `${durMin}min, rule=${meta?.durationSelectionRule}`, expected: '180min, OFF_PROGRESS_GT_50_AFTER', world };
    },
  },
  {
    id: 3,
    name: 'ON Interrupted → Report OFF',
    description: 'Interrupt an ON cycle (any progress %) and report OFF.',
    expected: 'Previous OFF duration ALWAYS used — no 50% rule for ON',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      // ON slot anchor+8h to anchor+11h (after OFF 6h). Report at anchor+10h (2h of 3h = 66.7%, would be "after" under the 50% rule)
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 600 * 60_000);
      world = submitReportOrConfirm(world, 'OFF', 'report');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 360 && meta?.durationSelectionRule === 'ON_ALWAYS_BEFORE';
      return { pass, actual: `${durMin}min (66.7% progress, would be "after" under 50% rule), rule=${meta?.durationSelectionRule}`, expected: '360min, ON_ALWAYS_BEFORE (ignores progress)', world };
    },
  },
  {
    id: 4,
    name: 'Growatt ON + Report ON (after)',
    description: 'Report ON arrives after Growatt actually turned ON.',
    expected: 'Reference = Growatt ON Start (actual), offset POSITIVE',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'OFF'); // reset baseline
      world = setSimulatedNow(world, new Date(anchor).getTime() + 480 * 60_000);
      world = forceGrowattState(world, 'ON'); // Growatt ON at this moment
      world = setSimulatedNow(world, world.simulatedNowMs + 60 * 60_000); // 1h later
      world = submitReportOrConfirm(world, 'ON', 'report');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE' && meta?.offsetReferenceKind === 'GROWATT_ON_START_ACTUAL';
      return { pass, actual: `sign=${meta?.offsetSign} ref=${meta?.offsetReferenceKind} (${meta?.offsetMinutes}m)`, expected: 'POSITIVE, GROWATT_ON_START_ACTUAL', world };
    },
  },
  {
    id: 5,
    name: 'Growatt ON + Report ON (before)',
    description: 'Report ON is backdated to before Growatt actually turned ON.',
    expected: 'Reference = Growatt ON Start (actual), offset NEGATIVE',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'OFF');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 480 * 60_000);
      world = forceGrowattState(world, 'ON'); // Growatt ON at T
      const growattOnMs = world.simulatedNowMs;
      world = setSimulatedNow(world, growattOnMs + 30 * 60_000); // clock advances so report isn't "in the future"
      // Report backdated to T-45min (before Growatt's actual ON start)
      world = submitReportOrConfirm(world, 'ON', 'report', growattOnMs - 45 * 60_000);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEGATIVE' && meta?.offsetReferenceKind === 'GROWATT_ON_START_ACTUAL';
      return { pass, actual: `sign=${meta?.offsetSign} ref=${meta?.offsetReferenceKind} (${meta?.offsetMinutes}m)`, expected: 'NEGATIVE, GROWATT_ON_START_ACTUAL', world };
    },
  },
  {
    id: 6,
    name: 'Growatt OFF + Report ON',
    description: 'Growatt is currently OFF; user reports ON.',
    expected: 'Reference = Growatt OFF END time (expected) — NEVER the OFF start time',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      // OFF slot anchor+2h..anchor+8h. Growatt OFF started at anchor+2h.
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000); // 3h into the 6h OFF window
      world = submitReportOrConfirm(world, 'ON', 'report');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetReferenceKind === 'GROWATT_OFF_END_EXPECTED';
      return { pass, actual: `ref=${meta?.offsetReferenceKind} (${meta?.offsetMinutes}m) — NOT start time`, expected: 'GROWATT_OFF_END_EXPECTED', world };
    },
  },
  {
    id: 7,
    name: 'Growatt OFF + Report OFF',
    description: 'Growatt is currently OFF; user confirms OFF.',
    expected: 'Reference = Growatt OFF START time (actual)',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 80 * 60_000);
      world = submitReportOrConfirm(world, 'OFF', 'confirm');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetReferenceKind === 'GROWATT_OFF_START_ACTUAL' && (meta?.offsetMinutes ?? 0) > 0;
      return { pass, actual: `ref=${meta?.offsetReferenceKind} (${meta?.offsetMinutes}m)`, expected: 'GROWATT_OFF_START_ACTUAL, +80m', world };
    },
  },
  {
    id: 8,
    name: 'Positive Offset Path',
    description: 'After a generated cycle with positive offset ends, Growatt flips ahead of the continuation schedule.',
    expected: 'ATC enters POSITIVE_OFFSET_PENDING (or reconciles instantly to NORMAL with a backdated start, if the scheduled time has already passed)',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 80 * 60_000);
      world = submitReportOrConfirm(world, 'OFF', 'confirm'); // produces POSITIVE offset (scenario 7 pattern)
      const continuationSlot = findContinuationFirstSlot(world.lastResult);
      const generatedEnd = world.lastResult!.communityTransitionMeta!.generatedCycleEndIso;
      const continuationStartMs = new Date(generatedEnd).getTime();
      const continuationDurMs = continuationSlot?.endIso ? new Date(continuationSlot.endIso).getTime() - continuationStartMs : 60 * 60_000;
      const midPointMs = continuationStartMs + Math.min(continuationDurMs / 2, 60 * 60_000);
      world = setSimulatedNow(world, midPointMs);
      // Force a GENUINE fresh Growatt transition at this exact moment (not a
      // no-op): first ensure Growatt matches the continuation's state, then
      // flip it — guarantees growattLastTransitionAt = midPointMs, so the
      // scheduled reconciliation time (midPointMs + 80min offset) is still in
      // the future and we can observe the pending window before exit-reconciliation.
      const matchingState: 'ON' | 'OFF' = continuationSlot?.state ?? 'ON';
      const oppositeOfContinuation: 'ON' | 'OFF' = matchingState === 'ON' ? 'OFF' : 'ON';
      world = forceGrowattState(world, matchingState);
      world = forceGrowattState(world, oppositeOfContinuation);
      const mode = world.lastResult?.atc.mode;
      // Either outcome is correct per Rule 9: a genuinely future scheduled
      // time shows POSITIVE_OFFSET_PENDING; if it already elapsed, the exit
      // block reconciles instantly to NORMAL with a non-null backdated start.
      const pass = !!(
        (mode === 'POSITIVE_OFFSET_PENDING' && !!world.lastResult?.atc.scheduledAutoTransitionIso) ||
        (mode === 'NORMAL' && world.lastResult?.reconciledCycleStartIso !== null && world.lastResult?.isResynced)
      );
      return { pass, actual: `atc.mode=${mode}, scheduledAutoTransitionIso=${world.lastResult?.atc.scheduledAutoTransitionIso}, reconciledCycleStartIso=${world.lastResult?.reconciledCycleStartIso}`, expected: 'POSITIVE_OFFSET_PENDING (pending) or NORMAL (already reconciled)', world };
    },
  },
  {
    id: 9,
    name: 'Negative Offset Path',
    description: 'After a generated cycle with negative offset ends, verify UNCERTAIN_ZONE.',
    expected: 'ATC mode becomes UNCERTAIN_ZONE once the continuation slot overruns',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReportOrConfirm(world, 'ON', 'report'); // produces NEGATIVE offset (scenario 6 pattern)
      const continuationSlot = findContinuationFirstSlot(world.lastResult);
      const target = continuationSlot?.endIso
        ? new Date(continuationSlot.endIso).getTime() + 35 * 60_000
        : world.simulatedNowMs + 35 * 60_000;
      world = setSimulatedNow(world, target);
      const pass = world.lastResult?.atc.mode === 'UNCERTAIN_ZONE';
      return { pass, actual: `atc.mode=${world.lastResult?.atc.mode}`, expected: 'UNCERTAIN_ZONE', world };
    },
  },
  {
    id: 10,
    name: 'Neutral Offset Path',
    description: 'Report exactly matches the expected Growatt reference time → offset = 0.',
    expected: 'Offset = 0 (NEUTRAL), continuation proceeds normally with no special zone',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      const offStartMs = world.simulatedNowMs;
      const offEndMs = offStartMs + 360 * 60_000; // raw OFF slot is 6h
      world = setSimulatedNow(world, offEndMs); // clock at exactly the expected boundary
      world = submitReportOrConfirm(world, 'ON', 'report', offEndMs);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0;
      return { pass, actual: `sign=${meta?.offsetSign} (${meta?.offsetMinutes}m)`, expected: 'NEUTRAL, 0m', world };
    },
  },
  {
    id: 11,
    name: 'UNCERTAIN_ZONE Entry',
    description: 'A standard negative-offset user (no community transition) overruns their predicted cycle end.',
    expected: 'ATC enters UNCERTAIN_ZONE once overrun exceeds the 15-min prediction-range buffer',
    run: () => {
      const { world: w0 } = freshBase(SCENARIOS_BASE_NOW);
      let world = { ...w0, offsetMinutes: -120 }; // stored negative offset, no resync
      world = refreshResult(world);
      const activeEnd = world.lastResult?.daySchedule.find(s => new Date(s.startIso).getTime() <= world.simulatedNowMs && (!s.endIso || new Date(s.endIso).getTime() > world.simulatedNowMs))?.endIso;
      world = setSimulatedNow(world, activeEnd ? new Date(activeEnd).getTime() + 25 * 60_000 : world.simulatedNowMs + 25 * 60_000);
      const pass = world.lastResult?.atc.mode === 'UNCERTAIN_ZONE';
      return { pass, actual: `atc.mode=${world.lastResult?.atc.mode}`, expected: 'UNCERTAIN_ZONE', world };
    },
  },
  {
    id: 12,
    name: 'UNCERTAIN_ZONE Exit',
    description: 'From UNCERTAIN_ZONE, Growatt finally confirms the transition.',
    expected: 'Exits to NORMAL with a backdated cycle start (GrowattTime + offset)',
    run: () => {
      const { world: w0 } = freshBase(SCENARIOS_BASE_NOW);
      let world = { ...w0, offsetMinutes: -120 };
      world = refreshResult(world);
      const activeEnd = world.lastResult?.daySchedule.find(s => new Date(s.startIso).getTime() <= world.simulatedNowMs && (!s.endIso || new Date(s.endIso).getTime() > world.simulatedNowMs))?.endIso;
      world = setSimulatedNow(world, activeEnd ? new Date(activeEnd).getTime() + 25 * 60_000 : world.simulatedNowMs + 25 * 60_000);
      const heldState = world.lastResult!.currentState;
      const newState: 'ON' | 'OFF' = heldState === 'ON' ? 'OFF' : 'ON';
      world = forceGrowattState(world, newState); // Growatt finally confirms
      const pass = world.lastResult?.atc.mode === 'NORMAL' && world.lastResult?.reconciledCycleStartIso !== null;
      return { pass, actual: `atc.mode=${world.lastResult?.atc.mode}, reconciledStart=${world.lastResult?.reconciledCycleStartIso}`, expected: 'NORMAL with non-null reconciledCycleStartIso', world };
    },
  },
  {
    id: 13,
    name: 'Generated State Completion',
    description: 'Once the generated cycle ends, the schedule must show the continuation slot as active — not freeze on the generated state.',
    expected: 'mode leaves COMMUNITY_SYNCED the instant the generated cycle ends',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReportOrConfirm(world, 'ON', 'report');
      const generatedEnd = world.lastResult!.communityTransitionMeta!.generatedCycleEndIso;
      const generatedState = world.lastResult!.communityTransitionMeta!.generatedCycleState;
      world = setSimulatedNow(world, new Date(generatedEnd).getTime() + 5 * 60_000); // just past generated end
      const pass = world.lastResult?.atc.mode !== 'COMMUNITY_SYNCED';
      return { pass, actual: `currentState=${world.lastResult?.currentState}, mode=${world.lastResult?.atc.mode} (generated was ${generatedState})`, expected: 'mode leaves COMMUNITY_SYNCED', world };
    },
  },
  {
    id: 14,
    name: 'Schedule Continuity',
    description: 'The continuation after a generated cycle follows the LOGICAL schedule sequence, not the nearest clock time.',
    expected: 'Continuation slot durations match the schedule pattern in sequence (e.g. generated ON(3h) → next is OFF(5h))',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = setSchedule(w0, [
        { id: 'a', state: 'ON', durationMin: 120 },
        { id: 'b', state: 'OFF', durationMin: 360 },
        { id: 'c', state: 'ON', durationMin: 180 },
        { id: 'd', state: 'OFF', durationMin: 300 },
      ]);
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 360 * 60_000); // >50% of OFF(6h) -> borrows next ON(3h)
      world = submitReportOrConfirm(world, 'ON', 'report');
      const slots = world.lastResult!.daySchedule;
      const genIdx = slots.findIndex(s => (s as any).isResynced);
      const nextSlot = genIdx >= 0 ? slots[genIdx + 1] : null;
      const nextDurMin = nextSlot?.endIso ? (new Date(nextSlot.endIso).getTime() - new Date(nextSlot.startIso).getTime()) / 60_000 : null;
      const pass = nextSlot?.state === 'OFF' && nextDurMin === 300;
      return { pass, actual: `next slot = ${nextSlot?.state} ${nextDurMin}min`, expected: 'next slot = OFF 300min (logical sequence, not clock-based)', world };
    },
  },
  {
    id: 15,
    name: 'Persistent Timeline Validation',
    description: 'Generated states remain visible in the schedule history long after completion — never deleted.',
    expected: 'The generated slot (isResynced=true) is still present in daySchedule even after the simulator advances far past its end',
    run: () => {
      const { world: w0, anchor } = freshBase(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReportOrConfirm(world, 'ON', 'report');
      // NOTE: the generated slot is reconstructed deterministically from resyncPoint
      // on every engine run (not deleted from any store) — advancing time keeps it
      // present in daySchedule as long as resyncPoint is still active.
      world = setSimulatedNow(world, world.simulatedNowMs + 20 * 3600 * 1000); // +20h
      const stillPresent = world.lastResult?.daySchedule.some(s => (s as any).isResynced === true);
      return { pass: !!stillPresent, actual: `generated slot present after +20h: ${stillPresent}`, expected: 'true', world };
    },
  },
];
