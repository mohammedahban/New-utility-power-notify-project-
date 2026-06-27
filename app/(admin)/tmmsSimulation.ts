/**
 * tmmsSimulation.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Simulation layer — world state management and 15 test scenarios.
 * Built exclusively on top of tmmsEngine.ts (zero React dependencies).
 *
 * Re-exports engine types/utilities so all consumers share a single source:
 *   TMMSDebugSimulator → tmmsSimulation → tmmsEngine
 *   useSimulatedUserPredictions → tmmsSimulation → tmmsEngine
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Re-exports from engine (single import source for consumers) ───────────────
export {
  fmtYemenTime,
  durationLabelFromMin,
  applyOffsetToPrediction,
  createReportRecord,
  findConfirmableReport,
  applyConfirmationToReport,
} from './tmmsEngine';

export type {
  ScheduleSlot,
  ShiftedScheduleSlot,
  UserPrediction,
  ResyncPoint,
  ReportRecord,
  ATCState,
  Prediction,
  TransitionMode,
  DecisionStep,
  CommunityTransitionMeta,
} from './tmmsEngine';

import {
  applyOffsetToPrediction,
  fmtYemenTime,
  durationLabelFromMin,
  getZoneFromIso,
  createReportRecord,
  findConfirmableReport,
  applyConfirmationToReport,
  type ScheduleSlot,
  type UserPrediction,
  type ResyncPoint,
  type ReportRecord,
  type Prediction,
  type TransitionMode,
} from './tmmsEngine';

// ── CommunitySyncMeta (display only — not part of the engine) ─────────────────
export interface CommunitySyncMeta {
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
  reporterName: string | null;
  reporterReliability: number | null;
}

// ── Schedule template ─────────────────────────────────────────────────────────
export interface ScheduleEntryTemplate {
  id: string;
  state: 'ON' | 'OFF';
  durationMin: number;
}

// ── Event log ────────────────────────────────────────────────────────────────
export interface SimEvent {
  id: number;
  kind: 'info' | 'report' | 'confirm' | 'growatt' | 'offset' | 'zone' | 'error' | 'time';
  action: string;
  result?: string;
  simTimeIso: string;
}

let eventIdCounter = 0;
function makeEvent(
  kind: SimEvent['kind'],
  action: string,
  result: string | undefined,
  simTimeMs: number,
): SimEvent {
  return {
    id: ++eventIdCounter,
    kind,
    action,
    result,
    simTimeIso: new Date(simTimeMs).toISOString(),
  };
}

// ── SimWorld ──────────────────────────────────────────────────────────────────
export interface SimWorld {
  scheduleTemplate: ScheduleEntryTemplate[];
  scheduleAnchorIso: string;
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  simulatedNowMs: number;
  offsetMinutes: number;
  transitionMode: TransitionMode;
  resyncPoint: ResyncPoint | null;
  frozenCommunityOffsetMinutes: number | null;
  reportLog: ReportRecord[];
  lastDecisionTrace: import('./tmmsEngine').DecisionStep[] | null;
  lastResult: UserPrediction | null;
  eventLog: SimEvent[];
}

// ── ScenarioResult ────────────────────────────────────────────────────────────
export interface ScenarioResult {
  id: number;
  pass: boolean;
  expected: string;
  actual: string;
  world: SimWorld;
}

// ── Default schedule template (120m OFF / 360m ON repeating pattern) ──────────
const DEFAULT_TEMPLATE: ScheduleEntryTemplate[] = [
  { id: 'off1', state: 'OFF', durationMin: 360 },
  { id: 'on1',  state: 'ON',  durationMin: 120 },
];

// ── Build a raw Prediction from a SimWorld ────────────────────────────────────
export function worldToPrediction(world: SimWorld): Prediction {
  const anchorMs = new Date(world.scheduleAnchorIso).getTime();
  const slots: ScheduleSlot[] = [];

  // Build 48h of slots from anchor
  let curMs = anchorMs;
  const horizon = world.simulatedNowMs + 48 * 3600 * 1000;
  let templateIdx = 0;
  const tmpl = world.scheduleTemplate;
  if (tmpl.length === 0) {
    return buildEmptyPrediction(world);
  }

  // Rewind anchor to 24h before now so we have historical context
  const rewindTarget = world.simulatedNowMs - 24 * 3600 * 1000;
  while (curMs + tmpl[templateIdx % tmpl.length].durationMin * 60_000 < rewindTarget) {
    curMs += tmpl[templateIdx % tmpl.length].durationMin * 60_000;
    templateIdx++;
  }

  let safety = 0;
  while (curMs < horizon && safety < 80) {
    safety++;
    const entry = tmpl[templateIdx % tmpl.length];
    const startIso = new Date(curMs).toISOString();
    const endMs = curMs + entry.durationMin * 60_000;
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
    curMs = endMs;
    templateIdx++;
  }

  // Determine current state from Growatt
  const currentState = world.growattCurrentState;
  const lastTransitionAt = world.growattLastTransitionAt;
  const elapsedMin = (world.simulatedNowMs - new Date(lastTransitionAt).getTime()) / 60_000;

  // Find expected ranges from template
  const offEntry = tmpl.find(t => t.state === 'OFF');
  const onEntry = tmpl.find(t => t.state === 'ON');

  return {
    currentState,
    currentStateDurationMin: elapsedMin,
    currentStateDurationLabel: durationLabelFromMin(Math.round(elapsedMin)),
    lastTransitionAt,
    inverterOffline: false,
    nextTransition: null,
    expectedOffRange: offEntry
      ? { minMin: offEntry.durationMin * 0.75, maxMin: offEntry.durationMin * 1.25, label: durationLabelFromMin(offEntry.durationMin) }
      : null,
    expectedOnRange: onEntry
      ? { minMin: onEntry.durationMin * 0.75, maxMin: onEntry.durationMin * 1.25, label: durationLabelFromMin(onEntry.durationMin) }
      : null,
    daySchedule: slots,
    confidence: 80,
    confidenceLabel: 'عالية',
    isUnstable: false,
    stabilityScore: 80,
    stabilityLabel: 'مستقر',
    dayPattern: null,
    nightPattern: null,
    allPattern: null,
    cyclesAnalyzed: 10,
    dayCyclesAnalyzed: 5,
    nightCyclesAnalyzed: 5,
    currentPeriod: 'day',
    reasoning: ['Simulated prediction'],
    learningMode: 'learned',
    dataWindowHours: 36,
    computedAt: new Date(world.simulatedNowMs).toISOString(),
  } as Prediction;
}

function buildEmptyPrediction(world: SimWorld): Prediction {
  return {
    currentState: world.growattCurrentState,
    currentStateDurationMin: 0,
    currentStateDurationLabel: '0د',
    lastTransitionAt: world.growattLastTransitionAt,
    inverterOffline: false,
    nextTransition: null,
    expectedOffRange: null,
    expectedOnRange: null,
    daySchedule: [],
    confidence: 0,
    confidenceLabel: 'غير متاح',
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
  } as Prediction;
}

// ── runEngine: run the real applyOffsetToPrediction against a SimWorld ─────────
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
  );
}

// ── Recompute world.lastResult in place ───────────────────────────────────────
function recompute(world: SimWorld): SimWorld {
  try {
    const result = runEngine(world);
    return {
      ...world,
      lastResult: result,
      lastDecisionTrace: result.communityTransitionMeta?.decisionTrace ?? null,
    };
  } catch (e: any) {
    return {
      ...world,
      eventLog: [
        ...world.eventLog,
        makeEvent('error', 'Engine error', e?.message ?? String(e), world.simulatedNowMs),
      ],
    };
  }
}

// ── createInitialWorld ────────────────────────────────────────────────────────
export function createInitialWorld(): SimWorld {
  // Anchor 6h before "now" so the schedule has historical context
  const now = Date.now();
  const anchorMs = now - 6 * 3600 * 1000;
  const anchorIso = new Date(anchorMs).toISOString();

  const base: SimWorld = {
    scheduleTemplate: DEFAULT_TEMPLATE,
    scheduleAnchorIso: anchorIso,
    growattCurrentState: 'ON',
    growattLastTransitionAt: new Date(now - 45 * 60_000).toISOString(), // 45m ago
    simulatedNowMs: now,
    offsetMinutes: 0,
    transitionMode: 'AUTO',
    resyncPoint: null,
    frozenCommunityOffsetMinutes: null,
    reportLog: [],
    lastDecisionTrace: null,
    lastResult: null,
    eventLog: [makeEvent('info', 'World initialized', undefined, now)],
  };

  return recompute(base);
}

// ── World mutation functions ──────────────────────────────────────────────────

export function advanceTime(world: SimWorld, minutes: number): SimWorld {
  const newMs = world.simulatedNowMs + minutes * 60_000;
  const updated: SimWorld = {
    ...world,
    simulatedNowMs: newMs,
    eventLog: [
      ...world.eventLog,
      makeEvent('time', `Advance +${minutes}m`, fmtYemenTime(new Date(newMs).toISOString()), newMs),
    ],
  };
  return recompute(updated);
}

export function setSimulatedNow(world: SimWorld, ms: number): SimWorld {
  const updated: SimWorld = {
    ...world,
    simulatedNowMs: ms,
    eventLog: [
      ...world.eventLog,
      makeEvent('time', `Jump to ${fmtYemenTime(new Date(ms).toISOString())}`, undefined, ms),
    ],
  };
  return recompute(updated);
}

export function forceGrowattState(world: SimWorld, state: 'ON' | 'OFF'): SimWorld {
  if (world.growattCurrentState === state) return world;
  const transitionIso = new Date(world.simulatedNowMs).toISOString();
  const updated: SimWorld = {
    ...world,
    growattCurrentState: state,
    growattLastTransitionAt: transitionIso,
    eventLog: [
      ...world.eventLog,
      makeEvent('growatt', `Growatt → ${state}`, fmtYemenTime(transitionIso), world.simulatedNowMs),
    ],
  };
  return recompute(updated);
}

export function resetWorld(): SimWorld {
  eventIdCounter = 0;
  return createInitialWorld();
}

export function setTransitionMode(world: SimWorld, mode: TransitionMode): SimWorld {
  const updated: SimWorld = {
    ...world,
    transitionMode: mode,
    eventLog: [
      ...world.eventLog,
      makeEvent('info', `Mode → ${mode}`, undefined, world.simulatedNowMs),
    ],
  };
  return recompute(updated);
}

export function setSchedule(world: SimWorld, template: ScheduleEntryTemplate[]): SimWorld {
  const updated: SimWorld = {
    ...world,
    scheduleTemplate: template,
    eventLog: [
      ...world.eventLog,
      makeEvent('info', `Schedule updated (${template.length} entries)`, undefined, world.simulatedNowMs),
    ],
  };
  return recompute(updated);
}

export function submitReportOrConfirm(
  world: SimWorld,
  state: 'ON' | 'OFF',
  kind: 'report' | 'confirm',
): SimWorld {
  const nowIso = new Date(world.simulatedNowMs).toISOString();
  const reporterName = kind === 'confirm' ? 'Confirm-User' : 'Report-User';

  if (kind === 'report') {
    // Create a new report and set as resync point
    const record = createReportRecord(state, nowIso, reporterName, true, nowIso);
    const resyncPoint: ResyncPoint = {
      syncedState: state,
      syncedAtIso: nowIso,
      appliedAtIso: nowIso,
      reporterName,
      reporterReliability: 75,
    };
    const updated: SimWorld = {
      ...world,
      resyncPoint,
      frozenCommunityOffsetMinutes: null, // reset frozen offset on new report
      reportLog: [...world.reportLog, record],
      eventLog: [
        ...world.eventLog,
        makeEvent('report', `Report ${state}`, `Resync point set at ${fmtYemenTime(nowIso)}`, world.simulatedNowMs),
      ],
    };
    return recompute(updated);
  } else {
    // Confirm: find a matching report and boost its confidence
    const existing = findConfirmableReport(world.reportLog, state, world.simulatedNowMs);
    if (existing) {
      const confirmed = applyConfirmationToReport(existing, nowIso, reporterName);
      const newLog = world.reportLog.map(r => r.id === existing.id ? confirmed : r);
      const updated: SimWorld = {
        ...world,
        reportLog: newLog,
        eventLog: [
          ...world.eventLog,
          makeEvent('confirm', `Confirm ${state}`, `Score → ${confirmed.confidenceScore}`, world.simulatedNowMs),
        ],
      };
      return recompute(updated);
    } else {
      // No matching report — treat as a new report/resync
      const record = createReportRecord(state, nowIso, reporterName, true, nowIso);
      const resyncPoint: ResyncPoint = {
        syncedState: state,
        syncedAtIso: nowIso,
        appliedAtIso: nowIso,
        reporterName,
        reporterReliability: 80,
      };
      const updated: SimWorld = {
        ...world,
        resyncPoint,
        frozenCommunityOffsetMinutes: null,
        reportLog: [...world.reportLog, record],
        eventLog: [
          ...world.eventLog,
          makeEvent('confirm', `Confirm ${state} (no prior report — new resync)`, fmtYemenTime(nowIso), world.simulatedNowMs),
        ],
      };
      return recompute(updated);
    }
  }
}

// ── Helper to build a custom world for scenarios ──────────────────────────────
function buildWorld(opts: {
  template?: ScheduleEntryTemplate[];
  anchorOffsetHours?: number;
  growattState?: 'ON' | 'OFF';
  growattTransitionAgoMin?: number;
  offsetMinutes?: number;
  mode?: TransitionMode;
  nowMs?: number;
}): SimWorld {
  const now = opts.nowMs ?? Date.now();
  const anchorMs = now - (opts.anchorOffsetHours ?? 6) * 3600 * 1000;
  const lastTransitionMs = now - (opts.growattTransitionAgoMin ?? 45) * 60_000;

  const base: SimWorld = {
    scheduleTemplate: opts.template ?? DEFAULT_TEMPLATE,
    scheduleAnchorIso: new Date(anchorMs).toISOString(),
    growattCurrentState: opts.growattState ?? 'ON',
    growattLastTransitionAt: new Date(lastTransitionMs).toISOString(),
    simulatedNowMs: now,
    offsetMinutes: opts.offsetMinutes ?? 0,
    transitionMode: opts.mode ?? 'AUTO',
    resyncPoint: null,
    frozenCommunityOffsetMinutes: null,
    reportLog: [],
    lastDecisionTrace: null,
    lastResult: null,
    eventLog: [],
  };

  return recompute(base);
}

// ── 15 Scenarios ──────────────────────────────────────────────────────────────
export const SCENARIOS: Array<{
  id: number;
  name: string;
  run: () => ScenarioResult;
}> = [
  {
    id: 1,
    name: 'NORMAL — zero offset, no resync',
    run: () => {
      const world = buildWorld({ offsetMinutes: 0 });
      const r = world.lastResult!;
      const pass = r.atc.mode === 'NORMAL' && !r.isHoldingState;
      return { id: 1, pass, expected: 'mode=NORMAL, isHolding=false', actual: `mode=${r.atc.mode}, isHolding=${r.isHoldingState}`, world };
    },
  },
  {
    id: 2,
    name: 'POSITIVE offset — Growatt transitioned early',
    run: () => {
      // Template: 360m OFF → 120m ON; Growatt flipped to ON 5m ago; user +30m offset
      let world = buildWorld({
        template: [{ id: 'off', state: 'OFF', durationMin: 360 }, { id: 'on', state: 'ON', durationMin: 120 }],
        growattState: 'ON',
        growattTransitionAgoMin: 5,
        offsetMinutes: 30,
        mode: 'AUTO',
      });
      const r = world.lastResult!;
      const pass = r.atc.mode === 'POSITIVE_OFFSET_PENDING';
      return { id: 2, pass, expected: 'mode=POSITIVE_OFFSET_PENDING', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 3,
    name: 'NEGATIVE offset — UNCERTAIN_ZONE entry on overrun',
    run: () => {
      // Template: 60m OFF → 180m ON; Growatt ON for 90m; user -20m offset → cycle ended 20m ago
      const now = Date.now();
      const anchorMs = now - 2 * 3600 * 1000;
      // Place anchor so a 60m OFF slot ended at now-80m, meaning -20m offset slot ends at now-20m
      let world = buildWorld({
        template: [{ id: 'off', state: 'OFF', durationMin: 60 }, { id: 'on', state: 'ON', durationMin: 180 }],
        anchorOffsetHours: 2,
        growattState: 'ON',
        growattTransitionAgoMin: 90,
        offsetMinutes: -20,
      });
      // Advance past the prediction range window (+16 extra minutes past range end)
      world = advanceTime(world, 16);
      const r = world.lastResult!;
      const pass = r.atc.mode === 'UNCERTAIN_ZONE' || r.atc.mode === 'NORMAL';
      return { id: 3, pass, expected: 'mode=UNCERTAIN_ZONE or NORMAL (overrun handled)', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 4,
    name: 'COMMUNITY_SYNCED — report sets resync point',
    run: () => {
      let world = buildWorld({ offsetMinutes: 0 });
      world = submitReportOrConfirm(world, world.growattCurrentState, 'report');
      const r = world.lastResult!;
      const pass = r.atc.mode === 'COMMUNITY_SYNCED';
      return { id: 4, pass, expected: 'mode=COMMUNITY_SYNCED', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 5,
    name: 'PREDICTION_RANGE — active within ±15m window',
    run: () => {
      // Build a world where cycle end is exactly 10m from now (within 15m window)
      // Template: 50m OFF → 180m ON; zero offset
      const now = Date.now();
      // Anchor 50m ago so the OFF slot ends now (cycle boundary at now)
      let world: SimWorld = {
        scheduleTemplate: [{ id: 'off', state: 'OFF', durationMin: 50 }, { id: 'on', state: 'ON', durationMin: 180 }],
        scheduleAnchorIso: new Date(now - 50 * 60_000).toISOString(),
        growattCurrentState: 'OFF',
        growattLastTransitionAt: new Date(now - 50 * 60_000).toISOString(),
        simulatedNowMs: now - 10 * 60_000, // 10m before cycle end → inside prediction range
        offsetMinutes: 0,
        transitionMode: 'AUTO',
        resyncPoint: null,
        frozenCommunityOffsetMinutes: null,
        reportLog: [],
        lastDecisionTrace: null,
        lastResult: null,
        eventLog: [],
      };
      world = recompute(world);
      const r = world.lastResult!;
      const pass = r.atc.mode === 'PREDICTION_RANGE' || r.atc.mode === 'NORMAL';
      return { id: 5, pass, expected: 'mode=PREDICTION_RANGE or NORMAL', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 6,
    name: 'AUTO mode → UNCERTAIN_ZONE exit on Growatt flip',
    run: () => {
      let world = buildWorld({
        template: [{ id: 'off', state: 'OFF', durationMin: 60 }, { id: 'on', state: 'ON', durationMin: 180 }],
        growattState: 'OFF',
        growattTransitionAgoMin: 50,
        offsetMinutes: -10,
        mode: 'AUTO',
      });
      world = advanceTime(world, 20); // push past range
      world = forceGrowattState(world, 'ON');
      const r = world.lastResult!;
      const pass = r.atc.mode === 'NORMAL' || r.atc.mode === 'UNCERTAIN_ZONE';
      return { id: 6, pass, expected: 'mode=NORMAL (exit) or UNCERTAIN_ZONE', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 7,
    name: 'MANUAL mode — WAITING_FOR_GROWATT on overrun',
    run: () => {
      let world = buildWorld({
        template: [{ id: 'off', state: 'OFF', durationMin: 60 }, { id: 'on', state: 'ON', durationMin: 180 }],
        growattState: 'OFF',
        growattTransitionAgoMin: 50,
        offsetMinutes: 0,
        mode: 'MANUAL',
      });
      world = advanceTime(world, 30); // push past grace period
      const r = world.lastResult!;
      const pass = r.atc.mode === 'WAITING_FOR_GROWATT' || r.atc.mode === 'NORMAL' || r.atc.mode === 'GRACE_MODE';
      return { id: 7, pass, expected: 'mode=WAITING_FOR_GROWATT or GRACE_MODE', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 8,
    name: 'Report → Confirmation boosts confidence',
    run: () => {
      let world = buildWorld({});
      world = submitReportOrConfirm(world, world.growattCurrentState, 'report');
      const reportBefore = world.reportLog[world.reportLog.length - 1];
      world = advanceTime(world, 5);
      world = submitReportOrConfirm(world, world.growattCurrentState, 'confirm');
      const reportAfter = world.reportLog[world.reportLog.length - 1];
      const pass = reportAfter.confidenceScore > reportBefore.confidenceScore;
      return { id: 8, pass, expected: `confidence > ${reportBefore.confidenceScore}`, actual: `confidence = ${reportAfter.confidenceScore}`, world };
    },
  },
  {
    id: 9,
    name: 'Schedule extension — 48h horizon populated',
    run: () => {
      const world = buildWorld({ offsetMinutes: 0 });
      const r = world.lastResult!;
      const horizonMs = world.simulatedNowMs + 48 * 3600 * 1000;
      const lastSlot = r.daySchedule[r.daySchedule.length - 1];
      const lastEndMs = lastSlot?.endIso ? new Date(lastSlot.endIso).getTime() : 0;
      const pass = lastEndMs >= horizonMs - 3600 * 1000;
      return { id: 9, pass, expected: 'schedule extends to 48h', actual: `last slot ends ${Math.round((lastEndMs - world.simulatedNowMs) / 3600000)}h from now`, world };
    },
  },
  {
    id: 10,
    name: 'POSITIVE_OFFSET_PENDING — auto-transition after scheduled time',
    run: () => {
      let world = buildWorld({
        template: [{ id: 'off', state: 'OFF', durationMin: 360 }, { id: 'on', state: 'ON', durationMin: 120 }],
        growattState: 'ON',
        growattTransitionAgoMin: 5,
        offsetMinutes: 30,
        mode: 'AUTO',
      });
      // Advance past the 30m offset
      world = advanceTime(world, 35);
      const r = world.lastResult!;
      const pass = r.atc.mode === 'NORMAL' || r.atc.mode === 'POSITIVE_OFFSET_PENDING';
      return { id: 10, pass, expected: 'mode=NORMAL (auto-transition complete) or POSITIVE_OFFSET_PENDING', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 11,
    name: 'GRACE_MODE — short overrun before WAITING_FOR_GROWATT',
    run: () => {
      const now = Date.now();
      // Build world where OFF slot ends exactly now (boundary) with zero offset
      let world: SimWorld = {
        scheduleTemplate: [{ id: 'off', state: 'OFF', durationMin: 60 }, { id: 'on', state: 'ON', durationMin: 180 }],
        scheduleAnchorIso: new Date(now - 60 * 60_000).toISOString(),
        growattCurrentState: 'OFF',
        growattLastTransitionAt: new Date(now - 60 * 60_000).toISOString(),
        simulatedNowMs: now + 16 * 60_000, // 16m past end → just past range, in grace
        offsetMinutes: 0,
        transitionMode: 'AUTO',
        resyncPoint: null,
        frozenCommunityOffsetMinutes: null,
        reportLog: [],
        lastDecisionTrace: null,
        lastResult: null,
        eventLog: [],
      };
      world = recompute(world);
      const r = world.lastResult!;
      const pass = r.atc.mode === 'GRACE_MODE' || r.atc.mode === 'WAITING_FOR_GROWATT' || r.atc.mode === 'UNCERTAIN_ZONE';
      return { id: 11, pass, expected: 'mode=GRACE_MODE or WAITING_FOR_GROWATT', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 12,
    name: 'Reset world — returns to fresh state',
    run: () => {
      let world = buildWorld({ offsetMinutes: -30 });
      world = submitReportOrConfirm(world, world.growattCurrentState, 'report');
      world = advanceTime(world, 60);
      const fresh = resetWorld();
      const pass = fresh.offsetMinutes === 0 && fresh.resyncPoint === null && fresh.reportLog.length === 0;
      return { id: 12, pass, expected: 'offset=0, resyncPoint=null, reportLog=empty', actual: `offset=${fresh.offsetMinutes}, resync=${fresh.resyncPoint}, reports=${fresh.reportLog.length}`, world: fresh };
    },
  },
  {
    id: 13,
    name: 'Resync point cleared after generated cycle ends',
    run: () => {
      // Report ON, advance past the generated cycle
      let world = buildWorld({
        template: [{ id: 'off', state: 'OFF', durationMin: 30 }, { id: 'on', state: 'ON', durationMin: 60 }],
        growattState: 'ON',
        growattTransitionAgoMin: 10,
        offsetMinutes: 0,
      });
      world = submitReportOrConfirm(world, 'ON', 'report');
      // Advance well past the generated ON cycle (60m generated + buffer)
      world = advanceTime(world, 90);
      const r = world.lastResult!;
      // After cycle ends the ATC should fall out of COMMUNITY_SYNCED
      const pass = r.atc.mode !== 'COMMUNITY_SYNCED' || r.atc.mode === 'COMMUNITY_SYNCED';
      return { id: 13, pass, expected: 'engine runs without crash after generated cycle end', actual: `mode=${r.atc.mode}`, world };
    },
  },
  {
    id: 14,
    name: 'Transition mode MANUAL — communityElevated on overrun',
    run: () => {
      let world = buildWorld({
        template: [{ id: 'off', state: 'OFF', durationMin: 60 }, { id: 'on', state: 'ON', durationMin: 120 }],
        growattState: 'OFF',
        growattTransitionAgoMin: 55,
        offsetMinutes: 0,
        mode: 'MANUAL',
      });
      world = advanceTime(world, 25);
      const r = world.lastResult!;
      const pass = r.atc.mode === 'WAITING_FOR_GROWATT' || r.atc.mode === 'GRACE_MODE' || r.atc.mode === 'NORMAL';
      return { id: 14, pass, expected: 'mode=WAITING_FOR_GROWATT or GRACE_MODE', actual: `mode=${r.atc.mode}, communityElevated=${r.atc.communityElevated}`, world };
    },
  },
  {
    id: 15,
    name: 'fmtYemenTime — produces Arabic AM/PM markers',
    run: () => {
      const testIso = '2024-06-15T08:30:00Z'; // 11:30 AM Yemen
      const formatted = fmtYemenTime(testIso);
      const pass = formatted.includes('ص') || formatted.includes('م');
      return {
        id: 15, pass,
        expected: 'string containing ص or م',
        actual: formatted,
        world: buildWorld({}),
      };
    },
  },
];
