/**
 * TMMS V2 Simulation Layer — Validation & Compliance Framework
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
      state: entry.state, startIso, endIso,
      startFormatted: fmtYemenTime(startIso), endFormatted: fmtYemenTime(endIso),
      durationLabel: durationLabelFromMin(entry.durationMin),
      zone: getZoneFromIso(startIso), isEstimated: false,
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
  { id: 't5', state: 'ON',  durationMin: 120 },
  { id: 't6', state: 'OFF', durationMin: 360 },
];

export interface SimEvent {
  id: string; simTimeIso: string; action: string; decision: string | null; result: string | null;
  kind: 'info' | 'report' | 'confirm' | 'growatt' | 'offset' | 'zone' | 'error' | 'time';
}

export interface SimWorld {
  scheduleTemplate: ScheduleEntryTemplate[];
  scheduleAnchorIso: string;
  simulatedNowMs: number;
  growattCurrentState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  offsetMinutes: number;
  frozenCommunityOffsetMinutes: number | null;
  resyncPoint: ResyncPoint | null;
  confidenceScore: number;
  transitionMode: TransitionMode;
  eventLog: SimEvent[];
  lastResult: UserPrediction | null;
  lastDecisionTrace: DecisionStep[];
}

let eventIdCounter = 0;
function makeEvent(world: SimWorld, kind: SimEvent['kind'], action: string, decision: string | null = null, result: string | null = null): SimEvent {
  eventIdCounter += 1;
  return { id: `evt_${eventIdCounter}_${Date.now()}`, simTimeIso: new Date(world.simulatedNowMs).toISOString(), action, decision, result, kind };
}

export function createInitialWorld(nowMs: number = Date.now()): SimWorld {
  const anchor = new Date(nowMs - 3 * 3600 * 1000).toISOString();
  const base: SimWorld = {
    scheduleTemplate: DEFAULT_TEMPLATE, scheduleAnchorIso: anchor, simulatedNowMs: nowMs,
    growattCurrentState: 'ON', growattLastTransitionAt: anchor, offsetMinutes: 0,
    frozenCommunityOffsetMinutes: null, resyncPoint: null, confidenceScore: 0,
    transitionMode: 'AUTO', eventLog: [], lastResult: null, lastDecisionTrace: [],
  };
  return refreshResult(base);
}

function worldToPrediction(world: SimWorld): Prediction {
  const horizonMs = world.simulatedNowMs + 48 * 3600 * 1000;
  return {
    currentState: world.growattCurrentState, currentStateDurationMin: 0, currentStateDurationLabel: '',
    lastTransitionAt: world.growattLastTransitionAt, inverterOffline: false, nextTransition: null,
    expectedOffRange: null, expectedOnRange: null, daySchedule: buildScheduleSlots(world.scheduleTemplate, world.scheduleAnchorIso, horizonMs),
    confidence: world.confidenceScore, confidenceLabel: 'High', isUnstable: false, stabilityScore: 1, stabilityLabel: 'Stable',
    dayPattern: null, nightPattern: null, allPattern: null, cyclesAnalyzed: 0, dayCyclesAnalyzed: 0, nightCyclesAnalyzed: 0,
    currentPeriod: 'day', reasoning: [], learningMode: 'prior_only', dataWindowHours: 48, computedAt: new Date(world.simulatedNowMs).toISOString(),
  };
}

export function runEngine(world: SimWorld): UserPrediction {
  const prediction = worldToPrediction(world);
  return applyOffsetToPrediction(prediction, world.offsetMinutes, world.resyncPoint, null, world.transitionMode, null, world.frozenCommunityOffsetMinutes, undefined, world.simulatedNowMs, undefined);
}

function refreshResult(world: SimWorld): SimWorld {
  const result = runEngine(world);
  return { ...world, lastResult: result, lastDecisionTrace: result.communityTransitionMeta?.decisionTrace ?? world.lastDecisionTrace };
}

export function advanceTime(world: SimWorld, minutes: number): SimWorld {
  const next = { ...world, simulatedNowMs: world.simulatedNowMs + minutes * 60_000 };
  next.eventLog = [...world.eventLog, makeEvent(next, 'time', `Advanced time +${minutes}m`)];
  return refreshResult(next);
}

export function setSimulatedNow(world: SimWorld, nowMs: number): SimWorld {
  return refreshResult({ ...world, simulatedNowMs: nowMs });
}

export function forceGrowattState(world: SimWorld, state: 'ON' | 'OFF'): SimWorld {
  if (state === world.growattCurrentState) return world;
  const next = { ...world, growattCurrentState: state, growattLastTransitionAt: new Date(world.simulatedNowMs).toISOString() };
  return refreshResult(next);
}

export function resetWorld(nowMs: number = Date.now()): SimWorld { return createInitialWorld(nowMs); }
export function setTransitionMode(world: SimWorld, mode: TransitionMode): SimWorld { return refreshResult({ ...world, transitionMode: mode }); }
export function setSchedule(world: SimWorld, template: ScheduleEntryTemplate[]): SimWorld { return refreshResult({ ...world, scheduleTemplate: template }); }

export function submitReportOrConfirm(
  world: SimWorld,
  state: 'ON' | 'OFF',
  kind: 'report' | 'confirm',
  eventAtMs?: number,
  reporterName: string = kind === 'report' ? 'Simulated User' : 'Simulated Confirmer',
): SimWorld {
  const rawEventTimeMs = eventAtMs ?? world.simulatedNowMs;
  let syncedAtIso = new Date(rawEventTimeMs).toISOString();
  let newConfidence = world.confidenceScore;
  let isLateConfirm = false;

  if (kind === 'confirm' && world.resyncPoint && world.resyncPoint.syncedState === state) {
    // ENFORCE RULE: Use the existing report's timestamp
    syncedAtIso = world.resyncPoint.syncedAtIso;
    newConfidence = Math.min(100, world.confidenceScore + 25);
    isLateConfirm = true;
  } else {
    // Fresh report (or confirm acting as a first report)
    newConfidence = 50;
  }

  const resyncPoint: ResyncPoint = {
    syncedState: state, syncedAtIso,
    appliedAtIso: new Date(world.simulatedNowMs).toISOString(),
    reporterName, reporterReliability: newConfidence,
  };

  let next: SimWorld = { 
    ...world, 
    resyncPoint, 
    confidenceScore: newConfidence,
    frozenCommunityOffsetMinutes: isLateConfirm ? world.frozenCommunityOffsetMinutes : null 
  };
  
  const result = runEngine(next);
  const meta = result.communityTransitionMeta;
  const log: SimEvent[] = [...world.eventLog, makeEvent(next, kind, `${kind} ${state} processed`, null, `Time used: ${fmtYemenTime(syncedAtIso)} | Conf: ${newConfidence}%`)];

  if (meta && meta.isFreshOffsetComputation && !isLateConfirm) {
    next = { ...next, frozenCommunityOffsetMinutes: meta.offsetMinutes };
    log.push(makeEvent(next, 'offset', 'Offset frozen', null, `${meta.offsetMinutes}m`));
  }

  return { ...next, eventLog: log, lastResult: result, lastDecisionTrace: meta?.decisionTrace ?? next.lastDecisionTrace };
}

// ── SCENARIO VALIDATION SUITE ───────────────────────────────────────────────
export interface ScenarioResult { pass: boolean; actual: string; expected: string; world: SimWorld; group: string; }
export interface ScenarioDef { id: string; group: string; name: string; expected: string; run: () => ScenarioResult; }

function freshBase(nowMs: number) {
  const anchor = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  return { world: { ...createInitialWorld(nowMs), scheduleAnchorIso: anchor, growattLastTransitionAt: anchor, eventLog: [] }, anchor };
}

const N = Date.now();
export const SCENARIOS: ScenarioDef[] = [
  // ── GROUP D: OFF Progress Validation ──
  {
    id: 'D1', group: 'GROUP D', name: 'OFF Progress < 50% → Prev ON', expected: '120min (Prev ON)',
    run: () => {
      const { world: w0, anchor } = freshBase(N);
      let w = setSimulatedNow(w0, new Date(anchor).getTime() + 180 * 60_000); // 1h into 6h OFF (16%)
      w = submitReportOrConfirm(w, 'ON', 'report');
      const meta = w.lastResult?.communityTransitionMeta;
      const dur = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60000 : 0;
      return { pass: dur === 120, actual: `${dur}min`, expected: '120min', world: w, group: 'GROUP D' };
    }
  },
  {
    id: 'D2', group: 'GROUP D', name: 'OFF Progress > 50% → Next ON', expected: '180min (Next ON)',
    run: () => {
      const { world: w0, anchor } = freshBase(N);
      let w = setSimulatedNow(w0, new Date(anchor).getTime() + 360 * 60_000); // 4h into 6h OFF (66%)
      w = submitReportOrConfirm(w, 'ON', 'report');
      const meta = w.lastResult?.communityTransitionMeta;
      const dur = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60000 : 0;
      return { pass: dur === 180, actual: `${dur}min`, expected: '180min', world: w, group: 'GROUP D' };
    }
  },
  // ── GROUP E: ON Interruption Validation ──
  {
    id: 'E1', group: 'GROUP E', name: 'ON Interrupted (Any %) → Prev OFF', expected: '360min (Prev OFF)',
    run: () => {
      const { world: w0, anchor } = freshBase(N);
      let w = setSimulatedNow(w0, new Date(anchor).getTime() + 600 * 60_000); // ON slot (anchor+8h). Interrupt at 10h.
      w = submitReportOrConfirm(w, 'OFF', 'report');
      const meta = w.lastResult?.communityTransitionMeta;
      const dur = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60000 : 0;
      return { pass: dur === 360 && meta?.durationSelectionRule === 'ON_ALWAYS_BEFORE', actual: `${dur}min, ${meta?.durationSelectionRule}`, expected: '360min', world: w, group: 'GROUP E' };
    }
  },
  // ── GROUP K: Historical Confirmation Validation ──
  {
    id: 'K2', group: 'GROUP K', name: 'Late Confirmation (+4h) Rule', expected: 'Uses original time, no new offset',
    run: () => {
      const { world: w0, anchor } = freshBase(N);
      let w = setSimulatedNow(w0, new Date(anchor).getTime() + 180 * 60_000); // T
      w = submitReportOrConfirm(w, 'ON', 'report');
      const originalMeta = w.lastResult?.communityTransitionMeta;
      const origStart = originalMeta?.generatedCycleStartIso;
      
      // Advance 4 hours and confirm
      w = setSimulatedNow(w, w.simulatedNowMs + 240 * 60_000); 
      w = submitReportOrConfirm(w, 'ON', 'confirm');
      
      const newMeta = w.lastResult?.communityTransitionMeta;
      const newStart = newMeta?.generatedCycleStartIso;
      
      const pass = origStart === newStart && w.confidenceScore > 50 && newMeta?.isFreshOffsetComputation === false;
      return { pass, actual: `Start: ${newStart}, FreshOffset: ${newMeta?.isFreshOffsetComputation}`, expected: `Start: ${origStart}, FreshOffset: false`, world: w, group: 'GROUP K' };
    }
  },
  {
    id: 'K8', group: 'GROUP K', name: 'Confirm After Generated State Completes', expected: 'State not recreated, conf increases',
    run: () => {
      const { world: w0, anchor } = freshBase(N);
      let w = setSimulatedNow(w0, new Date(anchor).getTime() + 180 * 60_000); 
      w = submitReportOrConfirm(w, 'ON', 'report'); // Gen ON (2h)
      
      // Advance 3 hours (past the 2h generated cycle end)
      w = setSimulatedNow(w, w.simulatedNowMs + 180 * 60_000); 
      w = submitReportOrConfirm(w, 'ON', 'confirm');
      
      const pass = w.lastResult?.atc.mode !== 'COMMUNITY_SYNCED' && w.confidenceScore > 50;
      return { pass, actual: `Mode: ${w.lastResult?.atc.mode}, Conf: ${w.confidenceScore}`, expected: `Mode leaves SYNCED, Conf increases`, world: w, group: 'GROUP K' };
    }
  }
];
