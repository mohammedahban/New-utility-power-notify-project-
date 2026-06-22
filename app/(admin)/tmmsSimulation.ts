/**
 * TMMS V2 Simulation Layer
 * ════════════════════════════════════════════════════════════════════════════
 * Drives the real tmmsEngine with deterministic world state so TMMSDebugSimulator
 * can exercise every code branch without touching production data.
 *
 * This file intentionally has NO side-effects: no Supabase calls, no React state.
 * Every function is a pure state transition:  (SimWorld, …) → SimWorld
 * ════════════════════════════════════════════════════════════════════════════
 */

import {
  applyOffsetToPrediction,
  extendScheduleTo48h,
  applyOffsetToSlots,
  computeCommunityTransition,
  fmtYemenTime,
  durationLabelFromMin,
  getZoneFromIso,
  type Prediction,
  type ScheduleSlot,
  type ResyncPoint,
  type UserPrediction,
  type DecisionStep,
  type TransitionMode,
} from './tmmsEngine';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScheduleEntryTemplate {
  id: string;
  state: 'ON' | 'OFF';
  durationMin: number;
}

export type SimEventKind = 'info' | 'report' | 'confirm' | 'growatt' | 'offset' | 'zone' | 'error' | 'time';

export interface SimEvent {
  id: string;
  kind: SimEventKind;
  action: string;
  result?: string;
  simTimeIso: string;
}

export interface SimWorld {
  scheduleTemplate: ScheduleEntryTemplate[];
  simulatedNowMs: number;
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  offsetMinutes: number;
  frozenCommunityOffsetMinutes: number | null;
  transitionMode: TransitionMode;
  resyncPoint: ResyncPoint | null;
  lastResult: UserPrediction | null;
  lastDecisionTrace: DecisionStep[] | null;
  eventLog: SimEvent[];
}

export interface ScenarioResult {
  pass: boolean;
  expected: string;
  actual: string;
  world: SimWorld;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _eventCounter = 0;
function makeEvent(kind: SimEventKind, action: string, simTimeIso: string, result?: string): SimEvent {
  return { id: `evt_${++_eventCounter}`, kind, action, simTimeIso, result };
}

/** Build a synthetic Prediction from SimWorld's schedule template + current Growatt state */
function buildPrediction(world: SimWorld): Prediction {
  const nowMs = world.simulatedNowMs;
  const slots: ScheduleSlot[] = [];

  // Anchor first slot start to simulatedNow (rounded to minute)
  let curMs = nowMs - 30 * 60_000; // start 30 min before "now" so there's context
  for (let rep = 0; rep < 6; rep++) {
    for (const t of world.scheduleTemplate) {
      const startIso = new Date(curMs).toISOString();
      const endMs = curMs + t.durationMin * 60_000;
      const endIso = new Date(endMs).toISOString();
      slots.push({
        state: t.state,
        startIso,
        endIso,
        startFormatted: fmtYemenTime(startIso),
        endFormatted: fmtYemenTime(endIso),
        durationLabel: durationLabelFromMin(t.durationMin),
        zone: getZoneFromIso(startIso),
        isEstimated: rep > 0,
      });
      curMs = endMs;
    }
  }

  // Find current slot to determine current state
  let currentState: 'ON' | 'OFF' = world.growattCurrentState;
  for (const s of slots) {
    const startMs = new Date(s.startIso).getTime();
    const endMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (nowMs >= startMs && nowMs < endMs) {
      currentState = s.state;
      break;
    }
  }

  const totalCycleMins = world.scheduleTemplate.reduce((s, t) => s + t.durationMin, 0);
  const offMins = world.scheduleTemplate.filter(t => t.state === 'OFF').reduce((s, t) => s + t.durationMin, 0);
  const onMins = world.scheduleTemplate.filter(t => t.state === 'ON').reduce((s, t) => s + t.durationMin, 0);

  return {
    currentState: world.growattCurrentState,
    currentStateDurationMin: Math.round((nowMs - new Date(world.growattLastTransitionAt).getTime()) / 60_000),
    currentStateDurationLabel: durationLabelFromMin(Math.round((nowMs - new Date(world.growattLastTransitionAt).getTime()) / 60_000)),
    lastTransitionAt: world.growattLastTransitionAt,
    inverterOffline: false,
    nextTransition: null,
    expectedOffRange: { minMin: offMins * 0.8, maxMin: offMins * 1.2, label: `${offMins}د` },
    expectedOnRange: { minMin: onMins * 0.8, maxMin: onMins * 1.2, label: `${onMins}د` },
    daySchedule: slots,
    confidence: 72,
    confidenceLabel: 'جيد',
    isUnstable: false,
    stabilityScore: 72,
    stabilityLabel: 'Stable',
    dayPattern: {
      cycles: 5,
      avgOffMin: offMins,
      stdDevOffMin: offMins * 0.1,
      avgOnMin: onMins,
      stdDevOnMin: onMins * 0.1,
      minOffMin: offMins * 0.8,
      maxOffMin: offMins * 1.2,
      minOnMin: onMins * 0.8,
      maxOnMin: onMins * 1.2,
    },
    nightPattern: null,
    allPattern: {
      cycles: 8,
      avgOffMin: offMins,
      stdDevOffMin: offMins * 0.1,
      avgOnMin: onMins,
      stdDevOnMin: onMins * 0.1,
      minOffMin: offMins * 0.8,
      maxOffMin: offMins * 1.2,
      minOnMin: onMins * 0.8,
      maxOnMin: onMins * 1.2,
    },
    cyclesAnalyzed: 8,
    dayCyclesAnalyzed: 5,
    nightCyclesAnalyzed: 3,
    currentPeriod: 'day',
    reasoning: ['Simulated prediction from TMMSDebugSimulator'],
    learningMode: 'hybrid',
    dataWindowHours: 36,
    computedAt: new Date(nowMs).toISOString(),
    apppe: {
      version: '4.0',
      crisisActive: false,
      crisisReason: null,
      driftOffset: 0,
      driftSampleCount: 5,
      biasRatio: 1.0,
      biasSampleCount: 5,
      volatilityEMA: 5,
      volatilityLabel: 'Low',
      crisisShift: { off: 0, on: 0 },
      learningStrength: 65,
      effectiveWeightedSamples: 15,
      effectiveWeightedSamplesOn: 7,
      madOff: 8,
      madOn: 5,
      predictionQuality: {
        dataQuantityFactor: 70,
        stabilityFactor: 80,
        driftStabilityFactor: 75,
        biasStabilityFactor: 85,
        volatilityFactor: 90,
        crisisFactor: 100,
      },
      historySource: 'simulator',
      rangeWasClamped: false,
    },
  };
}

/** Re-run the TMMS engine and return updated lastResult + lastDecisionTrace */
function recompute(world: SimWorld): SimWorld {
  const prediction = buildPrediction(world);
  const frozenOffset = world.frozenCommunityOffsetMinutes;

  let capturedTrace: DecisionStep[] | null = null;

  const result = applyOffsetToPrediction(
    prediction,
    world.offsetMinutes,
    world.resyncPoint ?? undefined,
    null,
    world.transitionMode,
    null,
    frozenOffset ?? undefined,
    undefined,
    world.simulatedNowMs,
    undefined,
  );

  capturedTrace = result.communityTransitionMeta?.decisionTrace ?? null;

  return { ...world, lastResult: result, lastDecisionTrace: capturedTrace };
}

// ── Public API ────────────────────────────────────────────────────────────────

const DEFAULT_SCHEDULE: ScheduleEntryTemplate[] = [
  { id: 't1', state: 'ON',  durationMin: 120 },
  { id: 't2', state: 'OFF', durationMin: 360 },
];

export function createInitialWorld(): SimWorld {
  const nowMs = Date.now();
  const base: SimWorld = {
    scheduleTemplate: DEFAULT_SCHEDULE,
    simulatedNowMs: nowMs,
    growattCurrentState: 'ON',
    growattLastTransitionAt: new Date(nowMs - 30 * 60_000).toISOString(),
    offsetMinutes: 0,
    frozenCommunityOffsetMinutes: null,
    transitionMode: 'AUTO',
    resyncPoint: null,
    lastResult: null,
    lastDecisionTrace: null,
    eventLog: [makeEvent('info', 'Simulator initialized', new Date(nowMs).toISOString())],
  };
  return recompute(base);
}

export function resetWorld(): SimWorld {
  _eventCounter = 0;
  return createInitialWorld();
}

export function advanceTime(world: SimWorld, minutes: number): SimWorld {
  const newMs = world.simulatedNowMs + minutes * 60_000;
  const iso = new Date(newMs).toISOString();
  const updated: SimWorld = {
    ...world,
    simulatedNowMs: newMs,
    eventLog: [...world.eventLog, makeEvent('time', `Time advanced +${minutes}m`, iso, fmtYemenTime(iso))],
  };
  return recompute(updated);
}

export function setSimulatedNow(world: SimWorld, ms: number): SimWorld {
  const iso = new Date(ms).toISOString();
  const updated: SimWorld = {
    ...world,
    simulatedNowMs: ms,
    eventLog: [...world.eventLog, makeEvent('time', `Clock set to ${fmtYemenTime(iso)}`, iso)],
  };
  return recompute(updated);
}

export function forceGrowattState(world: SimWorld, state: 'ON' | 'OFF'): SimWorld {
  if (world.growattCurrentState === state) return world;
  const iso = new Date(world.simulatedNowMs).toISOString();
  const updated: SimWorld = {
    ...world,
    growattCurrentState: state,
    growattLastTransitionAt: iso,
    eventLog: [...world.eventLog, makeEvent('growatt', `Growatt forced → ${state}`, iso, fmtYemenTime(iso))],
  };
  return recompute(updated);
}

export function setTransitionMode(world: SimWorld, mode: TransitionMode): SimWorld {
  const iso = new Date(world.simulatedNowMs).toISOString();
  const updated: SimWorld = {
    ...world,
    transitionMode: mode,
    eventLog: [...world.eventLog, makeEvent('info', `Mode → ${mode}`, iso)],
  };
  return recompute(updated);
}

export function setSchedule(world: SimWorld, template: ScheduleEntryTemplate[]): SimWorld {
  if (template.length === 0) return world;
  const iso = new Date(world.simulatedNowMs).toISOString();
  const updated: SimWorld = {
    ...world,
    scheduleTemplate: template,
    resyncPoint: null,
    frozenCommunityOffsetMinutes: null,
    eventLog: [...world.eventLog, makeEvent('info', `Schedule updated (${template.length} slots)`, iso)],
  };
  return recompute(updated);
}

export function submitReportOrConfirm(world: SimWorld, state: 'ON' | 'OFF', kind: 'report' | 'confirm'): SimWorld {
  const iso = new Date(world.simulatedNowMs).toISOString();
  const resyncPoint: ResyncPoint = {
    syncedState: state,
    syncedAtIso: iso,
    appliedAtIso: iso,
    reporterName: kind === 'confirm' ? 'Confirm (simulator)' : 'Reporter (simulator)',
    reporterReliability: kind === 'confirm' ? 85 : 72,
  };

  const updated: SimWorld = {
    ...world,
    resyncPoint,
    frozenCommunityOffsetMinutes: null, // allow fresh offset computation
    eventLog: [...world.eventLog, makeEvent(kind, `${kind === 'confirm' ? 'Confirm' : 'Report'} ${state} submitted at ${fmtYemenTime(iso)}`, iso)],
  };

  // Run once to compute fresh offset
  const after = recompute(updated);

  // Freeze offset immediately (Q2-A / Q3-A)
  const newOffset = after.lastResult?.communityTransitionMeta?.offsetMinutes ?? null;
  const frozen = newOffset !== null ? {
    ...after,
    frozenCommunityOffsetMinutes: newOffset,
    offsetMinutes: newOffset,
    eventLog: [
      ...after.eventLog,
      makeEvent('offset', `Offset frozen at ${newOffset > 0 ? '+' : ''}${newOffset}m (${after.lastResult?.communityTransitionMeta?.offsetSign ?? 'NEUTRAL'})`, iso),
    ],
  } : after;

  return recompute(frozen);
}

// ── Scenario Runner ────────────────────────────────────────────────────────────

interface Scenario {
  id: number;
  name: string;
  run(): ScenarioResult;
}

function runScenario(
  id: number,
  name: string,
  setup: () => SimWorld,
  check: (world: SimWorld) => { pass: boolean; expected: string; actual: string },
): Scenario {
  return {
    id,
    name,
    run(): ScenarioResult {
      const world = setup();
      const { pass, expected, actual } = check(world);
      return { pass, expected, actual, world };
    },
  };
}

export const SCENARIOS: Scenario[] = [
  runScenario(1, 'Initial state is NORMAL',
    () => createInitialWorld(),
    (w) => ({
      pass: w.lastResult?.atc.mode === 'NORMAL',
      expected: 'NORMAL',
      actual: w.lastResult?.atc.mode ?? '?',
    }),
  ),

  runScenario(2, 'Force Growatt OFF → state updates',
    () => forceGrowattState(createInitialWorld(), 'OFF'),
    (w) => ({
      pass: w.growattCurrentState === 'OFF',
      expected: 'OFF',
      actual: w.growattCurrentState,
    }),
  ),

  runScenario(3, 'Advance 90m → time progresses',
    () => advanceTime(createInitialWorld(), 90),
    (w) => {
      const expected = Date.now() + 90 * 60_000;
      const pass = Math.abs(w.simulatedNowMs - expected) < 5000;
      return { pass, expected: `~${Math.round(expected / 1000)}`, actual: String(Math.round(w.simulatedNowMs / 1000)) };
    },
  ),

  runScenario(4, 'Report ON → COMMUNITY_SYNCED while inside generated cycle',
    () => submitReportOrConfirm(createInitialWorld(), 'ON', 'report'),
    (w) => ({
      pass: w.lastResult?.atc.mode === 'COMMUNITY_SYNCED' || w.lastResult?.isResynced === true,
      expected: 'COMMUNITY_SYNCED or isResynced=true',
      actual: `${w.lastResult?.atc.mode} isResynced=${w.lastResult?.isResynced}`,
    }),
  ),

  runScenario(5, 'Report OFF changes displayed state',
    () => submitReportOrConfirm(createInitialWorld(), 'OFF', 'report'),
    (w) => ({
      pass: w.lastResult?.currentState === 'OFF',
      expected: 'OFF',
      actual: w.lastResult?.currentState ?? '?',
    }),
  ),

  runScenario(6, 'Offset freezes after report (Q2-A)',
    () => {
      let w = submitReportOrConfirm(createInitialWorld(), 'ON', 'report');
      const firstOffset = w.frozenCommunityOffsetMinutes;
      // Advance time and force growatt change — offset should remain frozen
      w = advanceTime(w, 30);
      w = forceGrowattState(w, 'OFF');
      return { ...w, _frozenAtFirstReport: firstOffset } as any;
    },
    (w: any) => {
      const consistent = w.frozenCommunityOffsetMinutes === w._frozenAtFirstReport;
      return {
        pass: consistent,
        expected: `frozen=${w._frozenAtFirstReport}m unchanged`,
        actual: `frozen=${w.frozenCommunityOffsetMinutes}m`,
      };
    },
  ),

  runScenario(7, 'MANUAL mode disables POSITIVE_OFFSET_PENDING auto-transition',
    () => {
      let w = setTransitionMode(createInitialWorld(), 'MANUAL');
      w = forceGrowattState(w, 'OFF');
      return w;
    },
    (w) => ({
      pass: w.lastResult?.atc.mode !== 'POSITIVE_OFFSET_PENDING',
      expected: 'not POSITIVE_OFFSET_PENDING',
      actual: w.lastResult?.atc.mode ?? '?',
    }),
  ),

  runScenario(8, 'Negative offset schedule — User A path',
    () => {
      let w = createInitialWorld();
      w = { ...w, offsetMinutes: -60, frozenCommunityOffsetMinutes: null };
      return recompute(w);
    },
    (w) => {
      const mode = w.lastResult?.atc.mode;
      const isUserAPath = mode === 'NORMAL' || mode === 'UNCERTAIN_ZONE' || mode === 'PREDICTION_RANGE';
      return { pass: isUserAPath, expected: 'NORMAL|UNCERTAIN_ZONE|PREDICTION_RANGE', actual: mode ?? '?' };
    },
  ),

  runScenario(9, 'Positive offset schedule — User B path',
    () => {
      let w = createInitialWorld();
      w = { ...w, offsetMinutes: 60, frozenCommunityOffsetMinutes: null };
      return recompute(w);
    },
    (w) => {
      const mode = w.lastResult?.atc.mode;
      const isUserBPath = mode === 'NORMAL' || mode === 'POSITIVE_OFFSET_PENDING' || mode === 'PREDICTION_RANGE';
      return { pass: isUserBPath, expected: 'NORMAL|POSITIVE_OFFSET_PENDING|PREDICTION_RANGE', actual: mode ?? '?' };
    },
  ),

  runScenario(10, 'setSchedule clears resync state',
    () => {
      let w = submitReportOrConfirm(createInitialWorld(), 'ON', 'report');
      w = setSchedule(w, [{ id: 'a', state: 'ON', durationMin: 90 }, { id: 'b', state: 'OFF', durationMin: 270 }]);
      return w;
    },
    (w) => ({
      pass: w.resyncPoint === null,
      expected: 'resyncPoint=null',
      actual: w.resyncPoint === null ? 'null' : 'not null',
    }),
  ),

  runScenario(11, 'Generated cycle has isResynced=true',
    () => submitReportOrConfirm(createInitialWorld(), 'OFF', 'confirm'),
    (w) => {
      const generatedSlot = w.lastResult?.daySchedule.find(s => (s as any).isResynced);
      return {
        pass: !!generatedSlot,
        expected: 'at least one slot with isResynced=true',
        actual: generatedSlot ? `found at ${generatedSlot.startFormatted}` : 'none found',
      };
    },
  ),

  runScenario(12, 'Reset clears all state',
    () => {
      let w = submitReportOrConfirm(createInitialWorld(), 'ON', 'report');
      w = advanceTime(w, 120);
      return resetWorld();
    },
    (w) => ({
      pass: w.resyncPoint === null && w.eventLog.length === 1,
      expected: 'resyncPoint=null, 1 event',
      actual: `resyncPoint=${w.resyncPoint === null ? 'null' : 'set'}, ${w.eventLog.length} events`,
    }),
  ),

  runScenario(13, 'Day schedule has at least 4 slots after initial build',
    () => createInitialWorld(),
    (w) => {
      const count = w.lastResult?.daySchedule.length ?? 0;
      return { pass: count >= 4, expected: '≥4 slots', actual: `${count} slots` };
    },
  ),

  runScenario(14, 'Community transition meta is populated after report',
    () => submitReportOrConfirm(createInitialWorld(), 'ON', 'report'),
    (w) => ({
      pass: w.lastResult?.communityTransitionMeta !== null,
      expected: 'communityTransitionMeta not null',
      actual: w.lastResult?.communityTransitionMeta !== null ? 'populated' : 'null',
    }),
  ),

  runScenario(15, 'forceGrowattState emits a growatt event',
    () => forceGrowattState(createInitialWorld(), 'OFF'),
    (w) => {
      const hasGrowattEvent = w.eventLog.some(e => e.kind === 'growatt');
      return { pass: hasGrowattEvent, expected: 'growatt event in log', actual: hasGrowattEvent ? 'found' : 'missing' };
    },
  ),
];
