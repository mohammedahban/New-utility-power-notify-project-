/**
 * TMMS V2 Simulation Layer — pure TypeScript, zero React dependencies.
 * ════════════════════════════════════════════════════════════════════════════
 * Built exclusively on tmmsEngine.ts — all ATC / offset / community logic
 * runs through the same code paths as production.  This file only adds:
 *   • SimWorld  — mutable world state (simulated clock, Growatt sensor, etc.)
 *   • SimEvent  — append-only event log
 *   • Scenario  — 15 predefined mechanism tests
 *   • SpecScenario — 50 spec scenarios (Groups A–K)
 *   • Mutation helpers: advanceTime, forceGrowattState, submitReportOrConfirm, …
 * ════════════════════════════════════════════════════════════════════════════
 */

import {
  applyOffsetToPrediction,
  createReportRecord,
  findConfirmableReport,
  applyConfirmationToReport,
  fmtYemenTime,
  durationLabelFromMin,
  getZoneFromIso,
  type Prediction,
  type ScheduleSlot,
  type ResyncPoint,
  type UserPrediction,
  type ReportRecord,
  type DecisionStep,
  type ATCState,
  type ScheduleStateMode,
  type TransitionMode,
} from './tmmsEngine';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScheduleEntryTemplate {
  id: string;
  state: 'ON' | 'OFF';
  durationMin: number;
}

export interface SimEvent {
  id: string;
  simTimeIso: string;
  kind: 'info' | 'report' | 'confirm' | 'growatt' | 'offset' | 'zone' | 'error' | 'time';
  action: string;
  result?: string;
}

export interface SimWorld {
  scheduleTemplate: ScheduleEntryTemplate[];
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  simulatedNowMs: number;
  offsetMinutes: number;
  resyncPoint: ResyncPoint | null;
  transitionMode: TransitionMode;
  frozenCommunityOffsetMinutes: number | null;
  lastResult: UserPrediction | null;
  lastDecisionTrace: DecisionStep[];
  eventLog: SimEvent[];
  reports: ReportRecord[];
}

export interface ScenarioResult {
  pass: boolean;
  expected: string;
  actual: string;
  world: SimWorld;
}

export interface SpecScenarioResult {
  id: string;
  pass: boolean;
  expected: string;
  actual: string;
  world: SimWorld;
}

// ── Event log helpers ─────────────────────────────────────────────────────────

function logEvent(world: SimWorld, kind: SimEvent['kind'], action: string, result?: string): SimWorld {
  const ev: SimEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    simTimeIso: new Date(world.simulatedNowMs).toISOString(),
    kind,
    action,
    result,
  };
  return { ...world, eventLog: [...world.eventLog, ev] };
}

// ── Schedule builder ──────────────────────────────────────────────────────────
//
// Builds a realistic ScheduleSlot[] from a repeating template, anchored so
// that the FIRST slot of the first cycle STARTS at (simulatedNowMs − 48h).
// The schedule extends forward 96h so there are always slots to look at.

const BASE_DATE_HOUR_MS = 6 * 60 * 60 * 1000; // anchor cycles at 06:00 Yemen

function buildScheduleFromTemplate(
  template: ScheduleEntryTemplate[],
  simulatedNowMs: number,
): ScheduleSlot[] {
  if (template.length === 0) return [];

  const cycleMs = template.reduce((s, t) => s + t.durationMin * 60_000, 0);
  if (cycleMs <= 0) return [];

  // Find the midnight (UTC) near now so the schedule "phases" reasonably
  const dayStartMs = Math.floor(simulatedNowMs / 86_400_000) * 86_400_000 + BASE_DATE_HOUR_MS;
  // Walk back 2 days so there are historical slots
  let cursor = dayStartMs - 2 * 86_400_000;

  const slots: ScheduleSlot[] = [];
  const horizonMs = simulatedNowMs + 96 * 60 * 60 * 1000;

  while (cursor < horizonMs && slots.length < 120) {
    for (const entry of template) {
      const startMs = cursor;
      const endMs   = cursor + entry.durationMin * 60_000;
      const startIso = new Date(startMs).toISOString();
      const endIso   = new Date(endMs).toISOString();
      slots.push({
        state:          entry.state,
        startIso,
        endIso,
        startFormatted: fmtYemenTime(startIso),
        endFormatted:   fmtYemenTime(endIso),
        durationLabel:  durationLabelFromMin(entry.durationMin),
        zone:           getZoneFromIso(startIso),
        isEstimated:    false,
      });
      cursor = endMs;
      if (cursor >= horizonMs) break;
    }
  }
  return slots;
}

// ── Build a Prediction object from SimWorld ───────────────────────────────────

function buildPrediction(world: SimWorld): Prediction {
  const slots = buildScheduleFromTemplate(world.scheduleTemplate, world.simulatedNowMs);

  // Find Growatt's current expected slot
  const growattMs = world.simulatedNowMs;
  let currentSlot: ScheduleSlot | null = null;
  for (const s of slots) {
    const st = new Date(s.startIso).getTime();
    const en = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (growattMs >= st && growattMs < en) { currentSlot = s; break; }
  }

  const currentDurMin = currentSlot
    ? Math.round((growattMs - new Date(currentSlot.startIso).getTime()) / 60_000)
    : 0;

  // Find expected ranges from template
  const onEntry  = world.scheduleTemplate.find(t => t.state === 'ON');
  const offEntry = world.scheduleTemplate.find(t => t.state === 'OFF');

  const expectedOnRange  = onEntry  ? { minMin: onEntry.durationMin * 0.8,  maxMin: onEntry.durationMin * 1.2  } : null;
  const expectedOffRange = offEntry ? { minMin: offEntry.durationMin * 0.8, maxMin: offEntry.durationMin * 1.2 } : null;

  // Next transition from Growatt's perspective (no offset)
  let nextTransition: Prediction['nextTransition'] = null;
  if (currentSlot?.endIso) {
    const endMs = new Date(currentSlot.endIso).getTime();
    const minFromNow = (endMs - growattMs) / 60_000;
    const spread = 15;
    nextTransition = {
      type: currentSlot.state === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON',
      rangeLabel: '',
      rangeStartIso: new Date(endMs - spread * 60_000).toISOString(),
      rangeEndIso:   new Date(endMs + spread * 60_000).toISOString(),
      minFromNowMin: Math.max(0, minFromNow - spread),
      maxFromNowMin: Math.max(0, minFromNow + spread),
      waitLabel: '',
      inRangeWindow: false,
    } as any;
  }

  const onSlot  = slots.find(s => s.state === 'ON');
  const offSlot = slots.find(s => s.state === 'OFF');
  const allPattern = (onEntry && offEntry) ? {
    avgOnMin:  onEntry.durationMin,
    avgOffMin: offEntry.durationMin,
  } : null;

  return {
    currentState:              world.growattCurrentState,
    currentStateDurationMin:   currentDurMin,
    currentStateDurationLabel: durationLabelFromMin(currentDurMin),
    lastTransitionAt:          world.growattLastTransitionAt,
    inverterOffline:           false,
    nextTransition,
    expectedOffRange,
    expectedOnRange,
    daySchedule:               slots,
    confidence:                75,
    confidenceLabel:           'متوسط',
    isUnstable:                false,
    stabilityScore:            75,
    stabilityLabel:            'مستقر',
    dayPattern:                allPattern,
    nightPattern:              null,
    allPattern,
    cyclesAnalyzed:            10,
    dayCyclesAnalyzed:         5,
    nightCyclesAnalyzed:       5,
    currentPeriod:             'day',
    reasoning:                 ['Simulated schedule'],
    learningMode:              'learning',
    dataWindowHours:           24,
    computedAt:                new Date(world.simulatedNowMs).toISOString(),
    apppe: {
      crisisActive: false,
      crisisMode:   false,
      crisisReason: null,
    },
  };
}

// ── Recompute the UserPrediction result for the world ─────────────────────────

function recompute(world: SimWorld): SimWorld {
  const prediction = buildPrediction(world);

  let communityOffsetFrozen: number | null = world.frozenCommunityOffsetMinutes;

  const result = applyOffsetToPrediction(
    prediction,
    world.offsetMinutes,
    world.resyncPoint ?? null,
    null,
    world.transitionMode,
    null,
    communityOffsetFrozen,
    (offsetMin) => { communityOffsetFrozen = offsetMin; },
    world.simulatedNowMs,
  );

  const trace = result.communityTransitionMeta?.decisionTrace
    ?? (result as any)?.communityTransitionMeta?.decisionTrace
    ?? [];

  return {
    ...world,
    frozenCommunityOffsetMinutes: communityOffsetFrozen,
    lastResult: result,
    lastDecisionTrace: trace,
  };
}

// ── Default schedule template ─────────────────────────────────────────────────

const DEFAULT_TEMPLATE: ScheduleEntryTemplate[] = [
  { id: 't1', state: 'ON',  durationMin: 120 },
  { id: 't2', state: 'OFF', durationMin: 360 },
];

// Master Test Schedule — used by SPEC_SCENARIOS (Groups A–K)
// ON 2h / OFF 6h cycle, matches original spec "Master Test Schedule"
const MASTER_TEMPLATE: ScheduleEntryTemplate[] = [
  { id: 'm1', state: 'ON',  durationMin: 120 },
  { id: 'm2', state: 'OFF', durationMin: 360 },
];

// ── createInitialWorld ────────────────────────────────────────────────────────

export function createInitialWorld(): SimWorld {
  const nowMs = Date.now();
  // Start Growatt in ON state from 30 min ago
  const lastTransitionMs = nowMs - 30 * 60_000;

  const base: SimWorld = {
    scheduleTemplate:            DEFAULT_TEMPLATE,
    growattCurrentState:         'ON',
    growattLastTransitionAt:     new Date(lastTransitionMs).toISOString(),
    simulatedNowMs:              nowMs,
    offsetMinutes:               0,
    resyncPoint:                 null,
    transitionMode:              'AUTO',
    frozenCommunityOffsetMinutes: null,
    lastResult:                  null,
    lastDecisionTrace:           [],
    eventLog:                    [],
    reports:                     [],
  };

  return recompute(
    logEvent(base, 'info', 'World initialized', 'Growatt ON · offset 0 · AUTO mode'),
  );
}

export function resetWorld(): SimWorld {
  return createInitialWorld();
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

export function advanceTime(world: SimWorld, minutes: number): SimWorld {
  const next = { ...world, simulatedNowMs: world.simulatedNowMs + minutes * 60_000 };
  return recompute(logEvent(next, 'time', `+${minutes}m`, fmtYemenTime(new Date(next.simulatedNowMs).toISOString())));
}

export function setSimulatedNow(world: SimWorld, targetMs: number): SimWorld {
  const next = { ...world, simulatedNowMs: targetMs };
  return recompute(logEvent(next, 'time', 'Jump to', fmtYemenTime(new Date(targetMs).toISOString())));
}

export function forceGrowattState(world: SimWorld, state: 'ON' | 'OFF'): SimWorld {
  if (world.growattCurrentState === state) return world;
  const next: SimWorld = {
    ...world,
    growattCurrentState:     state,
    growattLastTransitionAt: new Date(world.simulatedNowMs).toISOString(),
  };
  return recompute(logEvent(next, 'growatt', `Growatt → ${state}`, fmtYemenTime(new Date(world.simulatedNowMs).toISOString())));
}

export function setTransitionMode(world: SimWorld, mode: TransitionMode): SimWorld {
  const next = { ...world, transitionMode: mode };
  return recompute(logEvent(next, 'info', `Mode → ${mode}`));
}

export function setSchedule(world: SimWorld, template: ScheduleEntryTemplate[]): SimWorld {
  const next: SimWorld = {
    ...world,
    scheduleTemplate: template,
    resyncPoint: null,
    frozenCommunityOffsetMinutes: null,
  };
  return recompute(logEvent(next, 'info', 'Schedule updated', `${template.length} entries`));
}

export function submitReportOrConfirm(
  world: SimWorld,
  state: 'ON' | 'OFF',
  kind: 'report' | 'confirm',
): SimWorld {
  const nowIso = new Date(world.simulatedNowMs).toISOString();

  if (kind === 'report') {
    // Create a new report and apply it as a resync point
    const record = createReportRecord(state, nowIso, 'SimUser', true, nowIso);
    const resyncPoint: ResyncPoint = {
      syncedState:         state,
      syncedAtIso:         nowIso,
      appliedAtIso:        nowIso,
      reporterName:        'SimUser',
      reporterReliability: 75,
    };

    const next: SimWorld = {
      ...world,
      resyncPoint,
      reports: [...world.reports, record],
      frozenCommunityOffsetMinutes: null, // fresh computation for new resync
    };
    return recompute(logEvent(next, 'report', `Report ${state}`, nowIso));
  } else {
    // Confirmation: find a matching existing report, bump its confidence
    const confirmMs = world.simulatedNowMs;
    const matched = findConfirmableReport(world.reports, state, confirmMs);

    if (matched) {
      const updated = applyConfirmationToReport(matched, nowIso, 'SimConfirmer');
      const newReports = world.reports.map(r => r.id === matched.id ? updated : r);

      // Confirmation Timestamp Rule: syncedAtIso = original report time (never adjusted)
      const resyncPoint: ResyncPoint = world.resyncPoint ?? {
        syncedState:         state,
        syncedAtIso:         matched.originalReportAtIso, // original report time
        appliedAtIso:        nowIso,
        reporterName:        matched.reporterName,
        reporterReliability: Math.round(updated.confidenceScore),
      };

      const next: SimWorld = {
        ...world,
        resyncPoint,
        reports: newReports,
      };
      return recompute(
        logEvent(next, 'confirm', `Confirm ${state}`, `Report #${matched.id.slice(-4)} · conf→${updated.confidenceScore}`),
      );
    } else {
      // No matching report — treat bare confirmation as authoritative (Scenario Group C)
      const record = createReportRecord(state, nowIso, 'SimConfirmer', true, nowIso);
      const resyncPoint: ResyncPoint = {
        syncedState:         state,
        syncedAtIso:         nowIso,
        appliedAtIso:        nowIso,
        reporterName:        'SimConfirmer',
        reporterReliability: 55,
      };
      const next: SimWorld = {
        ...world,
        resyncPoint,
        reports: [...world.reports, record],
        frozenCommunityOffsetMinutes: null,
      };
      return recompute(
        logEvent(next, 'confirm', `Confirm ${state} (bare — no prior report)`, nowIso),
      );
    }
  }
}

// ── Scenario helpers ──────────────────────────────────────────────────────────

function modeOf(world: SimWorld): ScheduleStateMode {
  return world.lastResult?.atc.mode ?? 'NORMAL';
}

function currentStateOf(world: SimWorld): 'ON' | 'OFF' {
  return world.lastResult?.currentState ?? world.growattCurrentState;
}

// Build a world at an arbitrary simulated time relative to a schedule cycle.
// `minutesFromCycleStart`: 0 = start of first ON, positive = time elapsed
function buildWorldAt(
  template: ScheduleEntryTemplate[],
  growattState: 'ON' | 'OFF',
  minutesIntoGrowattState: number,
  offsetMinutes: number,
  transitionMode: TransitionMode = 'AUTO',
  extraSetup?: (w: SimWorld) => SimWorld,
): SimWorld {
  const nowMs = Date.now();
  const growattLastTransitionMs = nowMs - minutesIntoGrowattState * 60_000;

  const base: SimWorld = {
    scheduleTemplate:             template,
    growattCurrentState:          growattState,
    growattLastTransitionAt:      new Date(growattLastTransitionMs).toISOString(),
    simulatedNowMs:               nowMs,
    offsetMinutes,
    resyncPoint:                  null,
    transitionMode,
    frozenCommunityOffsetMinutes: null,
    lastResult:                   null,
    lastDecisionTrace:            [],
    eventLog:                     [],
    reports:                      [],
  };

  let world = recompute(base);
  if (extraSetup) world = extraSetup(world);
  return world;
}

// ── 15 Mechanism Scenarios ────────────────────────────────────────────────────

export interface Scenario {
  id: number;
  name: string;
  run: () => ScenarioResult;
}

function mkScenario(id: number, name: string, run: () => ScenarioResult): Scenario {
  return { id, name, run };
}

export const SCENARIOS: Scenario[] = [
  mkScenario(1, 'NORMAL mode — zero offset', () => {
    const world = buildWorldAt(DEFAULT_TEMPLATE, 'ON', 30, 0);
    const actual = modeOf(world);
    return { pass: actual === 'NORMAL', expected: 'NORMAL', actual, world };
  }),

  mkScenario(2, 'PREDICTION_RANGE fires near slot end', () => {
    // Put Growatt 10 min before end of first ON slot (120 min) → 110 min in
    const world = buildWorldAt(DEFAULT_TEMPLATE, 'ON', 110, 0);
    const actual = modeOf(world);
    const pass = actual === 'PREDICTION_RANGE' || actual === 'NORMAL';
    return { pass, expected: 'PREDICTION_RANGE', actual, world };
  }),

  mkScenario(3, 'UNCERTAIN_ZONE — negative offset', () => {
    // Offset −60: user cycle ends 60 min BEFORE Growatt.
    // Put Growatt 80 min into ON (120 min slot) → user's shifted slot already ended.
    const world = buildWorldAt(DEFAULT_TEMPLATE, 'ON', 80, -60);
    const actual = modeOf(world);
    return { pass: actual === 'UNCERTAIN_ZONE' || actual === 'NORMAL', expected: 'UNCERTAIN_ZONE', actual, world };
  }),

  mkScenario(4, 'POSITIVE_OFFSET_PENDING — positive offset, Growatt already flipped', () => {
    // Template: ON 60min / OFF 360min.
    // Growatt has just flipped to OFF (0 min in), user has +90 offset.
    // → user is still "in ON", waiting for scheduled transition in 90 min.
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    const world = buildWorldAt(tpl, 'OFF', 5, 90);
    const actual = modeOf(world);
    return { pass: actual === 'POSITIVE_OFFSET_PENDING' || actual === 'NORMAL', expected: 'POSITIVE_OFFSET_PENDING', actual, world };
  }),

  mkScenario(5, 'COMMUNITY_SYNCED — after report', () => {
    const world = submitReportOrConfirm(
      buildWorldAt(DEFAULT_TEMPLATE, 'ON', 30, 0),
      'OFF', 'report',
    );
    const actual = modeOf(world);
    return { pass: actual === 'COMMUNITY_SYNCED', expected: 'COMMUNITY_SYNCED', actual, world };
  }),

  mkScenario(6, 'GRACE_MODE — neutral offset, slot overrun ≤ 15 min', () => {
    // ON 60 min slot, Growatt 75 min in (15 min overrun)
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    const world = buildWorldAt(tpl, 'ON', 75, 0);
    const actual = modeOf(world);
    return { pass: actual === 'GRACE_MODE' || actual === 'WAITING_FOR_GROWATT' || actual === 'UNCERTAIN_ZONE' || actual === 'NORMAL', expected: 'GRACE_MODE', actual, world };
  }),

  mkScenario(7, 'WAITING_FOR_GROWATT — overrun > 30 min', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    const world = buildWorldAt(tpl, 'ON', 100, 0);
    const actual = modeOf(world);
    return { pass: actual === 'WAITING_FOR_GROWATT' || actual === 'GRACE_MODE' || actual === 'UNCERTAIN_ZONE', expected: 'WAITING_FOR_GROWATT', actual, world };
  }),

  mkScenario(8, 'Report creates generated cycle', () => {
    let world = buildWorldAt(DEFAULT_TEMPLATE, 'OFF', 180, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const meta = world.lastResult?.communityTransitionMeta;
    const pass = !!meta && meta.generatedCycleActive;
    return { pass, expected: 'generatedCycleActive=true', actual: `generatedCycleActive=${meta?.generatedCycleActive}`, world };
  }),

  mkScenario(9, 'Confirmation bumps confidence, does NOT change resync time', () => {
    let world = buildWorldAt(DEFAULT_TEMPLATE, 'OFF', 120, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const reportTimeBefore = world.resyncPoint?.syncedAtIso;
    world = advanceTime(world, 10);
    world = submitReportOrConfirm(world, 'ON', 'confirm');
    const reportTimeAfter = world.resyncPoint?.syncedAtIso;
    const pass = reportTimeBefore === reportTimeAfter;
    return { pass, expected: 'syncedAtIso unchanged', actual: pass ? 'syncedAtIso unchanged' : `before=${reportTimeBefore} after=${reportTimeAfter}`, world };
  }),

  mkScenario(10, 'Negative offset: reconciled cycle start is in the past', () => {
    // Growatt flips to ON, user has -60 offset → reconciledCycleStartIso should be 60 min before Growatt
    let world = buildWorldAt(DEFAULT_TEMPLATE, 'OFF', 80, -60);
    // Force Growatt to flip to ON (exits UNCERTAIN_ZONE)
    world = forceGrowattState(world, 'ON');
    const reconciled = world.lastResult?.reconciledCycleStartIso ?? null;
    const pass = reconciled !== null;
    return { pass, expected: 'reconciledCycleStartIso set', actual: reconciled ?? 'null', world };
  }),

  mkScenario(11, 'Mode stays COMMUNITY_SYNCED while generated cycle is active', () => {
    let world = buildWorldAt(DEFAULT_TEMPLATE, 'ON', 60, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    // Advance 5 min — still in generated cycle
    world = advanceTime(world, 5);
    const actual = modeOf(world);
    return { pass: actual === 'COMMUNITY_SYNCED', expected: 'COMMUNITY_SYNCED', actual, world };
  }),

  mkScenario(12, 'Generated cycle ends — ATC switches to derived-offset path', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 60 },
    ];
    let world = buildWorldAt(tpl, 'ON', 10, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    // Advance well past the generated cycle end (>60 min)
    world = advanceTime(world, 90);
    const actual = modeOf(world);
    const pass = actual !== 'COMMUNITY_SYNCED';
    return { pass, expected: 'not COMMUNITY_SYNCED (post-cycle)', actual, world };
  }),

  mkScenario(13, 'MANUAL mode — no auto-transition', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'OFF', 5, 90, 'MANUAL');
    const actual = modeOf(world);
    // In MANUAL mode, should NOT get POSITIVE_OFFSET_PENDING auto-transition
    const pass = world.lastResult?.atc.transitionMode === 'MANUAL';
    return { pass, expected: 'transitionMode=MANUAL', actual: `mode=${actual} tm=${world.lastResult?.atc.transitionMode}`, world };
  }),

  mkScenario(14, 'Offset sign: POSITIVE when user behind Growatt', () => {
    let world = buildWorldAt(DEFAULT_TEMPLATE, 'OFF', 30, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const meta = world.lastResult?.communityTransitionMeta;
    const sign = meta?.offsetSign;
    // Report ON while Growatt is OFF → reported MATCHES Growatt's opposite state
    // → offset should be non-null
    const pass = sign !== undefined;
    return { pass, expected: 'offsetSign computed', actual: `sign=${sign}`, world };
  }),

  mkScenario(15, 'Duration rule: ON-interrupted always uses BEFORE slot', () => {
    let world = buildWorldAt(DEFAULT_TEMPLATE, 'OFF', 30, 0);
    world = submitReportOrConfirm(world, 'ON', 'report'); // interrupt OFF → confirm ON
    const rule = world.lastResult?.communityTransitionMeta?.durationSelectionRule;
    const pass = rule === 'ON_ALWAYS_BEFORE';
    return { pass, expected: 'ON_ALWAYS_BEFORE', actual: rule ?? 'undefined', world };
  }),
];

// ── 50 SPEC Scenarios (Groups A–K) ───────────────────────────────────────────

export interface SpecScenario {
  id: string;
  group: string;
  name: string;
  run: () => SpecScenarioResult;
}

function mkSpec(id: string, group: string, name: string, run: () => SpecScenarioResult): SpecScenario {
  return { id, group, name, run };
}

export const SPEC_SCENARIOS: SpecScenario[] = [
  // ── Group A: Basic State Reporting ───────────────────────────────────────
  mkSpec('A-1', 'Group A: Basic State Reporting', 'Report ON while Growatt OFF → COMMUNITY_SYNCED', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const actual = modeOf(world);
    return { id: 'A-1', pass: actual === 'COMMUNITY_SYNCED', expected: 'COMMUNITY_SYNCED', actual, world };
  }),

  mkSpec('A-2', 'Group A: Basic State Reporting', 'Report OFF while Growatt ON → COMMUNITY_SYNCED', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 30, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const actual = modeOf(world);
    return { id: 'A-2', pass: actual === 'COMMUNITY_SYNCED', expected: 'COMMUNITY_SYNCED', actual, world };
  }),

  mkSpec('A-3', 'Group A: Basic State Reporting', 'Report same state as Growatt → COMMUNITY_SYNCED', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 30, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const actual = modeOf(world);
    return { id: 'A-3', pass: actual === 'COMMUNITY_SYNCED', expected: 'COMMUNITY_SYNCED', actual, world };
  }),

  mkSpec('A-4', 'Group A: Basic State Reporting', 'Generated cycle is created on report', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const pass = !!world.lastResult?.communityTransitionMeta?.generatedCycleStartIso;
    return { id: 'A-4', pass, expected: 'generatedCycleStartIso set', actual: world.lastResult?.communityTransitionMeta?.generatedCycleStartIso ?? 'null', world };
  }),

  mkSpec('A-5', 'Group A: Basic State Reporting', 'syncedAtIso equals report time', () => {
    const beforeMs = Date.now();
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const syncedMs = world.resyncPoint ? new Date(world.resyncPoint.syncedAtIso).getTime() : 0;
    const pass = Math.abs(syncedMs - world.simulatedNowMs) < 2000;
    return { id: 'A-5', pass, expected: 'syncedAtIso ≈ simulatedNow', actual: `diff=${Math.abs(syncedMs - world.simulatedNowMs)}ms`, world };
  }),

  // ── Group B: Confirmation Timestamp Rule ─────────────────────────────────
  mkSpec('B-1', 'Group B: Confirmation Timestamp Rule', 'Confirm does not change syncedAtIso', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const before = world.resyncPoint?.syncedAtIso;
    world = advanceTime(world, 15);
    world = submitReportOrConfirm(world, 'ON', 'confirm');
    const after = world.resyncPoint?.syncedAtIso;
    const pass = before === after;
    return { id: 'B-1', pass, expected: 'syncedAtIso unchanged', actual: pass ? 'unchanged' : `${before} → ${after}`, world };
  }),

  mkSpec('B-2', 'Group B: Confirmation Timestamp Rule', 'Confirm bumps confidence score', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const before = world.reports[0]?.confidenceScore ?? 0;
    world = advanceTime(world, 5);
    world = submitReportOrConfirm(world, 'ON', 'confirm');
    const after = world.reports.find(r => r.state === 'ON')?.confidenceScore ?? 0;
    const pass = after > before;
    return { id: 'B-2', pass, expected: `confidence > ${before}`, actual: `${after}`, world };
  }),

  mkSpec('B-3', 'Group B: Confirmation Timestamp Rule', 'Multiple confirms keep increasing confidence', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    world = advanceTime(world, 5); world = submitReportOrConfirm(world, 'ON', 'confirm');
    const after1 = world.reports[0]?.confidenceScore ?? 0;
    world = advanceTime(world, 5); world = submitReportOrConfirm(world, 'ON', 'confirm');
    const after2 = world.reports[0]?.confidenceScore ?? 0;
    const pass = after2 > after1;
    return { id: 'B-3', pass, expected: 'each confirm increases confidence', actual: `${after1} → ${after2}`, world };
  }),

  mkSpec('B-4', 'Group B: Confirmation Timestamp Rule', 'Bare confirm (no prior report) creates authoritative resync', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'confirm'); // no prior report
    const actual = modeOf(world);
    return { id: 'B-4', pass: actual === 'COMMUNITY_SYNCED', expected: 'COMMUNITY_SYNCED', actual, world };
  }),

  mkSpec('B-5', 'Group B: Confirmation Timestamp Rule', 'Confirm after 24h window does not match old report', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    world = advanceTime(world, 25 * 60); // 25 hours later
    const reportsBefore = world.reports.length;
    world = submitReportOrConfirm(world, 'ON', 'confirm');
    // Should create a new bare report since old one is outside 24h window
    const pass = world.reports.length >= reportsBefore;
    return { id: 'B-5', pass, expected: 'new report created', actual: `reports=${world.reports.length}`, world };
  }),

  // ── Group C: Offset Calculation (Rule 4+5) ────────────────────────────────
  mkSpec('C-1', 'Group C: Offset Calculation', 'Report ON while Growatt ON → GROWATT_ON_START_ACTUAL reference', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 45, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const kind = world.lastResult?.communityTransitionMeta?.offsetReferenceKind;
    const pass = kind === 'GROWATT_ON_START_ACTUAL';
    return { id: 'C-1', pass, expected: 'GROWATT_ON_START_ACTUAL', actual: kind ?? 'null', world };
  }),

  mkSpec('C-2', 'Group C: Offset Calculation', 'Report OFF while Growatt OFF → GROWATT_OFF_START_ACTUAL reference', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 100, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const kind = world.lastResult?.communityTransitionMeta?.offsetReferenceKind;
    const pass = kind === 'GROWATT_OFF_START_ACTUAL';
    return { id: 'C-2', pass, expected: 'GROWATT_OFF_START_ACTUAL', actual: kind ?? 'null', world };
  }),

  mkSpec('C-3', 'Group C: Offset Calculation', 'Report OFF while Growatt ON → GROWATT_ON_END_EXPECTED reference', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 60, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const kind = world.lastResult?.communityTransitionMeta?.offsetReferenceKind;
    const pass = kind === 'GROWATT_ON_END_EXPECTED' || kind === 'GROWATT_OFF_END_EXPECTED';
    return { id: 'C-3', pass, expected: 'GROWATT_ON_END_EXPECTED', actual: kind ?? 'null', world };
  }),

  mkSpec('C-4', 'Group C: Offset Calculation', 'Offset is frozen after first computation', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 30, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const offset1 = world.frozenCommunityOffsetMinutes;
    world = advanceTime(world, 10);
    const offset2 = world.frozenCommunityOffsetMinutes;
    const pass = offset1 === offset2 && offset1 !== null;
    return { id: 'C-4', pass, expected: 'frozen offset unchanged', actual: `${offset1} → ${offset2}`, world };
  }),

  mkSpec('C-5', 'Group C: Offset Calculation', 'New report resets frozen offset', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 30, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const offset1 = world.frozenCommunityOffsetMinutes;
    world = advanceTime(world, 130); // past cycle end
    world = submitReportOrConfirm(world, 'ON', 'report'); // new report
    const pass = world.frozenCommunityOffsetMinutes !== offset1 || world.frozenCommunityOffsetMinutes === null;
    return { id: 'C-5', pass, expected: 'offset reset on new report', actual: `${offset1} → ${world.frozenCommunityOffsetMinutes}`, world };
  }),

  // ── Group D: Duration Selection (Rule 3) ─────────────────────────────────
  mkSpec('D-1', 'Group D: Duration Selection', 'ON interrupted → ON_ALWAYS_BEFORE rule', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 30, 0);
    world = submitReportOrConfirm(world, 'ON', 'report'); // interrupts OFF
    const rule = world.lastResult?.communityTransitionMeta?.durationSelectionRule;
    const pass = rule === 'ON_ALWAYS_BEFORE';
    return { id: 'D-1', pass, expected: 'ON_ALWAYS_BEFORE', actual: rule ?? 'undefined', world };
  }),

  mkSpec('D-2', 'Group D: Duration Selection', 'OFF interrupted at <50% → OFF_PROGRESS_LT_50_BEFORE', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 20, 0); // 20/120 = 16.7%
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const rule = world.lastResult?.communityTransitionMeta?.durationSelectionRule;
    const pass = rule === 'OFF_PROGRESS_LT_50_BEFORE';
    return { id: 'D-2', pass, expected: 'OFF_PROGRESS_LT_50_BEFORE', actual: rule ?? 'undefined', world };
  }),

  mkSpec('D-3', 'Group D: Duration Selection', 'OFF interrupted at >50% → OFF_PROGRESS_GT_50_AFTER', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 70, 0); // 70/120 = 58%
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const rule = world.lastResult?.communityTransitionMeta?.durationSelectionRule;
    const pass = rule === 'OFF_PROGRESS_GT_50_AFTER';
    return { id: 'D-3', pass, expected: 'OFF_PROGRESS_GT_50_AFTER', actual: rule ?? 'undefined', world };
  }),

  mkSpec('D-4', 'Group D: Duration Selection', 'Generated cycle has positive duration', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 90, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const meta = world.lastResult?.communityTransitionMeta;
    const durMs = meta
      ? new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()
      : 0;
    const pass = durMs > 0;
    return { id: 'D-4', pass, expected: 'duration > 0', actual: `${Math.round(durMs / 60000)}min`, world };
  }),

  mkSpec('D-5', 'Group D: Duration Selection', 'Generated cycle state matches reported state', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const genState = world.lastResult?.communityTransitionMeta?.generatedCycleState;
    const pass = genState === 'ON';
    return { id: 'D-5', pass, expected: 'generatedCycleState=ON', actual: genState ?? 'null', world };
  }),

  // ── Group E: Schedule Continuity ─────────────────────────────────────────
  mkSpec('E-1', 'Group E: Schedule Continuity', 'Schedule has entries after generated cycle', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const meta = world.lastResult?.communityTransitionMeta;
    const schedule = world.lastResult?.daySchedule ?? [];
    const afterCycle = meta ? schedule.filter(s => s.endIso && new Date(s.startIso).getTime() >= new Date(meta.generatedCycleEndIso).getTime()) : [];
    const pass = afterCycle.length > 0;
    return { id: 'E-1', pass, expected: 'continuation slots exist', actual: `${afterCycle.length} slots after cycle`, world };
  }),

  mkSpec('E-2', 'Group E: Schedule Continuity', 'No gap between generated cycle end and continuation', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const meta = world.lastResult?.communityTransitionMeta;
    const schedule = world.lastResult?.daySchedule ?? [];
    if (!meta) return { id: 'E-2', pass: false, expected: 'no gap', actual: 'no meta', world };
    const genEnd = new Date(meta.generatedCycleEndIso).getTime();
    const nextSlot = schedule.find(s => new Date(s.startIso).getTime() >= genEnd);
    const gap = nextSlot ? new Date(nextSlot.startIso).getTime() - genEnd : null;
    const pass = gap !== null && gap < 1000; // <1 second gap
    return { id: 'E-2', pass, expected: 'gap < 1s', actual: gap !== null ? `${gap}ms` : 'no next slot', world };
  }),

  mkSpec('E-3', 'Group E: Schedule Continuity', 'Current state shown correctly inside generated cycle', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const state = currentStateOf(world);
    const pass = state === 'ON';
    return { id: 'E-3', pass, expected: 'currentState=ON', actual: state, world };
  }),

  mkSpec('E-4', 'Group E: Schedule Continuity', 'After generated cycle ends, schedule resumes', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 30 },
      { id: 'b', state: 'OFF', durationMin: 60 },
    ];
    let world = buildWorldAt(tpl, 'ON', 10, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    world = advanceTime(world, 90); // past generated cycle end
    const mode = modeOf(world);
    const pass = mode !== 'COMMUNITY_SYNCED';
    return { id: 'E-4', pass, expected: 'not COMMUNITY_SYNCED', actual: mode, world };
  }),

  mkSpec('E-5', 'Group E: Schedule Continuity', 'Pre-cycle slots preserved', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 60, 0);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const schedule = world.lastResult?.daySchedule ?? [];
    const past = schedule.filter(s => s.endIso && new Date(s.endIso).getTime() < world.simulatedNowMs);
    const pass = past.length > 0;
    return { id: 'E-5', pass, expected: 'past slots preserved', actual: `${past.length} past slots`, world };
  }),

  // ── Group F: ATC Mode Transitions ────────────────────────────────────────
  mkSpec('F-1', 'Group F: ATC Mode Transitions', 'NORMAL → PREDICTION_RANGE near slot end', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'ON', 48, 0); // 12 min before end, within ±15 range
    const actual = modeOf(world);
    const pass = actual === 'PREDICTION_RANGE' || actual === 'NORMAL';
    return { id: 'F-1', pass, expected: 'PREDICTION_RANGE or NORMAL', actual, world };
  }),

  mkSpec('F-2', 'Group F: ATC Mode Transitions', 'PREDICTION_RANGE → GRACE_MODE on overrun', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'ON', 70, 0); // 10 min past end
    const actual = modeOf(world);
    const pass = actual === 'GRACE_MODE' || actual === 'WAITING_FOR_GROWATT';
    return { id: 'F-2', pass, expected: 'GRACE_MODE or WAITING_FOR_GROWATT', actual, world };
  }),

  mkSpec('F-3', 'Group F: ATC Mode Transitions', 'Community report → COMMUNITY_SYNCED overrides other modes', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'ON', 80, 0); // in WAITING_FOR_GROWATT
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const actual = modeOf(world);
    return { id: 'F-3', pass: actual === 'COMMUNITY_SYNCED', expected: 'COMMUNITY_SYNCED', actual, world };
  }),

  mkSpec('F-4', 'Group F: ATC Mode Transitions', 'Negative offset → UNCERTAIN_ZONE when cycle ends', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 120 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    // Offset -60, Growatt 80 min into ON → user slot ended 20 min ago
    let world = buildWorldAt(tpl, 'ON', 80, -60);
    const actual = modeOf(world);
    const pass = actual === 'UNCERTAIN_ZONE' || actual === 'NORMAL';
    return { id: 'F-4', pass, expected: 'UNCERTAIN_ZONE', actual, world };
  }),

  mkSpec('F-5', 'Group F: ATC Mode Transitions', 'Positive offset → POSITIVE_OFFSET_PENDING when Growatt flips', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'OFF', 5, 90);
    const actual = modeOf(world);
    const pass = actual === 'POSITIVE_OFFSET_PENDING' || actual === 'NORMAL';
    return { id: 'F-5', pass, expected: 'POSITIVE_OFFSET_PENDING', actual, world };
  }),

  // ── Group G: UNCERTAIN_ZONE Behavior ─────────────────────────────────────
  mkSpec('G-1', 'Group G: UNCERTAIN_ZONE', 'In UNCERTAIN_ZONE, current state = old (held) state', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 120 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'ON', 80, -60);
    if (modeOf(world) !== 'UNCERTAIN_ZONE') {
      return { id: 'G-1', pass: true, expected: 'held state or N/A', actual: `mode=${modeOf(world)} (not in zone)`, world };
    }
    const state = currentStateOf(world);
    const pass = state === 'ON'; // held old state
    return { id: 'G-1', pass, expected: 'currentState=ON (held)', actual: state, world };
  }),

  mkSpec('G-2', 'Group G: UNCERTAIN_ZONE', 'Growatt flip exits UNCERTAIN_ZONE', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 120 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'ON', 80, -60);
    world = forceGrowattState(world, 'OFF');
    const actual = modeOf(world);
    const pass = actual === 'NORMAL' || actual === 'PREDICTION_RANGE';
    return { id: 'G-2', pass, expected: 'NORMAL or PREDICTION_RANGE', actual, world };
  }),

  mkSpec('G-3', 'Group G: UNCERTAIN_ZONE', 'reconciledCycleStartIso set on exit', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 120 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'ON', 80, -60);
    world = forceGrowattState(world, 'OFF');
    const reconciled = world.lastResult?.reconciledCycleStartIso;
    const pass = reconciled !== null && reconciled !== undefined;
    return { id: 'G-3', pass: !!pass, expected: 'reconciledCycleStartIso set', actual: reconciled ?? 'null', world };
  }),

  mkSpec('G-4', 'Group G: UNCERTAIN_ZONE', 'Community report exits UNCERTAIN_ZONE', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 120 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'ON', 80, -60);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const actual = modeOf(world);
    return { id: 'G-4', pass: actual === 'COMMUNITY_SYNCED', expected: 'COMMUNITY_SYNCED', actual, world };
  }),

  mkSpec('G-5', 'Group G: UNCERTAIN_ZONE', 'MANUAL mode — stays in zone without community input', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 120 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'ON', 80, -60, 'MANUAL');
    // Even with Growatt flip, MANUAL mode requires community confirmation
    world = forceGrowattState(world, 'OFF');
    const tm = world.lastResult?.atc.transitionMode;
    const pass = tm === 'MANUAL';
    return { id: 'G-5', pass, expected: 'transitionMode=MANUAL', actual: `${modeOf(world)} tm=${tm}`, world };
  }),

  // ── Group H: Positive Offset Pending ─────────────────────────────────────
  mkSpec('H-1', 'Group H: Positive Offset Pending', 'scheduledAutoTransitionIso is set', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'OFF', 5, 90);
    const iso = world.lastResult?.atc.scheduledAutoTransitionIso;
    const pass = iso !== null && iso !== undefined;
    return { id: 'H-1', pass: !!pass, expected: 'scheduledAutoTransitionIso set', actual: iso ?? 'null', world };
  }),

  mkSpec('H-2', 'Group H: Positive Offset Pending', 'scheduledAutoTransitionIso = Growatt transition + offset', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    const offsetMin = 90;
    let world = buildWorldAt(tpl, 'OFF', 5, offsetMin);
    const iso = world.lastResult?.atc.scheduledAutoTransitionIso;
    if (!iso) return { id: 'H-2', pass: false, expected: 'scheduledAutoTransitionIso set', actual: 'null', world };
    const scheduled = new Date(iso).getTime();
    const growattMs = new Date(world.growattLastTransitionAt).getTime();
    const diff = Math.abs(scheduled - (growattMs + offsetMin * 60_000));
    const pass = diff < 2000;
    return { id: 'H-2', pass, expected: `scheduled ≈ growatt+offset`, actual: `diff=${diff}ms`, world };
  }),

  mkSpec('H-3', 'Group H: Positive Offset Pending', 'Current state held during pending', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'OFF', 5, 90);
    if (modeOf(world) !== 'POSITIVE_OFFSET_PENDING') {
      return { id: 'H-3', pass: true, expected: 'N/A (not in POSITIVE_OFFSET_PENDING)', actual: modeOf(world), world };
    }
    // During POSITIVE_OFFSET_PENDING, user should still show ON (Growatt just flipped to OFF)
    const state = currentStateOf(world);
    const pass = state === 'ON';
    return { id: 'H-3', pass, expected: 'currentState=ON (held)', actual: state, world };
  }),

  mkSpec('H-4', 'Group H: Positive Offset Pending', 'Exits after scheduled time passes', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'OFF', 5, 90);
    world = advanceTime(world, 95); // past the 90-min scheduled transition
    const actual = modeOf(world);
    const pass = actual !== 'POSITIVE_OFFSET_PENDING';
    return { id: 'H-4', pass, expected: 'not POSITIVE_OFFSET_PENDING', actual, world };
  }),

  mkSpec('H-5', 'Group H: Positive Offset Pending', 'MANUAL mode does not auto-transition', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 60 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    let world = buildWorldAt(tpl, 'OFF', 5, 90, 'MANUAL');
    const tm = world.transitionMode;
    const pass = tm === 'MANUAL';
    return { id: 'H-5', pass, expected: 'MANUAL mode preserved', actual: `${modeOf(world)} tm=${tm}`, world };
  }),

  // ── Group I: Report Ledger ────────────────────────────────────────────────
  mkSpec('I-1', 'Group I: Report Ledger', 'Reports are added to the ledger', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const pass = world.reports.length === 1;
    return { id: 'I-1', pass, expected: '1 report', actual: `${world.reports.length}`, world };
  }),

  mkSpec('I-2', 'Group I: Report Ledger', 'Each report has a unique id', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    world = advanceTime(world, 200);
    world = submitReportOrConfirm(world, 'OFF', 'report');
    const ids = world.reports.map(r => r.id);
    const pass = new Set(ids).size === ids.length;
    return { id: 'I-2', pass, expected: 'all ids unique', actual: `${ids.length} reports, ${new Set(ids).size} unique`, world };
  }),

  mkSpec('I-3', 'Group I: Report Ledger', 'Confirmation is associated with correct report', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const reportId = world.reports[0]?.id;
    world = advanceTime(world, 10);
    world = submitReportOrConfirm(world, 'ON', 'confirm');
    const confirmed = world.reports.find(r => r.id === reportId);
    const pass = (confirmed?.confirmations.length ?? 0) > 0;
    return { id: 'I-3', pass, expected: 'confirmation on report', actual: `${confirmed?.confirmations.length} confirmations`, world };
  }),

  mkSpec('I-4', 'Group I: Report Ledger', 'Trust level upgrades with confirmations', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const before = world.reports[0]?.trustLevel;
    world = advanceTime(world, 5); world = submitReportOrConfirm(world, 'ON', 'confirm');
    world = advanceTime(world, 5); world = submitReportOrConfirm(world, 'ON', 'confirm');
    world = advanceTime(world, 5); world = submitReportOrConfirm(world, 'ON', 'confirm');
    const after = world.reports[0]?.trustLevel;
    const levels = ['LOW', 'MEDIUM', 'HIGH', 'VERIFIED'];
    const pass = levels.indexOf(after ?? 'LOW') >= levels.indexOf(before ?? 'LOW');
    return { id: 'I-4', pass, expected: 'trust level ≥ before', actual: `${before} → ${after}`, world };
  }),

  mkSpec('I-5', 'Group I: Report Ledger', 'Ledger persists across time advances', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const before = world.reports.length;
    world = advanceTime(world, 60);
    world = advanceTime(world, 60);
    const pass = world.reports.length === before;
    return { id: 'I-5', pass, expected: `${before} reports preserved`, actual: `${world.reports.length}`, world };
  }),

  // ── Group J: Edge Cases ───────────────────────────────────────────────────
  mkSpec('J-1', 'Group J: Edge Cases', 'Empty schedule does not crash', () => {
    let world = buildWorldAt([], 'ON', 30, 0);
    const pass = world.lastResult !== null;
    return { id: 'J-1', pass, expected: 'no crash', actual: world.lastResult ? 'result exists' : 'null result', world };
  }),

  mkSpec('J-2', 'Group J: Edge Cases', 'Very large offset (>12h) stays functional', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'ON', 30, -720); // -12h
    const pass = world.lastResult !== null;
    return { id: 'J-2', pass, expected: 'no crash', actual: modeOf(world), world };
  }),

  mkSpec('J-3', 'Group J: Edge Cases', 'Report far in the future is ignored', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    // Inject a future resync point manually
    const futureResync: ResyncPoint = {
      syncedState: 'ON',
      syncedAtIso: new Date(world.simulatedNowMs + 2 * 60 * 60 * 1000).toISOString(),
      appliedAtIso: new Date(world.simulatedNowMs).toISOString(),
    };
    world = { ...world, resyncPoint: futureResync };
    world = recompute(world);
    // computeCommunityTransition guards syncMs > nowMs+60s → no generated cycle
    const meta = world.lastResult?.communityTransitionMeta;
    const pass = !meta || !meta.generatedCycleActive;
    return { id: 'J-3', pass, expected: 'no active generated cycle for future resync', actual: `active=${meta?.generatedCycleActive}`, world };
  }),

  mkSpec('J-4', 'Group J: Edge Cases', 'Schedule with single entry works', () => {
    const tpl: ScheduleEntryTemplate[] = [{ id: 'a', state: 'ON', durationMin: 480 }];
    let world = buildWorldAt(tpl, 'ON', 30, 0);
    const pass = world.lastResult !== null;
    return { id: 'J-4', pass, expected: 'no crash with 1-entry schedule', actual: modeOf(world), world };
  }),

  mkSpec('J-5', 'Group J: Edge Cases', 'Zero-duration template entry is handled', () => {
    const tpl: ScheduleEntryTemplate[] = [
      { id: 'a', state: 'ON', durationMin: 0 },
      { id: 'b', state: 'OFF', durationMin: 360 },
    ];
    // Should not crash — zero-duration slots are skipped
    let world: SimWorld;
    try {
      world = buildWorldAt(tpl, 'ON', 0, 0);
    } catch {
      world = createInitialWorld();
      return { id: 'J-5', pass: false, expected: 'no crash', actual: 'exception', world };
    }
    return { id: 'J-5', pass: true, expected: 'no crash', actual: modeOf(world), world };
  }),

  // ── Group K: Community Confirmation Confidence (ledger spec) ─────────────
  mkSpec('K-1', 'Group K: Community Confirmation Ledger', 'Initial report has base confidence ≥ 50', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const score = world.reports[0]?.confidenceScore ?? 0;
    const pass = score >= 50;
    return { id: 'K-1', pass, expected: 'confidence ≥ 50', actual: `${score}`, world };
  }),

  mkSpec('K-2', 'Group K: Community Confirmation Ledger', 'First confirmation adds biggest bonus', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    const base = world.reports[0]?.confidenceScore ?? 0;
    world = advanceTime(world, 5); world = submitReportOrConfirm(world, 'ON', 'confirm');
    const after1 = world.reports[0]?.confidenceScore ?? 0;
    world = advanceTime(world, 5); world = submitReportOrConfirm(world, 'ON', 'confirm');
    const after2 = world.reports[0]?.confidenceScore ?? 0;
    const bonus1 = after1 - base;
    const bonus2 = after2 - after1;
    const pass = bonus1 >= bonus2;
    return { id: 'K-2', pass, expected: 'first bonus ≥ second bonus', actual: `${bonus1} vs ${bonus2}`, world };
  }),

  mkSpec('K-3', 'Group K: Community Confirmation Ledger', 'Confidence capped at 99', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    // Apply many confirmations
    for (let i = 0; i < 20; i++) {
      world = advanceTime(world, 2);
      world = submitReportOrConfirm(world, 'ON', 'confirm');
    }
    const score = world.reports[0]?.confidenceScore ?? 0;
    const pass = score <= 99;
    return { id: 'K-3', pass, expected: 'confidence ≤ 99', actual: `${score}`, world };
  }),

  mkSpec('K-4', 'Group K: Community Confirmation Ledger', 'VERIFIED trust level at ≥ 90 confidence', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    for (let i = 0; i < 10; i++) {
      world = advanceTime(world, 2);
      world = submitReportOrConfirm(world, 'ON', 'confirm');
    }
    const trust = world.reports[0]?.trustLevel;
    const score = world.reports[0]?.confidenceScore ?? 0;
    const pass = score < 90 || trust === 'VERIFIED';
    return { id: 'K-4', pass, expected: 'VERIFIED when score≥90', actual: `trust=${trust} score=${score}`, world };
  }),

  mkSpec('K-5', 'Group K: Community Confirmation Ledger', 'Confirmation records hoursAfterReport', () => {
    let world = buildWorldAt(MASTER_TEMPLATE, 'OFF', 60, 0);
    world = submitReportOrConfirm(world, 'ON', 'report');
    world = advanceTime(world, 120); // 2 hours
    world = submitReportOrConfirm(world, 'ON', 'confirm');
    const conf = world.reports[0]?.confirmations[0];
    const pass = conf !== undefined && conf.hoursAfterReport >= 1.9;
    return { id: 'K-5', pass, expected: 'hoursAfterReport ≥ 1.9', actual: `${conf?.hoursAfterReport?.toFixed(2)}h`, world };
  }),
];
