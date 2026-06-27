/**
 * TMMS V2 Simulation Layer
 * ════════════════════════════════════════════════════════════════════════════
 * Debug/development tool. Provides SimWorld state management, scenario
 * definitions, and helpers for TMMSDebugSimulator.
 *
 * Architecture:
 *   tmmsSimulation.ts  → wraps tmmsEngine.ts (applyOffsetToPrediction)
 *   TMMSDebugSimulator → consumes this layer (UI only, no business logic)
 *
 * NO Supabase, NO AsyncStorage, NO side effects.
 * ════════════════════════════════════════════════════════════════════════════
 */

import {
  applyOffsetToPrediction,
  fmtYemenTime,
  durationLabelFromMin,
  getZoneFromIso,
  type Prediction,
  type ResyncPoint,
  type TransitionMode,
  type UserPrediction,
  type DecisionStep,
} from './tmmsEngine';

// ── Re-exports used by TMMSDebugSimulator ────────────────────────────────────
export { fmtYemenTime, durationLabelFromMin, getZoneFromIso };
export type { UserPrediction, ResyncPoint, TransitionMode };

// ── CommunitySyncMeta (mirror of production type) ───────────────────────────
export interface CommunitySyncMeta {
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
  reporterName: string | null;
  reporterReliability: number | null;
}

// ── ShiftedScheduleSlot ──────────────────────────────────────────────────────
export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
  isResynced?: boolean;
}

// ── ScheduleEntryTemplate ────────────────────────────────────────────────────
export interface ScheduleEntryTemplate {
  id: string;
  state: 'ON' | 'OFF';
  durationMin: number;
}

// ── SimEvent ─────────────────────────────────────────────────────────────────
export interface SimEvent {
  id: number;
  kind: 'info' | 'report' | 'confirm' | 'growatt' | 'offset' | 'zone' | 'error' | 'time';
  action: string;
  result?: string;
  simTimeIso: string;
}

// ── SimWorld ─────────────────────────────────────────────────────────────────
export interface SimWorld {
  simulatedNowMs: number;
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  offsetMinutes: number;
  frozenCommunityOffsetMinutes: number | null;
  transitionMode: TransitionMode;
  scheduleTemplate: ScheduleEntryTemplate[];
  scheduleAnchorIso: string;
  resyncPoint: ResyncPoint | null;
  lastResult: UserPrediction | null;
  lastDecisionTrace: DecisionStep[];
  eventLog: SimEvent[];
}

// ── ScenarioResult ────────────────────────────────────────────────────────────
export interface ScenarioResult {
  pass: boolean;
  expected: string;
  actual: string;
  world: SimWorld;
}

// ── Default schedule template ─────────────────────────────────────────────────
const DEFAULT_TEMPLATE: ScheduleEntryTemplate[] = [
  { id: 'a', state: 'ON',  durationMin: 120 },
  { id: 'b', state: 'OFF', durationMin: 360 },
  { id: 'c', state: 'ON',  durationMin: 120 },
  { id: 'd', state: 'OFF', durationMin: 360 },
];

let simEventCounter = 0;
function makeEvent(
  kind: SimEvent['kind'],
  action: string,
  simTimeIso: string,
  result?: string,
): SimEvent {
  simEventCounter += 1;
  return { id: simEventCounter, kind, action, result, simTimeIso };
}

// ── Build Prediction from SimWorld schedule ───────────────────────────────────
export function worldToPrediction(world: SimWorld): Prediction {
  const nowMs = world.simulatedNowMs;
  const anchorMs = new Date(world.scheduleAnchorIso).getTime();

  // Build full 48h slot list from repeating template
  const slots: Array<{
    state: 'ON' | 'OFF';
    startIso: string;
    endIso: string;
    startFormatted: string;
    endFormatted: string;
    durationLabel: string;
    zone: string;
    isEstimated: boolean;
  }> = [];

  const totalCycleMin = world.scheduleTemplate.reduce((s, t) => s + t.durationMin, 0);
  if (totalCycleMin <= 0) {
    // Fallback: empty prediction
    return buildEmptyPrediction(world);
  }

  const horizonMs = nowMs + 48 * 60 * 60 * 1000;
  let curMs = anchorMs;

  // Find starting offset within cycle relative to NOW
  // Go back enough cycles to cover 24h before now
  const startMs = anchorMs + Math.floor((nowMs - anchorMs - 24 * 60 * 60 * 1000) / (totalCycleMin * 60_000)) * totalCycleMin * 60_000;
  curMs = startMs;

  let templateIdx = 0;
  let templateMsOffset = 0;

  // figure out which template entry and offset within it corresponds to startMs
  // by replaying from anchorMs
  const msFromAnchor = startMs - anchorMs;
  const cycleMs = totalCycleMin * 60_000;
  const fullCycles = Math.floor(Math.max(0, msFromAnchor) / cycleMs);
  let remaining = msFromAnchor - fullCycles * cycleMs;
  if (remaining < 0) remaining += cycleMs;

  for (let i = 0; i < world.scheduleTemplate.length; i++) {
    const tms = world.scheduleTemplate[i].durationMin * 60_000;
    if (remaining < tms) {
      templateIdx = i;
      templateMsOffset = remaining;
      break;
    }
    remaining -= tms;
    if (i === world.scheduleTemplate.length - 1) {
      templateIdx = 0;
      templateMsOffset = 0;
    }
  }

  curMs = startMs;
  let tIdx = templateIdx;
  let tOffset = templateMsOffset;

  while (curMs < horizonMs && slots.length < 60) {
    const entry = world.scheduleTemplate[tIdx];
    const entryMs = entry.durationMin * 60_000;
    const slotDurMs = entryMs - tOffset;
    const slotStartMs = curMs;
    const slotEndMs = curMs + slotDurMs;

    const slotStartIso = new Date(slotStartMs).toISOString();
    const slotEndIso = new Date(slotEndMs).toISOString();

    slots.push({
      state: entry.state,
      startIso: slotStartIso,
      endIso: slotEndIso,
      startFormatted: fmtYemenTime(slotStartIso),
      endFormatted: fmtYemenTime(slotEndIso),
      durationLabel: durationLabelFromMin(Math.round(slotDurMs / 60_000)),
      zone: getZoneFromIso(slotStartIso),
      isEstimated: false,
    });

    curMs = slotEndMs;
    tOffset = 0;
    tIdx = (tIdx + 1) % world.scheduleTemplate.length;
  }

  // Determine current Growatt state from world (not schedule)
  const currentState = world.growattCurrentState;

  // Find current slot for context
  const currentSlot = slots.find(s => {
    const st = new Date(s.startIso).getTime();
    const en = new Date(s.endIso).getTime();
    return nowMs >= st && nowMs < en;
  });

  const currentStateDurationMs = currentSlot
    ? new Date(currentSlot.endIso).getTime() - new Date(currentSlot.startIso).getTime()
    : 120 * 60_000;
  const currentStateDurationMin = Math.round(currentStateDurationMs / 60_000);

  // Find expected ranges
  const onSlots = slots.filter(s => s.state === 'ON' && s.endIso);
  const offSlots = slots.filter(s => s.state === 'OFF' && s.endIso);
  const avgOnMin = onSlots.length > 0
    ? Math.round(onSlots.reduce((s, sl) => s + (new Date(sl.endIso).getTime() - new Date(sl.startIso).getTime()) / 60_000, 0) / onSlots.length)
    : 120;
  const avgOffMin = offSlots.length > 0
    ? Math.round(offSlots.reduce((s, sl) => s + (new Date(sl.endIso).getTime() - new Date(sl.startIso).getTime()) / 60_000, 0) / offSlots.length)
    : 360;

  return {
    currentState,
    currentStateDurationMin,
    currentStateDurationLabel: durationLabelFromMin(currentStateDurationMin),
    lastTransitionAt: world.growattLastTransitionAt,
    inverterOffline: false,
    nextTransition: null,
    expectedOffRange: { minMin: Math.round(avgOffMin * 0.8), maxMin: Math.round(avgOffMin * 1.2), label: durationLabelFromMin(avgOffMin) },
    expectedOnRange:  { minMin: Math.round(avgOnMin  * 0.8), maxMin: Math.round(avgOnMin  * 1.2), label: durationLabelFromMin(avgOnMin)  },
    daySchedule: slots as any,
    confidence: 82,
    confidenceLabel: 'عالٍ',
    isUnstable: false,
    stabilityScore: 78,
    stabilityLabel: 'مستقر',
    dayPattern:   null,
    nightPattern: null,
    allPattern:   null,
    cyclesAnalyzed: 14,
    dayCyclesAnalyzed: 7,
    nightCyclesAnalyzed: 7,
    currentPeriod: 'day',
    reasoning: ['Simulated schedule'],
    learningMode: 'learned',
    dataWindowHours: 48,
    computedAt: new Date(nowMs).toISOString(),
    apppe: { crisisActive: false, crisisReason: null },
  } as any;
}

function buildEmptyPrediction(world: SimWorld): Prediction {
  return {
    currentState: world.growattCurrentState,
    currentStateDurationMin: 0,
    currentStateDurationLabel: '',
    lastTransitionAt: world.growattLastTransitionAt,
    inverterOffline: false,
    nextTransition: null,
    expectedOffRange: null,
    expectedOnRange: null,
    daySchedule: [],
    confidence: 0,
    confidenceLabel: 'غير معروف',
    isUnstable: true,
    stabilityScore: 0,
    stabilityLabel: 'غير مستقر',
    dayPattern: null,
    nightPattern: null,
    allPattern: null,
    cyclesAnalyzed: 0,
    dayCyclesAnalyzed: 0,
    nightCyclesAnalyzed: 0,
    currentPeriod: 'day',
    reasoning: [],
    learningMode: 'estimated',
    dataWindowHours: 0,
    computedAt: new Date(world.simulatedNowMs).toISOString(),
  } as any;
}

// ── runEngine ─────────────────────────────────────────────────────────────────
export function runEngine(world: SimWorld): UserPrediction {
  const prediction = worldToPrediction(world);
  return applyOffsetToPrediction(
    prediction,
    world.offsetMinutes,
    world.resyncPoint ?? null,
    null,
    world.transitionMode,
    null,
    world.frozenCommunityOffsetMinutes ?? null,
    undefined,
    world.simulatedNowMs,
    undefined,
  );
}

// ── createInitialWorld ────────────────────────────────────────────────────────
export function createInitialWorld(): SimWorld {
  const nowMs = Date.now();
  // Anchor at midnight Yemen time today
  const d = new Date(nowMs);
  const yemenOffset = 3 * 60 * 60 * 1000;
  const yemenNow = new Date(d.getTime() + yemenOffset);
  const anchorMs = Date.UTC(
    yemenNow.getUTCFullYear(),
    yemenNow.getUTCMonth(),
    yemenNow.getUTCDate(),
    0, 0, 0, 0,
  ) - yemenOffset;

  // Start the simulated clock at midnight Yemen time today
  const simNowMs = anchorMs;

  const growattLastTransitionAt = new Date(simNowMs - 30 * 60_000).toISOString();

  const world: SimWorld = {
    simulatedNowMs: simNowMs,
    growattCurrentState: 'ON',
    growattLastTransitionAt,
    offsetMinutes: 0,
    frozenCommunityOffsetMinutes: null,
    transitionMode: 'AUTO',
    scheduleTemplate: DEFAULT_TEMPLATE,
    scheduleAnchorIso: new Date(anchorMs).toISOString(),
    resyncPoint: null,
    lastResult: null,
    lastDecisionTrace: [],
    eventLog: [],
  };

  const result = runEngine(world);
  return {
    ...world,
    lastResult: result,
    lastDecisionTrace: result.communityTransitionMeta?.decisionTrace ?? [],
    eventLog: [makeEvent('info', 'World initialized', new Date(simNowMs).toISOString(), `State: ON, Offset: 0`)],
  };
}

// ── advanceTime ───────────────────────────────────────────────────────────────
export function advanceTime(world: SimWorld, minutes: number): SimWorld {
  const newNowMs = world.simulatedNowMs + minutes * 60_000;
  return recompute({
    ...world,
    simulatedNowMs: newNowMs,
    eventLog: [
      ...world.eventLog,
      makeEvent('time', `+${minutes}m`, new Date(newNowMs).toISOString(), `Clock: ${new Date(newNowMs).toLocaleTimeString()}`),
    ],
  });
}

// ── setSimulatedNow ───────────────────────────────────────────────────────────
export function setSimulatedNow(world: SimWorld, ms: number): SimWorld {
  return recompute({
    ...world,
    simulatedNowMs: ms,
    eventLog: [
      ...world.eventLog,
      makeEvent('time', 'Clock set', new Date(ms).toISOString()),
    ],
  });
}

// ── forceGrowattState ─────────────────────────────────────────────────────────
export function forceGrowattState(world: SimWorld, state: 'ON' | 'OFF'): SimWorld {
  if (world.growattCurrentState === state) return world;
  const transAt = new Date(world.simulatedNowMs).toISOString();
  return recompute({
    ...world,
    growattCurrentState: state,
    growattLastTransitionAt: transAt,
    eventLog: [
      ...world.eventLog,
      makeEvent('growatt', `Growatt → ${state}`, transAt, `Forced transition at ${fmtYemenTime(transAt)}`),
    ],
  });
}

// ── resetWorld ────────────────────────────────────────────────────────────────
export function resetWorld(): SimWorld {
  simEventCounter = 0;
  return createInitialWorld();
}

// ── setTransitionMode ─────────────────────────────────────────────────────────
export function setTransitionMode(world: SimWorld, mode: TransitionMode): SimWorld {
  return recompute({
    ...world,
    transitionMode: mode,
    eventLog: [
      ...world.eventLog,
      makeEvent('info', `Mode → ${mode}`, new Date(world.simulatedNowMs).toISOString()),
    ],
  });
}

// ── setSchedule ───────────────────────────────────────────────────────────────
export function setSchedule(world: SimWorld, template: ScheduleEntryTemplate[]): SimWorld {
  if (!template || template.length === 0) return world;
  return recompute({
    ...world,
    scheduleTemplate: template,
    resyncPoint: null,
    frozenCommunityOffsetMinutes: null,
    eventLog: [
      ...world.eventLog,
      makeEvent('info', 'Schedule updated', new Date(world.simulatedNowMs).toISOString(), `${template.length} entries`),
    ],
  });
}

// ── submitReportOrConfirm ─────────────────────────────────────────────────────
export function submitReportOrConfirm(
  world: SimWorld,
  state: 'ON' | 'OFF',
  kind: 'report' | 'confirm',
): SimWorld {
  const nowIso = new Date(world.simulatedNowMs).toISOString();
  const reporterName = kind === 'report' ? 'SimUser' : 'SimConfirmer';

  const newResync: ResyncPoint = {
    syncedState: state,
    syncedAtIso: nowIso,
    appliedAtIso: nowIso,
    reporterName,
    reporterReliability: kind === 'confirm' ? 80 : 65,
  };

  // On a fresh report (not a confirm of existing), reset frozen offset
  const frozenOffset = kind === 'report' ? null : world.frozenCommunityOffsetMinutes;

  const updated = recompute({
    ...world,
    resyncPoint: newResync,
    frozenCommunityOffsetMinutes: frozenOffset,
    eventLog: [
      ...world.eventLog,
      makeEvent(kind, `${kind === 'report' ? 'Report' : 'Confirm'} → ${state}`, nowIso, `via ${reporterName}`),
    ],
  });

  // After first compute, freeze the derived offset
  const derivedOffset = updated.lastResult?.communityTransitionMeta?.offsetMinutes ?? null;
  if (derivedOffset !== null && frozenOffset === null) {
    return recompute({
      ...updated,
      frozenCommunityOffsetMinutes: derivedOffset,
      eventLog: [
        ...updated.eventLog,
        makeEvent('offset', `Offset frozen at ${derivedOffset >= 0 ? '+' : ''}${derivedOffset}m`, nowIso),
      ],
    });
  }

  return updated;
}

// ── recompute ─────────────────────────────────────────────────────────────────
function recompute(world: SimWorld): SimWorld {
  try {
    const result = runEngine(world);
    return {
      ...world,
      lastResult: result,
      lastDecisionTrace: result.communityTransitionMeta?.decisionTrace ?? [],
    };
  } catch (e: any) {
    const errIso = new Date(world.simulatedNowMs).toISOString();
    return {
      ...world,
      lastResult: null,
      lastDecisionTrace: [],
      eventLog: [
        ...world.eventLog,
        makeEvent('error', 'Engine error', errIso, String(e?.message ?? e)),
      ],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIOS
// ─────────────────────────────────────────────────────────────────────────────

interface Scenario {
  id: number;
  name: string;
  run: () => ScenarioResult;
}

function assertScenario(
  world: SimWorld,
  expected: string,
  check: (w: SimWorld) => boolean,
): ScenarioResult {
  const pass = check(world);
  const actual = world.lastResult?.atc?.mode ?? 'NO_RESULT';
  return { pass, expected, actual, world };
}

function buildScenarioWorld(
  template: ScheduleEntryTemplate[],
  offsetMin: number,
  transitionMode: TransitionMode = 'AUTO',
  advanceMin: number = 0,
  growattState?: 'ON' | 'OFF',
  reportState?: 'ON' | 'OFF',
): SimWorld {
  let w = createInitialWorld();
  w = setSchedule(w, template);
  w = setTransitionMode(w, transitionMode);
  if (growattState) w = forceGrowattState(w, growattState);
  w = recompute({ ...w, offsetMinutes: offsetMin });
  if (advanceMin > 0) w = advanceTime(w, advanceMin);
  if (reportState !== undefined) w = submitReportOrConfirm(w, reportState, 'report');
  return w;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 1,
    name: 'Normal neutral offset — NORMAL mode',
    run: () => {
      const w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 30);
      return assertScenario(w, 'NORMAL', ww => ww.lastResult?.atc?.mode === 'NORMAL');
    },
  },
  {
    id: 2,
    name: 'Positive offset — Growatt flipped ahead → POSITIVE_OFFSET_PENDING',
    run: () => {
      // Growatt transitions to OFF, user has +60 offset so should hold ON
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 60, 'AUTO', 0, 'OFF');
      return assertScenario(w, 'POSITIVE_OFFSET_PENDING',
        ww => ww.lastResult?.atc?.mode === 'POSITIVE_OFFSET_PENDING'
      );
    },
  },
  {
    id: 3,
    name: 'Negative offset — slot ends → PREDICTION_RANGE',
    run: () => {
      // Use small template so we can quickly get near slot end
      const tpl: ScheduleEntryTemplate[] = [
        { id: 'a', state: 'ON',  durationMin: 60 },
        { id: 'b', state: 'OFF', durationMin: 60 },
      ];
      // Advance 50m into first slot (ON 60m), offset -15m makes slot "end" at 45m
      let w = buildScenarioWorld(tpl, -15, 'AUTO', 55);
      const mode = w.lastResult?.atc?.mode;
      const pass = mode === 'PREDICTION_RANGE' || mode === 'UNCERTAIN_ZONE';
      return { pass, expected: 'PREDICTION_RANGE or UNCERTAIN_ZONE', actual: mode ?? 'NO_RESULT', world: w };
    },
  },
  {
    id: 4,
    name: 'Community report — COMMUNITY_SYNCED mode',
    run: () => {
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 30, undefined, 'OFF');
      return assertScenario(w, 'COMMUNITY_SYNCED', ww => ww.lastResult?.atc?.mode === 'COMMUNITY_SYNCED');
    },
  },
  {
    id: 5,
    name: 'MANUAL mode — isHoldingState false',
    run: () => {
      const w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'MANUAL', 30);
      return assertScenario(w, 'NORMAL (MANUAL)', ww => ww.lastResult !== null);
    },
  },
  {
    id: 6,
    name: 'Generated cycle duration is positive',
    run: () => {
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 30, undefined, 'OFF');
      const meta = w.lastResult?.communityTransitionMeta;
      const durMs = meta
        ? new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()
        : -1;
      const pass = durMs > 0;
      return { pass, expected: 'Generated cycle duration > 0', actual: `${Math.round(durMs / 60_000)}m`, world: w };
    },
  },
  {
    id: 7,
    name: 'Offset sign is POSITIVE when generated start is after reference',
    run: () => {
      // Report ON when Growatt is already ON (same state) → reference = growattLastTransitionAt
      // syncedAtIso (now) > growattLastTransitionAt → POSITIVE
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 60, 'ON', 'ON');
      const meta = w.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE';
      return { pass, expected: 'POSITIVE', actual: meta?.offsetSign ?? '—', world: w };
    },
  },
  {
    id: 8,
    name: 'Schedule has future slots after now',
    run: () => {
      const w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 30);
      const nowMs = w.simulatedNowMs;
      const futureSlots = (w.lastResult?.daySchedule ?? []).filter(
        (s: any) => new Date(s.startIso).getTime() > nowMs,
      );
      const pass = futureSlots.length > 0;
      return { pass, expected: '>0 future slots', actual: `${futureSlots.length}`, world: w };
    },
  },
  {
    id: 9,
    name: 'Resync event appears in schedule (isResynced flag)',
    run: () => {
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 30, undefined, 'OFF');
      const resynced = (w.lastResult?.daySchedule ?? []).some((s: any) => s.isResynced);
      return { pass: resynced, expected: 'isResynced slot present', actual: String(resynced), world: w };
    },
  },
  {
    id: 10,
    name: 'Transition decision trace is non-empty after report',
    run: () => {
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 30, undefined, 'OFF');
      const pass = w.lastDecisionTrace.length > 0;
      return { pass, expected: 'trace.length > 0', actual: `${w.lastDecisionTrace.length} steps`, world: w };
    },
  },
  {
    id: 11,
    name: 'advanceTime 6h — simulatedNowMs increases by 6h',
    run: () => {
      let w = createInitialWorld();
      const before = w.simulatedNowMs;
      w = advanceTime(w, 360);
      const diff = w.simulatedNowMs - before;
      const pass = diff === 360 * 60_000;
      return { pass, expected: '360m = 21600000ms', actual: `${diff}ms`, world: w };
    },
  },
  {
    id: 12,
    name: 'forceGrowattState — growattCurrentState changes',
    run: () => {
      let w = createInitialWorld();
      w = forceGrowattState(w, 'OFF');
      const pass = w.growattCurrentState === 'OFF';
      return { pass, expected: 'growattCurrentState = OFF', actual: w.growattCurrentState, world: w };
    },
  },
  {
    id: 13,
    name: 'setSchedule resets resync and frozen offset',
    run: () => {
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 30, undefined, 'OFF');
      w = setSchedule(w, DEFAULT_TEMPLATE);
      const pass = w.resyncPoint === null && w.frozenCommunityOffsetMinutes === null;
      return { pass, expected: 'resyncPoint=null, frozen=null', actual: `resync=${w.resyncPoint}, frozen=${w.frozenCommunityOffsetMinutes}`, world: w };
    },
  },
  {
    id: 14,
    name: 'Community confirmation elevates existing report',
    run: () => {
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 0, 'AUTO', 30, undefined, 'OFF');
      w = advanceTime(w, 5);
      w = submitReportOrConfirm(w, 'OFF', 'confirm');
      const pass = w.lastResult?.atc?.mode === 'COMMUNITY_SYNCED';
      return { pass, expected: 'COMMUNITY_SYNCED', actual: w.lastResult?.atc?.mode ?? '—', world: w };
    },
  },
  {
    id: 15,
    name: 'resetWorld — returns clean world',
    run: () => {
      let w = buildScenarioWorld(DEFAULT_TEMPLATE, 30, 'MANUAL', 120, 'OFF', 'ON');
      w = resetWorld();
      const pass =
        w.offsetMinutes === 0 &&
        w.resyncPoint === null &&
        w.transitionMode === 'AUTO' &&
        w.frozenCommunityOffsetMinutes === null;
      return {
        pass,
        expected: 'offset=0, resync=null, mode=AUTO, frozen=null',
        actual: `offset=${w.offsetMinutes}, resync=${w.resyncPoint}, mode=${w.transitionMode}, frozen=${w.frozenCommunityOffsetMinutes}`,
        world: w,
      };
    },
  },
];
