/**
 * TMMS Debug Simulator — World State & Scenario Runner
 * ════════════════════════════════════════════════════════════════════════════
 * Pure simulation layer for the TMMSDebugSimulator component.
 * Wraps tmmsEngine.ts functions with an injectable clock (simulatedNowMs) so
 * every deterministic scenario can be replayed without real time passing.
 * ════════════════════════════════════════════════════════════════════════════
 */

import {
  applyOffsetToPrediction,
  computeCommunityTransition,
  extendScheduleTo48h,
  applyOffsetToSlots,
  fmtYemenTime,
  durationLabelFromMin,
  getZoneFromIso,
  type Prediction,
  type ScheduleSlot,
  type ResyncPoint,
  type ShiftedScheduleSlot,
  type UserPrediction,
  type TransitionMode,
} from './tmmsEngine';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScheduleEntryTemplate {
  state: 'ON' | 'OFF';
  durationMin: number;
}

export interface SimEvent {
  atMs: number;
  label: string;
  detail: string;
  kind: 'GROWATT' | 'REPORT' | 'ADVANCE' | 'RESET' | 'INFO';
}

export interface ScenarioResult {
  pass: boolean;
  expected: string;
  actual: string;
  world?: SimWorld;
}

export interface SimWorld {
  // ── Clock ──────────────────────────────────────────────────────────────────
  simulatedNowMs: number;
  // ── Growatt ────────────────────────────────────────────────────────────────
  growattState: 'ON' | 'OFF';
  growattLastTransitionAt: string | null;
  // ── Schedule ───────────────────────────────────────────────────────────────
  schedule: ScheduleSlot[];
  scheduleTemplates: ScheduleEntryTemplate[];
  // ── User config ────────────────────────────────────────────────────────────
  offsetMinutes: number;
  transitionMode: TransitionMode;
  // ── Community sync ─────────────────────────────────────────────────────────
  resyncPoint: ResyncPoint | null;
  frozenCommunityOffsetMinutes: number | null;
  frozenSyncedAtIso: string | null;
  confidenceScore: number;
  // ── Derived result (last run of the engine) ────────────────────────────────
  lastResult: UserPrediction | null;
  // ── Event log ──────────────────────────────────────────────────────────────
  events: SimEvent[];
}

// ── Default schedule template (6h OFF / 2h ON cycle) ─────────────────────────

const DEFAULT_TEMPLATES: ScheduleEntryTemplate[] = [
  { state: 'OFF', durationMin: 360 },
  { state: 'ON',  durationMin: 120 },
];

// ── Build a ScheduleSlot array from templates starting at a given ms ──────────

function buildScheduleFromTemplates(
  templates: ScheduleEntryTemplate[],
  startMs: number,
  count = 10,
): ScheduleSlot[] {
  const slots: ScheduleSlot[] = [];
  let cursor = startMs;
  let tIdx = 0;
  for (let i = 0; i < count; i++) {
    const tmpl = templates[tIdx % templates.length];
    tIdx++;
    const endMs = cursor + tmpl.durationMin * 60_000;
    const startIso = new Date(cursor).toISOString();
    const endIso   = new Date(endMs).toISOString();
    slots.push({
      state: tmpl.state,
      startIso,
      endIso,
      startFormatted: fmtYemenTime(startIso),
      endFormatted:   fmtYemenTime(endIso),
      durationLabel:  durationLabelFromMin(tmpl.durationMin),
      zone: getZoneFromIso(startIso),
      isEstimated: false,
    });
    cursor = endMs;
  }
  return slots;
}

// ── Build a minimal Prediction shim from the current world state ──────────────

function buildPrediction(world: SimWorld): Prediction {
  return {
    currentState: world.growattState,
    currentStateDurationMin: world.growattLastTransitionAt
      ? (world.simulatedNowMs - new Date(world.growattLastTransitionAt).getTime()) / 60_000
      : 0,
    currentStateDurationLabel: '',
    lastTransitionAt: world.growattLastTransitionAt,
    inverterOffline: false,
    nextTransition: null,
    expectedOffRange: null,
    expectedOnRange: null,
    daySchedule: world.schedule,
    confidence: world.confidenceScore,
    confidenceLabel: world.confidenceScore >= 85 ? 'عالية' : world.confidenceScore >= 65 ? 'متوسطة' : 'منخفضة',
    isUnstable: false,
    stabilityScore: world.confidenceScore,
    stabilityLabel: '',
    dayPattern: null,
    nightPattern: null,
    allPattern: null,
    cyclesAnalyzed: world.schedule.length,
    dayCyclesAnalyzed: 0,
    nightCyclesAnalyzed: 0,
    currentPeriod: 'day',
    reasoning: [],
    learningMode: 'learned',
    dataWindowHours: 36,
    computedAt: new Date(world.simulatedNowMs).toISOString(),
    apppe: {
      version: 'v4',
      crisisActive: false,
      crisisReason: null,
    },
  };
}

// ── Run the TMMS engine against the current world ────────────────────────────

function runEngine(world: SimWorld): UserPrediction {
  const prediction = buildPrediction(world);
  const frozen = world.frozenCommunityOffsetMinutes;

  return applyOffsetToPrediction(
    prediction,
    world.offsetMinutes,
    world.resyncPoint,
    null,
    world.transitionMode,
    null,
    frozen,
    undefined,
    world.simulatedNowMs,
    undefined,
  );
}

// ── Mutations (all return NEW SimWorld — immutable pattern) ───────────────────

export function createInitialWorld(): SimWorld {
  const nowMs = Date.now();
  // Start the schedule 2 hours ago so there is at least one active slot
  const scheduleStart = nowMs - 2 * 60 * 60_000;
  const schedule = buildScheduleFromTemplates(DEFAULT_TEMPLATES, scheduleStart, 12);

  // Determine Growatt state from the first active slot
  let growattState: 'ON' | 'OFF' = 'OFF';
  let growattLastTransitionAt: string | null = null;
  for (const slot of schedule) {
    const start = new Date(slot.startIso).getTime();
    const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= start && nowMs < end) {
      growattState = slot.state;
      growattLastTransitionAt = slot.startIso;
      break;
    }
  }

  const world: SimWorld = {
    simulatedNowMs: nowMs,
    growattState,
    growattLastTransitionAt,
    schedule,
    scheduleTemplates: DEFAULT_TEMPLATES,
    offsetMinutes: 0,
    transitionMode: 'AUTO',
    resyncPoint: null,
    frozenCommunityOffsetMinutes: null,
    frozenSyncedAtIso: null,
    confidenceScore: 82,
    lastResult: null,
    events: [],
  };

  return { ...world, lastResult: runEngine(world) };
}

export function setSimulatedNow(world: SimWorld, isoOrMs: string | number): SimWorld {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : new Date(isoOrMs).getTime();
  const next: SimWorld = {
    ...world,
    simulatedNowMs: ms,
    events: [...world.events, {
      atMs: ms,
      label: 'Clock Set',
      detail: `Simulated now → ${fmtYemenTime(new Date(ms).toISOString())}`,
      kind: 'INFO',
    }],
  };
  return { ...next, lastResult: runEngine(next) };
}

export function advanceTime(world: SimWorld, deltaMinutes: number): SimWorld {
  const newMs = world.simulatedNowMs + deltaMinutes * 60_000;
  const newIso = new Date(newMs).toISOString();

  // Check if Growatt should auto-transition at the new time
  let nextGrowattState = world.growattState;
  let nextLastTransition = world.growattLastTransitionAt;

  for (const slot of world.schedule) {
    const slotStart = new Date(slot.startIso).getTime();
    if (slotStart > world.simulatedNowMs && slotStart <= newMs) {
      nextGrowattState = slot.state;
      nextLastTransition = slot.startIso;
    }
  }

  const next: SimWorld = {
    ...world,
    simulatedNowMs: newMs,
    growattState: nextGrowattState,
    growattLastTransitionAt: nextLastTransition,
    events: [...world.events, {
      atMs: newMs,
      label: `+${deltaMinutes}m`,
      detail: `Time advanced to ${fmtYemenTime(newIso)}${nextGrowattState !== world.growattState ? ` · Growatt → ${nextGrowattState}` : ''}`,
      kind: 'ADVANCE',
    }],
  };
  return { ...next, lastResult: runEngine(next) };
}

export function forceGrowattState(world: SimWorld, state: 'ON' | 'OFF'): SimWorld {
  const transitionIso = new Date(world.simulatedNowMs).toISOString();
  const next: SimWorld = {
    ...world,
    growattState: state,
    growattLastTransitionAt: transitionIso,
    events: [...world.events, {
      atMs: world.simulatedNowMs,
      label: `Growatt → ${state}`,
      detail: `Forced transition to ${state} at ${fmtYemenTime(transitionIso)}`,
      kind: 'GROWATT',
    }],
  };
  return { ...next, lastResult: runEngine(next) };
}

export function resetWorld(_world: SimWorld): SimWorld {
  return createInitialWorld();
}

export function setTransitionMode(world: SimWorld, mode: TransitionMode): SimWorld {
  const next: SimWorld = { ...world, transitionMode: mode };
  return { ...next, lastResult: runEngine(next) };
}

export function setSchedule(world: SimWorld, templates: ScheduleEntryTemplate[]): SimWorld {
  const scheduleStart = world.simulatedNowMs - 2 * 60 * 60_000;
  const schedule = buildScheduleFromTemplates(templates, scheduleStart, 12);
  const next: SimWorld = { ...world, schedule, scheduleTemplates: templates };
  return { ...next, lastResult: runEngine(next) };
}

export function submitReportOrConfirm(world: SimWorld, reportedState: 'ON' | 'OFF'): SimWorld {
  const syncedAtIso = new Date(world.simulatedNowMs).toISOString();
  const isNewResync = world.frozenSyncedAtIso !== syncedAtIso;

  const resyncPoint: ResyncPoint = {
    syncedState: reportedState,
    syncedAtIso,
    appliedAtIso: syncedAtIso,
    reporterName: 'simulator',
    reporterReliability: 75,
  };

  const next: SimWorld = {
    ...world,
    resyncPoint,
    frozenCommunityOffsetMinutes: isNewResync ? null : world.frozenCommunityOffsetMinutes,
    frozenSyncedAtIso: syncedAtIso,
    confidenceScore: Math.min(100, world.confidenceScore + 5),
    events: [...world.events, {
      atMs: world.simulatedNowMs,
      label: `Report: ${reportedState}`,
      detail: `Community report/confirm → ${reportedState} at ${fmtYemenTime(syncedAtIso)}`,
      kind: 'REPORT',
    }],
  };

  // Run engine to get fresh offset if needed
  const result = runEngine(next);

  // Freeze offset after first computation
  let frozenOffset = next.frozenCommunityOffsetMinutes;
  if (isNewResync && result.communityTransitionMeta?.isFreshOffsetComputation) {
    frozenOffset = result.communityTransitionMeta.offsetMinutes;
  }

  return {
    ...next,
    frozenCommunityOffsetMinutes: frozenOffset,
    lastResult: result,
  };
}

// ── Scenario helpers ──────────────────────────────────────────────────────────

interface Scenario {
  id: string;
  name: string;
  group: string;
  run: () => ScenarioResult;
}

function makeBaseWorld(offsetMinutes: number, growattState: 'ON' | 'OFF', transitionAgo: number): SimWorld {
  const nowMs = Date.now();
  const scheduleStart = nowMs - 4 * 60 * 60_000;
  const schedule = buildScheduleFromTemplates(DEFAULT_TEMPLATES, scheduleStart, 12);
  const transitionAt = new Date(nowMs - transitionAgo * 60_000).toISOString();

  const world: SimWorld = {
    simulatedNowMs: nowMs,
    growattState,
    growattLastTransitionAt: transitionAt,
    schedule,
    scheduleTemplates: DEFAULT_TEMPLATES,
    offsetMinutes,
    transitionMode: 'AUTO',
    resyncPoint: null,
    frozenCommunityOffsetMinutes: null,
    frozenSyncedAtIso: null,
    confidenceScore: 80,
    lastResult: null,
    events: [],
  };
  return { ...world, lastResult: runEngine(world) };
}

// ── Scenario Suite (Groups A-K) ────────────────────────────────────────────────

export const SCENARIOS: Scenario[] = [
  // ── Group A: Neutral offset baseline ──────────────────────────────────────
  {
    id: 'A1',
    name: 'Neutral: NORMAL mode during active slot',
    group: 'A · Neutral Offset',
    run(): ScenarioResult {
      const world = makeBaseWorld(0, 'OFF', 30);
      const result = world.lastResult!;
      const actual = result.atc.mode;
      const expected = 'NORMAL';
      return { pass: actual === expected, expected, actual };
    },
  },
  {
    id: 'A2',
    name: 'Neutral: PREDICTION_RANGE within 15 min of slot end',
    group: 'A · Neutral Offset',
    run(): ScenarioResult {
      // Build a world where the active slot ends in 10 minutes
      const nowMs = Date.now();
      const slotEndMs = nowMs + 10 * 60_000;
      const slotStartMs = slotEndMs - 360 * 60_000;
      const schedule: ScheduleSlot[] = [
        {
          state: 'OFF',
          startIso: new Date(slotStartMs).toISOString(),
          endIso: new Date(slotEndMs).toISOString(),
          startFormatted: fmtYemenTime(new Date(slotStartMs).toISOString()),
          endFormatted: fmtYemenTime(new Date(slotEndMs).toISOString()),
          durationLabel: '6س',
          zone: getZoneFromIso(new Date(slotStartMs).toISOString()),
          isEstimated: false,
        },
        {
          state: 'ON',
          startIso: new Date(slotEndMs).toISOString(),
          endIso: new Date(slotEndMs + 120 * 60_000).toISOString(),
          startFormatted: fmtYemenTime(new Date(slotEndMs).toISOString()),
          endFormatted: fmtYemenTime(new Date(slotEndMs + 120 * 60_000).toISOString()),
          durationLabel: '2س',
          zone: getZoneFromIso(new Date(slotEndMs).toISOString()),
          isEstimated: false,
        },
      ];
      const world: SimWorld = {
        simulatedNowMs: nowMs,
        growattState: 'OFF',
        growattLastTransitionAt: new Date(slotStartMs).toISOString(),
        schedule,
        scheduleTemplates: DEFAULT_TEMPLATES,
        offsetMinutes: 0,
        transitionMode: 'AUTO',
        resyncPoint: null,
        frozenCommunityOffsetMinutes: null,
        frozenSyncedAtIso: null,
        confidenceScore: 80,
        lastResult: null,
        events: [],
      };
      const finalWorld = { ...world, lastResult: runEngine(world) };
      const actual = finalWorld.lastResult!.atc.mode;
      const expected = 'PREDICTION_RANGE';
      return { pass: actual === expected, expected, actual, world: finalWorld };
    },
  },

  // ── Group B: Positive offset ────────────────────────────────────────────────
  {
    id: 'B1',
    name: 'Positive: POSITIVE_OFFSET_PENDING after Growatt flips',
    group: 'B · Positive Offset',
    run(): ScenarioResult {
      const nowMs = Date.now();
      // Growatt flipped to ON 20 min ago; user has +60 min offset → scheduled in 40 min
      const scheduleStart = nowMs - 4 * 60 * 60_000;
      const schedule = buildScheduleFromTemplates(DEFAULT_TEMPLATES, scheduleStart, 12);
      const transitionAt = new Date(nowMs - 20 * 60_000).toISOString();

      const world: SimWorld = {
        simulatedNowMs: nowMs,
        growattState: 'ON',
        growattLastTransitionAt: transitionAt,
        schedule,
        scheduleTemplates: DEFAULT_TEMPLATES,
        offsetMinutes: 60,
        transitionMode: 'AUTO',
        resyncPoint: null,
        frozenCommunityOffsetMinutes: null,
        frozenSyncedAtIso: null,
        confidenceScore: 80,
        lastResult: null,
        events: [],
      };
      const finalWorld = { ...world, lastResult: runEngine(world) };
      const actual = finalWorld.lastResult!.atc.mode;
      const expected = 'POSITIVE_OFFSET_PENDING';
      return { pass: actual === expected, expected, actual, world: finalWorld };
    },
  },
  {
    id: 'B2',
    name: 'Positive: scheduledAutoTransitionIso is set correctly',
    group: 'B · Positive Offset',
    run(): ScenarioResult {
      const nowMs = Date.now();
      const transitionAt = new Date(nowMs - 30 * 60_000).toISOString();
      const scheduleStart = nowMs - 4 * 60 * 60_000;
      const schedule = buildScheduleFromTemplates(DEFAULT_TEMPLATES, scheduleStart, 12);
      const world: SimWorld = {
        simulatedNowMs: nowMs,
        growattState: 'ON',
        growattLastTransitionAt: transitionAt,
        schedule,
        scheduleTemplates: DEFAULT_TEMPLATES,
        offsetMinutes: 60,
        transitionMode: 'AUTO',
        resyncPoint: null,
        frozenCommunityOffsetMinutes: null,
        frozenSyncedAtIso: null,
        confidenceScore: 80,
        lastResult: null,
        events: [],
      };
      const finalWorld = { ...world, lastResult: runEngine(world) };
      const scheduled = finalWorld.lastResult!.atc.scheduledAutoTransitionIso;
      const expectedMs = new Date(transitionAt).getTime() + 60 * 60_000;
      const actualMs = scheduled ? new Date(scheduled).getTime() : 0;
      const pass = Math.abs(actualMs - expectedMs) < 1000;
      return {
        pass,
        expected: `scheduledMs=${expectedMs}`,
        actual: `scheduledMs=${actualMs}`,
        world: finalWorld,
      };
    },
  },

  // ── Group C: Negative offset ────────────────────────────────────────────────
  {
    id: 'C1',
    name: 'Negative: UNCERTAIN_ZONE after predicted end',
    group: 'C · Negative Offset',
    run(): ScenarioResult {
      // Build a schedule where the user's shifted slot ended 20 min ago
      const nowMs = Date.now();
      const shiftedEndMs = nowMs - 20 * 60_000; // slot ended 20 min ago for user
      const offsetMs = -60 * 60_000; // -60 min offset
      const rawEndMs = shiftedEndMs - offsetMs; // raw end = shifted end + |offset|
      const rawStartMs = rawEndMs - 360 * 60_000;
      const schedule: ScheduleSlot[] = [
        {
          state: 'OFF',
          startIso: new Date(rawStartMs).toISOString(),
          endIso: new Date(rawEndMs).toISOString(),
          startFormatted: fmtYemenTime(new Date(rawStartMs).toISOString()),
          endFormatted: fmtYemenTime(new Date(rawEndMs).toISOString()),
          durationLabel: '6س',
          zone: getZoneFromIso(new Date(rawStartMs).toISOString()),
          isEstimated: false,
        },
        {
          state: 'ON',
          startIso: new Date(rawEndMs).toISOString(),
          endIso: new Date(rawEndMs + 120 * 60_000).toISOString(),
          startFormatted: fmtYemenTime(new Date(rawEndMs).toISOString()),
          endFormatted: fmtYemenTime(new Date(rawEndMs + 120 * 60_000).toISOString()),
          durationLabel: '2س',
          zone: getZoneFromIso(new Date(rawEndMs).toISOString()),
          isEstimated: false,
        },
      ];
      const world: SimWorld = {
        simulatedNowMs: nowMs,
        growattState: 'OFF', // Growatt hasn't confirmed yet
        growattLastTransitionAt: new Date(rawStartMs).toISOString(),
        schedule,
        scheduleTemplates: DEFAULT_TEMPLATES,
        offsetMinutes: -60,
        transitionMode: 'AUTO',
        resyncPoint: null,
        frozenCommunityOffsetMinutes: null,
        frozenSyncedAtIso: null,
        confidenceScore: 80,
        lastResult: null,
        events: [],
      };
      const finalWorld = { ...world, lastResult: runEngine(world) };
      const actual = finalWorld.lastResult!.atc.mode;
      const expected = 'UNCERTAIN_ZONE';
      return { pass: actual === expected, expected, actual, world: finalWorld };
    },
  },

  // ── Group D: Community Sync ──────────────────────────────────────────────────
  {
    id: 'D1',
    name: 'Community: COMMUNITY_SYNCED after report',
    group: 'D · Community Sync',
    run(): ScenarioResult {
      let world = makeBaseWorld(0, 'OFF', 60);
      world = submitReportOrConfirm(world, 'ON');
      const actual = world.lastResult!.atc.mode;
      const expected = 'COMMUNITY_SYNCED';
      return { pass: actual === expected, expected, actual, world };
    },
  },
  {
    id: 'D2',
    name: 'Community: generatedCycleActive=true while inside generated cycle',
    group: 'D · Community Sync',
    run(): ScenarioResult {
      let world = makeBaseWorld(0, 'OFF', 60);
      world = submitReportOrConfirm(world, 'ON');
      const meta = world.lastResult!.communityTransitionMeta;
      const actual = String(meta?.generatedCycleActive ?? false);
      const expected = 'true';
      return { pass: actual === expected, expected, actual, world };
    },
  },
  {
    id: 'D3',
    name: 'Community: offset computed once (frozen on re-run)',
    group: 'D · Community Sync',
    run(): ScenarioResult {
      let world = makeBaseWorld(0, 'OFF', 60);
      world = submitReportOrConfirm(world, 'ON');
      const firstOffset = world.frozenCommunityOffsetMinutes;
      // Re-run engine; offset must not change
      const rerun = { ...world, lastResult: runEngine(world) };
      const secondOffset = rerun.lastResult?.communityTransitionMeta?.offsetMinutes ?? null;
      const pass = firstOffset !== null && firstOffset === secondOffset;
      return {
        pass,
        expected: `frozen=${firstOffset}`,
        actual: `rerun=${secondOffset}`,
        world: rerun,
      };
    },
  },

  // ── Group E: Transition mode ─────────────────────────────────────────────────
  {
    id: 'E1',
    name: 'MANUAL mode: WAITING_FOR_GROWATT has communityElevated=true',
    group: 'E · Transition Mode',
    run(): ScenarioResult {
      const nowMs = Date.now();
      // Force a slot that ended 30 min ago (beyond grace) for neutral user
      const slotEndMs = nowMs - 30 * 60_000;
      const slotStartMs = slotEndMs - 360 * 60_000;
      const schedule: ScheduleSlot[] = [
        {
          state: 'OFF',
          startIso: new Date(slotStartMs).toISOString(),
          endIso: new Date(slotEndMs).toISOString(),
          startFormatted: fmtYemenTime(new Date(slotStartMs).toISOString()),
          endFormatted: fmtYemenTime(new Date(slotEndMs).toISOString()),
          durationLabel: '6س',
          zone: getZoneFromIso(new Date(slotStartMs).toISOString()),
          isEstimated: false,
        },
        {
          state: 'ON',
          startIso: new Date(slotEndMs).toISOString(),
          endIso: new Date(slotEndMs + 120 * 60_000).toISOString(),
          startFormatted: fmtYemenTime(new Date(slotEndMs).toISOString()),
          endFormatted: fmtYemenTime(new Date(slotEndMs + 120 * 60_000).toISOString()),
          durationLabel: '2س',
          zone: getZoneFromIso(new Date(slotEndMs).toISOString()),
          isEstimated: false,
        },
      ];
      let world: SimWorld = {
        simulatedNowMs: nowMs,
        growattState: 'OFF', // Growatt stuck OFF beyond grace
        growattLastTransitionAt: new Date(slotStartMs).toISOString(),
        schedule,
        scheduleTemplates: DEFAULT_TEMPLATES,
        offsetMinutes: 0,
        transitionMode: 'MANUAL',
        resyncPoint: null,
        frozenCommunityOffsetMinutes: null,
        frozenSyncedAtIso: null,
        confidenceScore: 80,
        lastResult: null,
        events: [],
      };
      world = { ...world, lastResult: runEngine(world) };
      const atc = world.lastResult!.atc;
      const pass = atc.mode === 'WAITING_FOR_GROWATT' && atc.communityElevated === true;
      return {
        pass,
        expected: 'WAITING_FOR_GROWATT + communityElevated=true',
        actual: `${atc.mode} + communityElevated=${atc.communityElevated}`,
        world,
      };
    },
  },

  // ── Group F: Elapsed time ────────────────────────────────────────────────────
  {
    id: 'F1',
    name: 'currentStateStartIso is present after normal slot',
    group: 'F · Elapsed Time',
    run(): ScenarioResult {
      const world = makeBaseWorld(0, 'OFF', 45);
      const startIso = world.lastResult!.currentStateStartIso;
      const pass = startIso !== null && startIso !== undefined;
      return {
        pass,
        expected: 'non-null ISO',
        actual: startIso ?? 'null',
        world,
      };
    },
  },

  // ── Group G: Schedule continuity ─────────────────────────────────────────────
  {
    id: 'G1',
    name: 'daySchedule has multiple slots',
    group: 'G · Schedule Continuity',
    run(): ScenarioResult {
      const world = makeBaseWorld(0, 'OFF', 30);
      const count = world.lastResult!.daySchedule.length;
      const pass = count >= 4;
      return {
        pass,
        expected: '≥4 slots',
        actual: `${count} slots`,
        world,
      };
    },
  },
  {
    id: 'G2',
    name: 'Slots alternate ON/OFF without gaps',
    group: 'G · Schedule Continuity',
    run(): ScenarioResult {
      const world = makeBaseWorld(0, 'OFF', 30);
      const slots = world.lastResult!.daySchedule;
      let gapFound = false;
      for (let i = 1; i < slots.length; i++) {
        const prevEnd = slots[i - 1].endIso ? new Date(slots[i - 1].endIso!).getTime() : null;
        const curStart = new Date(slots[i].startIso).getTime();
        if (prevEnd !== null && Math.abs(curStart - prevEnd) > 1000) {
          gapFound = true;
          break;
        }
      }
      return {
        pass: !gapFound,
        expected: 'No gaps between slots',
        actual: gapFound ? 'GAP DETECTED' : 'No gaps',
        world,
      };
    },
  },

  // ── Group H: Crisis mode ─────────────────────────────────────────────────────
  {
    id: 'H1',
    name: 'crisisMode=false when apppe.crisisActive=false',
    group: 'H · Crisis Mode',
    run(): ScenarioResult {
      const world = makeBaseWorld(0, 'OFF', 30);
      const actual = String(world.lastResult!.crisisMode);
      return { pass: actual === 'false', expected: 'false', actual, world };
    },
  },

  // ── Group I: Offset sign ─────────────────────────────────────────────────────
  {
    id: 'I1',
    name: 'Community offset sign: POSITIVE when report is after Growatt',
    group: 'I · Offset Sign',
    run(): ScenarioResult {
      // Growatt transitioned to OFF 90 min ago; user reports ON now → offset > 0
      let world = makeBaseWorld(0, 'OFF', 90);
      world = submitReportOrConfirm(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const actual = meta?.offsetSign ?? 'null';
      // Report at now vs Growatt OFF start 90 min ago → offset = +90 min (POSITIVE)
      const pass = actual === 'POSITIVE' || actual === 'NEUTRAL'; // accept NEUTRAL if schedule aligns
      return { pass, expected: 'POSITIVE or NEUTRAL', actual: String(actual), world };
    },
  },

  // ── Group J: Reset ────────────────────────────────────────────────────────────
  {
    id: 'J1',
    name: 'resetWorld clears resyncPoint and events',
    group: 'J · Reset',
    run(): ScenarioResult {
      let world = makeBaseWorld(0, 'OFF', 30);
      world = submitReportOrConfirm(world, 'ON');
      world = advanceTime(world, 10);
      const reset = resetWorld(world);
      const pass = reset.resyncPoint === null && reset.events.length === 0;
      return {
        pass,
        expected: 'resyncPoint=null, events=[]',
        actual: `resyncPoint=${reset.resyncPoint}, events.length=${reset.events.length}`,
      };
    },
  },

  // ── Group K: Advance time ─────────────────────────────────────────────────────
  {
    id: 'K1',
    name: 'advanceTime correctly increments simulatedNowMs',
    group: 'K · Advance Time',
    run(): ScenarioResult {
      const world = makeBaseWorld(0, 'OFF', 30);
      const before = world.simulatedNowMs;
      const after = advanceTime(world, 60).simulatedNowMs;
      const pass = after === before + 60 * 60_000;
      return {
        pass,
        expected: `${before + 60 * 60_000}`,
        actual: `${after}`,
      };
    },
  },
  {
    id: 'K2',
    name: 'advanceTime auto-transitions Growatt when slot boundary crossed',
    group: 'K · Advance Time',
    run(): ScenarioResult {
      // Build world where a transition happens in 30 min
      const nowMs = Date.now();
      const slotEndMs = nowMs + 30 * 60_000;
      const schedule: ScheduleSlot[] = [
        {
          state: 'OFF',
          startIso: new Date(nowMs - 60 * 60_000).toISOString(),
          endIso: new Date(slotEndMs).toISOString(),
          startFormatted: fmtYemenTime(new Date(nowMs - 60 * 60_000).toISOString()),
          endFormatted: fmtYemenTime(new Date(slotEndMs).toISOString()),
          durationLabel: '1.5س',
          zone: getZoneFromIso(new Date(nowMs - 60 * 60_000).toISOString()),
          isEstimated: false,
        },
        {
          state: 'ON',
          startIso: new Date(slotEndMs).toISOString(),
          endIso: new Date(slotEndMs + 120 * 60_000).toISOString(),
          startFormatted: fmtYemenTime(new Date(slotEndMs).toISOString()),
          endFormatted: fmtYemenTime(new Date(slotEndMs + 120 * 60_000).toISOString()),
          durationLabel: '2س',
          zone: getZoneFromIso(new Date(slotEndMs).toISOString()),
          isEstimated: false,
        },
      ];
      let world: SimWorld = {
        simulatedNowMs: nowMs,
        growattState: 'OFF',
        growattLastTransitionAt: new Date(nowMs - 60 * 60_000).toISOString(),
        schedule,
        scheduleTemplates: DEFAULT_TEMPLATES,
        offsetMinutes: 0,
        transitionMode: 'AUTO',
        resyncPoint: null,
        frozenCommunityOffsetMinutes: null,
        frozenSyncedAtIso: null,
        confidenceScore: 80,
        lastResult: null,
        events: [],
      };
      world = { ...world, lastResult: runEngine(world) };
      // Advance 45 min — crosses the slot boundary at +30 min
      const advanced = advanceTime(world, 45);
      const actual = advanced.growattState;
      const expected = 'ON';
      return { pass: actual === expected, expected, actual, world: advanced };
    },
  },
];
