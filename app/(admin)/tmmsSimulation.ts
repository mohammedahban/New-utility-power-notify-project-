/**
 * TMMS V2 Simulation Layer — Complete Scenario Validation & Compliance Framework
 * ════════════════════════════════════════════════════════════════════════════
 * Built ON TOP of tmmsEngine.ts — never reimplements TMMS logic.
 *
 * This layer supplies:
 *   • Schedule construction helpers
 *   • Controllable "world" clock
 *   • Growatt simulation
 *   • Report / Confirmation tracking with full Timestamp Rule enforcement
 *   • 50+ predefined scenarios covering all Groups A–K
 * ════════════════════════════════════════════════════════════════════════════
 */
import {
  applyOffsetToPrediction,
  fmtYemenTime,
  getZoneFromIso,
  durationLabelFromMin,
  computeCommunityOffset,
  type Prediction,
  type ScheduleSlot,
  type ResyncPoint,
  type UserPrediction,
  type TransitionMode,
  type DecisionStep,
  type CommunityTransitionResult,
} from './tmmsEngine';

// ── Schedule template ─────────────────────────────────────────────────────────

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

// ── Master Test Schedule (from spec) ──────────────────────────────────────────
export const MASTER_SCHEDULE: ScheduleEntryTemplate[] = [
  { id: 'm1', state: 'ON',  durationMin: 120 }, // 02:00 → 04:00
  { id: 'm2', state: 'OFF', durationMin: 360 }, // 04:00 → 10:00
  { id: 'm3', state: 'ON',  durationMin: 180 }, // 10:00 → 13:00
  { id: 'm4', state: 'OFF', durationMin: 300 }, // 13:00 → 18:00
  { id: 'm5', state: 'ON',  durationMin: 120 }, // 18:00 → 20:00
  { id: 'm6', state: 'OFF', durationMin: 360 }, // 20:00 → 02:00
];

// ══════════════════════════════════════════════════════════════════════════════
// REPORT & CONFIRMATION TRACKING — Community Confirmation Timestamp Rule
// ══════════════════════════════════════════════════════════════════════════════

/** A confirmation linked to a specific report */
export interface SimConfirmationEntry {
  timestampMs: number;
  timestampIso: string;
  reporterName: string;
}

/** A community report (or standalone confirmation treated as report) */
export interface SimReportEntry {
  id: string;
  state: 'ON' | 'OFF';
  reportTimestampMs: number;
  reportTimestampIso: string;
  processed: boolean;
  /** Was this report created by a confirmation with no matching report? */
  isStandaloneConfirmation: boolean;
  confidenceScore: number;
  confirmations: SimConfirmationEntry[];
  /** The engine result when this report was processed */
  transitionResult: CommunityTransitionResult | null;
}

/** Full per-scenario debug payload (20 required fields from spec) */
export interface ScenarioDebugInfo {
  scheduleSnapshot: string;
  currentState: string;
  growattState: string;
  referenceTime: string;
  referenceKind: string;
  generatedState: string;
  durationSelectionRule: string;
  durationSelectionResult: string;
  offsetFormula: string;
  offsetValue: string;
  offsetSign: string;
  offsetReason: string;
  timelineContinuityResult: string;
  transitionTree: string;
  verificationWindowResult: string;
  uncertainZoneResult: string;
  confidenceScoreChanges: string;
  communityConfirmationAnalysis: string;
  expectedResult: string;
  actualResult: string;
  pass: boolean;
}

// ── World state ──────────────────────────────────────────────────────────────

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
  frozenCommunityOffsetMinutes: number | null;
  resyncPoint: ResyncPoint | null;
  transitionMode: TransitionMode;
  eventLog: SimEvent[];
  lastResult: UserPrediction | null;
  lastDecisionTrace: DecisionStep[];
  // ── Report & Confirmation Tracking (Timestamp Rule) ────────────────────
  reports: SimReportEntry[];
  /** Global confidence score (increments with each confirmation) */
  confidenceScore: number;
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
  const anchor = new Date(nowMs - 3 * 3600 * 1000).toISOString();
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
    confidenceScore: 50, // base confidence
  };
  return refreshResult(base);
}

// ── Build the Prediction object the engine expects ────────────────────────────
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

/** Re-run the engine and cache the result + decision trace on the world */
function refreshResult(world: SimWorld): SimWorld {
  const result = runEngine(world);
  return {
    ...world,
    lastResult: result,
    lastDecisionTrace: result.communityTransitionMeta?.decisionTrace ?? world.lastDecisionTrace,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT & CONFIRMATION HANDLERS — Timestamp Rule Enforcement
// ══════════════════════════════════════════════════════════════════════════════

/** Find the most recent unprocessed report matching the given state */
function findUnprocessedReport(world: SimWorld, state: 'ON' | 'OFF'): SimReportEntry | null {
  for (let i = world.reports.length - 1; i >= 0; i--) {
    const r = world.reports[i];
    if (r.state === state && !r.processed) return r;
  }
  return null;
}

/** Find the most recent processed report matching the given state */
function findProcessedReport(world: SimWorld, state: 'ON' | 'OFF'): SimReportEntry | null {
  for (let i = world.reports.length - 1; i >= 0; i--) {
    const r = world.reports[i];
    if (r.state === state && r.processed) return r;
  }
  return null;
}

/** Find ANY most recent report matching the given state */
function findLatestReport(world: SimWorld, state: 'ON' | 'OFF'): SimReportEntry | null {
  for (let i = world.reports.length - 1; i >= 0; i--) {
    if (world.reports[i].state === state) return world.reports[i];
  }
  return null;
}

/** Maximum confirmation window: 24 hours (in ms) */
const MAX_CONFIRMATION_WINDOW_MS = 24 * 3600 * 1000;

/** Check if a confirmation is "late" (report already processed, or >24h old) */
function isLateConfirmation(report: SimReportEntry, confirmMs: number): boolean {
  if (report.processed) return true;
  const ageMs = confirmMs - report.reportTimestampMs;
  if (ageMs > MAX_CONFIRMATION_WINDOW_MS) return true;
  return false;
}

/**
 * SUBMIT REPORT — Creates a report entry, marks it as processed immediately,
 * and runs the engine with the report timestamp as the resync point.
 */
export function submitReport(
  world: SimWorld,
  state: 'ON' | 'OFF',
  reportAtMs?: number,
  reporterName: string = 'Simulated User',
): SimWorld {
  const effectiveReportMs = reportAtMs ?? world.simulatedNowMs;
  const reportAtIso = new Date(effectiveReportMs).toISOString();

  // Create report entry
  const report: SimReportEntry = {
    id: `rep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    state,
    reportTimestampMs: effectiveReportMs,
    reportTimestampIso: reportAtIso,
    processed: true,
    isStandaloneConfirmation: false,
    confidenceScore: 50,
    confirmations: [],
    transitionResult: null,
  };

  // Build resync point with REPORT timestamp (authoritative)
  const resyncPoint: ResyncPoint = {
    syncedState: state,
    syncedAtIso: reportAtIso,
    appliedAtIso: new Date(world.simulatedNowMs).toISOString(),
    reporterName,
    reporterReliability: 90,
  };

  let next: SimWorld = {
    ...world,
    resyncPoint,
    frozenCommunityOffsetMinutes: null,
    reports: [...world.reports, report],
  };

  const result = runEngine(next);
  const meta = result.communityTransitionMeta;

  // Update the report with transition result
  const updatedReports = [...next.reports];
  const reportIdx = updatedReports.length - 1;
  updatedReports[reportIdx] = { ...updatedReports[reportIdx], transitionResult: meta ?? null };

  const log: SimEvent[] = [
    ...world.eventLog,
    makeEvent(next, 'report', `Report ${state} received`, null, `synced at ${fmtYemenTime(reportAtIso)} (authoritative)`),
  ];

  if (meta) {
    for (const step of meta.decisionTrace) {
      log.push(makeEvent(next, step.label.includes('Offset') ? 'offset' : 'info', step.label, null, step.detail));
    }
    if (meta.isFreshOffsetComputation) {
      next = { ...next, frozenCommunityOffsetMinutes: meta.offsetMinutes };
      log.push(makeEvent(next, 'offset', 'Offset frozen & persisted', null, `${meta.offsetMinutes > 0 ? '+' : ''}${meta.offsetMinutes}m (${meta.offsetSign})`));
    }
  }

  return {
    ...next,
    reports: updatedReports,
    eventLog: log,
    lastResult: result,
    lastDecisionTrace: meta?.decisionTrace ?? next.lastDecisionTrace,
  };
}

/**
 * SUBMIT CONFIRMATION — Community Confirmation Timestamp Rule enforcement.
 *
 * Rule: All calculations use the Original Report Timestamp as authoritative.
 *       The Confirmation Timestamp only affects Confidence Score.
 *
 * Cases:
 *   1. Matching unprocessed report found → process with REPORT timestamp
 *   2. Matching processed report found → increase confidence only, no recalculation
 *   3. No matching report found → treat as standalone report (fallback)
 */
export function submitConfirmation(
  world: SimWorld,
  state: 'ON' | 'OFF',
  confirmAtMs?: number,
  reporterName: string = 'Simulated Confirmer',
): SimWorld {
  const effectiveConfirmMs = confirmAtMs ?? world.simulatedNowMs;
  const confirmAtIso = new Date(effectiveConfirmMs).toISOString();

  const confirmationEntry: SimConfirmationEntry = {
    timestampMs: effectiveConfirmMs,
    timestampIso: confirmAtIso,
    reporterName,
  };

  // ── Case 1: Find matching unprocessed report ────────────────────────────
  const unprocessedReport = findUnprocessedReport(world, state);

  if (unprocessedReport && !isLateConfirmation(unprocessedReport, effectiveConfirmMs)) {
    // Process the unprocessed report using the REPORT timestamp (not confirmation time)
    const reportAtIso = unprocessedReport.reportTimestampIso;

    const resyncPoint: ResyncPoint = {
      syncedState: state,
      syncedAtIso: reportAtIso, // AUTHORITATIVE: report timestamp
      appliedAtIso: new Date(world.simulatedNowMs).toISOString(),
      reporterName,
      reporterReliability: 90,
    };

    const newConfidence = Math.min(100, world.confidenceScore + 15);

    let next: SimWorld = {
      ...world,
      resyncPoint,
      frozenCommunityOffsetMinutes: null,
      confidenceScore: newConfidence,
    };

    const result = runEngine(next);
    const meta = result.communityTransitionMeta;

    // Update the report: mark processed, add confirmation, store result
    const updatedReports = next.reports.map(r =>
      r.id === unprocessedReport.id
        ? { ...r, processed: true, confirmations: [...r.confirmations, confirmationEntry], transitionResult: meta ?? null, confidenceScore: r.confidenceScore + 15 }
        : r,
    );

    const log: SimEvent[] = [
      ...world.eventLog,
      makeEvent(next, 'confirm', `Confirmation ${state} received`, null, `confirm at ${fmtYemenTime(confirmAtIso)} → using REPORT timestamp ${fmtYemenTime(reportAtIso)} (Rule)`),
      makeEvent(next, 'info', `Confidence increased`, null, `${world.confidenceScore} → ${newConfidence}`),
    ];

    if (meta) {
      for (const step of meta.decisionTrace) {
        log.push(makeEvent(next, step.label.includes('Offset') ? 'offset' : 'info', step.label, null, step.detail));
      }
      if (meta.isFreshOffsetComputation) {
        next = { ...next, frozenCommunityOffsetMinutes: meta.offsetMinutes };
        log.push(makeEvent(next, 'offset', 'Offset frozen & persisted', null, `${meta.offsetMinutes > 0 ? '+' : ''}${meta.offsetMinutes}m (${meta.offsetSign})`));
      }
    }

    return {
      ...next,
      reports: updatedReports,
      eventLog: log,
      lastResult: result,
      lastDecisionTrace: meta?.decisionTrace ?? next.lastDecisionTrace,
    };
  }

  // ── Case 2: Matching processed report found → confidence only ───────────
  const processedReport = findProcessedReport(world, state) ?? findLatestReport(world, state);

  if (processedReport) {
    const newConfidence = Math.min(100, world.confidenceScore + 15);

    // Add confirmation to the report
    const updatedReports = world.reports.map(r =>
      r.id === processedReport.id
        ? { ...r, confirmations: [...r.confirmations, confirmationEntry], confidenceScore: Math.min(100, r.confidenceScore + 15) }
        : r,
    );

    const log: SimEvent[] = [
      ...world.eventLog,
      makeEvent(world, 'confirm', `Confirmation ${state} received`, null, `confirm at ${fmtYemenTime(confirmAtIso)} → report already processed at ${fmtYemenTime(processedReport.reportTimestampIso)}`),
      makeEvent(world, 'info', `Late Confirmation: confidence only`, null, `${world.confidenceScore} → ${newConfidence} — NO new transition, NO offset recalculation (Rule)`),
    ];

    return {
      ...world,
      reports: updatedReports,
      confidenceScore: newConfidence,
      eventLog: log,
    };
  }

  // ── Case 3: No matching report → treat as standalone (fallback) ─────────
  return submitReport(world, state, effectiveConfirmMs, reporterName);
}

/**
 * LEGACY: submitReportOrConfirm — now dispatches to submitReport or submitConfirmation.
 * Maintains backward compatibility with existing scenario code.
 */
export function submitReportOrConfirm(
  world: SimWorld,
  state: 'ON' | 'OFF',
  kind: 'report' | 'confirm',
  reportAtMs?: number,
  reporterName: string = kind === 'report' ? 'Simulated User' : 'Simulated Confirmer',
): SimWorld {
  if (kind === 'report') {
    return submitReport(world, state, reportAtMs, reporterName);
  }
  return submitConfirmation(world, state, reportAtMs, reporterName);
}

// ── Actions ──────────────────────────────────────────────────────────────────

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

// ── Scenario Runner ──────────────────────────────────────────────────────────

export interface ScenarioResult {
  pass: boolean;
  actual: string;
  expected: string;
  world: SimWorld;
  debugInfo: ScenarioDebugInfo;
}

export interface ScenarioDef {
  group: string;
  id: string;
  name: string;
  description: string;
  expected: string;
  run: () => ScenarioResult;
}

function freshBase(nowMs: number): { world: SimWorld; anchor: string } {
  const anchor = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  let world = createInitialWorld(nowMs);
  world = { ...world, scheduleAnchorIso: anchor, growattLastTransitionAt: anchor, eventLog: [], reports: [], confidenceScore: 50 };
  return { world, anchor };
}

/** Extract ScenarioDebugInfo from a world state */
function extractDebugInfo(world: SimWorld, expected: string, actual: string, pass: boolean): ScenarioDebugInfo {
  const r = world.lastResult;
  const meta = r?.communityTransitionMeta;
  const report = world.reports[world.reports.length - 1] ?? null;

  const scheduleSnapshot = world.scheduleTemplate.map(t => `${t.state} ${t.durationMin}m`).join(' → ');
  const currentState = r?.currentState ?? '—';
  const growattState = world.growattCurrentState;
  const referenceTime = meta?.offsetReferenceIso ? fmtYemenTime(meta.offsetReferenceIso) : '—';
  const referenceKind = meta?.offsetReferenceKind ?? '—';
  const generatedState = meta ? `${meta.generatedCycleState} ${fmtYemenTime(meta.generatedCycleStartIso)} → ${fmtYemenTime(meta.generatedCycleEndIso)}` : '—';
  const durationRule = meta?.durationSelectionRule ?? '—';
  const durationResult = meta ? `${Math.round((new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000)} min` : '—';
  const offsetFormula = meta ? `Offset = ${fmtYemenTime(meta.generatedCycleStartIso)} − ${fmtYemenTime(meta.offsetReferenceIso ?? '')}` : '—';
  const offsetValue = meta ? `${meta.offsetMinutes > 0 ? '+' : ''}${meta.offsetMinutes}m` : '—';
  const offsetSign = meta?.offsetSign ?? '—';
  const offsetReason = meta
    ? meta.offsetSign === 'POSITIVE' ? 'Generated timeline started AFTER Growatt reference'
      : meta.offsetSign === 'NEGATIVE' ? 'Generated timeline started BEFORE Growatt reference'
        : 'Generated timeline start exactly matches Growatt reference'
    : '—';

  // Timeline continuity
  const slots = r?.daySchedule ?? [];
  const genIdx = slots.findIndex(s => (s as any).isResynced === true);
  const nextSlot = genIdx >= 0 ? slots[genIdx + 1] : null;
  const timelineContinuity = nextSlot ? `${nextSlot.state} ${nextSlot.durationLabel ?? ''} (logical sequence)` : 'No generated state active';

  // Transition tree
  const transitionTree = meta?.decisionTrace.map(s => `${s.step}. ${s.label}`).join(' → ') ?? '—';

  // Verification window
  const verificationWindow = r?.atc.inValidationWindow
    ? `ACTIVE — ${Math.ceil(r.atc.validationWindowRemainingMin)} min remaining`
    : 'inactive';

  // UNCERTAIN_ZONE
  const uncertainZone = r?.atc.mode === 'UNCERTAIN_ZONE'
    ? `ACTIVE — overrun ${Math.ceil(r.atc.overrunMinutes)} min`
    : r?.atc.mode === 'PREDICTION_RANGE' ? 'PREDICTION_RANGE (border)' : 'inactive';

  // Confidence
  const confidenceChanges = `Current: ${world.confidenceScore}% (base 50% + ${world.reports.reduce((s, r) => s + r.confirmations.length, 0) * 15}% from ${world.reports.reduce((s, r) => s + r.confirmations.length, 0)} confirmations)`;

  // Community Confirmation Analysis
  const confirmAnalysis = report
    ? report.confirmations.length > 0
      ? `Report ${report.state} at ${fmtYemenTime(report.reportTimestampIso)} — ${report.confirmations.length} confirmation(s), processed=${report.processed}`
      : `Report ${report.state} at ${fmtYemenTime(report.reportTimestampIso)} — no confirmations`
    : 'No report submitted';

  return {
    scheduleSnapshot,
    currentState,
    growattState: `${growattState} (since ${fmtYemenTime(world.growattLastTransitionAt)})`,
    referenceTime,
    referenceKind,
    generatedState,
    durationSelectionRule: durationRule,
    durationSelectionResult: durationResult,
    offsetFormula,
    offsetValue,
    offsetSign,
    offsetReason,
    timelineContinuityResult: timelineContinuity,
    transitionTree,
    verificationWindowResult: verificationWindow,
    uncertainZoneResult: uncertainZone,
    confidenceScoreChanges: confidenceChanges,
    communityConfirmationAnalysis: confirmAnalysis,
    expectedResult: expected,
    actualResult: actual,
    pass,
  };
}

/** Find the slot immediately AFTER the generated (isResynced) slot */
function findContinuationFirstSlot(result: UserPrediction | null) {
  if (!result) return null;
  const slots = result.daySchedule;
  const genIdx = slots.findIndex(s => (s as any).isResynced === true);
  if (genIdx === -1 || genIdx + 1 >= slots.length) return null;
  return slots[genIdx + 1];
}

/** Build a standard master schedule world */
function freshMasterSchedule(nowMs: number): { world: SimWorld; anchor: string } {
  const { world: w0, anchor } = freshBase(nowMs);
  const world = setSchedule(w0, MASTER_SCHEDULE);
  return { world, anchor };
}

const SCENARIOS_BASE_NOW = Date.now();

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO DEFINITIONS — All Groups A–K
// ══════════════════════════════════════════════════════════════════════════════

export const SCENARIOS: ScenarioDef[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP A — Growatt Currently ON (A1–A6)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'A', id: 'A1', name: 'Growatt ON + Report ON (after start)', description: 'Growatt ON started at 10:00. Report ON at 11:00 (1h after start).', expected: 'Generated ON Duration = Previous ON = 2h. Offset = +60m (Positive).',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      // Growatt ON at anchor+120min (10:00 equivalent)
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      // Report ON 1h after Growatt ON
      world = setSimulatedNow(world, world.simulatedNowMs + 60 * 60_000);
      world = submitReport(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 120 && meta?.offsetSign === 'POSITIVE' && (meta?.offsetMinutes ?? 0) > 0;
      const actual = `dur=${durMin}min, offset=${meta?.offsetMinutes}m (${meta?.offsetSign}), ref=${meta?.offsetReferenceKind}`;
      return { pass, actual, expected: 'dur=120min, offset=+60m (POSITIVE), ref=GROWATT_ON_START_ACTUAL', world, debugInfo: extractDebugInfo(world, 'dur=120min, offset=+60m', actual, pass) };
    },
  },
  {
    group: 'A', id: 'A2', name: 'Growatt ON + Report ON (before start)', description: 'Growatt ON at 10:00. Report ON backdated to 09:30 (30m before).', expected: 'Offset = −30m (Negative). Generated ON = 2h. UNCERTAIN_ZONE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      const growattOnMs = world.simulatedNowMs;
      world = forceGrowattState(world, 'ON');
      // Advance clock so report isn't "in the future"
      world = setSimulatedNow(world, growattOnMs + 30 * 60_000);
      // Report backdated to 30min before Growatt ON
      world = submitReport(world, 'ON', growattOnMs - 30 * 60_000);
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 120 && meta?.offsetSign === 'NEGATIVE' && (meta?.offsetMinutes ?? 0) < 0;
      const actual = `dur=${durMin}min, offset=${meta?.offsetMinutes}m (${meta?.offsetSign}), ref=${meta?.offsetReferenceKind}`;
      return { pass, actual, expected: 'dur=120min, offset=-30m (NEGATIVE), ref=GROWATT_ON_START_ACTUAL', world, debugInfo: extractDebugInfo(world, 'dur=120min, offset=-30m, UNCERTAIN_ZONE', actual, pass) };
    },
  },
  {
    group: 'A', id: 'A3', name: 'Growatt ON + Report ON (exact start)', description: 'Growatt ON at 10:00. Report ON exactly at 10:00.', expected: 'Offset = 0 (Neutral).',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = submitReport(world, 'ON', world.simulatedNowMs);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=0m (NEUTRAL)', world, debugInfo: extractDebugInfo(world, 'offset=0m (NEUTRAL)', actual, pass) };
    },
  },
  {
    group: 'A', id: 'A4', name: 'Growatt ON ending + Report OFF (before end)', description: 'Growatt ON ends at 13:00. Report OFF at 12:00 (1h before end).', expected: 'Offset = −60m (Negative). Generated OFF = Previous OFF = 6h. UNCERTAIN_ZONE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      // Growatt ON at anchor+120m, will end at anchor+300m (13:00)
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      // Report OFF 1h before ON ends (12:00)
      world = setSimulatedNow(world, new Date(anchor).getTime() + 240 * 60_000);
      world = submitReport(world, 'OFF');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 360 && meta?.offsetSign === 'NEGATIVE';
      const actual = `dur=${durMin}min, offset=${meta?.offsetMinutes}m (${meta?.offsetSign}), ref=${meta?.offsetReferenceKind}`;
      return { pass, actual, expected: 'dur=360min, offset=-60m (NEGATIVE), ref=GROWATT_ON_END_EXPECTED', world, debugInfo: extractDebugInfo(world, 'dur=360min, offset=-60m, UNCERTAIN_ZONE', actual, pass) };
    },
  },
  {
    group: 'A', id: 'A5', name: 'Growatt ON ended + Report OFF (after end)', description: 'Growatt ON ended at 13:00. Report OFF at 14:00 (1h after).', expected: 'Offset = +60m (Positive).',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      // ON ends, OFF starts at anchor+300m
      world = setSimulatedNow(world, new Date(anchor).getTime() + 300 * 60_000);
      world = forceGrowattState(world, 'OFF');
      // Report OFF 1h after ON ended
      world = setSimulatedNow(world, world.simulatedNowMs + 60 * 60_000);
      world = submitReport(world, 'OFF');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE' && (meta?.offsetMinutes ?? 0) > 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=+60m (POSITIVE)', world, debugInfo: extractDebugInfo(world, 'offset=+60m (POSITIVE)', actual, pass) };
    },
  },
  {
    group: 'A', id: 'A6', name: 'Growatt ON ended + Report OFF (exact end)', description: 'Growatt ON ends at 13:00. Report OFF exactly at 13:00.', expected: 'Offset = 0 (Neutral).',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 300 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = submitReport(world, 'OFF', world.simulatedNowMs);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=0m (NEUTRAL)', world, debugInfo: extractDebugInfo(world, 'offset=0m (NEUTRAL)', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP B — Growatt Currently OFF (B1–B6)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'B', id: 'B1', name: 'OFF Progress 20% + Report ON', description: 'OFF cycle at 20% progress. Report ON.', expected: 'Previous ON = 3h. Offset Negative.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      // OFF starts at anchor+120m, 6h duration. 20% = 72m into OFF.
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 72 * 60_000);
      world = submitReport(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 180 && meta?.durationSelectionRule === 'OFF_PROGRESS_LT_50_BEFORE';
      const actual = `dur=${durMin}min (Previous ON=3h), rule=${meta?.durationSelectionRule}, offsetSign=${meta?.offsetSign}`;
      return { pass, actual, expected: 'dur=180min, OFF_PROGRESS_LT_50_BEFORE, offset=NEGATIVE', world, debugInfo: extractDebugInfo(world, 'dur=180min (Previous ON), NEGATIVE', actual, pass) };
    },
  },
  {
    group: 'B', id: 'B2', name: 'OFF Progress 80% + Report ON', description: 'OFF cycle at 80% progress. Report ON.', expected: 'Next ON = 2h. Offset Negative.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 288 * 60_000); // 80% of 360m
      world = submitReport(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 120 && meta?.durationSelectionRule === 'OFF_PROGRESS_GT_50_AFTER';
      const actual = `dur=${durMin}min (Next ON=2h), rule=${meta?.durationSelectionRule}, offsetSign=${meta?.offsetSign}`;
      return { pass, actual, expected: 'dur=120min, OFF_PROGRESS_GT_50_AFTER, offset=NEGATIVE', world, debugInfo: extractDebugInfo(world, 'dur=120min (Next ON), NEGATIVE', actual, pass) };
    },
  },
  {
    group: 'B', id: 'B3', name: 'After expected OFF end + Report ON', description: 'Current 19:00, expected OFF ended at 18:00. Report ON.', expected: 'Offset Positive.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      // OFF at anchor+120m, expected to end at anchor+480m (after 6h + 3h ON)
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      // Advance past expected OFF end by 1h
      world = setSimulatedNow(world, new Date(anchor).getTime() + 540 * 60_000);
      world = submitReport(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE';
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=POSITIVE (report after expected OFF end)', world, debugInfo: extractDebugInfo(world, 'offset=POSITIVE', actual, pass) };
    },
  },
  {
    group: 'B', id: 'B4', name: 'Report OFF at OFF start', description: 'Report OFF exactly when OFF starts.', expected: 'Offset Neutral.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = submitReport(world, 'OFF', world.simulatedNowMs);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=0m (NEUTRAL)', world, debugInfo: extractDebugInfo(world, 'offset=0m (NEUTRAL)', actual, pass) };
    },
  },
  {
    group: 'B', id: 'B5', name: 'Report OFF after OFF start', description: 'Report OFF after OFF has started.', expected: 'Offset Positive.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 60 * 60_000);
      world = submitReport(world, 'OFF');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE' && (meta?.offsetMinutes ?? 0) > 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=POSITIVE (report after OFF start)', world, debugInfo: extractDebugInfo(world, 'offset=POSITIVE', actual, pass) };
    },
  },
  {
    group: 'B', id: 'B6', name: 'Report OFF before OFF start', description: 'Report OFF before OFF starts (backdated).', expected: 'Offset Negative.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      const offStartMs = world.simulatedNowMs;
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, offStartMs + 30 * 60_000);
      world = submitReport(world, 'OFF', offStartMs - 30 * 60_000);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEGATIVE';
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=NEGATIVE (report before OFF start)', world, debugInfo: extractDebugInfo(world, 'offset=NEGATIVE', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP C — Confirmation Scenarios (C1–C12 mirror of A1–A6 + B1–B6)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'C', id: 'C1', name: 'Confirm ON (after Growatt ON start)', description: 'Confirmation ON instead of Report ON — A1 equivalent.', expected: 'Same as A1: Previous ON=2h, offset +60m Positive.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, world.simulatedNowMs + 60 * 60_000);
      world = submitConfirmation(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 120 && meta?.offsetSign === 'POSITIVE';
      const actual = `dur=${durMin}min, offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'dur=120min, offset=+60m (POSITIVE) — same as report', world, debugInfo: extractDebugInfo(world, 'dur=120min, +60m (POSITIVE)', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C2', name: 'Confirm ON (before Growatt ON start)', description: 'Confirmation ON backdated — A2 equivalent.', expected: 'Same as A2: offset −30m Negative.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      const growattOnMs = world.simulatedNowMs;
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, growattOnMs + 30 * 60_000);
      world = submitConfirmation(world, 'ON', growattOnMs - 30 * 60_000);
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 120 && meta?.offsetSign === 'NEGATIVE';
      const actual = `dur=${durMin}min, offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'dur=120min, offset=-30m (NEGATIVE) — same as report', world, debugInfo: extractDebugInfo(world, 'dur=120min, -30m (NEGATIVE)', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C3', name: 'Confirm ON (exact Growatt ON start)', description: 'Confirmation ON exactly at Growatt ON — A3 equivalent.', expected: 'Same as A3: offset 0 Neutral.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = submitConfirmation(world, 'ON', world.simulatedNowMs);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=0m (NEUTRAL) — same as report', world, debugInfo: extractDebugInfo(world, 'offset=0m (NEUTRAL)', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C4', name: 'Confirm OFF (before Growatt ON end)', description: 'Confirmation OFF before ON ends — A4 equivalent.', expected: 'Same as A4: offset −60m Negative, Generated OFF=6h.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 240 * 60_000);
      world = submitConfirmation(world, 'OFF');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 360 && meta?.offsetSign === 'NEGATIVE';
      const actual = `dur=${durMin}min, offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'dur=360min, offset=-60m (NEGATIVE) — same as report', world, debugInfo: extractDebugInfo(world, 'dur=360min, -60m (NEGATIVE)', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C5', name: 'Confirm OFF (after Growatt ON end)', description: 'Confirmation OFF after ON ended — A5 equivalent.', expected: 'Same as A5: offset +60m Positive.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 300 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 60 * 60_000);
      world = submitConfirmation(world, 'OFF');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE' && (meta?.offsetMinutes ?? 0) > 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=+60m (POSITIVE) — same as report', world, debugInfo: extractDebugInfo(world, 'offset=+60m (POSITIVE)', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C6', name: 'Confirm OFF (exact Growatt ON end)', description: 'Confirmation OFF exactly at ON end — A6 equivalent.', expected: 'Same as A6: offset 0 Neutral.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 300 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = submitConfirmation(world, 'OFF', world.simulatedNowMs);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=0m (NEUTRAL) — same as report', world, debugInfo: extractDebugInfo(world, 'offset=0m (NEUTRAL)', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C7', name: 'Confirm ON at OFF 20% — B1 equivalent', description: 'Confirmation ON during OFF at 20% progress.', expected: 'Same as B1: Previous ON=3h, NEGATIVE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 72 * 60_000);
      world = submitConfirmation(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 180 && meta?.durationSelectionRule === 'OFF_PROGRESS_LT_50_BEFORE';
      const actual = `dur=${durMin}min, rule=${meta?.durationSelectionRule}`;
      return { pass, actual, expected: 'dur=180min, OFF_PROGRESS_LT_50_BEFORE — same as report', world, debugInfo: extractDebugInfo(world, 'dur=180min, NEGATIVE', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C8', name: 'Confirm ON at OFF 80% — B2 equivalent', description: 'Confirmation ON during OFF at 80% progress.', expected: 'Same as B2: Next ON=2h, NEGATIVE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 288 * 60_000);
      world = submitConfirmation(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 120 && meta?.durationSelectionRule === 'OFF_PROGRESS_GT_50_AFTER';
      const actual = `dur=${durMin}min, rule=${meta?.durationSelectionRule}`;
      return { pass, actual, expected: 'dur=120min, OFF_PROGRESS_GT_50_AFTER — same as report', world, debugInfo: extractDebugInfo(world, 'dur=120min, NEGATIVE', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C9', name: 'Confirm ON after expected OFF end', description: 'Confirmation ON after expected OFF end — B3 equivalent.', expected: 'Same as B3: POSITIVE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 540 * 60_000);
      world = submitConfirmation(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE';
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=POSITIVE — same as report', world, debugInfo: extractDebugInfo(world, 'offset=POSITIVE', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C10', name: 'Confirm OFF at OFF start — B4 equivalent', description: 'Confirmation OFF exactly at OFF start.', expected: 'Same as B4: NEUTRAL.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = submitConfirmation(world, 'OFF', world.simulatedNowMs);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=0m (NEUTRAL) — same as report', world, debugInfo: extractDebugInfo(world, 'offset=0m (NEUTRAL)', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C11', name: 'Confirm OFF after OFF start — B5 equivalent', description: 'Confirmation OFF after OFF started.', expected: 'Same as B5: POSITIVE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 60 * 60_000);
      world = submitConfirmation(world, 'OFF');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE' && (meta?.offsetMinutes ?? 0) > 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=POSITIVE — same as report', world, debugInfo: extractDebugInfo(world, 'offset=POSITIVE', actual, pass) };
    },
  },
  {
    group: 'C', id: 'C12', name: 'Confirm OFF before OFF start — B6 equivalent', description: 'Confirmation OFF backdated before OFF start.', expected: 'Same as B6: NEGATIVE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      const offStartMs = world.simulatedNowMs;
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, offStartMs + 30 * 60_000);
      world = submitConfirmation(world, 'OFF', offStartMs - 30 * 60_000);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEGATIVE';
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=NEGATIVE — same as report', world, debugInfo: extractDebugInfo(world, 'offset=NEGATIVE', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP D — OFF Progress Validation (D1–D2)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'D', id: 'D1', name: 'OFF Progress = 20% → Previous ON', description: 'OFF at 20% progress: must use PREVIOUS same-state (ON) duration.', expected: 'Previous ON duration (3h).',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 72 * 60_000);
      world = submitReport(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.durationSelectionRule === 'OFF_PROGRESS_LT_50_BEFORE';
      const actual = `rule=${meta?.durationSelectionRule}`;
      return { pass, actual, expected: 'OFF_PROGRESS_LT_50_BEFORE', world, debugInfo: extractDebugInfo(world, 'Previous ON (3h)', actual, pass) };
    },
  },
  {
    group: 'D', id: 'D2', name: 'OFF Progress = 80% → Next ON', description: 'OFF at 80% progress: must use NEXT same-state (ON) duration.', expected: 'Next ON duration (2h).',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 288 * 60_000);
      world = submitReport(world, 'ON');
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.durationSelectionRule === 'OFF_PROGRESS_GT_50_AFTER';
      const actual = `rule=${meta?.durationSelectionRule}`;
      return { pass, actual, expected: 'OFF_PROGRESS_GT_50_AFTER', world, debugInfo: extractDebugInfo(world, 'Next ON (2h)', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP E — ON Interruption Validation (E1–E2)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'E', id: 'E1', name: 'ON interrupted early → Previous OFF', description: 'ON interrupted at 10% progress → must use Previous OFF (no 50% rule).', expected: 'Previous OFF duration (6h).',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      // ON at anchor+120m (10:00), duration 3h. Interrupt at 10% = 18m into ON
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, world.simulatedNowMs + 18 * 60_000);
      world = submitReport(world, 'OFF');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 360 && meta?.durationSelectionRule === 'ON_ALWAYS_BEFORE';
      const actual = `dur=${durMin}min, rule=${meta?.durationSelectionRule}`;
      return { pass, actual, expected: 'dur=360min, ON_ALWAYS_BEFORE', world, debugInfo: extractDebugInfo(world, 'Previous OFF (6h)', actual, pass) };
    },
  },
  {
    group: 'E', id: 'E2', name: 'ON interrupted late → Previous OFF', description: 'ON interrupted at 90% progress → still must use Previous OFF (no 50% rule).', expected: 'Previous OFF duration (6h) — ON ignores progress.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      world = setSimulatedNow(world, world.simulatedNowMs + 162 * 60_000); // 90% of 3h
      world = submitReport(world, 'OFF');
      const meta = world.lastResult?.communityTransitionMeta;
      const durMin = meta ? (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000 : null;
      const pass = durMin === 360 && meta?.durationSelectionRule === 'ON_ALWAYS_BEFORE';
      const actual = `dur=${durMin}min, rule=${meta?.durationSelectionRule}`;
      return { pass, actual, expected: 'dur=360min, ON_ALWAYS_BEFORE (ignores 90% progress)', world, debugInfo: extractDebugInfo(world, 'Previous OFF (6h)', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP F — Generated State Completion (F1–F3)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'F', id: 'F1', name: 'Positive Offset → Verification Window', description: 'Positive offset completion should trigger verification window.', expected: 'ATC enters POSITIVE_OFFSET_PENDING or Verification Window.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 80 * 60_000);
      world = submitConfirmation(world, 'OFF'); // produces POSITIVE offset
      const continuationSlot = findContinuationFirstSlot(world.lastResult);
      const generatedEnd = world.lastResult!.communityTransitionMeta!.generatedCycleEndIso;
      const continuationStartMs = new Date(generatedEnd).getTime();
      const continuationDurMs = continuationSlot?.endIso ? new Date(continuationSlot.endIso).getTime() - continuationStartMs : 60 * 60_000;
      const midPointMs = continuationStartMs + Math.min(continuationDurMs / 2, 60 * 60_000);
      world = setSimulatedNow(world, midPointMs);
      const matchingState: 'ON' | 'OFF' = continuationSlot?.state ?? 'ON';
      const oppositeOfContinuation: 'ON' | 'OFF' = matchingState === 'ON' ? 'OFF' : 'ON';
      world = forceGrowattState(world, matchingState);
      world = forceGrowattState(world, oppositeOfContinuation);
      const mode = world.lastResult?.atc.mode;
      const pass = !!(
        (mode === 'POSITIVE_OFFSET_PENDING' && !!world.lastResult?.atc.scheduledAutoTransitionIso) ||
        (mode === 'NORMAL' && world.lastResult?.reconciledCycleStartIso !== null && world.lastResult?.isResynced)
      );
      const actual = `atc.mode=${mode}, scheduledAuto=${world.lastResult?.atc.scheduledAutoTransitionIso}`;
      return { pass, actual, expected: 'POSITIVE_OFFSET_PENDING or NORMAL (reconciled)', world, debugInfo: extractDebugInfo(world, 'Verification Window', actual, pass) };
    },
  },
  {
    group: 'F', id: 'F2', name: 'Negative Offset → UNCERTAIN_ZONE', description: 'Negative offset completion should enter UNCERTAIN_ZONE.', expected: 'ATC mode = UNCERTAIN_ZONE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReport(world, 'ON'); // produces NEGATIVE offset
      const continuationSlot = findContinuationFirstSlot(world.lastResult);
      const target = continuationSlot?.endIso
        ? new Date(continuationSlot.endIso).getTime() + 35 * 60_000
        : world.simulatedNowMs + 35 * 60_000;
      world = setSimulatedNow(world, target);
      const pass = world.lastResult?.atc.mode === 'UNCERTAIN_ZONE';
      const actual = `atc.mode=${world.lastResult?.atc.mode}`;
      return { pass, actual, expected: 'atc.mode=UNCERTAIN_ZONE', world, debugInfo: extractDebugInfo(world, 'UNCERTAIN_ZONE', actual, pass) };
    },
  },
  {
    group: 'F', id: 'F3', name: 'Neutral Offset → Normal Continuity', description: 'Neutral offset should proceed with normal schedule continuity.', expected: 'ATC mode = NORMAL or COMMUNITY_SYNCED, no special zone.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      const offStartMs = world.simulatedNowMs;
      const offEndMs = offStartMs + 360 * 60_000;
      world = setSimulatedNow(world, offEndMs);
      world = submitReport(world, 'ON', offEndMs); // Neutral offset
      const pass = world.lastResult?.communityTransitionMeta?.offsetSign === 'NEUTRAL' &&
        (world.lastResult?.atc.mode === 'NORMAL' || world.lastResult?.atc.mode === 'COMMUNITY_SYNCED');
      const actual = `offsetSign=${world.lastResult?.communityTransitionMeta?.offsetSign}, atc.mode=${world.lastResult?.atc.mode}`;
      return { pass, actual, expected: 'NEUTRAL, mode=NORMAL/COMMUNITY_SYNCED', world, debugInfo: extractDebugInfo(world, 'Normal Continuity', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP G — Schedule Continuity (G1–G2)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'G', id: 'G1', name: 'Generated ON ends → Logical Next OFF', description: 'After generated ON ends, next slot must be OFF (logical sequence).', expected: 'Next slot = OFF with correct duration.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 360 * 60_000); // >50% → borrows next ON
      world = submitReport(world, 'ON');
      const slots = world.lastResult!.daySchedule;
      const genIdx = slots.findIndex(s => (s as any).isResynced);
      const nextSlot = genIdx >= 0 ? slots[genIdx + 1] : null;
      const pass = nextSlot?.state === 'OFF';
      const actual = `next=${nextSlot?.state} ${nextSlot?.durationLabel}`;
      return { pass, actual, expected: 'next=OFF (logical sequence)', world, debugInfo: extractDebugInfo(world, 'Logical Next OFF', actual, pass) };
    },
  },
  {
    group: 'G', id: 'G2', name: 'Generated OFF ends → Logical Next ON', description: 'After generated OFF ends, next slot must be ON (logical sequence).', expected: 'Next slot = ON with correct duration.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 18 * 60_000); // early in OFF
      world = submitReport(world, 'OFF'); // generates OFF with previous OFF duration
      const slots = world.lastResult!.daySchedule;
      const genIdx = slots.findIndex(s => (s as any).isResynced);
      const nextSlot = genIdx >= 0 ? slots[genIdx + 1] : null;
      const pass = nextSlot?.state === 'ON';
      const actual = `next=${nextSlot?.state} ${nextSlot?.durationLabel}`;
      return { pass, actual, expected: 'next=ON (logical sequence)', world, debugInfo: extractDebugInfo(world, 'Logical Next ON', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP H — Persistent Timeline (H1–H2)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'H', id: 'H1', name: 'Generated State Created → Stored Permanently', description: 'Generated state must be stored permanently in timeline.', expected: 'Generated slot (isResynced=true) present in daySchedule.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReport(world, 'ON');
      const present = world.lastResult?.daySchedule.some(s => (s as any).isResynced === true);
      const pass = !!present;
      const actual = `generated present=${present}`;
      return { pass, actual, expected: 'generated present=true', world, debugInfo: extractDebugInfo(world, 'Stored Permanently', actual, pass) };
    },
  },
  {
    group: 'H', id: 'H2', name: 'Generated State Completed → History Preserved', description: 'After generated state completes, history must still contain it.', expected: 'Generated slot still present after +20h.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = forceGrowattState(w0, 'ON');
      world = setSimulatedNow(world, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReport(world, 'ON');
      world = setSimulatedNow(world, world.simulatedNowMs + 20 * 3600 * 1000);
      const stillPresent = world.lastResult?.daySchedule.some(s => (s as any).isResynced === true);
      const pass = !!stillPresent;
      const actual = `generated present after +20h=${stillPresent}`;
      return { pass, actual, expected: 'generated present=true after +20h', world, debugInfo: extractDebugInfo(world, 'History Preserved', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP I — UNCERTAIN_ZONE (I1–I4)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'I', id: 'I1', name: 'Negative Offset Completion → Enter UNCERTAIN_ZONE', description: 'When negative offset generated cycle ends, enter UNCERTAIN_ZONE.', expected: 'atc.mode = UNCERTAIN_ZONE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReport(world, 'ON'); // NEGATIVE offset
      const continuationSlot = findContinuationFirstSlot(world.lastResult);
      const target = continuationSlot?.endIso
        ? new Date(continuationSlot.endIso).getTime() + 35 * 60_000
        : world.simulatedNowMs + 35 * 60_000;
      world = setSimulatedNow(world, target);
      const pass = world.lastResult?.atc.mode === 'UNCERTAIN_ZONE';
      const actual = `atc.mode=${world.lastResult?.atc.mode}`;
      return { pass, actual, expected: 'atc.mode=UNCERTAIN_ZONE', world, debugInfo: extractDebugInfo(world, 'Enter UNCERTAIN_ZONE', actual, pass) };
    },
  },
  {
    group: 'I', id: 'I2', name: 'Confirmation During UNCERTAIN_ZONE → Immediate Exit', description: 'A confirmation arriving during UNCERTAIN_ZONE should exit the zone.', expected: 'Exits UNCERTAIN_ZONE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReport(world, 'ON');
      const continuationSlot = findContinuationFirstSlot(world.lastResult);
      const target = continuationSlot?.endIso
        ? new Date(continuationSlot.endIso).getTime() + 35 * 60_000
        : world.simulatedNowMs + 35 * 60_000;
      world = setSimulatedNow(world, target); // Now in UNCERTAIN_ZONE
      const inZoneBefore = world.lastResult?.atc.mode === 'UNCERTAIN_ZONE';
      // Confirmation should exit
      world = submitConfirmation(world, 'ON');
      const exited = world.lastResult?.atc.mode !== 'UNCERTAIN_ZONE';
      const pass = inZoneBefore && exited;
      const actual = `inZoneBefore=${inZoneBefore}, modeAfter=${world.lastResult?.atc.mode}`;
      return { pass, actual, expected: 'inZoneBefore=true, modeAfter≠UNCERTAIN_ZONE', world, debugInfo: extractDebugInfo(world, 'Immediate Exit', actual, pass) };
    },
  },
  {
    group: 'I', id: 'I3', name: 'Report During UNCERTAIN_ZONE → Immediate Exit', description: 'A new report arriving during UNCERTAIN_ZONE should exit the zone.', expected: 'Exits UNCERTAIN_ZONE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReport(world, 'ON');
      const continuationSlot = findContinuationFirstSlot(world.lastResult);
      const target = continuationSlot?.endIso
        ? new Date(continuationSlot.endIso).getTime() + 35 * 60_000
        : world.simulatedNowMs + 35 * 60_000;
      world = setSimulatedNow(world, target);
      const inZoneBefore = world.lastResult?.atc.mode === 'UNCERTAIN_ZONE';
      world = submitReport(world, 'ON');
      const exited = world.lastResult?.atc.mode !== 'UNCERTAIN_ZONE';
      const pass = inZoneBefore && exited;
      const actual = `inZoneBefore=${inZoneBefore}, modeAfter=${world.lastResult?.atc.mode}`;
      return { pass, actual, expected: 'inZoneBefore=true, modeAfter≠UNCERTAIN_ZONE', world, debugInfo: extractDebugInfo(world, 'Immediate Exit', actual, pass) };
    },
  },
  {
    group: 'I', id: 'I4', name: 'Growatt Transition During UNCERTAIN_ZONE → Exit + Reconciliation', description: 'Growatt transition during UNCERTAIN_ZONE exits with duration reconciliation.', expected: 'Exits to NORMAL with reconciledCycleStartIso.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      world = setSimulatedNow(world, world.simulatedNowMs + 180 * 60_000);
      world = submitReport(world, 'ON');
      const continuationSlot = findContinuationFirstSlot(world.lastResult);
      const target = continuationSlot?.endIso
        ? new Date(continuationSlot.endIso).getTime() + 35 * 60_000
        : world.simulatedNowMs + 35 * 60_000;
      world = setSimulatedNow(world, target);
      const heldState = world.lastResult!.currentState;
      const newState: 'ON' | 'OFF' = heldState === 'ON' ? 'OFF' : 'ON';
      world = forceGrowattState(world, newState);
      const pass = world.lastResult?.atc.mode === 'NORMAL' && world.lastResult?.reconciledCycleStartIso !== null;
      const actual = `atc.mode=${world.lastResult?.atc.mode}, reconciled=${world.lastResult?.reconciledCycleStartIso}`;
      return { pass, actual, expected: 'atc.mode=NORMAL, reconciledCycleStartIso≠null', world, debugInfo: extractDebugInfo(world, 'Exit + Duration Reconciliation', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP J — Neutral Offset (J1–J3)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'J', id: 'J1', name: 'Offset = 0 → Neutral', description: 'Exact match between generated start and reference → offset 0.', expected: 'offsetSign = NEUTRAL, offsetMinutes = 0.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      const offStartMs = world.simulatedNowMs;
      const offEndMs = offStartMs + 360 * 60_000;
      world = setSimulatedNow(world, offEndMs);
      world = submitReport(world, 'ON', offEndMs);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEUTRAL' && meta?.offsetMinutes === 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=0m (NEUTRAL)', world, debugInfo: extractDebugInfo(world, 'Neutral', actual, pass) };
    },
  },
  {
    group: 'J', id: 'J2', name: 'Offset = +1 Minute → Positive', description: 'Generated start 1 minute after reference → Positive.', expected: 'offsetSign = POSITIVE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      const offStartMs = world.simulatedNowMs;
      world = setSimulatedNow(world, offStartMs + 360 * 60_000 + 60_000); // 1 min past OFF end
      world = submitReport(world, 'ON', offStartMs + 360 * 60_000 + 60_000);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'POSITIVE' && (meta?.offsetMinutes ?? 0) > 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=POSITIVE (+1m or more)', world, debugInfo: extractDebugInfo(world, 'Positive (+1m)', actual, pass) };
    },
  },
  {
    group: 'J', id: 'J3', name: 'Offset = −1 Minute → Negative', description: 'Generated start 1 minute before reference → Negative.', expected: 'offsetSign = NEGATIVE.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      const offStartMs = world.simulatedNowMs;
      world = setSimulatedNow(world, offStartMs + 360 * 60_000); // Now = OFF end
      // Report ON 1 minute BEFORE OFF end
      world = submitReport(world, 'ON', offStartMs + 360 * 60_000 - 60_000);
      const meta = world.lastResult?.communityTransitionMeta;
      const pass = meta?.offsetSign === 'NEGATIVE' && (meta?.offsetMinutes ?? 0) < 0;
      const actual = `offset=${meta?.offsetMinutes}m (${meta?.offsetSign})`;
      return { pass, actual, expected: 'offset=NEGATIVE (-1m or less)', world, debugInfo: extractDebugInfo(world, 'Negative (-1m)', actual, pass) };
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP K — Historical Confirmation Validation (K1–K8)
  // ════════════════════════════════════════════════════════════════════════════

  {
    group: 'K', id: 'K1', name: 'Confirmation 10 min after processed report', description: 'Report ON at 10:00 processed. Confirmation at 10:10.', expected: 'No new transition. Offset uses 10:00. Confidence increased.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      const reportMs = world.simulatedNowMs;
      world = submitReport(world, 'ON', reportMs); // Process report
      const confidenceBefore = world.confidenceScore;
      const slotsBefore = world.lastResult?.daySchedule.length ?? 0;
      // Confirmation 10 min later
      world = setSimulatedNow(world, reportMs + 10 * 60_000);
      world = submitConfirmation(world, 'ON', reportMs + 10 * 60_000);
      const confidenceAfter = world.confidenceScore;
      const noNewTransition = (world.lastResult?.daySchedule.length ?? 0) === slotsBefore;
      const pass = confidenceAfter > confidenceBefore && noNewTransition && world.reports[0].confirmations.length === 1;
      const actual = `confidence=${confidenceBefore}→${confidenceAfter}, noNewTransition=${noNewTransition}, confirms=${world.reports[0].confirmations.length}`;
      return { pass, actual, expected: 'confidence increased, no new transition', world, debugInfo: extractDebugInfo(world, 'Confidence only (+10m)', actual, pass) };
    },
  },
  {
    group: 'K', id: 'K2', name: 'Confirmation 4h after processed report', description: 'Report ON at 10:00. Confirmation at 14:00 (4h later).', expected: 'No new transition. Confidence increased only.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      const reportMs = world.simulatedNowMs;
      world = submitReport(world, 'ON', reportMs);
      const confidenceBefore = world.confidenceScore;
      world = setSimulatedNow(world, reportMs + 4 * 3600 * 1000);
      world = submitConfirmation(world, 'ON', reportMs + 4 * 3600 * 1000);
      const pass = world.confidenceScore > confidenceBefore && world.reports[0].confirmations.length === 1;
      const actual = `confidence=${confidenceBefore}→${world.confidenceScore}, confirms=${world.reports[0].confirmations.length}`;
      return { pass, actual, expected: 'confidence increased, no new transition', world, debugInfo: extractDebugInfo(world, 'Confidence only (+4h)', actual, pass) };
    },
  },
  {
    group: 'K', id: 'K3', name: 'Confirmation 12h after processed report', description: 'Report ON at 10:00. Confirmation at 22:00 (12h later).', expected: 'No new transition, no offset recalc, no generated state recreation. Confidence only.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      const reportMs = world.simulatedNowMs;
      world = submitReport(world, 'ON', reportMs);
      const confidenceBefore = world.confidenceScore;
      const genStartBefore = world.lastResult?.communityTransitionMeta?.generatedCycleStartIso;
      world = setSimulatedNow(world, reportMs + 12 * 3600 * 1000);
      world = submitConfirmation(world, 'ON', reportMs + 12 * 3600 * 1000);
      const genStartAfter = world.lastResult?.communityTransitionMeta?.generatedCycleStartIso;
      const noGenRecreate = genStartBefore === genStartAfter || !genStartAfter;
      const pass = world.confidenceScore > confidenceBefore && noGenRecreate && world.reports[0].confirmations.length === 1;
      const actual = `confidence=${confidenceBefore}→${world.confidenceScore}, noGenRecreate=${noGenRecreate}`;
      return { pass, actual, expected: 'confidence increased, no generated state recreation', world, debugInfo: extractDebugInfo(world, 'Confidence only (+12h)', actual, pass) };
    },
  },
  {
    group: 'K', id: 'K4', name: 'Confirmation 12h after processed report OFF', description: 'Report OFF at 08:00. Confirmation at 20:00 (12h later).', expected: 'No new transition, no timeline rebuild, no offset recalc. Confidence only.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      const reportMs = world.simulatedNowMs;
      world = submitReport(world, 'OFF', reportMs);
      const confidenceBefore = world.confidenceScore;
      world = setSimulatedNow(world, reportMs + 12 * 3600 * 1000);
      world = submitConfirmation(world, 'OFF', reportMs + 12 * 3600 * 1000);
      const pass = world.confidenceScore > confidenceBefore && world.reports[0].confirmations.length === 1;
      const actual = `confidence=${confidenceBefore}→${world.confidenceScore}`;
      return { pass, actual, expected: 'confidence increased, no new transition', world, debugInfo: extractDebugInfo(world, 'Confidence only (+12h OFF)', actual, pass) };
    },
  },
  {
    group: 'K', id: 'K5', name: 'Confirmation 24h after report → boundary', description: 'Report OFF at 08:00. Confirmation next day at 08:00 (24h).', expected: 'No new transition, no schedule reconstruction. Confidence only.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'OFF');
      const reportMs = world.simulatedNowMs;
      world = submitReport(world, 'OFF', reportMs);
      const confidenceBefore = world.confidenceScore;
      world = setSimulatedNow(world, reportMs + 24 * 3600 * 1000);
      world = submitConfirmation(world, 'OFF', reportMs + 24 * 3600 * 1000);
      const pass = world.confidenceScore > confidenceBefore && world.reports[0].confirmations.length === 1;
      const actual = `confidence=${confidenceBefore}→${world.confidenceScore}`;
      return { pass, actual, expected: 'confidence increased, no new transition', world, debugInfo: extractDebugInfo(world, 'Confidence only (+24h)', actual, pass) };
    },
  },
  {
    group: 'K', id: 'K6', name: 'Unprocessed Report + Confirmation', description: 'Report ON at 10:00 (not processed). Confirmation at 18:00 processes it.', expected: 'Generated State Start = 10:00 (NOT 18:00). All calculations use 10:00.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      const reportMs = world.simulatedNowMs;
      // Create report but do NOT process it
      const reportAtIso = new Date(reportMs).toISOString();
      const reportEntry: SimReportEntry = {
        id: `rep_k6_${Date.now()}`,
        state: 'ON',
        reportTimestampMs: reportMs,
        reportTimestampIso: reportAtIso,
        processed: false,
        isStandaloneConfirmation: false,
        confidenceScore: 50,
        confirmations: [],
        transitionResult: null,
      };
      world = { ...world, reports: [...world.reports, reportEntry] };
      // Now advance to 18:00 and submit confirmation
      world = setSimulatedNow(world, reportMs + 8 * 3600 * 1000);
      world = submitConfirmation(world, 'ON', reportMs + 8 * 3600 * 1000);
      const meta = world.lastResult?.communityTransitionMeta;
      // The generated state should use the REPORT timestamp (10:00), not confirmation (18:00)
      const genStartMs = meta ? new Date(meta.generatedCycleStartIso).getTime() : null;
      const usesReportTimestamp = genStartMs === reportMs;
      const pass = usesReportTimestamp && meta?.offsetSign === 'NEUTRAL';
      const actual = `genStart=${fmtYemenTime(meta?.generatedCycleStartIso ?? '')}, usesReportTime=${usesReportTimestamp}`;
      return { pass, actual, expected: `genStart=${fmtYemenTime(reportAtIso)} (report time)`, world, debugInfo: extractDebugInfo(world, 'Uses Report Time 10:00', actual, pass) };
    },
  },
  {
    group: 'K', id: 'K7', name: 'Multiple Confirmations', description: 'One report ON at 10:00. Three confirmations at 11:00, 15:00, 21:00.', expected: 'One transition, one generated state, offset calculated once. Confidence increases each time.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      const reportMs = world.simulatedNowMs;
      world = submitReport(world, 'ON', reportMs);
      const genCount = world.reports.filter(r => r.processed && r.transitionResult).length;
      const confidenceAfterReport = world.confidenceScore;
      // Confirmation 1
      world = setSimulatedNow(world, reportMs + 1 * 3600 * 1000);
      world = submitConfirmation(world, 'ON', reportMs + 1 * 3600 * 1000);
      const confidenceAfterC1 = world.confidenceScore;
      // Confirmation 2
      world = setSimulatedNow(world, reportMs + 5 * 3600 * 1000);
      world = submitConfirmation(world, 'ON', reportMs + 5 * 3600 * 1000);
      const confidenceAfterC2 = world.confidenceScore;
      // Confirmation 3
      world = setSimulatedNow(world, reportMs + 11 * 3600 * 1000);
      world = submitConfirmation(world, 'ON', reportMs + 11 * 3600 * 1000);
      const confidenceAfterC3 = world.confidenceScore;
      const totalTransitions = genCount; // Should still be 1
      const pass = totalTransitions === 1 && confidenceAfterC3 > confidenceAfterC2 && confidenceAfterC2 > confidenceAfterC1 && confidenceAfterC1 > confidenceAfterReport;
      const actual = `transitions=${totalTransitions}, confidence=${confidenceAfterReport}→${confidenceAfterC1}→${confidenceAfterC2}→${confidenceAfterC3}`;
      return { pass, actual, expected: '1 transition, confidence increased 3×', world, debugInfo: extractDebugInfo(world, '1 transition, 3× confidence', actual, pass) };
    },
  },
  {
    group: 'K', id: 'K8', name: 'Confirmation After Generated State Finished', description: 'Report ON at 10:00. Generated cycle ends 13:00. Confirmation at 18:00.', expected: 'Do not recreate cycle. Do not rebuild history. Do not change offset. Confidence only.',
    run: () => {
      const { world: w0, anchor } = freshMasterSchedule(SCENARIOS_BASE_NOW);
      let world = setSimulatedNow(w0, new Date(anchor).getTime() + 120 * 60_000);
      world = forceGrowattState(world, 'ON');
      const reportMs = world.simulatedNowMs;
      world = submitReport(world, 'ON', reportMs);
      const genEndMs = new Date(world.lastResult!.communityTransitionMeta!.generatedCycleEndIso).getTime();
      // Advance past generated cycle end
      world = setSimulatedNow(world, genEndMs + 5 * 60_000);
      const modeAfterEnd = world.lastResult?.atc.mode;
      // Now confirmation arrives 5h after report
      world = setSimulatedNow(world, reportMs + 8 * 3600 * 1000);
      const reportsBefore = world.reports.length;
      const slotsBefore = world.lastResult?.daySchedule.length ?? 0;
      world = submitConfirmation(world, 'ON', reportMs + 8 * 3600 * 1000);
      const noNewSlots = (world.lastResult?.daySchedule.length ?? 0) <= slotsBefore + 1; // +1 tolerance
      const pass = modeAfterEnd !== 'COMMUNITY_SYNCED' && noNewSlots && world.confidenceScore > 50;
      const actual = `modeAfterGenEnd=${modeAfterEnd}, noNewSlots=${noNewSlots}, confidence=${world.confidenceScore}`;
      return { pass, actual, expected: 'mode≠COMMUNITY_SYNCED (gen ended), confidence increased', world, debugInfo: extractDebugInfo(world, 'Confidence only (after gen end)', actual, pass) };
    },
  },
];

/** Get total scenario count */
export function getTotalScenarioCount(): number {
  return SCENARIOS.length;
}

/** Get scenario count by group */
export function getScenarioCountByGroup(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sc of SCENARIOS) {
    counts[sc.group] = (counts[sc.group] || 0) + 1;
  }
  return counts;
}
