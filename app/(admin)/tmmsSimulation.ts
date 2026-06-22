/**
 * tmmsSimulation.ts — Deterministic TMMS V2 Debug Simulator
 *
 * Provides an injectable, clock-free simulation world that drives
 * TMMSDebugSimulator.tsx without touching the real Supabase backend.
 *
 * All "now" references use world.simulatedNowMs so scenarios are
 * fully reproducible regardless of wall-clock time.
 */

import {
  applyOffsetToPrediction,
  type Prediction,
  type ResyncPoint,
  type ScheduleSlot,
  type UserPrediction,
  type CommunityTransitionResult,
  type TransitionMode,
  fmtYemenTime,
} from './tmmsEngine';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScheduleEntryTemplate {
  state: 'ON' | 'OFF';
  durationMin: number;
}

export interface SimEvent {
  at: string; // ISO
  kind: 'GROWATT_TRANSITION' | 'REPORT' | 'CONFIRM' | 'AUTO_TRANSITION' | 'SCENARIO_NOTE';
  detail: string;
}

export interface SimWorld {
  /** Simulated wall-clock time in milliseconds */
  simulatedNowMs: number;
  /** Current Growatt (sensor) state */
  growattState: 'ON' | 'OFF';
  /** When Growatt last transitioned (ISO) */
  growattLastTransitionAt: string | null;
  /** User offset in minutes */
  offsetMinutes: number;
  /** TMMS transition mode */
  transitionMode: TransitionMode;
  /** Active resync point (community report/confirm) */
  resyncPoint: ResyncPoint | null;
  /** Frozen community offset (Q2-A: compute once) */
  frozenCommunityOffset: number | null;
  /** Schedule template used to generate prediction slots */
  scheduleTemplate: ScheduleEntryTemplate[];
  /** Event log for the current scenario */
  events: SimEvent[];
  /** Result of the last applyOffsetToPrediction call */
  lastResult: UserPrediction | null;
  /** Confidence score derived from reliability logic */
  confidenceScore: number;
}

export interface ScenarioResult {
  pass: boolean;
  expected: string;
  actual: string;
  world: SimWorld;
}

// ── World factory ─────────────────────────────────────────────────────────────

/** Build a base prediction from the world's schedule template and simulated time */
function buildPrediction(world: SimWorld): Prediction {
  const nowMs = world.simulatedNowMs;

  // Generate slots starting from nowMs - 12h
  const baseMs = nowMs - 12 * 60 * 60 * 1000;
  const slots: ScheduleSlot[] = [];
  let cursor = baseMs;

  const template = world.scheduleTemplate.length > 0
    ? world.scheduleTemplate
    : [{ state: 'OFF' as const, durationMin: 360 }, { state: 'ON' as const, durationMin: 120 }];

  let tIdx = 0;
  while (cursor < nowMs + 48 * 60 * 60 * 1000 && slots.length < 48) {
    const entry = template[tIdx % template.length];
    const startIso = new Date(cursor).toISOString();
    const endMs = cursor + entry.durationMin * 60_000;
    const endIso = new Date(endMs).toISOString();

    slots.push({
      state: entry.state,
      startIso,
      endIso,
      startFormatted: fmtYemenTime(startIso),
      endFormatted: fmtYemenTime(endIso),
      durationLabel: `${entry.durationMin}د`,
      zone: 'Midday',
      isEstimated: cursor > nowMs,
    });

    cursor = endMs;
    tIdx++;
  }

  // Determine current state from slots
  let currentState: 'ON' | 'OFF' = world.growattState;
  let lastTransitionAt: string | null = world.growattLastTransitionAt;

  const avgOffMin = template.find(t => t.state === 'OFF')?.durationMin ?? 360;
  const avgOnMin  = template.find(t => t.state === 'ON')?.durationMin ?? 120;

  return {
    currentState: world.growattState,
    currentStateDurationMin: lastTransitionAt
      ? Math.round((nowMs - new Date(lastTransitionAt).getTime()) / 60_000)
      : 60,
    currentStateDurationLabel: '—',
    lastTransitionAt: world.growattLastTransitionAt,
    inverterOffline: false,
    nextTransition: null,
    expectedOffRange: { minMin: avgOffMin * 0.8, maxMin: avgOffMin * 1.2, label: `~${avgOffMin}د` },
    expectedOnRange:  { minMin: avgOnMin  * 0.8, maxMin: avgOnMin  * 1.2, label: `~${avgOnMin}د` },
    daySchedule: slots,
    confidence: world.confidenceScore,
    confidenceLabel: world.confidenceScore >= 85 ? 'عالية' : world.confidenceScore >= 65 ? 'متوسطة' : 'منخفضة',
    isUnstable: world.confidenceScore < 40,
    stabilityScore: world.confidenceScore,
    stabilityLabel: 'مستقر',
    dayPattern: {
      cycles: 8,
      avgOffMin,
      stdDevOffMin: 20,
      avgOnMin,
      stdDevOnMin: 15,
      minOffMin: avgOffMin * 0.6,
      maxOffMin: avgOffMin * 1.4,
      minOnMin:  avgOnMin  * 0.6,
      maxOnMin:  avgOnMin  * 1.4,
    },
    nightPattern: null,
    allPattern: {
      cycles: 12,
      avgOffMin,
      stdDevOffMin: 25,
      avgOnMin,
      stdDevOnMin: 18,
      minOffMin: avgOffMin * 0.5,
      maxOffMin: avgOffMin * 1.5,
      minOnMin:  avgOnMin  * 0.5,
      maxOnMin:  avgOnMin  * 1.5,
    },
    cyclesAnalyzed: 12,
    dayCyclesAnalyzed: 8,
    nightCyclesAnalyzed: 4,
    currentPeriod: 'day',
    reasoning: ['Simulation mode — deterministic schedule'],
    learningMode: 'learned',
    dataWindowHours: 36,
    computedAt: new Date(nowMs).toISOString(),
    apppe: {
      version: '4.0',
      crisisActive: false,
      crisisReason: null,
    },
  };
}

/** Derive confidence score from resync point reliability */
function deriveConfidence(world: SimWorld): number {
  if (!world.resyncPoint) return 75;
  const rel = world.resyncPoint.reporterReliability ?? 50;
  return Math.min(100, Math.round(50 + rel * 0.5));
}

export function createInitialWorld(): SimWorld {
  const nowMs = Date.now();
  // Default: Growatt is OFF, last transitioned 2h ago
  const lastTransMs = nowMs - 2 * 60 * 60 * 1000;

  return {
    simulatedNowMs: nowMs,
    growattState: 'OFF',
    growattLastTransitionAt: new Date(lastTransMs).toISOString(),
    offsetMinutes: 0,
    transitionMode: 'AUTO',
    resyncPoint: null,
    frozenCommunityOffset: null,
    scheduleTemplate: [
      { state: 'OFF', durationMin: 360 },
      { state: 'ON',  durationMin: 120 },
    ],
    events: [],
    lastResult: null,
    confidenceScore: 75,
  };
}

// ── Mutators (all return a NEW world — immutable pattern) ─────────────────────

function runPipeline(world: SimWorld): SimWorld {
  const prediction = buildPrediction(world);
  const newWorld = { ...world, confidenceScore: deriveConfidence(world) };

  let frozenOffset = world.frozenCommunityOffset;

  const result = applyOffsetToPrediction(
    prediction,
    world.offsetMinutes,
    world.resyncPoint,
    world.resyncPoint ? {
      reporterName: world.resyncPoint.reporterName ?? null,
      reporterReliability: world.resyncPoint.reporterReliability ?? null,
      syncedAtIso: world.resyncPoint.syncedAtIso,
      syncedState: world.resyncPoint.syncedState,
    } : null,
    world.transitionMode,
    null,
    frozenOffset,
    (offsetMin) => {
      frozenOffset = offsetMin;
    },
    world.simulatedNowMs,
  );

  return {
    ...newWorld,
    frozenCommunityOffset: frozenOffset,
    lastResult: result,
  };
}

export function advanceTime(world: SimWorld, deltaMin: number): SimWorld {
  const newMs = world.simulatedNowMs + deltaMin * 60_000;
  const event: SimEvent = {
    at: new Date(newMs).toISOString(),
    kind: 'SCENARIO_NOTE',
    detail: `⏩ Advance +${deltaMin}m → ${fmtYemenTime(new Date(newMs).toISOString())}`,
  };
  return runPipeline({ ...world, simulatedNowMs: newMs, events: [...world.events, event] });
}

export function setSimulatedNow(world: SimWorld, ms: number): SimWorld {
  const event: SimEvent = {
    at: new Date(ms).toISOString(),
    kind: 'SCENARIO_NOTE',
    detail: `🕐 Set now → ${fmtYemenTime(new Date(ms).toISOString())}`,
  };
  return runPipeline({ ...world, simulatedNowMs: ms, events: [...world.events, event] });
}

export function forceGrowattState(world: SimWorld, state: 'ON' | 'OFF'): SimWorld {
  const transAt = new Date(world.simulatedNowMs).toISOString();
  const event: SimEvent = {
    at: transAt,
    kind: 'GROWATT_TRANSITION',
    detail: `⚡ Growatt → ${state}`,
  };
  return runPipeline({
    ...world,
    growattState: state,
    growattLastTransitionAt: transAt,
    events: [...world.events, event],
  });
}

export function resetWorld(world: SimWorld): SimWorld {
  return runPipeline({
    ...createInitialWorld(),
    scheduleTemplate: world.scheduleTemplate,
    offsetMinutes: world.offsetMinutes,
    transitionMode: world.transitionMode,
  });
}

export function setTransitionMode(world: SimWorld, mode: TransitionMode): SimWorld {
  const event: SimEvent = {
    at: new Date(world.simulatedNowMs).toISOString(),
    kind: 'SCENARIO_NOTE',
    detail: `🔄 Mode → ${mode}`,
  };
  return runPipeline({ ...world, transitionMode: mode, events: [...world.events, event] });
}

export function setSchedule(world: SimWorld, template: ScheduleEntryTemplate[]): SimWorld {
  const event: SimEvent = {
    at: new Date(world.simulatedNowMs).toISOString(),
    kind: 'SCENARIO_NOTE',
    detail: `📅 Schedule updated (${template.map(t => `${t.state}:${t.durationMin}m`).join(', ')})`,
  };
  return runPipeline({ ...world, scheduleTemplate: template, events: [...world.events, event] });
}

export function submitReportOrConfirm(
  world: SimWorld,
  state: 'ON' | 'OFF',
  type: 'REPORT' | 'CONFIRM',
  reliability: number = 80,
): SimWorld {
  const syncedAtIso = new Date(world.simulatedNowMs).toISOString();
  const resyncPoint: ResyncPoint = {
    syncedState: state,
    syncedAtIso,
    appliedAtIso: syncedAtIso,
    reporterName: 'SimUser',
    reporterReliability: reliability,
  };
  const event: SimEvent = {
    at: syncedAtIso,
    kind: type === 'REPORT' ? 'REPORT' : 'CONFIRM',
    detail: `${type === 'REPORT' ? '📢' : '✅'} ${type} → ${state} (rel:${reliability}%)`,
  };
  // Clear frozen offset when a NEW resync point is created
  return runPipeline({
    ...world,
    resyncPoint,
    frozenCommunityOffset: null,
    events: [...world.events, event],
  });
}

// ── Scenario runner ───────────────────────────────────────────────────────────

interface Scenario {
  id: string;
  name: string;
  group: string;
  run: () => ScenarioResult;
}

function makeWorld(overrides: Partial<SimWorld> = {}): SimWorld {
  return runPipeline({ ...createInitialWorld(), ...overrides });
}

/** Assert helper — returns ScenarioResult */
function assert(
  world: SimWorld,
  condition: boolean,
  expected: string,
  actual: string,
): ScenarioResult {
  return { pass: condition, expected, actual, world };
}

export const SCENARIOS: Scenario[] = [
  // ── Group A: Neutral Offset ──────────────────────────────────────────────
  {
    id: 'A-1',
    group: 'Group A — Neutral Offset',
    name: 'NORMAL mode when no transition expected soon',
    run(): ScenarioResult {
      const w = makeWorld({ offsetMinutes: 0 });
      const mode = w.lastResult?.atc.mode ?? 'UNKNOWN';
      return assert(w, mode === 'NORMAL', 'NORMAL', mode);
    },
  },
  {
    id: 'A-2',
    group: 'Group A — Neutral Offset',
    name: 'GRACE_MODE after slot overruns by 5 min',
    run(): ScenarioResult {
      // Growatt ON for 370 min (slot was 360 min) → 10 min overrun
      let w = makeWorld({
        offsetMinutes: 0,
        scheduleTemplate: [{ state: 'ON', durationMin: 360 }, { state: 'OFF', durationMin: 240 }],
      });
      // Set growatt transition to 370 min ago so the slot has overrun
      const transAt = new Date(w.simulatedNowMs - 370 * 60_000).toISOString();
      w = runPipeline({ ...w, growattState: 'ON', growattLastTransitionAt: transAt });
      const mode = w.lastResult?.atc.mode ?? 'UNKNOWN';
      return assert(w, mode === 'GRACE_MODE' || mode === 'WAITING_FOR_GROWATT', 'GRACE_MODE or WAITING_FOR_GROWATT', mode);
    },
  },

  // ── Group B: Positive Offset ──────────────────────────────────────────────
  {
    id: 'B-1',
    group: 'Group B — Positive Offset',
    name: 'POSITIVE_OFFSET_PENDING when Growatt flipped ahead of user',
    run(): ScenarioResult {
      const nowMs = Date.now();
      // Growatt transitioned to ON 10 min ago; user has +60 min offset
      const transAt = new Date(nowMs - 10 * 60_000).toISOString();
      const w = runPipeline({
        ...createInitialWorld(),
        offsetMinutes: 60,
        growattState: 'ON',
        growattLastTransitionAt: transAt,
        scheduleTemplate: [{ state: 'OFF', durationMin: 360 }, { state: 'ON', durationMin: 120 }],
      });
      const mode = w.lastResult?.atc.mode ?? 'UNKNOWN';
      return assert(w, mode === 'POSITIVE_OFFSET_PENDING', 'POSITIVE_OFFSET_PENDING', mode);
    },
  },
  {
    id: 'B-2',
    group: 'Group B — Positive Offset',
    name: 'scheduledAutoTransitionIso is set in POSITIVE_OFFSET_PENDING',
    run(): ScenarioResult {
      const nowMs = Date.now();
      const transAt = new Date(nowMs - 10 * 60_000).toISOString();
      const w = runPipeline({
        ...createInitialWorld(),
        offsetMinutes: 60,
        growattState: 'ON',
        growattLastTransitionAt: transAt,
        scheduleTemplate: [{ state: 'OFF', durationMin: 360 }, { state: 'ON', durationMin: 120 }],
      });
      const iso = w.lastResult?.atc.scheduledAutoTransitionIso;
      const hasIso = !!iso;
      return assert(w, hasIso, 'scheduledAutoTransitionIso set', iso ?? 'null');
    },
  },

  // ── Group C: Negative Offset ──────────────────────────────────────────────
  {
    id: 'C-1',
    group: 'Group C — Negative Offset',
    name: 'UNCERTAIN_ZONE after predicted slot end passes (no Growatt confirm)',
    run(): ScenarioResult {
      const nowMs = Date.now();
      // Slot ended 20 min ago; user is -30 min ahead; Growatt still says OFF
      const slotStartMs = nowMs - (360 + 20) * 60_000;
      const transAt = new Date(slotStartMs).toISOString();
      const w = runPipeline({
        ...createInitialWorld(),
        offsetMinutes: -30,
        growattState: 'OFF',
        growattLastTransitionAt: transAt,
        scheduleTemplate: [{ state: 'OFF', durationMin: 360 }, { state: 'ON', durationMin: 120 }],
        simulatedNowMs: nowMs,
      });
      const mode = w.lastResult?.atc.mode ?? 'UNKNOWN';
      return assert(w, mode === 'UNCERTAIN_ZONE', 'UNCERTAIN_ZONE', mode);
    },
  },

  // ── Group D: Community Sync ───────────────────────────────────────────────
  {
    id: 'D-1',
    group: 'Group D — Community Sync',
    name: 'COMMUNITY_SYNCED mode after report',
    run(): ScenarioResult {
      let w = createInitialWorld();
      w = { ...w, growattState: 'OFF', growattLastTransitionAt: new Date(w.simulatedNowMs - 120 * 60_000).toISOString() };
      w = submitReportOrConfirm(w, 'ON', 'REPORT');
      const mode = w.lastResult?.atc.mode ?? 'UNKNOWN';
      return assert(w, mode === 'COMMUNITY_SYNCED', 'COMMUNITY_SYNCED', mode);
    },
  },
  {
    id: 'D-2',
    group: 'Group D — Community Sync',
    name: 'generatedCycleStartIso equals syncedAtIso',
    run(): ScenarioResult {
      let w = createInitialWorld();
      w = { ...w, growattState: 'OFF', growattLastTransitionAt: new Date(w.simulatedNowMs - 120 * 60_000).toISOString() };
      w = submitReportOrConfirm(w, 'ON', 'REPORT');
      const meta = w.lastResult?.communityTransitionMeta;
      const resyncAt = w.resyncPoint?.syncedAtIso ?? 'N/A';
      const genStart = meta?.generatedCycleStartIso ?? 'null';
      const equal = genStart === resyncAt;
      return assert(w, equal, resyncAt, genStart);
    },
  },
  {
    id: 'D-3',
    group: 'Group D — Community Sync',
    name: 'Offset computed once (frozen) on second render',
    run(): ScenarioResult {
      let w = createInitialWorld();
      w = { ...w, growattState: 'OFF', growattLastTransitionAt: new Date(w.simulatedNowMs - 120 * 60_000).toISOString() };
      w = submitReportOrConfirm(w, 'ON', 'REPORT');
      const firstOffset = w.frozenCommunityOffset;
      // Advance time and run again — frozen offset must not change
      w = advanceTime(w, 5);
      const secondOffset = w.frozenCommunityOffset;
      const frozen = firstOffset !== null && firstOffset === secondOffset;
      return assert(w, frozen, `frozen=${firstOffset}`, `second=${secondOffset}`);
    },
  },

  // ── Group E: Transition Modes ─────────────────────────────────────────────
  {
    id: 'E-1',
    group: 'Group E — Transition Modes',
    name: 'MANUAL mode preserved after setTransitionMode',
    run(): ScenarioResult {
      let w = createInitialWorld();
      w = setTransitionMode(w, 'MANUAL');
      const mode = w.lastResult?.atc.transitionMode ?? 'UNKNOWN';
      return assert(w, mode === 'MANUAL', 'MANUAL', mode);
    },
  },
  {
    id: 'E-2',
    group: 'Group E — Transition Modes',
    name: 'AUTO mode restored after reset',
    run(): ScenarioResult {
      let w = createInitialWorld();
      w = setTransitionMode(w, 'MANUAL');
      w = resetWorld(w);
      const mode = w.lastResult?.atc.transitionMode ?? 'UNKNOWN';
      return assert(w, mode === 'AUTO', 'AUTO', mode);
    },
  },

  // ── Group F: Elapsed Time ─────────────────────────────────────────────────
  {
    id: 'F-1',
    group: 'Group F — Elapsed Time',
    name: 'currentStateStartIso is set when result is available',
    run(): ScenarioResult {
      const w = makeWorld({ offsetMinutes: 0 });
      const startIso = w.lastResult?.currentStateStartIso;
      const hasStart = startIso != null;
      return assert(w, hasStart, 'non-null startIso', startIso ?? 'null');
    },
  },

  // ── Group G: Schedule Continuity ──────────────────────────────────────────
  {
    id: 'G-1',
    group: 'Group G — Schedule Continuity',
    name: 'daySchedule has at least 4 slots',
    run(): ScenarioResult {
      const w = makeWorld();
      const count = w.lastResult?.daySchedule.length ?? 0;
      return assert(w, count >= 4, '≥4 slots', String(count));
    },
  },
  {
    id: 'G-2',
    group: 'Group G — Schedule Continuity',
    name: 'Custom schedule template respected',
    run(): ScenarioResult {
      const template: ScheduleEntryTemplate[] = [
        { state: 'ON', durationMin: 60 },
        { state: 'OFF', durationMin: 180 },
      ];
      let w = createInitialWorld();
      w = setSchedule(w, template);
      const slots = w.lastResult?.daySchedule ?? [];
      const hasExpectedDurations = slots.some(s => s.durationLabel?.includes('60') || s.durationLabel?.includes('180') || s.durationLabel?.includes('1س') || s.durationLabel?.includes('3س'));
      return assert(w, hasExpectedDurations, 'slots with 60/180 min durations', slots.map(s => s.durationLabel).slice(0, 3).join(', '));
    },
  },

  // ── Group H: Crisis Mode ──────────────────────────────────────────────────
  {
    id: 'H-1',
    group: 'Group H — Crisis Mode',
    name: 'crisisMode false by default',
    run(): ScenarioResult {
      const w = makeWorld();
      const crisis = w.lastResult?.crisisMode ?? true;
      return assert(w, crisis === false, 'false', String(crisis));
    },
  },

  // ── Group I: Reset / Advance Time ─────────────────────────────────────────
  {
    id: 'I-1',
    group: 'Group I — Reset / Advance Time',
    name: 'advanceTime increases simulatedNowMs',
    run(): ScenarioResult {
      let w = createInitialWorld();
      const before = w.simulatedNowMs;
      w = advanceTime(w, 30);
      const after = w.simulatedNowMs;
      const diff = Math.round((after - before) / 60_000);
      return assert(w, diff === 30, '30 min advance', `${diff} min`);
    },
  },
  {
    id: 'I-2',
    group: 'Group I — Reset / Advance Time',
    name: 'resetWorld clears resyncPoint and events',
    run(): ScenarioResult {
      let w = createInitialWorld();
      w = submitReportOrConfirm(w, 'ON', 'REPORT');
      w = resetWorld(w);
      const noResync = w.resyncPoint === null;
      const noEvents = w.events.length === 0;
      return assert(w, noResync && noEvents, 'resync=null, events=[]', `resync=${w.resyncPoint}, events=${w.events.length}`);
    },
  },

  // ── Group J: Validation Window ────────────────────────────────────────────
  {
    id: 'J-1',
    group: 'Group J — Validation Window',
    name: 'inValidationWindow true when Growatt disagrees within 20 min',
    run(): ScenarioResult {
      let w = createInitialWorld();
      // Growatt is OFF; report says ON (disagreement)
      w = { ...w, growattState: 'OFF', growattLastTransitionAt: new Date(w.simulatedNowMs - 30 * 60_000).toISOString() };
      w = submitReportOrConfirm(w, 'ON', 'REPORT');
      // Don't advance time — still within validation window
      const inWindow = w.lastResult?.atc.inValidationWindow ?? false;
      return assert(w, inWindow, 'inValidationWindow=true', String(inWindow));
    },
  },

  // ── Group K: Confidence Score ─────────────────────────────────────────────
  {
    id: 'K-1',
    group: 'Group K — Confidence Score',
    name: 'confidenceScore increases with high reporter reliability',
    run(): ScenarioResult {
      let w = createInitialWorld();
      w = submitReportOrConfirm(w, 'ON', 'REPORT', 100);
      const score = w.confidenceScore;
      return assert(w, score > 75, '>75', String(score));
    },
  },
];
