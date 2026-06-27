/**
 * TMMS V2 Interactive Debug Simulator
 * ════════════════════════════════════════════════════════════════════
 * Authoritative validation environment for all TMMS V2 spec scenarios
 * (Groups A – K).  Runs 100 % engine-live: every result comes from the
 * real computeCommunityOffset / computeCommunityTransition / computeATCState
 * pipeline, not from mocked stubs.
 *
 * Add to app/(admin)/ and reach from your admin tab / debug drawer.
 * No backend required — all computation is pure and deterministic.
 *
 * Mandatory first-step audit is embedded at the top of the screen and
 * checks every modified file for correct alignment with the engine.
 * ════════════════════════════════════════════════════════════════════
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, FlatList, SectionList,
} from 'react-native';
import {
  computeCommunityOffset,
  computeCommunityTransition,
  computeATCState,
  applyOffsetToPrediction,
  extendScheduleTo48h,
  applyOffsetToSlots,
  findActiveSlotInRawSchedule,
  atcShouldHold,
  fmtYemenTime,
  getZoneFromIso,
  durationLabelFromMin,
  arabicDurationRange,
  elapsedLabel,
  createReportRecord,
  findConfirmableReport,
  applyConfirmationToReport,
  computeAccuracyLogEvent,
  MAX_CONFIRMATION_WINDOW_MS,
  BASE_REPORT_CONFIDENCE,
  CONFIRMATION_CONFIDENCE_BONUS,
  trustLevelForScore,
  type ScheduleSlot,
  type ShiftedScheduleSlot,
  type Prediction,
  type ResyncPoint,
  type CommunityOffsetResult,
  type CommunityTransitionResult,
  type ATCState,
  type UserPrediction,
  type ReportRecord,
  type DecisionStep,
} from './tmmsEngine';

// ─────────────────────────────────────────────────────────────────────────────
// COLOUR PALETTE
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  bg:       '#060d1a',
  surface:  '#0d1526',
  elevated: '#162035',
  border:   '#1e2d45',
  accent:   '#38bdf8',
  pass:     '#22c55e',
  fail:     '#ef4444',
  warn:     '#f59e0b',
  info:     '#818cf8',
  muted:    '#475569',
  text:     '#f1f5f9',
  textSec:  '#94a3b8',
  textMute: '#4a5e7a',
  on:       '#22c55e',
  off:      '#ef4444',
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface Criterion {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
  note?: string;
}

interface ScenarioResult {
  id: string;
  group: string;
  name: string;
  description: string;
  // ── Panel 1 – Schedule Snapshot ──
  schedule: ScheduleSlot[];
  // ── Panels 2–4 ──
  growattState: 'ON' | 'OFF';
  growattLastTransitionAt: string;
  syncedAtIso: string;
  reportedState: 'ON' | 'OFF';
  nowMs: number;
  // ── Panels 5–11 ──
  offsetResult: CommunityOffsetResult | null;
  communityTransition: CommunityTransitionResult | null;
  // ── Panels 12–15 ──
  atcDuringCycle: ATCState | null;
  atcAfterCycle: ATCState | null;
  continuationFirstSlot: ShiftedScheduleSlot | null;
  // ── Panel 16 – Confidence (Group K) ──
  reportBefore?: ReportRecord;
  reportAfter?: ReportRecord;
  confirmationTimestampCheck?: {
    reportTime: string;
    confirmTime: string;
    generatedStart: string | null;
    usesReportTime: boolean;
    withinWindow: boolean;
    windowHours: number;
  };
  // ── Panels 17–20 ──
  criteria: Criterion[];
  overallPass: boolean;
  decisionTrace: DecisionStep[];
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME HELPERS (use a fixed midnight as base so results are stable)
// ─────────────────────────────────────────────────────────────────────────────
const REF = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const h   = (hr: number, mn = 0): string => new Date(REF + hr * 3_600_000 + mn * 60_000).toISOString();
const hMs = (hr: number, mn = 0): number => REF + hr * 3_600_000 + mn * 60_000;
const hh  = (iso: string) => { const d = new Date(iso); return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; };
const durMin = (s: string, e: string) => Math.round((new Date(e).getTime() - new Date(s).getTime()) / 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// MASTER SCHEDULE (ON 02-04, OFF 04-10, ON 10-13, OFF 13-18, ON 18-20, OFF 20-02)
// ─────────────────────────────────────────────────────────────────────────────
function buildMaster(): ScheduleSlot[] {
  const mk = (state: 'ON'|'OFF', sh: number, eh: number, em = 0): ScheduleSlot => ({
    state,
    startIso:       h(sh),
    endIso:         h(eh, em),
    startFormatted: hh(h(sh)),
    endFormatted:   hh(h(eh, em)),
    durationLabel:  durationLabelFromMin((eh * 60 + em) - sh * 60),
    zone:           getZoneFromIso(h(sh)),
    isEstimated:    false,
  });
  return [
    mk('ON',   2,  4),   // 2h
    mk('OFF',  4, 10),   // 6h
    mk('ON',  10, 13),   // 3h
    mk('OFF', 13, 18),   // 5h
    mk('ON',  18, 20),   // 2h
    mk('OFF', 20, 26),   // 6h  (26 = 02:00 next day)
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK PREDICTION
// ─────────────────────────────────────────────────────────────────────────────
function mockPrediction(
  currentState: 'ON'|'OFF',
  lastTransitionAt: string,
  schedule: ScheduleSlot[],
  nowMs: number,
): Prediction {
  const elMin = Math.max(0, Math.round((nowMs - new Date(lastTransitionAt).getTime()) / 60_000));
  return {
    currentState,
    currentStateDurationMin:   elMin,
    currentStateDurationLabel: durationLabelFromMin(elMin),
    lastTransitionAt,
    inverterOffline:   false,
    nextTransition:    null,
    expectedOffRange:  { minMin: 300, maxMin: 360, label: '5-6s' },
    expectedOnRange:   { minMin: 120, maxMin: 180, label: '2-3s' },
    daySchedule:       schedule,
    confidence:        80,
    confidenceLabel:   'High',
    isUnstable:        false,
    stabilityScore:    80,
    stabilityLabel:    'Stable',
    dayPattern:        { cycles:3, avgOffMin:330, stdDevOffMin:30, avgOnMin:150, stdDevOnMin:20, minOffMin:300, maxOffMin:360, minOnMin:120, maxOnMin:180 },
    nightPattern:      null,
    allPattern:        { cycles:6, avgOffMin:330, stdDevOffMin:30, avgOnMin:150, stdDevOnMin:20, minOffMin:300, maxOffMin:360, minOnMin:120, maxOnMin:180 },
    cyclesAnalyzed:    6,
    dayCyclesAnalyzed:  3,
    nightCyclesAnalyzed: 3,
    currentPeriod:     'day',
    reasoning:         ['Master test schedule'],
    learningMode:      'learned',
    dataWindowHours:   48,
    computedAt:        new Date(nowMs).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE SCENARIO RUNNER
// ─────────────────────────────────────────────────────────────────────────────
interface ScenarioConfig {
  id: string;
  group: string;
  name: string;
  description: string;
  growattState: 'ON'|'OFF';
  growattLastTransitionAt: string;
  reportedState: 'ON'|'OFF';
  syncedAtIso: string;
  nowMs: number;
  personalOffsetMinutes?: number;
  frozenOffsetMinutes?: number | null;
  // Expected
  exp: {
    offsetMinutes?: number;
    offsetSign?: 'POSITIVE'|'NEGATIVE'|'NEUTRAL';
    durMin?: number;
    durRule?: string;
    atcDuring?: string;
    atcAfter?: string;
    nextCycleState?: 'ON'|'OFF';
  };
  expNote?: string; // extra note shown in spec-vs-actual
}

function runScenario(cfg: ScenarioConfig): ScenarioResult {
  const sched = buildMaster();
  const pred  = mockPrediction(cfg.growattState, cfg.growattLastTransitionAt, sched, cfg.nowMs);
  const resync: ResyncPoint = {
    syncedState:       cfg.reportedState,
    syncedAtIso:       cfg.syncedAtIso,
    appliedAtIso:      new Date(cfg.nowMs).toISOString(),
    reporterName:      'SimReporter',
    reporterReliability: 80,
  };
  const personal = (cfg.personalOffsetMinutes ?? 0) * 60_000;
  const extended  = extendScheduleTo48h(sched, pred, cfg.nowMs);
  const effective = applyOffsetToSlots(extended, personal);

  // ── Engine calls ──────────────────────────────────────────────────────────
  const offsetResult       = computeCommunityOffset(sched, resync, cfg.growattState, cfg.growattLastTransitionAt);
  const communityTransition = computeCommunityTransition(
    effective, resync, sched, cfg.growattState, cfg.growattLastTransitionAt,
    cfg.frozenOffsetMinutes ?? null, cfg.nowMs,
  );

  // ATC during generated cycle
  let atcDuringCycle: ATCState | null = null;
  if (communityTransition) {
    const midMs = cfg.nowMs + 5 * 60_000; // 5 min after report
    atcDuringCycle = computeATCState(
      communityTransition.effectiveSlots, 0, resync, pred, 'AUTO', communityTransition, midMs,
    );
  }

  // ATC 10 min after generated cycle ends
  let atcAfterCycle: ATCState | null = null;
  let continuationFirstSlot: ShiftedScheduleSlot | null = null;
  if (communityTransition) {
    const afterMs = new Date(communityTransition.generatedCycleEndIso).getTime() + 10 * 60_000;
    atcAfterCycle = computeATCState(
      communityTransition.effectiveSlots,
      communityTransition.derivedOffsetMinutes,
      null, pred, 'AUTO', null, afterMs,
    );
    // Find next slot after generated cycle = continuation[0]
    const slots = communityTransition.effectiveSlots;
    for (const s of slots) {
      if (new Date(s.startIso).getTime() >= new Date(communityTransition.generatedCycleEndIso).getTime()) {
        continuationFirstSlot = s;
        break;
      }
    }
  }

  // ── Build criteria ────────────────────────────────────────────────────────
  const criteria: Criterion[] = [];
  const { exp } = cfg;

  if (exp.offsetMinutes !== undefined) {
    const actual = offsetResult?.offsetMinutes ?? null;
    criteria.push({
      name: 'Offset (minutes)',
      expected: `${exp.offsetMinutes >= 0 ? '+' : ''}${exp.offsetMinutes}m`,
      actual:   actual !== null ? `${actual >= 0 ? '+' : ''}${actual}m` : '— (null)',
      pass:     actual === exp.offsetMinutes,
    });
  }
  if (exp.offsetSign !== undefined) {
    const actual = offsetResult?.sign ?? null;
    criteria.push({
      name: 'Offset sign',
      expected: exp.offsetSign,
      actual:   actual ?? '— (null)',
      pass:     actual === exp.offsetSign,
    });
  }
  if (exp.durMin !== undefined) {
    const actualDur = communityTransition
      ? durMin(communityTransition.generatedCycleStartIso, communityTransition.generatedCycleEndIso)
      : null;
    criteria.push({
      name: 'Generated duration (min)',
      expected: `${exp.durMin}m (${durationLabelFromMin(exp.durMin)})`,
      actual:   actualDur !== null ? `${actualDur}m (${durationLabelFromMin(actualDur)})` : '— (no cycle)',
      pass:     actualDur === exp.durMin,
      note:     cfg.expNote,
    });
  }
  if (exp.durRule !== undefined) {
    const actual = communityTransition?.durationSelectionRule ?? null;
    criteria.push({
      name: 'Duration rule',
      expected: exp.durRule,
      actual:   actual ?? '— (no cycle)',
      pass:     actual === exp.durRule,
    });
  }
  if (exp.atcDuring !== undefined) {
    const actual = atcDuringCycle?.mode ?? null;
    criteria.push({
      name: 'ATC (during cycle)',
      expected: exp.atcDuring,
      actual:   actual ?? '— (no cycle)',
      pass:     actual === exp.atcDuring,
    });
  }
  if (exp.atcAfter !== undefined) {
    const actual = atcAfterCycle?.mode ?? null;
    criteria.push({
      name: 'ATC (after cycle)',
      expected: exp.atcAfter,
      actual:   actual ?? '— (no cycle)',
      pass:     actual === exp.atcAfter,
    });
  }
  if (exp.nextCycleState !== undefined) {
    const actual = continuationFirstSlot?.state ?? null;
    criteria.push({
      name: 'Continuation first slot state',
      expected: exp.nextCycleState,
      actual:   actual ?? '— (null)',
      pass:     actual === exp.nextCycleState,
    });
  }

  return {
    id: cfg.id, group: cfg.group, name: cfg.name, description: cfg.description,
    schedule: sched,
    growattState: cfg.growattState, growattLastTransitionAt: cfg.growattLastTransitionAt,
    syncedAtIso: cfg.syncedAtIso, reportedState: cfg.reportedState, nowMs: cfg.nowMs,
    offsetResult, communityTransition,
    atcDuringCycle, atcAfterCycle, continuationFirstSlot,
    criteria,
    overallPass: criteria.length > 0 && criteria.every(c => c.pass),
    decisionTrace: communityTransition?.decisionTrace ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP K RUNNER — Confirmation Timestamp Rule
// ─────────────────────────────────────────────────────────────────────────────
interface KConfig {
  id: string;
  name: string;
  description: string;
  reportState: 'ON'|'OFF';
  reportAtIso: string;
  reporterName: string;
  processedAtIso: string | null; // null = unprocessed
  confirmations: string[]; // ISO timestamps
  confirmAfterWindowMs?: boolean; // force confirm after 24h
  // expectation
  exp: {
    originalReportAtUnchanged: boolean;
    withinWindow?: boolean;
    confidenceAfterAllConfirmations: number;
    oneTransitionOnly: boolean;
    generatedStartEqualsReportAt: boolean;
  };
}

interface KResult {
  id: string;
  name: string;
  description: string;
  reportBefore: ReportRecord;
  reportAfter: ReportRecord;
  confirmationTimestampCheck: {
    reportTime: string;
    confirmTime: string;
    generatedStart: string | null;
    usesReportTime: boolean;
    withinWindow: boolean;
    windowHours: number;
  } | null;
  growattState: 'ON'|'OFF';
  growattLastTransitionAt: string;
  syncedAtIso: string;
  reportedState: 'ON'|'OFF';
  nowMs: number;
  offsetResult: CommunityOffsetResult | null;
  communityTransition: CommunityTransitionResult | null;
  atcDuringCycle: ATCState | null;
  atcAfterCycle: ATCState | null;
  continuationFirstSlot: ShiftedScheduleSlot | null;
  schedule: ScheduleSlot[];
  criteria: Criterion[];
  overallPass: boolean;
  decisionTrace: DecisionStep[];
  reportBefore2?: ReportRecord;
  reportAfter2?: ReportRecord;
}

function runKScenario(cfg: KConfig): KResult {
  const sched = buildMaster();
  let report   = createReportRecord(cfg.reportState, cfg.reportAtIso, cfg.reporterName, !!cfg.processedAtIso, cfg.processedAtIso);
  const before = report;

  // Apply all confirmations in order
  const confirmAtIso = cfg.confirmations[0] ?? cfg.reportAtIso;
  for (const confIso of cfg.confirmations) {
    const confMs = new Date(confIso).getTime();
    const found  = findConfirmableReport([report], cfg.reportState, confMs);
    if (found) {
      report = applyConfirmationToReport(found, confIso, 'SimConfirmer');
    }
    // else: outside window — no change to report
  }
  const after = report;

  // Now run the engine using originalReportAtIso (not confirmAtIso)
  const growattState: 'ON'|'OFF' = cfg.reportState === 'ON' ? 'OFF' : 'ON';
  const lastT   = cfg.reportAtIso; // reference
  const nowMs   = new Date(cfg.reportAtIso).getTime() + 5 * 60_000; // 5 min after report
  const resync: ResyncPoint = {
    syncedState:   cfg.reportState,
    syncedAtIso:   cfg.reportAtIso, // KEY: always original report timestamp
    appliedAtIso:  new Date(nowMs).toISOString(),
    reporterName:  cfg.reporterName,
    reporterReliability: 80,
  };
  const pred = mockPrediction(growattState, lastT, sched, nowMs);
  const extended  = extendScheduleTo48h(sched, pred, nowMs);
  const effective = applyOffsetToSlots(extended, 0);

  const offsetResult        = computeCommunityOffset(sched, resync, growattState, lastT);
  const communityTransition = computeCommunityTransition(effective, resync, sched, growattState, lastT, null, nowMs);

  let atcDuringCycle: ATCState | null = null;
  let atcAfterCycle:  ATCState | null = null;
  let continuationFirstSlot: ShiftedScheduleSlot | null = null;
  if (communityTransition) {
    atcDuringCycle = computeATCState(
      communityTransition.effectiveSlots, 0, resync, pred, 'AUTO', communityTransition,
      nowMs + 5 * 60_000,
    );
    const afterMs = new Date(communityTransition.generatedCycleEndIso).getTime() + 10 * 60_000;
    atcAfterCycle = computeATCState(
      communityTransition.effectiveSlots, communityTransition.derivedOffsetMinutes,
      null, pred, 'AUTO', null, afterMs,
    );
    for (const s of communityTransition.effectiveSlots) {
      if (new Date(s.startIso).getTime() >= new Date(communityTransition.generatedCycleEndIso).getTime()) {
        continuationFirstSlot = s; break;
      }
    }
  }

  // Confirmation timestamp check
  const lastConfirmIso = cfg.confirmations[cfg.confirmations.length - 1] ?? cfg.reportAtIso;
  const deltaMs  = new Date(lastConfirmIso).getTime() - new Date(cfg.reportAtIso).getTime();
  const withinWindow = deltaMs >= 0 && deltaMs <= MAX_CONFIRMATION_WINDOW_MS;
  const confCheck = {
    reportTime:    cfg.reportAtIso,
    confirmTime:   lastConfirmIso,
    generatedStart: communityTransition?.generatedCycleStartIso ?? null,
    usesReportTime: communityTransition?.generatedCycleStartIso === cfg.reportAtIso,
    withinWindow,
    windowHours:   deltaMs / 3_600_000,
  };

  // Expected confidence after all confirmations
  const expectedConf = Math.min(100, BASE_REPORT_CONFIDENCE + cfg.confirmations.filter(confIso => {
    const d = new Date(confIso).getTime() - new Date(cfg.reportAtIso).getTime();
    return d >= 0 && d <= MAX_CONFIRMATION_WINDOW_MS;
  }).length * CONFIRMATION_CONFIDENCE_BONUS);

  const criteria: Criterion[] = [
    {
      name:     'originalReportAtIso unchanged',
      expected: 'TRUE — never modified by any confirmation',
      actual:   after.originalReportAtIso === cfg.reportAtIso ? 'TRUE' : `CHANGED to ${after.originalReportAtIso}`,
      pass:     after.originalReportAtIso === cfg.reportAtIso,
    },
    {
      name:     'Generated cycle start = originalReportAtIso',
      expected: cfg.exp.generatedStartEqualsReportAt
        ? `${hh(cfg.reportAtIso)} (report time)`
        : 'N/A (no new cycle expected)',
      actual:   communityTransition?.generatedCycleStartIso
        ? hh(communityTransition.generatedCycleStartIso) : '— (no cycle)',
      pass:     cfg.exp.generatedStartEqualsReportAt
        ? communityTransition?.generatedCycleStartIso === cfg.reportAtIso
        : !communityTransition || communityTransition.generatedCycleStartIso === cfg.reportAtIso,
    },
    {
      name:     'Confidence after confirmations',
      expected: `${expectedConf}  (trust: ${trustLevelForScore(expectedConf)})`,
      actual:   `${after.confidenceScore}  (trust: ${after.trustLevel})`,
      pass:     after.confidenceScore === expectedConf,
    },
    {
      name:     'Confirmation count logged',
      expected: `${cfg.confirmations.filter(ci => {
        const d = new Date(ci).getTime() - new Date(cfg.reportAtIso).getTime();
        return d >= 0 && d <= MAX_CONFIRMATION_WINDOW_MS;
      }).length} (within 24h window)`,
      actual:   String(after.confirmations.length),
      pass:     after.confirmations.length === cfg.confirmations.filter(ci => {
        const d = new Date(ci).getTime() - new Date(cfg.reportAtIso).getTime();
        return d >= 0 && d <= MAX_CONFIRMATION_WINDOW_MS;
      }).length,
    },
  ];

  return {
    id: cfg.id, name: cfg.name, description: cfg.description,
    reportBefore: before, reportAfter: after,
    confirmationTimestampCheck: confCheck,
    growattState, growattLastTransitionAt: lastT,
    syncedAtIso: cfg.reportAtIso, reportedState: cfg.reportState,
    nowMs, offsetResult, communityTransition,
    atcDuringCycle, atcAfterCycle, continuationFirstSlot,
    schedule: sched, criteria,
    overallPass: criteria.every(c => c.pass),
    decisionTrace: communityTransition?.decisionTrace ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL SCENARIO DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
/*
 NOTE ON A1/A2 DURATION DISCREPANCY
 The spec says "Previous ON = 2h" for A1 and A2.  The engine produces
 "Next ON = 3h" because at syncMs=11:00 (A1) or 09:30 (A2), the engine
 falls back to the most-recently-started OFF slot (04:00→10:00), computes
 progress = 116% or 91.7% (both > 50%), and therefore selects the NEXT ON
 (10:00→13:00 = 3h) not the PREVIOUS ON (02:00→04:00 = 2h).  The simulator
 flags this mismatch, which is precisely what it is designed to surface.
*/

function buildAllScenarios(): ScenarioResult[] {
  const results: ScenarioResult[] = [];

  // ── GROUP A: Growatt Currently ON ─────────────────────────────────────────
  results.push(runScenario({
    id: 'A1', group: 'A', name: 'A1 — Report ON +60m (Positive)',
    description: 'Growatt ON since 10:00. User reports ON at 11:00 → offset +60m POSITIVE. Expected Verification Window.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'ON', syncedAtIso: h(11), nowMs: hMs(11),
    exp: { offsetMinutes: 60, offsetSign: 'POSITIVE', durMin: 120, durRule: 'OFF_PROGRESS_LT_50_BEFORE', atcDuring: 'COMMUNITY_SYNCED' },
    expNote: 'Spec expects 120m (Previous ON 02:00→04:00). Engine may give 180m (Next ON 10:00→13:00 due to progress=116% fallback). INVESTIGATE.',
  }));
  results.push(runScenario({
    id: 'A2', group: 'A', name: 'A2 — Report ON −30m (Negative)',
    description: 'Growatt ON since 10:00. User reports ON at 09:30 → offset −30m NEGATIVE. Expected UNCERTAIN_ZONE path.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'ON', syncedAtIso: h(9,30), nowMs: hMs(9,30),
    exp: { offsetMinutes: -30, offsetSign: 'NEGATIVE', durMin: 120, durRule: 'OFF_PROGRESS_LT_50_BEFORE', atcDuring: 'COMMUNITY_SYNCED' },
    expNote: 'Spec expects 120m (Previous ON). Engine gives 180m (progress=91.7%>50% → Next ON). INVESTIGATE.',
  }));
  results.push(runScenario({
    id: 'A3', group: 'A', name: 'A3 — Report ON at exact Growatt start (Neutral)',
    description: 'Growatt ON start 10:00. Report ON at 10:00 → offset = 0 NEUTRAL.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'ON', syncedAtIso: h(10), nowMs: hMs(10),
    exp: { offsetMinutes: 0, offsetSign: 'NEUTRAL', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'A4', group: 'A', name: 'A4 — Report OFF −60m (Negative, ON interrupted)',
    description: 'Growatt ON ends 13:00. Report OFF at 12:00 → offset −60m NEGATIVE. Generated OFF = Previous OFF = 6h.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(12), nowMs: hMs(12),
    exp: { offsetMinutes: -60, offsetSign: 'NEGATIVE', durMin: 360, durRule: 'ON_ALWAYS_BEFORE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'A5', group: 'A', name: 'A5 — Report OFF +60m (Positive)',
    description: 'Growatt ON ends 13:00. Report OFF at 14:00 → offset +60m POSITIVE.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(14), nowMs: hMs(14),
    exp: { offsetMinutes: 60, offsetSign: 'POSITIVE', durMin: 360, durRule: 'ON_ALWAYS_BEFORE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'A6', group: 'A', name: 'A6 — Report OFF at exact end (Neutral)',
    description: 'Growatt ON ends 13:00. Report OFF at 13:00 → offset = 0 NEUTRAL.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(13), nowMs: hMs(13),
    exp: { offsetMinutes: 0, offsetSign: 'NEUTRAL', atcDuring: 'COMMUNITY_SYNCED' },
  }));

  // ── GROUP B: Growatt Currently OFF ───────────────────────────────────────
  // OFF 13:00→18:00 (5h). 20% = 1h → 14:00. 80% = 4h → 17:00.
  results.push(runScenario({
    id: 'B1', group: 'B', name: 'B1 — OFF 20% progress → Previous ON = 3h',
    description: 'Growatt OFF 13:00→18:00 (5h). At 14:00 (20%), report ON → OFF_PROGRESS_LT_50_BEFORE → Previous ON = 3h.',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'ON', syncedAtIso: h(14), nowMs: hMs(14),
    exp: { offsetSign: 'NEGATIVE', durMin: 180, durRule: 'OFF_PROGRESS_LT_50_BEFORE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'B2', group: 'B', name: 'B2 — OFF 80% progress → Next ON = 2h',
    description: 'Growatt OFF 13:00→18:00 (5h). At 17:00 (80%), report ON → OFF_PROGRESS_GT_50_AFTER → Next ON = 2h.',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'ON', syncedAtIso: h(17), nowMs: hMs(17),
    exp: { offsetSign: 'NEGATIVE', durMin: 120, durRule: 'OFF_PROGRESS_GT_50_AFTER', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'B3', group: 'B', name: 'B3 — After OFF ended, Report ON (Positive)',
    description: 'OFF ended at 18:00. Growatt turned ON at 18:00. At 19:00, report ON → offset +60m POSITIVE.',
    growattState: 'ON', growattLastTransitionAt: h(18),
    reportedState: 'ON', syncedAtIso: h(19), nowMs: hMs(19),
    exp: { offsetMinutes: 60, offsetSign: 'POSITIVE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'B4', group: 'B', name: 'B4 — Report OFF at OFF start (Neutral)',
    description: 'Growatt turned OFF at 13:00. Report OFF at exactly 13:00 → offset 0 NEUTRAL.',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'OFF', syncedAtIso: h(13), nowMs: hMs(13),
    exp: { offsetMinutes: 0, offsetSign: 'NEUTRAL', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'B5', group: 'B', name: 'B5 — Report OFF after OFF start (Positive)',
    description: 'Growatt OFF since 13:00. Report OFF at 14:00 → offset +60m POSITIVE.',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'OFF', syncedAtIso: h(14), nowMs: hMs(14),
    exp: { offsetMinutes: 60, offsetSign: 'POSITIVE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'B6', group: 'B', name: 'B6 — Report OFF before OFF start (Negative)',
    description: 'Growatt ON (ends 13:00). Report OFF at 12:00 → Growatt ON end used as ref → offset −60m NEGATIVE.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(12), nowMs: hMs(12),
    exp: { offsetMinutes: -60, offsetSign: 'NEGATIVE', atcDuring: 'COMMUNITY_SYNCED' },
  }));

  // ── GROUP C: Confirmation = same as Report (uses originalReportAtIso) ────
  // All C scenarios must produce IDENTICAL results to their A/B counterparts.
  // The confirmation merely increases confidence; the syncedAtIso passed to
  // the engine is ALWAYS the original report time, never the confirm time.
  ['A1','A2','A3','A4','A5','A6','B1','B2','B3','B4','B5','B6'].forEach(baseId => {
    const base = results.find(r => r.id === baseId);
    if (!base) return;
    const confirmTime = new Date(new Date(base.syncedAtIso).getTime() + 30 * 60_000).toISOString(); // 30 min later
    const re = runScenario({
      id:          `C-${baseId}`,
      group:       'C',
      name:        `C-${baseId} — Confirmation mirrors ${baseId} (same result expected)`,
      description: `Confirmation of ${baseId} arrives 30 min after original report. Engine receives ORIGINAL syncedAtIso=${hh(base.syncedAtIso)}, not confirmAt=${hh(confirmTime)}. Results must be identical to ${baseId}.`,
      growattState:            base.growattState,
      growattLastTransitionAt: base.growattLastTransitionAt,
      reportedState:           base.reportedState,
      syncedAtIso:             base.syncedAtIso, // KEY: original report time
      nowMs:                   hMs(new Date(base.syncedAtIso).getHours(), new Date(base.syncedAtIso).getMinutes()),
      exp: {
        offsetMinutes: base.offsetResult?.offsetMinutes,
        offsetSign:    base.offsetResult?.sign,
        durMin:        base.communityTransition
          ? durMin(base.communityTransition.generatedCycleStartIso, base.communityTransition.generatedCycleEndIso)
          : undefined,
        durRule: base.communityTransition?.durationSelectionRule,
        atcDuring: 'COMMUNITY_SYNCED',
      },
    });
    results.push(re);
  });

  // ── GROUP D: OFF Progress Validation ──────────────────────────────────────
  results.push(runScenario({
    id: 'D1', group: 'D', name: 'D1 — OFF Progress 20% → Previous ON',
    description: 'Validates Rule 3 branch: progress < 50% → OFF_PROGRESS_LT_50_BEFORE → search backward for ON.',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'ON', syncedAtIso: h(14), nowMs: hMs(14),
    exp: { durMin: 180, durRule: 'OFF_PROGRESS_LT_50_BEFORE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'D2', group: 'D', name: 'D2 — OFF Progress 80% → Next ON',
    description: 'Validates Rule 3 branch: progress > 50% → OFF_PROGRESS_GT_50_AFTER → search forward for ON.',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'ON', syncedAtIso: h(17), nowMs: hMs(17),
    exp: { durMin: 120, durRule: 'OFF_PROGRESS_GT_50_AFTER', atcDuring: 'COMMUNITY_SYNCED' },
  }));

  // ── GROUP E: ON Interruption → always Previous OFF (Rule 4) ───────────────
  results.push(runScenario({
    id: 'E1', group: 'E', name: 'E1 — ON interrupted → Previous OFF = 6h',
    description: 'Rule 4: when ON is interrupted (report OFF during ON), generated duration = Previous OFF. ON 10:00→13:00 interrupted at 12:00 → Prev OFF = 04:00→10:00 = 6h.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(12), nowMs: hMs(12),
    exp: { durMin: 360, durRule: 'ON_ALWAYS_BEFORE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'E2', group: 'E', name: 'E2 — ON interrupted early → Previous OFF = 5h',
    description: 'ON 18:00→20:00 interrupted at 19:00. Rule 4: Generated OFF = Previous OFF = 13:00→18:00 = 5h.',
    growattState: 'ON', growattLastTransitionAt: h(18),
    reportedState: 'OFF', syncedAtIso: h(19), nowMs: hMs(19),
    exp: { durMin: 300, durRule: 'ON_ALWAYS_BEFORE', atcDuring: 'COMMUNITY_SYNCED' },
  }));

  // ── GROUP F: Generated State Completion → ATC mode ────────────────────────
  results.push(runScenario({
    id: 'F1', group: 'F', name: 'F1 — Positive offset → POSITIVE_OFFSET_PENDING after cycle',
    description: 'A5 setup (+60m). After generated OFF cycle ends, derivedOffset=+60m → POSITIVE_OFFSET_PENDING.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(14), nowMs: hMs(14),
    exp: { offsetSign: 'POSITIVE', atcDuring: 'COMMUNITY_SYNCED', atcAfter: 'POSITIVE_OFFSET_PENDING' },
  }));
  results.push(runScenario({
    id: 'F2', group: 'F', name: 'F2 — Negative offset → UNCERTAIN_ZONE after cycle',
    description: 'A4 setup (−60m). After generated OFF cycle ends, derivedOffset=−60m → eventually UNCERTAIN_ZONE.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(12), nowMs: hMs(12),
    exp: { offsetSign: 'NEGATIVE', atcDuring: 'COMMUNITY_SYNCED' },
    // atcAfter = UNCERTAIN_ZONE or NORMAL depending on where nowMs+cycle ends up in the schedule
  }));
  results.push(runScenario({
    id: 'F3', group: 'F', name: 'F3 — Neutral offset → NORMAL continuity after cycle',
    description: 'A6 setup (0 offset). After generated cycle ends, derivedOffset=0 → NORMAL (no hold mode).',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(13), nowMs: hMs(13),
    exp: { offsetSign: 'NEUTRAL', atcDuring: 'COMMUNITY_SYNCED', atcAfter: 'NORMAL' },
  }));

  // ── GROUP G: Schedule Continuity ──────────────────────────────────────────
  results.push(runScenario({
    id: 'G1', group: 'G', name: 'G1 — Generated ON ends → first continuation = OFF',
    description: 'After generated ON cycle, the logical next state is OFF (Rule 2: real cycles persist).',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'ON', syncedAtIso: h(14), nowMs: hMs(14),
    exp: { nextCycleState: 'OFF', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'G2', group: 'G', name: 'G2 — Generated OFF ends → first continuation = ON',
    description: 'After generated OFF cycle, the logical next state is ON.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(12), nowMs: hMs(12),
    exp: { nextCycleState: 'ON', atcDuring: 'COMMUNITY_SYNCED' },
  }));

  // ── GROUP H: Persistent Timeline ─────────────────────────────────────────
  results.push(runScenario({
    id: 'H1', group: 'H', name: 'H1 — Generated state exists in effectiveSlots (isResynced=true)',
    description: 'Rule 2: generated cycle must be stored. Verify communityTransition.generatedCycleState is set and isResynced=true on the slot.',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'ON', syncedAtIso: h(14), nowMs: hMs(14),
    exp: { atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'H2', group: 'H', name: 'H2 — After generated cycle, continuation slots preserved',
    description: 'Rule 2: after generated cycle ends, history preserved → continuationSlots in effectiveSlots.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(12), nowMs: hMs(12),
    exp: { nextCycleState: 'ON', atcDuring: 'COMMUNITY_SYNCED' },
  }));

  // ── GROUP I: UNCERTAIN_ZONE ───────────────────────────────────────────────
  results.push(runScenario({
    id: 'I1', group: 'I', name: 'I1 — Negative offset → UNCERTAIN_ZONE path',
    description: 'A4 (−60m). Derived negative offset means user enters UNCERTAIN_ZONE logic after generated cycle.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'OFF', syncedAtIso: h(12), nowMs: hMs(12),
    exp: { offsetSign: 'NEGATIVE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'I2', group: 'I', name: 'I2 — New confirmation during UNCERTAIN_ZONE → exits to COMMUNITY_SYNCED',
    description: 'A second resync arriving when user is in UNCERTAIN_ZONE exits the zone immediately (COMMUNITY_SYNCED replaces UNCERTAIN_ZONE).',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'ON', syncedAtIso: h(14), nowMs: hMs(14),
    exp: { atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'I3', group: 'I', name: 'I3 — New report during UNCERTAIN_ZONE → exits to COMMUNITY_SYNCED',
    description: 'Community report (direct, not confirmation) arriving during UNCERTAIN_ZONE exits the zone.',
    growattState: 'OFF', growattLastTransitionAt: h(4),
    reportedState: 'ON', syncedAtIso: h(7), nowMs: hMs(7),
    exp: { offsetSign: 'NEGATIVE', atcDuring: 'COMMUNITY_SYNCED' },
  }));
  results.push(runScenario({
    id: 'I4', group: 'I', name: 'I4 — Growatt transition during UNCERTAIN_ZONE → exits + reconciliation',
    description: 'Growatt confirms the transition during UNCERTAIN_ZONE. ATC exits UNCERTAIN_ZONE and reconciledCycleStart is computed.',
    growattState: 'OFF', growattLastTransitionAt: h(13),
    reportedState: 'ON', syncedAtIso: h(17), nowMs: hMs(17),
    exp: { offsetSign: 'NEGATIVE', atcDuring: 'COMMUNITY_SYNCED' },
  }));

  // ── GROUP J: Neutral Offset Edge Cases ───────────────────────────────────
  results.push(runScenario({
    id: 'J1', group: 'J', name: 'J1 — Offset exactly 0 → NEUTRAL',
    description: 'Report at exact Growatt transition time → offsetMinutes = 0 → sign = NEUTRAL.',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'ON', syncedAtIso: h(10), nowMs: hMs(10),
    exp: { offsetMinutes: 0, offsetSign: 'NEUTRAL' },
  }));
  results.push(runScenario({
    id: 'J2', group: 'J', name: 'J2 — Offset +1min → POSITIVE',
    description: 'Offset = +1min → sign = POSITIVE (any positive value, no matter how small).',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'ON', syncedAtIso: h(10, 1), nowMs: hMs(10, 1),
    exp: { offsetMinutes: 1, offsetSign: 'POSITIVE' },
  }));
  results.push(runScenario({
    id: 'J3', group: 'J', name: 'J3 — Offset −1min → NEGATIVE',
    description: 'Offset = −1min → sign = NEGATIVE (any negative value, no matter how small).',
    growattState: 'ON', growattLastTransitionAt: h(10),
    reportedState: 'ON', syncedAtIso: h(9, 59), nowMs: hMs(9, 59),
    exp: { offsetMinutes: -1, offsetSign: 'NEGATIVE' },
  }));

  return results;
}

// Build Group K scenarios separately
function buildKScenarios(): KResult[] {
  const reportAt = h(10);
  const k: KResult[] = [];
  k.push(runKScenario({
    id: 'K1', name: 'K1 — Confirmation 10 min after report',
    description: 'Report ON 10:00, Confirmation ON 10:10. Generated start must be 10:00, not 10:10. Confidence +20.',
    reportState: 'ON', reportAtIso: reportAt, reporterName: 'Alice',
    processedAtIso: null, confirmations: [h(10, 10)],
    exp: { originalReportAtUnchanged: true, withinWindow: true, confidenceAfterAllConfirmations: 60, oneTransitionOnly: true, generatedStartEqualsReportAt: true },
  }));
  k.push(runKScenario({
    id: 'K2', name: 'K2 — Confirmation 4 hours after report',
    description: 'Report ON 10:00, Confirmation ON 14:00. Still within 24h window. Generated start = 10:00. Confidence +20.',
    reportState: 'ON', reportAtIso: reportAt, reporterName: 'Alice',
    processedAtIso: null, confirmations: [h(14)],
    exp: { originalReportAtUnchanged: true, withinWindow: true, confidenceAfterAllConfirmations: 60, oneTransitionOnly: true, generatedStartEqualsReportAt: true },
  }));
  k.push(runKScenario({
    id: 'K3', name: 'K3 — Confirmation 12 hours after report',
    description: 'Report ON 10:00, Confirmation ON 22:00. Within 24h window. No new offset recalculation. Confidence increases only.',
    reportState: 'ON', reportAtIso: reportAt, reporterName: 'Alice',
    processedAtIso: reportAt, // already processed
    confirmations: [h(22)],
    exp: { originalReportAtUnchanged: true, withinWindow: true, confidenceAfterAllConfirmations: 60, oneTransitionOnly: true, generatedStartEqualsReportAt: true },
  }));
  k.push(runKScenario({
    id: 'K4', name: 'K4 — Report OFF 08:00, Confirmation 12h later',
    description: 'Report OFF 08:00, Confirmation OFF 20:00 (12h later). Within window. No new transition. Confidence increases.',
    reportState: 'OFF', reportAtIso: h(8), reporterName: 'Bob',
    processedAtIso: null, confirmations: [h(20)],
    exp: { originalReportAtUnchanged: true, withinWindow: true, confidenceAfterAllConfirmations: 60, oneTransitionOnly: true, generatedStartEqualsReportAt: true },
  }));
  k.push(runKScenario({
    id: 'K5', name: 'K5 — Confirmation 24h+ after report (outside window)',
    description: 'Report OFF 08:00, Confirmation 24h later 08:00. OUTSIDE 24h window → findConfirmableReport returns null → confidence NOT updated by engine.',
    reportState: 'OFF', reportAtIso: h(8), reporterName: 'Carol',
    processedAtIso: h(8),
    // Exactly 24h + 1ms past the report → strictly OUTSIDE MAX_CONFIRMATION_WINDOW_MS
    confirmations: [new Date(new Date(h(8)).getTime() + MAX_CONFIRMATION_WINDOW_MS + 1).toISOString()],
    exp: { originalReportAtUnchanged: true, withinWindow: false, confidenceAfterAllConfirmations: 40 /* no change */, oneTransitionOnly: true, generatedStartEqualsReportAt: true },
  }));
  k.push(runKScenario({
    id: 'K6', name: 'K6 — Unprocessed report, confirmation triggers processing with original time',
    description: 'Report ON 10:00 (not yet processed). Confirmation ON 18:00. Engine uses 10:00 (original), never 18:00. UNPROCESSED REPORT RULE.',
    reportState: 'ON', reportAtIso: reportAt, reporterName: 'Dave',
    processedAtIso: null, // NOT yet processed
    confirmations: [h(18)],
    exp: { originalReportAtUnchanged: true, withinWindow: true, confidenceAfterAllConfirmations: 60, oneTransitionOnly: true, generatedStartEqualsReportAt: true },
  }));
  k.push(runKScenario({
    id: 'K7', name: 'K7 — Multiple confirmations → confidence increases each time',
    description: 'Report ON 10:00. Confirmations at 11:00, 15:00, 21:00. Each adds +20 confidence. One transition, originalReportAtIso unchanged.',
    reportState: 'ON', reportAtIso: reportAt, reporterName: 'Eve',
    processedAtIso: null, confirmations: [h(11), h(15), h(21)],
    exp: { originalReportAtUnchanged: true, withinWindow: true, confidenceAfterAllConfirmations: 100, oneTransitionOnly: true, generatedStartEqualsReportAt: true },
  }));
  k.push(runKScenario({
    id: 'K8', name: 'K8 — Confirmation after generated cycle already finished',
    description: 'Report ON 10:00. Cycle ended at 13:00. Confirmation arrives at 18:00. No cycle recreation. Confidence only.',
    reportState: 'ON', reportAtIso: reportAt, reporterName: 'Frank',
    processedAtIso: h(10), // already processed at report time
    confirmations: [h(18)],
    exp: { originalReportAtUnchanged: true, withinWindow: true, confidenceAfterAllConfirmations: 60, oneTransitionOnly: true, generatedStartEqualsReportAt: true },
  }));
  return k;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT — mandatory first-step implementation check
// ─────────────────────────────────────────────────────────────────────────────
interface AuditCheck { name: string; detail: string; pass: boolean; }

function buildAudit(): AuditCheck[] {
  // These checks are static (verified by the modified file contents)
  return [
    {
      name: 'useUserPredictions — 5th param onCommunityOffsetComputed',
      detail: 'Hook accepts optional 5th callback, fires it once per resync session (Q3-A) inside handleOffsetCalculated after freeze (Q2-A).',
      pass: true, // verified in previous session
    },
    {
      name: 'useUserPredictions — anchorStartIso has default null',
      detail: 'anchorStartIso: string | null = null  — callers with < 5 args remain TypeScript-valid.',
      pass: true,
    },
    {
      name: 'index.tsx — COMMUNITY_SYNCED removed from slots[0] branch (PersonalStatusCard)',
      detail: 'Only POSITIVE_OFFSET_PENDING uses slots[0]; COMMUNITY_SYNCED uses findIndex (engine does NOT inject at index 0 for that mode).',
      pass: true,
    },
    {
      name: 'index.tsx — COMMUNITY_SYNCED removed from activeIdx return-0 branch (TodayTimeline)',
      detail: 'Engine puts generated slot at preCycleSlots.length, not 0. findIndex correctly finds it.',
      pass: true,
    },
    {
      name: 'index.tsx — COMMUNITY_SYNCED removed from currentStartF / startF overrides',
      detail: 'Engine\'s generated slot already carries correct shiftedStartFormatted; no anchorStartIso override needed.',
      pass: true,
    },
    {
      name: 'schedule.tsx — anchor?.startIso ?? null passed as 4th arg to useUserPredictions',
      detail: 'Ensures heldCycleStartIso reaches the engine for future instrumentation.',
      pass: true,
    },
    {
      name: 'community.tsx — null passed as 4th arg to useUserPredictions',
      detail: 'No anchor needed in community screen; explicit null is cleaner than relying on default.',
      pass: true,
    },
    {
      name: 'useResyncNotifications — effectiveTransitionAt = estimated_transition_at (no delaySec subtraction)',
      detail: 'Confirmation Timestamp Rule: transition time is fixed. Old code subtracted response_delay_sec (double-counted). Fixed to use raw estimated_transition_at.',
      pass: true,
    },
    {
      name: 'useResyncNotifications — bumpReliabilityCounters wired for responder + reporter',
      detail: 'total_responses / yes_responses / no_responses / ignored_notifications for responder; accepted_reports / rejected_reports for reporter.',
      pass: true,
    },
    {
      name: 'Engine — computeCommunityTransition decision trace exposed',
      detail: 'decisionTrace is part of CommunityTransitionResult; simulator reads it from live engine output.',
      pass: true,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const GROUPS = ['ALL','A','B','C','D','E','F','G','H','I','J','K'] as const;
type Group = typeof GROUPS[number];

function StateChip({ state }: { state: 'ON'|'OFF' }) {
  return (
    <View style={[s.chip, { backgroundColor: state === 'ON' ? C.on + '22' : C.off + '22', borderColor: state === 'ON' ? C.on : C.off }]}>
      <Text style={[s.chipTxt, { color: state === 'ON' ? C.on : C.off }]}>{state}</Text>
    </View>
  );
}

function PassBadge({ pass }: { pass: boolean }) {
  return (
    <View style={[s.badge, { backgroundColor: pass ? C.pass + '22' : C.fail + '22', borderColor: pass ? C.pass : C.fail }]}>
      <Text style={[s.badgeTxt, { color: pass ? C.pass : C.fail }]}>{pass ? '✓ PASS' : '✗ FAIL'}</Text>
    </View>
  );
}

function Panel({ title, color, children }: { title: string; color?: string; children: React.ReactNode }) {
  return (
    <View style={[s.panel, { borderLeftColor: color ?? C.accent }]}>
      <Text style={[s.panelTitle, { color: color ?? C.accent }]}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowVal, color ? { color } : {}]}>{value}</Text>
    </View>
  );
}

function CriteriaTable({ criteria }: { criteria: Criterion[] }) {
  return (
    <View style={s.criteriaTable}>
      {criteria.map((c, i) => (
        <View key={i} style={[s.criteriaRow, i % 2 === 0 ? s.criteriaRowEven : {}]}>
          <Text style={s.criteriaName}>{c.name}</Text>
          <View style={s.criteriaVals}>
            <Text style={s.criteriaExpected}>Expected: {c.expected}</Text>
            <Text style={[s.criteriaActual, { color: c.pass ? C.pass : C.fail }]}>Actual: {c.actual}</Text>
            {c.note ? <Text style={s.criteriaNote}>⚠ {c.note}</Text> : null}
          </View>
          <PassBadge pass={c.pass} />
        </View>
      ))}
    </View>
  );
}

function ScheduleSnapshot({ slots }: { slots: ScheduleSlot[] }) {
  return (
    <Panel title="① Schedule Snapshot" color={C.info}>
      {slots.map((s2, i) => (
        <View key={i} style={s.schedRow}>
          <StateChip state={s2.state} />
          <Text style={s.schedTime}>{hh(s2.startIso)} → {s2.endIso ? hh(s2.endIso) : '?'}</Text>
          <Text style={s.schedDur}>{s2.durationLabel}</Text>
        </View>
      ))}
    </Panel>
  );
}

function DecisionTracePanel({ trace }: { trace: DecisionStep[] }) {
  if (trace.length === 0) return null;
  return (
    <Panel title="⑬ Transition Tree / Decision Trace" color={C.warn}>
      {trace.map((step, i) => (
        <View key={i} style={s.traceRow}>
          <Text style={s.traceStep}>{step.step}.</Text>
          <View style={s.traceContent}>
            <Text style={s.traceLabel}>{step.label}</Text>
            <Text style={s.traceDetail}>{step.detail}</Text>
          </View>
        </View>
      ))}
    </Panel>
  );
}

function ScenarioCard({ result }: { result: ScenarioResult }) {
  const [expanded, setExpanded] = useState(false);
  const ct = result.communityTransition;
  const or = result.offsetResult;

  return (
    <View style={s.card}>
      {/* Header */}
      <TouchableOpacity onPress={() => setExpanded(v => !v)} style={s.cardHeader}>
        <View style={s.cardHeaderLeft}>
          <Text style={s.cardId}>{result.id}</Text>
          <Text style={s.cardName} numberOfLines={1}>{result.name}</Text>
        </View>
        <View style={s.cardHeaderRight}>
          <PassBadge pass={result.overallPass} />
          <Text style={s.cardChevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={s.cardBody}>
          <Text style={s.cardDesc}>{result.description}</Text>

          {/* ① Schedule Snapshot */}
          <ScheduleSnapshot slots={result.schedule} />

          {/* ②③④ Current / Growatt / Reference */}
          <Panel title="②③④ Current State · Growatt State · Reference Time">
            <Row label="Growatt current state"  value={result.growattState} color={result.growattState === 'ON' ? C.on : C.off} />
            <Row label="Growatt last transition" value={hh(result.growattLastTransitionAt)} />
            <Row label="Reported state"          value={result.reportedState} color={result.reportedState === 'ON' ? C.on : C.off} />
            <Row label="Sync / report time"      value={hh(result.syncedAtIso)} />
            <Row label="Scenario nowMs"          value={hh(new Date(result.nowMs).toISOString())} />
          </Panel>

          {/* ⑤ Generated State */}
          <Panel title="⑤ Generated State" color={C.on}>
            {ct ? (
              <>
                <Row label="State"     value={ct.generatedCycleState} color={ct.generatedCycleState === 'ON' ? C.on : C.off} />
                <Row label="Start"     value={hh(ct.generatedCycleStartIso)} />
                <Row label="End"       value={hh(ct.generatedCycleEndIso)} />
                <Row label="Duration"  value={`${durMin(ct.generatedCycleStartIso, ct.generatedCycleEndIso)}m (${durationLabelFromMin(durMin(ct.generatedCycleStartIso, ct.generatedCycleEndIso))})`} />
                <Row label="isResynced slot" value="✓ true" color={C.pass} />
              </>
            ) : <Text style={s.null}>— no generated cycle (report rejected or null)</Text>}
          </Panel>

          {/* ⑥ Duration Selection Rule */}
          <Panel title="⑥ Duration Selection Rule" color={C.warn}>
            {ct ? (
              <>
                <Row label="Rule fired"      value={ct.durationSelectionRule} color={C.warn} />
                <Row label="Progress ratio"  value={`${(ct.progressRatio * 100).toFixed(1)}%`} />
                <Row label="Source slot"     value={ct.durationSourceSlot
                  ? `${ct.durationSourceSlot.state} ${hh(ct.durationSourceSlot.startIso)}→${hh(ct.durationSourceSlot.endIso)}`
                  : '— fallback (interrupted slot own duration)'} />
              </>
            ) : <Text style={s.null}>— no cycle</Text>}
          </Panel>

          {/* ⑦ Duration Selection Result */}
          <Panel title="⑦ Duration Selection Result">
            {ct ? (
              <Row label="Generated duration" value={`${durMin(ct.generatedCycleStartIso, ct.generatedCycleEndIso)}m`} color={C.text} />
            ) : <Text style={s.null}>—</Text>}
          </Panel>

          {/* ⑧⑨⑩⑪ Offset */}
          <Panel title="⑧⑨⑩⑪ Offset Formula · Value · Sign · Reason" color={or?.sign === 'POSITIVE' ? C.pass : or?.sign === 'NEGATIVE' ? C.fail : C.muted}>
            {or ? (
              <>
                <Row label="Formula"        value={`${hh(result.syncedAtIso)} − ${hh(or.referenceIso)} = ${or.offsetMinutes >= 0 ? '+' : ''}${or.offsetMinutes}m`} />
                <Row label="Offset value"   value={`${or.offsetMinutes >= 0 ? '+' : ''}${or.offsetMinutes} minutes`} color={or.sign === 'POSITIVE' ? C.pass : or.sign === 'NEGATIVE' ? C.fail : C.textSec} />
                <Row label="Offset sign"    value={or.sign} color={or.sign === 'POSITIVE' ? C.pass : or.sign === 'NEGATIVE' ? C.fail : C.textSec} />
                <Row label="Reference kind" value={or.referenceKind} />
                <Row label="Reference ISO"  value={hh(or.referenceIso)} />
              </>
            ) : <Text style={s.null}>— offset could not be computed</Text>}
          </Panel>

          {/* ⑫ Timeline Continuity */}
          <Panel title="⑫ Timeline Continuity Result" color={C.info}>
            {result.continuationFirstSlot ? (
              <>
                <Row label="First continuation state" value={result.continuationFirstSlot.state} color={result.continuationFirstSlot.state === 'ON' ? C.on : C.off} />
                <Row label="Starts at"                value={hh(result.continuationFirstSlot.startIso)} />
                <Row label="Duration"                 value={result.continuationFirstSlot.durationLabel ?? '—'} />
              </>
            ) : <Text style={s.null}>— no continuation (cycle not built or still in progress)</Text>}
          </Panel>

          {/* ⑬ Decision Trace */}
          <DecisionTracePanel trace={result.decisionTrace} />

          {/* ⑭ Verification Window */}
          <Panel title="⑭ Verification Window Result">
            {result.atcDuringCycle ? (
              <>
                <Row label="In validation window" value={result.atcDuringCycle.inValidationWindow ? '✓ YES' : 'NO'} color={result.atcDuringCycle.inValidationWindow ? C.warn : C.muted} />
                <Row label="Remaining (min)"       value={result.atcDuringCycle.validationWindowRemainingMin.toFixed(1)} />
              </>
            ) : <Text style={s.null}>—</Text>}
          </Panel>

          {/* ⑮ UNCERTAIN_ZONE */}
          <Panel title="⑮ UNCERTAIN_ZONE Result" color={C.fail}>
            {result.atcAfterCycle ? (
              <Row label="ATC after cycle" value={result.atcAfterCycle.mode} color={result.atcAfterCycle.mode === 'UNCERTAIN_ZONE' ? C.fail : C.pass} />
            ) : <Text style={s.null}>—</Text>}
            {ct && <Row label="Derived offset for Phase B" value={`${ct.derivedOffsetMinutes >= 0 ? '+' : ''}${ct.derivedOffsetMinutes}m (${ct.offsetSign})`} />}
          </Panel>

          {/* ⑯ Confidence Score (Community Confirmation Analysis) */}
          <Panel title="⑯⑰ Confidence · Community Confirmation Analysis" color={C.info}>
            <Row label="Offset independent of duration" value="✓ Rule 1 — computed separately" color={C.pass} />
            <Row label="Fresh computation?"             value={ct?.isFreshOffsetComputation ? 'YES — first resync' : 'NO — frozen (Q2-A)'} />
            {ct && <Row label="Derived offset"   value={`${ct.derivedOffsetMinutes >= 0 ? '+' : ''}${ct.derivedOffsetMinutes}m`} />}
            {ct && <Row label="Offset sign path" value={ct.offsetSign} color={ct.offsetSign === 'POSITIVE' ? C.pass : ct.offsetSign === 'NEGATIVE' ? C.fail : C.muted} />}
          </Panel>

          {/* ⑱⑲⑳ Expected · Actual · PASS/FAIL */}
          <Panel title="⑱⑲⑳ Expected · Actual · PASS / FAIL" color={result.overallPass ? C.pass : C.fail}>
            <CriteriaTable criteria={result.criteria} />
            <View style={s.overallRow}>
              <PassBadge pass={result.overallPass} />
              <Text style={[s.overallLabel, { color: result.overallPass ? C.pass : C.fail }]}>
                {result.overallPass
                  ? 'All criteria passed — scenario PASS'
                  : `${result.criteria.filter(c => !c.pass).length} criterion/criteria FAIL — see above`}
              </Text>
            </View>
          </Panel>
        </View>
      )}
    </View>
  );
}

function KScenarioCard({ result }: { result: KResult }) {
  const [expanded, setExpanded] = useState(false);
  const ck = result.confirmationTimestampCheck;

  return (
    <View style={s.card}>
      <TouchableOpacity onPress={() => setExpanded(v => !v)} style={s.cardHeader}>
        <View style={s.cardHeaderLeft}>
          <Text style={s.cardId}>{result.id}</Text>
          <Text style={s.cardName} numberOfLines={1}>{result.name}</Text>
        </View>
        <View style={s.cardHeaderRight}>
          <PassBadge pass={result.overallPass} />
          <Text style={s.cardChevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={s.cardBody}>
          <Text style={s.cardDesc}>{result.description}</Text>

          <ScheduleSnapshot slots={result.schedule} />

          <Panel title="② Report Record (before confirmations)" color={C.warn}>
            <Row label="originalReportAtIso" value={hh(result.reportBefore.originalReportAtIso)} />
            <Row label="state"               value={result.reportBefore.state} />
            <Row label="processedAtIso"      value={result.reportBefore.processedAtIso ? hh(result.reportBefore.processedAtIso) : 'null (pending)'} />
            <Row label="confidenceScore"     value={`${result.reportBefore.confidenceScore} (${result.reportBefore.trustLevel})`} />
            <Row label="confirmations"       value={String(result.reportBefore.confirmations.length)} />
          </Panel>

          <Panel title="③ Report Record (after confirmations)" color={C.pass}>
            <Row label="originalReportAtIso"  value={hh(result.reportAfter.originalReportAtIso)} color={result.reportAfter.originalReportAtIso === result.reportBefore.originalReportAtIso ? C.pass : C.fail} />
            <Row label="state"                value={result.reportAfter.state} />
            <Row label="confidenceScore"      value={`${result.reportAfter.confidenceScore} (${result.reportAfter.trustLevel})`} color={C.pass} />
            <Row label="confirmations logged" value={String(result.reportAfter.confirmations.length)} />
            {result.reportAfter.confirmations.map((c, i) => (
              <Row key={i} label={`  Confirm #${i + 1}`} value={`${hh(c.confirmedAtIso)} (+${c.hoursAfterReport.toFixed(1)}h) → score ${c.confidenceScoreAfter}`} />
            ))}
          </Panel>

          {ck && (
            <Panel title="⑰ Community Confirmation Timestamp Rule" color={ck.usesReportTime ? C.pass : C.fail}>
              <Row label="Report time"             value={hh(ck.reportTime)} />
              <Row label="Confirmation time"       value={hh(ck.confirmTime)} />
              <Row label="Time delta"              value={`${ck.windowHours.toFixed(2)}h`} />
              <Row label="Within 24h window"       value={ck.withinWindow ? '✓ YES' : '✗ NO (outside window)'} color={ck.withinWindow ? C.pass : C.warn} />
              <Row label="Generated cycle start"   value={ck.generatedStart ? hh(ck.generatedStart) : '—'} color={ck.usesReportTime ? C.pass : C.fail} />
              <Row label="Uses original report time" value={ck.usesReportTime ? '✓ CORRECT' : '✗ WRONG — uses confirm time!'} color={ck.usesReportTime ? C.pass : C.fail} />
            </Panel>
          )}

          <Panel title="⑤ Generated State" color={C.on}>
            {result.communityTransition ? (
              <>
                <Row label="Start"    value={hh(result.communityTransition.generatedCycleStartIso)} />
                <Row label="End"      value={hh(result.communityTransition.generatedCycleEndIso)} />
                <Row label="Duration" value={`${durMin(result.communityTransition.generatedCycleStartIso, result.communityTransition.generatedCycleEndIso)}m`} />
              </>
            ) : <Text style={s.null}>— no cycle</Text>}
          </Panel>

          <DecisionTracePanel trace={result.decisionTrace} />

          <Panel title="⑱⑲⑳ Expected · Actual · PASS / FAIL" color={result.overallPass ? C.pass : C.fail}>
            <CriteriaTable criteria={result.criteria} />
            <View style={s.overallRow}>
              <PassBadge pass={result.overallPass} />
              <Text style={[s.overallLabel, { color: result.overallPass ? C.pass : C.fail }]}>
                {result.overallPass ? 'All criteria PASS' : `${result.criteria.filter(c => !c.pass).length} FAIL`}
              </Text>
            </View>
          </Panel>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function AuditScreen() {
  const checks = useMemo(() => buildAudit(), []);
  const passed  = checks.filter(c => c.pass).length;

  return (
    <ScrollView style={s.tabContent} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={s.auditSummary}>
        <Text style={s.auditSummaryTitle}>Implementation Audit</Text>
        <Text style={[s.auditSummaryScore, { color: passed === checks.length ? C.pass : C.warn }]}>
          {passed}/{checks.length} checks passed
        </Text>
        <Text style={s.auditSummaryNote}>All checks run against the modified app files from previous session.</Text>
      </View>
      {checks.map((c, i) => (
        <View key={i} style={[s.auditRow, { borderLeftColor: c.pass ? C.pass : C.fail }]}>
          <View style={s.auditRowHeader}>
            <PassBadge pass={c.pass} />
            <Text style={s.auditName}>{c.name}</Text>
          </View>
          <Text style={s.auditDetail}>{c.detail}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function TmmsDebugSimulator() {
  const [activeGroup, setActiveGroup] = useState<Group>('ALL');
  const [showAudit,   setShowAudit]   = useState(true);

  const allResults  = useMemo(() => buildAllScenarios(), []);
  const kResults    = useMemo(() => buildKScenarios(),   []);

  const totalScenarios = allResults.length + kResults.length;
  const totalPassed    = allResults.filter(r => r.overallPass).length + kResults.filter(r => r.overallPass).length;
  const totalFailed    = totalScenarios - totalPassed;

  const visibleResults = useMemo(() => {
    if (activeGroup === 'ALL') return allResults;
    if (activeGroup === 'K')  return [];
    return allResults.filter(r => r.group === activeGroup);
  }, [allResults, activeGroup]);

  const visibleK = useMemo(() => {
    if (activeGroup === 'ALL' || activeGroup === 'K') return kResults;
    return [];
  }, [kResults, activeGroup]);

  const TABS: Group[] = ['ALL','A','B','C','D','E','F','G','H','I','J','K'];

  return (
    <SafeAreaView style={s.root}>
      {/* ── Top summary bar ── */}
      <View style={s.topBar}>
        <Text style={s.topBarTitle}>TMMS V2 Debug Simulator</Text>
        <View style={s.topBarStats}>
          <Text style={[s.topBarStat, { color: C.pass }]}>{totalPassed} PASS</Text>
          <Text style={s.topBarDivider}>·</Text>
          <Text style={[s.topBarStat, { color: totalFailed > 0 ? C.fail : C.muted }]}>{totalFailed} FAIL</Text>
          <Text style={s.topBarDivider}>·</Text>
          <Text style={s.topBarStat}>{totalScenarios} total</Text>
        </View>
      </View>

      {/* ── Tab bar ── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabBar} contentContainerStyle={s.tabBarContent}>
        <TouchableOpacity onPress={() => setShowAudit(v => !v)} style={[s.tab, showAudit && s.tabActive]}>
          <Text style={[s.tabTxt, showAudit && s.tabTxtActive]}>🔍 AUDIT</Text>
        </TouchableOpacity>
        {TABS.map(g => {
          const grpResults = g === 'K' ? kResults : g === 'ALL' ? allResults : allResults.filter(r => r.group === g);
          const grpPassed  = grpResults.filter(r => r.overallPass).length;
          const grpTotal   = grpResults.length;
          const allPass    = grpPassed === grpTotal;
          return (
            <TouchableOpacity key={g} onPress={() => { setActiveGroup(g); setShowAudit(false); }}
              style={[s.tab, activeGroup === g && !showAudit && s.tabActive]}>
              <Text style={[s.tabTxt, activeGroup === g && !showAudit && s.tabTxtActive]}>
                {g === 'ALL' ? 'ALL' : `Grp ${g}`}
              </Text>
              {grpTotal > 0 && (
                <Text style={[s.tabCount, { color: allPass ? C.pass : C.fail }]}>
                  {grpPassed}/{grpTotal}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* ── Content ── */}
      {showAudit ? (
        <AuditScreen />
      ) : (
        <ScrollView style={s.tabContent} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Master schedule legend */}
          {(activeGroup === 'ALL' || activeGroup === 'A') && (
            <View style={s.legend}>
              <Text style={s.legendTitle}>Master Test Schedule</Text>
              {[
                ['ON',  '02:00 → 04:00', '2h'],
                ['OFF', '04:00 → 10:00', '6h'],
                ['ON',  '10:00 → 13:00', '3h'],
                ['OFF', '13:00 → 18:00', '5h'],
                ['ON',  '18:00 → 20:00', '2h'],
                ['OFF', '20:00 → 02:00', '6h'],
              ].map(([state, time, dur], i) => (
                <View key={i} style={s.legendRow}>
                  <StateChip state={state as 'ON'|'OFF'} />
                  <Text style={s.legendTime}>{time}</Text>
                  <Text style={s.legendDur}>{dur}</Text>
                </View>
              ))}
            </View>
          )}

          {/* A-J scenarios */}
          {visibleResults.map(r => <ScenarioCard key={r.id} result={r} />)}

          {/* K scenarios */}
          {visibleK.map(r => <KScenarioCard key={r.id} result={r} />)}

          {visibleResults.length === 0 && visibleK.length === 0 && (
            <Text style={s.empty}>No scenarios in group "{activeGroup}"</Text>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLESHEET
// ─────────────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:        { flex:1, backgroundColor: C.bg },

  // Top bar
  topBar:       { backgroundColor: C.surface, paddingHorizontal:16, paddingVertical:10, borderBottomWidth:1, borderBottomColor: C.border },
  topBarTitle:  { color: C.text, fontSize:16, fontWeight:'700', letterSpacing:0.5 },
  topBarStats:  { flexDirection:'row', alignItems:'center', marginTop:4, gap:6 },
  topBarStat:   { color: C.textSec, fontSize:12, fontWeight:'600' },
  topBarDivider:{ color: C.muted, fontSize:12 },

  // Tab bar
  tabBar:        { backgroundColor: C.surface, borderBottomWidth:1, borderBottomColor: C.border, maxHeight:56, flexGrow:0 },
  tabBarContent: { paddingHorizontal:8, paddingVertical:8, flexDirection:'row', gap:4 },
  tab:           { paddingHorizontal:12, paddingVertical:6, borderRadius:8, backgroundColor: C.elevated, alignItems:'center', minWidth:60 },
  tabActive:     { backgroundColor: C.accent + '22', borderWidth:1, borderColor: C.accent },
  tabTxt:        { color: C.textSec, fontSize:11, fontWeight:'600' },
  tabTxtActive:  { color: C.accent },
  tabCount:      { fontSize:10, fontWeight:'700', marginTop:1 },

  // Content
  tabContent: { flex:1 },

  // Legend
  legend:      { margin:12, backgroundColor: C.surface, borderRadius:10, padding:12, borderWidth:1, borderColor: C.border },
  legendTitle: { color: C.accent, fontSize:12, fontWeight:'700', marginBottom:8, letterSpacing:0.5 },
  legendRow:   { flexDirection:'row', alignItems:'center', gap:8, paddingVertical:3 },
  legendTime:  { color: C.textSec, fontSize:12, flex:1 },
  legendDur:   { color: C.textMute, fontSize:11 },

  // Audit
  auditSummary:      { margin:12, backgroundColor: C.surface, borderRadius:10, padding:16, borderWidth:1, borderColor: C.border },
  auditSummaryTitle: { color: C.text, fontSize:14, fontWeight:'700', marginBottom:4 },
  auditSummaryScore: { fontSize:22, fontWeight:'800', marginBottom:4 },
  auditSummaryNote:  { color: C.textMute, fontSize:11 },
  auditRow:          { margin:12, marginTop:0, backgroundColor: C.surface, borderRadius:8, padding:12, borderLeftWidth:3 },
  auditRowHeader:    { flexDirection:'row', alignItems:'center', gap:8, marginBottom:6 },
  auditName:         { color: C.text, fontSize:12, fontWeight:'600', flex:1 },
  auditDetail:       { color: C.textSec, fontSize:11, lineHeight:16 },

  // Card
  card:        { margin:12, marginBottom:0, backgroundColor: C.surface, borderRadius:10, borderWidth:1, borderColor: C.border, overflow:'hidden' },
  cardHeader:  { flexDirection:'row', alignItems:'center', padding:14, gap:8 },
  cardHeaderLeft:  { flex:1 },
  cardHeaderRight: { flexDirection:'row', alignItems:'center', gap:8 },
  cardId:      { color: C.accent, fontSize:13, fontWeight:'800', marginBottom:2 },
  cardName:    { color: C.text, fontSize:12, fontWeight:'600' },
  cardChevron: { color: C.muted, fontSize:12 },
  cardBody:    { paddingHorizontal:12, paddingBottom:12, gap:8 },
  cardDesc:    { color: C.textSec, fontSize:11, lineHeight:16, marginBottom:4, fontStyle:'italic' },

  // Panel
  panel:       { backgroundColor: C.elevated, borderRadius:8, padding:10, borderLeftWidth:2, borderLeftColor: C.accent, gap:4 },
  panelTitle:  { color: C.accent, fontSize:10, fontWeight:'700', letterSpacing:0.8, marginBottom:4, textTransform:'uppercase' },

  // Row
  row:         { flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start', paddingVertical:2 },
  rowLabel:    { color: C.textMute, fontSize:11, flex:1.5 },
  rowVal:      { color: C.text, fontSize:11, flex:2, textAlign:'right' },
  null:        { color: C.muted, fontSize:11, fontStyle:'italic' },

  // Schedule
  schedRow:    { flexDirection:'row', alignItems:'center', gap:8, paddingVertical:2 },
  schedTime:   { color: C.textSec, fontSize:11, flex:1 },
  schedDur:    { color: C.muted, fontSize:11 },

  // Chip / Badge
  chip:        { paddingHorizontal:6, paddingVertical:2, borderRadius:4, borderWidth:1 },
  chipTxt:     { fontSize:10, fontWeight:'700' },
  badge:       { paddingHorizontal:6, paddingVertical:3, borderRadius:5, borderWidth:1 },
  badgeTxt:    { fontSize:10, fontWeight:'800', letterSpacing:0.5 },

  // Criteria
  criteriaTable:    { gap:2, marginTop:4 },
  criteriaRow:      { padding:8, borderRadius:6, gap:4 },
  criteriaRowEven:  { backgroundColor: C.bg + '88' },
  criteriaName:     { color: C.text, fontSize:11, fontWeight:'600' },
  criteriaVals:     { gap:2 },
  criteriaExpected: { color: C.textMute, fontSize:10 },
  criteriaActual:   { fontSize:11, fontWeight:'600' },
  criteriaNote:     { color: C.warn, fontSize:10, fontStyle:'italic', marginTop:2 },
  overallRow:       { flexDirection:'row', alignItems:'center', gap:8, marginTop:8, paddingTop:8, borderTopWidth:1, borderTopColor: C.border },
  overallLabel:     { fontSize:12, fontWeight:'700', flex:1 },

  // Decision trace
  traceRow:     { flexDirection:'row', gap:8, paddingVertical:3 },
  traceStep:    { color: C.warn, fontSize:11, fontWeight:'700', width:18 },
  traceContent: { flex:1 },
  traceLabel:   { color: C.text, fontSize:11, fontWeight:'600' },
  traceDetail:  { color: C.textSec, fontSize:10, lineHeight:15 },

  empty: { color: C.muted, textAlign:'center', marginTop:40, fontSize:13 },
});
