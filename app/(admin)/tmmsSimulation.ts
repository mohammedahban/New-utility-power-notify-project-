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
  createReportRecord,
  findConfirmableReport,
  applyConfirmationToReport,
  computeCommunityOffset,
  type Prediction,
  type ScheduleSlot,
  type ResyncPoint,
  type UserPrediction,
  type TransitionMode,
  type DecisionStep,
  type ReportRecord,
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
  /** Persistent, ever-growing ledger of every community report ever
   *  submitted this session (Rule 2 / Group H persistence + Group K
   *  Confirmation Timestamp Rule). Never cleared by ordinary actions —
   *  only resetWorld() starts a fresh one. */
  reports: ReportRecord[];
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
    reports: [],
  };
  // Run the real engine once immediately so every panel has data to show on
  // first mount, instead of staying blank until the first user action.
  return refreshResult(base);
}

// ── Build the Prediction object the engine expects, from world state ─────────
function worldToPrediction(world: SimWorld): Prediction {
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
 * Section 5: Report / Confirm.
 *
 * REPORT (kind='report'): always creates a brand-new ReportRecord in the
 * persistent ledger (`world.reports`), using its OWN timestamp as the
 * authoritative `originalReportAtIso`. Unless `deferProcessing` is set, it is
 * processed immediately: a ResyncPoint is built from that timestamp and run
 * through the real engine, exactly as before.
 *
 * CONFIRM (kind='confirm'): per the COMMUNITY CONFIRMATION TIMESTAMP RULE,
 * a confirmation must NEVER create a new transition from its own timestamp.
 * It looks up the ledger (`findConfirmableReport`) for a matching report of
 * the same state within the Max Confirmation Window (24h):
 *   - Match found, already processed: confidence/trust ONLY. The existing
 *     ResyncPoint / frozen offset / generated state are left completely
 *     untouched — no recompute, no rebuild, regardless of how many
 *     confirmations arrive or how late (LATE CONFIRMATION RULE).
 *   - Match found, NOT YET processed (UNPROCESSED REPORT RULE): this
 *     confirmation is what triggers processing, but processing uses the
 *     report's ORIGINAL timestamp, never the confirmation's.
 *   - No match at all: there is nothing to confirm, so (per Scenario Group C)
 *     the confirmation is itself authoritative and is treated exactly like
 *     a fresh report.
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
  deferProcessing: boolean = false,
): SimWorld {
  const eventAtMs  = reportAtMs ?? world.simulatedNowMs;
  const eventAtIso = new Date(eventAtMs).toISOString();
  const nowIso     = new Date(world.simulatedNowMs).toISOString();

  if (kind === 'confirm') {
    const matched = findConfirmableReport(world.reports, state, eventAtMs);
    if (matched) {
      const updated  = applyConfirmationToReport(matched, eventAtIso, reporterName);
      const reports  = world.reports.map(r => (r.id === matched.id ? updated : r));
      let next: SimWorld = { ...world, reports };
      const log: SimEvent[] = [
        ...world.eventLog,
        makeEvent(next, 'confirm', `Confirmation ${state} received`, null,
          `confirms report originally timestamped ${fmtYemenTime(matched.originalReportAtIso)} — confidence ${matched.confidenceScore}→${updated.confidenceScore} (${updated.trustLevel})`),
      ];

      if (matched.processedAtIso === null) {
        // ── UNPROCESSED REPORT RULE ──────────────────────────────────────
        // This confirmation triggers processing, but using the ORIGINAL
        // report timestamp — never the confirmation's own.
        const resyncPoint: ResyncPoint = {
          syncedState: matched.state,
          syncedAtIso: matched.originalReportAtIso,
          appliedAtIso: nowIso,
          reporterName: matched.reporterName,
          reporterReliability: updated.confidenceScore,
        };
        next = { ...next, resyncPoint, frozenCommunityOffsetMinutes: null };
        const result = runEngine(next);
        const meta = result.communityTransitionMeta;
        if (meta?.isFreshOffsetComputation) {
          next = { ...next, frozenCommunityOffsetMinutes: meta.offsetMinutes };
        }
        next = { ...next, reports: next.reports.map(r => (r.id === matched.id ? { ...r, processedAtIso: nowIso } : r)) };
        log.push(makeEvent(next, 'info', 'Deferred report processed by confirmation', null,
          `using ORIGINAL report timestamp ${fmtYemenTime(matched.originalReportAtIso)} — NOT the confirmation's ${fmtYemenTime(eventAtIso)}`));
        if (meta) {
          for (const step of meta.decisionTrace) log.push(makeEvent(next, step.label.includes('Offset') ? 'offset' : 'info', step.label, null, step.detail));
        }
        return { ...next, eventLog: log, lastResult: result, lastDecisionTrace: meta?.decisionTrace ?? next.lastDecisionTrace };
      }

      // ── Already processed: confidence/trust ONLY, full stop. The
      // ResyncPoint and frozen offset are untouched — re-run the engine
      // purely to refresh lastResult against the current world clock (e.g.
      // a zone may have naturally changed simply because time passed).
      const result = runEngine(next);
      return { ...next, eventLog: log, lastResult: result, lastDecisionTrace: next.lastDecisionTrace };
    }
    // No matching report within the window — nothing to confirm. Falls
    // through to be treated as a fresh, independent report (Group C).
  }

  // ── kind === 'report', OR a "bare" confirmation with no antecedent ───────
  const reportRecord = createReportRecord(state, eventAtIso, reporterName, !deferProcessing, nowIso);
  let next: SimWorld = { ...world, reports: [...world.reports, reportRecord] };

  const log: SimEvent[] = [
    ...world.eventLog,
    makeEvent(next, kind, `${kind === 'report' ? 'Report' : 'Confirmation'} ${state} received`, null,
      deferProcessing ? `logged at ${fmtYemenTime(eventAtIso)} — processing deferred` : `synced at ${fmtYemenTime(eventAtIso)}`),
  ];

  if (deferProcessing) {
    return { ...next, eventLog: log };
  }

  const resyncPoint: ResyncPoint = {
    syncedState: state,
    syncedAtIso: eventAtIso,
    appliedAtIso: nowIso,
    reporterName,
    reporterReliability: reportRecord.confidenceScore,
  };
  next = { ...next, resyncPoint, frozenCommunityOffsetMinutes: null };
  const result = runEngine(next); // FRESH computation — full detail (referenceKind etc.)
  const meta = result.communityTransitionMeta;

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

// ════════════════════════════════════════════════════════════════════════════
// SPEC SCENARIOS — Groups A-K (literal scenario set from the TMMS V2 spec doc)
// ════════════════════════════════════════════════════════════════════════════
// Distinct from the 15 built-in scenarios above (which exercise the engine's
// mechanisms in general terms). These implement the EXACT lettered/numbered
// scenarios from the spec — including Group K, the Community Confirmation
// Timestamp Rule, which is the centerpiece of this validation pass.

export interface SpecScenarioResult { pass: boolean; expected: string; actual: string; world: SimWorld; }
export interface SpecScenarioDef { id: string; group: string; name: string; expected: string; run: () => SpecScenarioResult; }

const SPEC_DAY0 = Date.UTC(2026, 5, 21, 0, 0, 0);
function specClock(h: number, m = 0, dayOffset = 0): number { return SPEC_DAY0 + dayOffset * 86_400_000 + h * 3_600_000 + m * 60_000; }

/** Clock-aligned world for Groups A/B/C/D/E/G — anchored exactly 48h (3 full
 *  16h cycles) back, so the Master Test Schedule's ON/OFF boundaries land on
 *  the literal clock times the spec uses (02:00/04:00/10:00/13:00/18:00/20:00). */
function specClockAlignedWorld(nowMs: number): SimWorld {
  let w = createInitialWorld(nowMs);
  const anchorMs = specClock(2, 0, -2);
  w = {
    ...w,
    scheduleAnchorIso: new Date(anchorMs).toISOString(),
    growattLastTransitionAt: new Date(anchorMs).toISOString(),
    growattCurrentState: 'ON',
    resyncPoint: null,
    frozenCommunityOffsetMinutes: null,
    eventLog: [],
    reports: [],
  };
  return setSimulatedNow(w, nowMs);
}

/** Relative-time world for Groups F/H/I/K — anchor = now-24h; only relative
 *  timing matters, no wall-clock alignment needed. */
function specRelativeWorld(nowMs: number): { world: SimWorld; anchor: string } {
  const anchor = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  let w = createInitialWorld(nowMs);
  w = { ...w, scheduleAnchorIso: anchor, growattLastTransitionAt: anchor, eventLog: [], reports: [] };
  return { world: setSimulatedNow(w, nowMs), anchor };
}

const SPEC_NOW = Date.now();

// ── Groups A & C(A) — Growatt Currently ON (A1-A6; C repeats with confirm) ──
function specA1(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(9, 0));
  w = forceGrowattState(w, 'OFF'); w = setSimulatedNow(w, specClock(10, 0)); w = forceGrowattState(w, 'ON');
  w = setSimulatedNow(w, specClock(11, 0));
  w = submitReportOrConfirm(w, 'ON', kind);
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetMinutes === 60 && meta?.offsetSign === 'POSITIVE', world: w,
    expected: 'offset +60m POSITIVE (Verification Window)', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign} ref=${meta?.offsetReferenceKind}` };
}
function specA2(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(9, 0));
  w = forceGrowattState(w, 'OFF'); w = setSimulatedNow(w, specClock(10, 0)); w = forceGrowattState(w, 'ON');
  w = setSimulatedNow(w, specClock(10, 5));
  w = submitReportOrConfirm(w, 'ON', kind, specClock(9, 30));
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetMinutes === -30 && meta?.offsetSign === 'NEGATIVE', world: w,
    expected: 'offset -30m NEGATIVE (UNCERTAIN_ZONE territory)', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign}` };
}
function specA3(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(9, 0));
  w = forceGrowattState(w, 'OFF'); w = setSimulatedNow(w, specClock(10, 0)); w = forceGrowattState(w, 'ON');
  w = submitReportOrConfirm(w, 'ON', kind, specClock(10, 0));
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetMinutes === 0 && meta?.offsetSign === 'NEUTRAL', world: w,
    expected: 'offset = 0, NEUTRAL', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign}` };
}
function specA4(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, specClock(13, 5));
  w = submitReportOrConfirm(w, 'OFF', kind, specClock(12, 0));
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetMinutes === -60 && meta?.offsetSign === 'NEGATIVE', world: w,
    expected: 'offset -60m NEGATIVE (UNCERTAIN_ZONE)', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign}` };
}
function specA5(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, specClock(14, 0));
  w = submitReportOrConfirm(w, 'OFF', kind);
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetMinutes === 60 && meta?.offsetSign === 'POSITIVE', world: w,
    expected: 'offset +60m POSITIVE', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign}` };
}
function specA6(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = submitReportOrConfirm(w, 'OFF', kind, specClock(13, 0));
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetMinutes === 0 && meta?.offsetSign === 'NEUTRAL', world: w,
    expected: 'Neutral', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign}` };
}

// ── Groups B & C(B) — Growatt Currently OFF (B1-B6; C repeats with confirm) ─
function specB1(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, specClock(14, 0)); // 1h into 5h OFF = 20%
  w = submitReportOrConfirm(w, 'ON', kind);
  const meta = w.lastResult?.communityTransitionMeta;
  const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60000 : null;
  return { pass: durMin === 180 && meta?.durationSelectionRule === 'OFF_PROGRESS_LT_50_BEFORE' && meta?.offsetSign === 'NEGATIVE', world: w,
    expected: 'Previous ON = 3h (180min); offset NEGATIVE', actual: `duration=${durMin}min rule=${meta?.durationSelectionRule} offsetSign=${meta?.offsetSign}` };
}
function specB2(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, specClock(17, 0)); // 4h into 5h OFF = 80%
  w = submitReportOrConfirm(w, 'ON', kind);
  const meta = w.lastResult?.communityTransitionMeta;
  const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60000 : null;
  return { pass: durMin === 120 && meta?.durationSelectionRule === 'OFF_PROGRESS_GT_50_AFTER' && meta?.offsetSign === 'NEGATIVE', world: w,
    expected: 'Next ON = 2h (120min); offset NEGATIVE', actual: `duration=${durMin}min rule=${meta?.durationSelectionRule} offsetSign=${meta?.offsetSign}` };
}
function specB3(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, specClock(19, 0)); // 1h past expected OFF end (18:00)
  w = submitReportOrConfirm(w, 'ON', kind);
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetSign === 'POSITIVE' && meta?.offsetMinutes === 60, world: w,
    expected: 'offset +60m POSITIVE', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign} ref=${meta?.offsetReferenceKind}` };
}
function specB4(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = submitReportOrConfirm(w, 'OFF', kind, specClock(13, 0));
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0, world: w,
    expected: 'Neutral', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign}` };
}
function specB5(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, specClock(13, 40));
  w = submitReportOrConfirm(w, 'OFF', kind);
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetSign === 'POSITIVE', world: w, expected: 'Positive', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign}` };
}
function specB6(kind: 'report' | 'confirm'): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, specClock(13, 10));
  w = submitReportOrConfirm(w, 'OFF', kind, specClock(12, 30));
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetSign === 'NEGATIVE', world: w, expected: 'Negative', actual: `offset=${meta?.offsetMinutes}m sign=${meta?.offsetSign}` };
}

// ── Group D — OFF Progress Validation (duration rule in isolation) ─────────
function specD1(): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(4, 0));
  w = setSimulatedNow(w, specClock(5, 12)); // 20% of 6h OFF
  w = submitReportOrConfirm(w, 'ON', 'report');
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.durationSelectionRule === 'OFF_PROGRESS_LT_50_BEFORE', world: w, expected: 'Previous ON used', actual: `rule=${meta?.durationSelectionRule} progress=${((meta?.progressRatio ?? 0) * 100).toFixed(1)}%` };
}
function specD2(): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(4, 0));
  w = setSimulatedNow(w, specClock(8, 48)); // 80% of 6h OFF
  w = submitReportOrConfirm(w, 'ON', 'report');
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.durationSelectionRule === 'OFF_PROGRESS_GT_50_AFTER', world: w, expected: 'Next ON used', actual: `rule=${meta?.durationSelectionRule} progress=${((meta?.progressRatio ?? 0) * 100).toFixed(1)}%` };
}

// ── Group E — ON Interruption Validation (no 50% rule, ever) ───────────────
function specE1(): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(10, 0));
  w = setSimulatedNow(w, specClock(10, 36)); // 20% of 3h ON
  w = submitReportOrConfirm(w, 'OFF', 'report');
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.durationSelectionRule === 'ON_ALWAYS_BEFORE', world: w, expected: 'Previous OFF regardless of %', actual: `rule=${meta?.durationSelectionRule} progress=${((meta?.progressRatio ?? 0) * 100).toFixed(1)}%` };
}
function specE2(): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(10, 0));
  w = setSimulatedNow(w, specClock(12, 24)); // 80% of 3h ON
  w = submitReportOrConfirm(w, 'OFF', 'report');
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.durationSelectionRule === 'ON_ALWAYS_BEFORE', world: w, expected: 'Previous OFF regardless of %', actual: `rule=${meta?.durationSelectionRule} progress=${((meta?.progressRatio ?? 0) * 100).toFixed(1)}%` };
}

// ── Group F — Generated State Completion -> zone outcome ───────────────────
function specF1(): SpecScenarioResult {
  const { world: w0, anchor } = specRelativeWorld(SPEC_NOW);
  let w = forceGrowattState(w0, 'ON');
  w = setSimulatedNow(w, new Date(anchor).getTime() + 120 * 60000);
  w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, w.simulatedNowMs + 80 * 60000);
  w = submitReportOrConfirm(w, 'OFF', 'confirm'); // POSITIVE offset
  const genIdx = w.lastResult!.daySchedule.findIndex((s: any) => s.isResynced);
  const continuationSlot = w.lastResult!.daySchedule[genIdx + 1];
  const genEnd = w.lastResult!.communityTransitionMeta!.generatedCycleEndIso;
  const midMs = new Date(genEnd).getTime() + Math.min(((continuationSlot?.endIso ? new Date(continuationSlot.endIso).getTime() - new Date(genEnd).getTime() : 60 * 60000) / 2), 60 * 60000);
  w = setSimulatedNow(w, midMs);
  const matchingState: 'ON' | 'OFF' = continuationSlot?.state ?? 'ON';
  const opposite: 'ON' | 'OFF' = matchingState === 'ON' ? 'OFF' : 'ON';
  w = forceGrowattState(w, matchingState);
  w = forceGrowattState(w, opposite);
  const mode = w.lastResult?.atc.mode;
  return {
    pass: (mode === 'POSITIVE_OFFSET_PENDING' && !!w.lastResult?.atc.scheduledAutoTransitionIso) || (mode === 'NORMAL' && w.lastResult?.reconciledCycleStartIso !== null),
    world: w, expected: 'Verification Window (POSITIVE_OFFSET_PENDING) or instantly-reconciled NORMAL',
    actual: `atc.mode=${mode} scheduledAutoTransitionIso=${w.lastResult?.atc.scheduledAutoTransitionIso}`,
  };
}
function specF2(): SpecScenarioResult {
  const { world: w0, anchor } = specRelativeWorld(SPEC_NOW);
  let w = forceGrowattState(w0, 'ON');
  w = setSimulatedNow(w, new Date(anchor).getTime() + 120 * 60000);
  w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, w.simulatedNowMs + 180 * 60000);
  w = submitReportOrConfirm(w, 'ON', 'report'); // NEGATIVE offset
  const continuationSlot = w.lastResult!.daySchedule[w.lastResult!.daySchedule.findIndex((s: any) => s.isResynced) + 1];
  const genEnd = w.lastResult!.communityTransitionMeta!.generatedCycleEndIso;
  const target = continuationSlot?.endIso ? new Date(continuationSlot.endIso).getTime() + 35 * 60000 : new Date(genEnd).getTime() + 35 * 60000;
  w = setSimulatedNow(w, target);
  return { pass: w.lastResult?.atc.mode === 'UNCERTAIN_ZONE', world: w, expected: 'UNCERTAIN_ZONE', actual: `atc.mode=${w.lastResult?.atc.mode}` };
}
function specF3(): SpecScenarioResult {
  const { world: w0, anchor } = specRelativeWorld(SPEC_NOW);
  let w = forceGrowattState(w0, 'ON');
  w = setSimulatedNow(w, new Date(anchor).getTime() + 120 * 60000);
  w = forceGrowattState(w, 'OFF');
  const offEndMs = w.simulatedNowMs + 360 * 60000;
  w = setSimulatedNow(w, offEndMs);
  w = submitReportOrConfirm(w, 'ON', 'report', offEndMs); // NEUTRAL offset
  const meta = w.lastResult?.communityTransitionMeta;
  return { pass: meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0, world: w, expected: 'Neutral, normal continuity', actual: `sign=${meta?.offsetSign} (${meta?.offsetMinutes}m)` };
}

// ── Group G — Schedule Continuity ───────────────────────────────────────────
function specG1(): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(11, 0));
  w = forceGrowattState(w, 'ON'); w = setSimulatedNow(w, specClock(13, 0)); w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, specClock(17, 0)); // 80% -> borrows next ON(18-20,2h)
  w = submitReportOrConfirm(w, 'ON', 'report');
  const slots = w.lastResult!.daySchedule;
  const genIdx = slots.findIndex((s: any) => s.isResynced);
  const next = genIdx >= 0 ? slots[genIdx + 1] : null;
  return { pass: next?.state === 'OFF', world: w, expected: 'next = OFF (logical schedule sequence)', actual: `next=${next?.state}` };
}
function specG2(): SpecScenarioResult {
  let w = specClockAlignedWorld(specClock(10, 0));
  w = setSimulatedNow(w, specClock(10, 36)); // 20% -> previous OFF (04-10, 6h)
  w = submitReportOrConfirm(w, 'OFF', 'report');
  const slots = w.lastResult!.daySchedule;
  const genIdx = slots.findIndex((s: any) => s.isResynced);
  const next = genIdx >= 0 ? slots[genIdx + 1] : null;
  return { pass: next?.state === 'ON', world: w, expected: 'next = ON (logical schedule sequence)', actual: `next=${next?.state}` };
}

// ── Group H — Persistent Timeline ───────────────────────────────────────────
function specH1(): SpecScenarioResult {
  const { world: w0, anchor } = specRelativeWorld(SPEC_NOW);
  let w = forceGrowattState(w0, 'ON');
  w = setSimulatedNow(w, new Date(anchor).getTime() + 120 * 60000);
  w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, w.simulatedNowMs + 80 * 60000);
  w = submitReportOrConfirm(w, 'OFF', 'report');
  w = setSimulatedNow(w, w.simulatedNowMs + 20 * 3600 * 1000);
  const stillPresent = w.lastResult?.daySchedule.some((s: any) => s.isResynced === true);
  return { pass: !!stillPresent, world: w, expected: 'true', actual: `present=${stillPresent}` };
}
function specH2(): SpecScenarioResult {
  const { world: w0, anchor } = specRelativeWorld(SPEC_NOW);
  let w = forceGrowattState(w0, 'ON');
  w = setSimulatedNow(w, new Date(anchor).getTime() + 120 * 60000);
  w = forceGrowattState(w, 'OFF');
  w = setSimulatedNow(w, w.simulatedNowMs + 80 * 60000);
  w = submitReportOrConfirm(w, 'OFF', 'report');
  const firstGenStart = w.lastResult?.communityTransitionMeta?.generatedCycleStartIso;
  const firstReportId = w.reports[w.reports.length - 1].id;
  w = setSimulatedNow(w, w.simulatedNowMs + 200 * 3600 * 1000);
  w = submitReportOrConfirm(w, 'ON', 'report'); // a second, independent report
  const firstStillInLedger = w.reports.some(r => r.id === firstReportId && r.originalReportAtIso === firstGenStart);
  return {
    pass: firstStillInLedger, world: w,
    expected: 'First generated cycle permanently queryable in the reports ledger (audit-trail level — Rule 2)',
    actual: `ledgerCount=${w.reports.length}, firstStillInLedger=${firstStillInLedger}`,
  };
}

// ── Group I — UNCERTAIN_ZONE ─────────────────────────────────────────────────
function specReachUncertainZone(): SimWorld {
  const { world: w0 } = specRelativeWorld(SPEC_NOW);
  let w = { ...w0, offsetMinutes: -120 };
  w = setSimulatedNow(w, w.simulatedNowMs);
  const activeEnd = w.lastResult?.daySchedule.find(s => new Date(s.startIso).getTime() <= w.simulatedNowMs && (!s.endIso || new Date(s.endIso).getTime() > w.simulatedNowMs))?.endIso;
  return setSimulatedNow(w, activeEnd ? new Date(activeEnd).getTime() + 25 * 60000 : w.simulatedNowMs + 25 * 60000);
}
function specI1(): SpecScenarioResult {
  const w = specReachUncertainZone();
  return { pass: w.lastResult?.atc.mode === 'UNCERTAIN_ZONE', world: w, expected: 'UNCERTAIN_ZONE', actual: `atc.mode=${w.lastResult?.atc.mode}` };
}
function specI2(): SpecScenarioResult {
  let w = specReachUncertainZone();
  const wasUncertain = w.lastResult?.atc.mode === 'UNCERTAIN_ZONE';
  const heldState = w.lastResult!.currentState;
  w = submitReportOrConfirm(w, heldState === 'ON' ? 'OFF' : 'ON', 'confirm');
  return { pass: wasUncertain && w.lastResult?.atc.mode !== 'UNCERTAIN_ZONE', world: w, expected: 'Immediate exit from UNCERTAIN_ZONE', actual: `wasUncertain=${wasUncertain}, afterMode=${w.lastResult?.atc.mode}` };
}
function specI3(): SpecScenarioResult {
  let w = specReachUncertainZone();
  const wasUncertain = w.lastResult?.atc.mode === 'UNCERTAIN_ZONE';
  const heldState = w.lastResult!.currentState;
  w = submitReportOrConfirm(w, heldState === 'ON' ? 'OFF' : 'ON', 'report');
  return { pass: wasUncertain && w.lastResult?.atc.mode !== 'UNCERTAIN_ZONE', world: w, expected: 'Immediate exit from UNCERTAIN_ZONE', actual: `wasUncertain=${wasUncertain}, afterMode=${w.lastResult?.atc.mode}` };
}
function specI4(): SpecScenarioResult {
  let w = specReachUncertainZone();
  const heldState = w.lastResult!.currentState;
  w = forceGrowattState(w, heldState === 'ON' ? 'OFF' : 'ON');
  return { pass: w.lastResult?.atc.mode === 'NORMAL' && w.lastResult?.reconciledCycleStartIso !== null, world: w, expected: 'NORMAL + duration reconciliation', actual: `atc.mode=${w.lastResult?.atc.mode} reconciledStart=${w.lastResult?.reconciledCycleStartIso}` };
}

// ── Group J — Neutral Offset boundary ───────────────────────────────────────
function specJ(deltaMin: number): SpecScenarioResult {
  const { world: w0 } = specRelativeWorld(SPEC_NOW);
  const raw: ScheduleSlot[] = [{ state: 'OFF', startIso: new Date(SPEC_NOW - 6 * 3600000).toISOString(), endIso: new Date(SPEC_NOW).toISOString(), startFormatted: '', endFormatted: '', durationLabel: '', zone: '', isEstimated: false }];
  const r = computeCommunityOffset(raw, { syncedState: 'ON', syncedAtIso: new Date(SPEC_NOW + deltaMin * 60000).toISOString(), appliedAtIso: new Date(SPEC_NOW).toISOString() }, 'OFF', raw[0].startIso);
  const expectedSign = deltaMin === 0 ? 'NEUTRAL' : deltaMin > 0 ? 'POSITIVE' : 'NEGATIVE';
  return { pass: r?.sign === expectedSign && r?.offsetMinutes === deltaMin, world: w0, expected: `${expectedSign}, ${deltaMin}`, actual: `sign=${r?.sign} (${r?.offsetMinutes}m)` };
}

// ── Group K — Community Confirmation Timestamp Rule ─────────────────────────
function specKReportThenConfirm(state: 'ON' | 'OFF', reportAt: number, confirmAt: number) {
  const { world: w0 } = specRelativeWorld(reportAt - 6 * 3600000);
  let w = forceGrowattState(w0, state === 'ON' ? 'OFF' : 'ON');
  w = setSimulatedNow(w, reportAt);
  w = submitReportOrConfirm(w, state, 'report', reportAt);
  const afterReport = { genStart: w.lastResult?.communityTransitionMeta?.generatedCycleStartIso, offset: w.lastResult?.communityTransitionMeta?.offsetMinutes, reportId: w.reports[w.reports.length - 1].id, confBefore: w.reports[w.reports.length - 1].confidenceScore };
  w = setSimulatedNow(w, confirmAt);
  w = submitReportOrConfirm(w, state, 'confirm', confirmAt);
  const rec = w.reports.find(r => r.id === afterReport.reportId)!;
  return { world: w, afterReport, genStart: w.lastResult?.communityTransitionMeta?.generatedCycleStartIso, offset: w.lastResult?.communityTransitionMeta?.offsetMinutes, confAfter: rec.confidenceScore };
}
function specK1(): SpecScenarioResult {
  const r = specKReportThenConfirm('ON', specClock(10, 0), specClock(10, 10));
  return { pass: r.genStart === r.afterReport.genStart && r.offset === r.afterReport.offset && r.confAfter > r.afterReport.confBefore, world: r.world,
    expected: 'Generated state start unchanged, offset unchanged, confidence increased', actual: `genStart unchanged=${r.genStart === r.afterReport.genStart}, confidence ${r.afterReport.confBefore}->${r.confAfter}` };
}
function specK2(): SpecScenarioResult {
  const r = specKReportThenConfirm('ON', specClock(10, 0), specClock(14, 0));
  return { pass: r.genStart === r.afterReport.genStart && r.offset === r.afterReport.offset && r.confAfter > r.afterReport.confBefore, world: r.world,
    expected: 'Generated state start unchanged (4h later confirm), confidence increased', actual: `genStart unchanged=${r.genStart === r.afterReport.genStart}, confidence ${r.afterReport.confBefore}->${r.confAfter}` };
}
function specK3(): SpecScenarioResult {
  const r = specKReportThenConfirm('ON', specClock(10, 0), specClock(22, 0));
  return { pass: r.genStart === r.afterReport.genStart && r.offset === r.afterReport.offset && r.confAfter > r.afterReport.confBefore, world: r.world,
    expected: 'No offset recalculation, no state recreation (12h later), confidence increased only', actual: `genStart unchanged=${r.genStart === r.afterReport.genStart}, offset unchanged=${r.offset === r.afterReport.offset}` };
}
function specK4(): SpecScenarioResult {
  const r = specKReportThenConfirm('OFF', specClock(8, 0), specClock(20, 0));
  return { pass: r.genStart === r.afterReport.genStart && r.offset === r.afterReport.offset && r.confAfter > r.afterReport.confBefore, world: r.world,
    expected: 'No new transition, no rebuild, no recalculation (12h later)', actual: `genStart unchanged=${r.genStart === r.afterReport.genStart}` };
}
function specK5(): SpecScenarioResult {
  const r = specKReportThenConfirm('OFF', specClock(8, 0), specClock(8, 0, 1)); // exactly 24h later
  return { pass: r.genStart === r.afterReport.genStart && r.offset === r.afterReport.offset && r.confAfter > r.afterReport.confBefore, world: r.world,
    expected: 'No new transition/state/rebuild at the 24h boundary, confidence increased only', actual: `genStart unchanged=${r.genStart === r.afterReport.genStart}, confidence ${r.afterReport.confBefore}->${r.confAfter}` };
}
function specK6(): SpecScenarioResult {
  const { world: w0 } = specRelativeWorld(specClock(10, 0) - 6 * 3600000);
  let w = forceGrowattState(w0, 'OFF');
  w = setSimulatedNow(w, specClock(10, 0));
  w = submitReportOrConfirm(w, 'ON', 'report', specClock(10, 0), 'Simulated User', true); // deferProcessing
  const pendingBefore = w.lastResult?.communityTransitionMeta == null;
  w = setSimulatedNow(w, specClock(18, 0));
  w = submitReportOrConfirm(w, 'ON', 'confirm', specClock(18, 0));
  const genStart = w.lastResult?.communityTransitionMeta?.generatedCycleStartIso;
  return { pass: pendingBefore && genStart === new Date(specClock(10, 0)).toISOString(), world: w,
    expected: 'Generated State Start = 10:00, NOT the 18:00 confirmation', actual: `pendingBefore=${pendingBefore}, genStart=${genStart}` };
}
function specK7(): SpecScenarioResult {
  const { world: w0 } = specRelativeWorld(specClock(10, 0) - 6 * 3600000);
  let w = forceGrowattState(w0, 'OFF');
  w = setSimulatedNow(w, specClock(10, 0));
  w = submitReportOrConfirm(w, 'ON', 'report', specClock(10, 0));
  const reportId = w.reports[0].id;
  const offset0 = w.lastResult?.communityTransitionMeta?.offsetMinutes;
  const genStart0 = w.lastResult?.communityTransitionMeta?.generatedCycleStartIso;
  const confidences: number[] = [w.reports[0].confidenceScore];
  for (const t of [specClock(11, 0), specClock(15, 0), specClock(21, 0)]) {
    w = setSimulatedNow(w, t);
    w = submitReportOrConfirm(w, 'ON', 'confirm', t);
    confidences.push(w.reports.find(r => r.id === reportId)!.confidenceScore);
  }
  const monotonic = confidences[confidences.length - 1] > confidences[0];
  const stable = w.reports.length === 1 && w.lastResult?.communityTransitionMeta?.offsetMinutes === offset0 && w.lastResult?.communityTransitionMeta?.generatedCycleStartIso === genStart0;
  return { pass: stable && monotonic, world: w, expected: 'One report, one generated state, offset computed once; confidence rises with each confirmation', actual: `reportCount=${w.reports.length}, confidences=${confidences.join('->')}` };
}
function specK8(): SpecScenarioResult {
  const { world: w0 } = specRelativeWorld(specClock(10, 0) - 6 * 3600000);
  let w = forceGrowattState(w0, 'OFF');
  w = setSimulatedNow(w, specClock(10, 0));
  w = submitReportOrConfirm(w, 'ON', 'report', specClock(10, 0));
  const genEnd = w.lastResult!.communityTransitionMeta!.generatedCycleEndIso;
  const offsetBefore = w.lastResult?.communityTransitionMeta?.offsetMinutes;
  const genStartBefore = w.lastResult?.communityTransitionMeta?.generatedCycleStartIso;
  const confirmAt = new Date(genEnd).getTime() + 60 * 60000;
  w = setSimulatedNow(w, confirmAt);
  w = submitReportOrConfirm(w, 'ON', 'confirm', confirmAt);
  return {
    pass: w.reports.length === 1 && w.lastResult?.communityTransitionMeta?.offsetMinutes === offsetBefore && w.lastResult?.communityTransitionMeta?.generatedCycleStartIso === genStartBefore,
    world: w, expected: 'Do not recreate cycle, do not change offset; confidence increased only',
    actual: `reportCount=${w.reports.length}, offsetUnchanged=${w.lastResult?.communityTransitionMeta?.offsetMinutes === offsetBefore}`,
  };
}

export const SPEC_SCENARIOS: SpecScenarioDef[] = [
  { id: 'A1', group: 'A — Growatt Currently ON', name: 'Report ON after Growatt ON start', expected: '+60m POSITIVE', run: () => specA1('report') },
  { id: 'A2', group: 'A — Growatt Currently ON', name: 'Report ON before Growatt ON start', expected: '-30m NEGATIVE', run: () => specA2('report') },
  { id: 'A3', group: 'A — Growatt Currently ON', name: 'Report ON exactly at Growatt ON start', expected: '0, NEUTRAL', run: () => specA3('report') },
  { id: 'A4', group: 'A — Growatt Currently ON', name: 'Report OFF before Growatt ON end', expected: '-60m NEGATIVE', run: () => specA4('report') },
  { id: 'A5', group: 'A — Growatt Currently ON', name: 'Report OFF after Growatt ON end', expected: '+60m POSITIVE', run: () => specA5('report') },
  { id: 'A6', group: 'A — Growatt Currently ON', name: 'Report OFF exactly at Growatt ON end', expected: 'Neutral', run: () => specA6('report') },
  { id: 'B1', group: 'B — Growatt Currently OFF', name: 'OFF progress 20%, report ON', expected: 'Previous ON=3h, Negative', run: () => specB1('report') },
  { id: 'B2', group: 'B — Growatt Currently OFF', name: 'OFF progress 80%, report ON', expected: 'Next ON=2h, Negative', run: () => specB2('report') },
  { id: 'B3', group: 'B — Growatt Currently OFF', name: 'Report ON 1h past expected OFF end', expected: 'Positive', run: () => specB3('report') },
  { id: 'B4', group: 'B — Growatt Currently OFF', name: 'Report OFF at OFF start', expected: 'Neutral', run: () => specB4('report') },
  { id: 'B5', group: 'B — Growatt Currently OFF', name: 'Report OFF after OFF start', expected: 'Positive', run: () => specB5('report') },
  { id: 'B6', group: 'B — Growatt Currently OFF', name: 'Report OFF before OFF start', expected: 'Negative', run: () => specB6('report') },
  { id: 'C-A1', group: 'C — Same as A/B via Confirmation', name: 'A1 repeated with confirm', expected: 'identical to A1', run: () => specA1('confirm') },
  { id: 'C-A2', group: 'C — Same as A/B via Confirmation', name: 'A2 repeated with confirm', expected: 'identical to A2', run: () => specA2('confirm') },
  { id: 'C-A3', group: 'C — Same as A/B via Confirmation', name: 'A3 repeated with confirm', expected: 'identical to A3', run: () => specA3('confirm') },
  { id: 'C-A4', group: 'C — Same as A/B via Confirmation', name: 'A4 repeated with confirm', expected: 'identical to A4', run: () => specA4('confirm') },
  { id: 'C-A5', group: 'C — Same as A/B via Confirmation', name: 'A5 repeated with confirm', expected: 'identical to A5', run: () => specA5('confirm') },
  { id: 'C-A6', group: 'C — Same as A/B via Confirmation', name: 'A6 repeated with confirm', expected: 'identical to A6', run: () => specA6('confirm') },
  { id: 'C-B1', group: 'C — Same as A/B via Confirmation', name: 'B1 repeated with confirm', expected: 'identical to B1', run: () => specB1('confirm') },
  { id: 'C-B2', group: 'C — Same as A/B via Confirmation', name: 'B2 repeated with confirm', expected: 'identical to B2', run: () => specB2('confirm') },
  { id: 'C-B3', group: 'C — Same as A/B via Confirmation', name: 'B3 repeated with confirm', expected: 'identical to B3', run: () => specB3('confirm') },
  { id: 'C-B4', group: 'C — Same as A/B via Confirmation', name: 'B4 repeated with confirm', expected: 'identical to B4', run: () => specB4('confirm') },
  { id: 'C-B5', group: 'C — Same as A/B via Confirmation', name: 'B5 repeated with confirm', expected: 'identical to B5', run: () => specB5('confirm') },
  { id: 'C-B6', group: 'C — Same as A/B via Confirmation', name: 'B6 repeated with confirm', expected: 'identical to B6', run: () => specB6('confirm') },
  { id: 'D1', group: 'D — OFF Progress Validation', name: 'OFF progress 20%', expected: 'Previous ON', run: specD1 },
  { id: 'D2', group: 'D — OFF Progress Validation', name: 'OFF progress 80%', expected: 'Next ON', run: specD2 },
  { id: 'E1', group: 'E — ON Interruption Validation', name: 'ON interrupted at 20%', expected: 'Previous OFF (no 50% rule)', run: specE1 },
  { id: 'E2', group: 'E — ON Interruption Validation', name: 'ON interrupted at 80%', expected: 'Previous OFF (no 50% rule)', run: specE2 },
  { id: 'F1', group: 'F — Generated State Completion', name: 'Positive offset completion', expected: 'Verification Window', run: specF1 },
  { id: 'F2', group: 'F — Generated State Completion', name: 'Negative offset completion', expected: 'UNCERTAIN_ZONE', run: specF2 },
  { id: 'F3', group: 'F — Generated State Completion', name: 'Neutral offset', expected: 'Normal continuity', run: specF3 },
  { id: 'G1', group: 'G — Schedule Continuity', name: 'Generated ON ends', expected: 'Logical next OFF', run: specG1 },
  { id: 'G2', group: 'G — Schedule Continuity', name: 'Generated OFF ends', expected: 'Logical next ON', run: specG2 },
  { id: 'H1', group: 'H — Persistent Timeline', name: 'Generated state created', expected: 'Stored permanently', run: specH1 },
  { id: 'H2', group: 'H — Persistent Timeline', name: 'Generated state superseded by a later one', expected: 'History preserved in ledger', run: specH2 },
  { id: 'I1', group: 'I — UNCERTAIN_ZONE', name: 'Negative offset completion', expected: 'Enter UNCERTAIN_ZONE', run: specI1 },
  { id: 'I2', group: 'I — UNCERTAIN_ZONE', name: 'Confirmation during UNCERTAIN_ZONE', expected: 'Immediate exit', run: specI2 },
  { id: 'I3', group: 'I — UNCERTAIN_ZONE', name: 'Report during UNCERTAIN_ZONE', expected: 'Immediate exit', run: specI3 },
  { id: 'I4', group: 'I — UNCERTAIN_ZONE', name: 'Growatt transition during UNCERTAIN_ZONE', expected: 'Exit + duration reconciliation', run: specI4 },
  { id: 'J1', group: 'J — Neutral Offset', name: 'Offset = 0', expected: 'Neutral', run: () => specJ(0) },
  { id: 'J2', group: 'J — Neutral Offset', name: 'Offset = +1 minute', expected: 'Positive', run: () => specJ(1) },
  { id: 'J3', group: 'J — Neutral Offset', name: 'Offset = -1 minute', expected: 'Negative', run: () => specJ(-1) },
  { id: 'K1', group: 'K — Confirmation Timestamp Rule', name: 'Confirm 10min after report', expected: 'genStart unchanged, confidence ↑', run: specK1 },
  { id: 'K2', group: 'K — Confirmation Timestamp Rule', name: 'Confirm 4h after report', expected: 'genStart unchanged, confidence ↑', run: specK2 },
  { id: 'K3', group: 'K — Confirmation Timestamp Rule', name: 'Confirm 12h after report', expected: 'No recalculation, confidence ↑ only', run: specK3 },
  { id: 'K4', group: 'K — Confirmation Timestamp Rule', name: 'OFF report, confirm 12h later', expected: 'No new transition, confidence ↑', run: specK4 },
  { id: 'K5', group: 'K — Confirmation Timestamp Rule', name: 'OFF report, confirm exactly 24h later', expected: 'No reconstruction, confidence ↑ only', run: specK5 },
  { id: 'K6', group: 'K — Confirmation Timestamp Rule', name: 'Unprocessed report + later confirmation', expected: 'Uses ORIGINAL report timestamp', run: specK6 },
  { id: 'K7', group: 'K — Confirmation Timestamp Rule', name: 'Multiple confirmations', expected: 'One transition; confidence rises each time', run: specK7 },
  { id: 'K8', group: 'K — Confirmation Timestamp Rule', name: 'Confirmation after generated cycle finished', expected: 'No recreation; confidence ↑ only', run: specK8 },
];

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
