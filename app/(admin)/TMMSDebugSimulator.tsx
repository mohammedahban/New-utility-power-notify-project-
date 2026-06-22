/**
 * TMMS V2 Debug Simulator
 * ════════════════════════════════════════════════════════════════════════════
 * Development/debug tool only. Does NOT touch production users or data.
 *
 * Architecture (as required):
 *   UI Layer                 → this file (components only, no business logic)
 *   TMMS Engine Layer         → ./tmmsEngine.ts   (pure, reusable, copy-paste
 *                                                   ready for production)
 *   Simulation Layer          → ./tmmsSimulation.ts (world state, scenarios —
 *                                                     built ON the real engine)
 *   Debug Visualization Layer → the Timeline / Inspector components below,
 *                                which only ever READ engine/simulation output
 *
 * No fake backend, no duplicate business models: every report, confirmation,
 * and offset calculation you see here is the SAME function call production
 * code makes (applyOffsetToPrediction from tmmsEngine.ts).
 *
 * Gate this behind your own dev/admin flag before mounting in a real app,
 * e.g.: {__DEV__ && <TMMSDebugSimulator />}
 * ════════════════════════════════════════════════════════════════════════════
 */
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  createInitialWorld,
  advanceTime,
  setSimulatedNow,
  forceGrowattState,
  resetWorld,
  setTransitionMode,
  setSchedule,
  submitReportOrConfirm,
  SCENARIOS,
  type SimWorld,
  type SimEvent,
  type ScheduleEntryTemplate,
  type ScenarioResult,
} from './tmmsSimulation';
import { fmtYemenTime, type ShiftedScheduleSlot } from './tmmsEngine';

// ════════════════════════════════════════════════════════════════════════════
// THEME — instrument-panel / oscilloscope aesthetic. Subject-grounded choice:
// this tool monitors an electrical inverter's ON/OFF cycles, so a dark
// control-panel look with LED-style semantic colors fits the domain directly.
// ════════════════════════════════════════════════════════════════════════════
const C = {
  bg: '#0A0E12',
  bgGradient: 'radial-gradient(ellipse at top, #0D1218 0%, #0A0E12 60%)',
  panel: '#12181F',
  panelAlt: '#161D26',
  panelDeep: '#0D1116',
  border: '#212A34',
  borderLight: '#2C3744',
  textPrimary: '#E4E9EE',
  textSecondary: '#8893A0',
  textMuted: '#525C68',
  mono: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  on: '#3DDC84',
  onDim: '#1F6B40',
  off: '#5C7A99',
  offDim: '#2E3F4F',
  positive: '#4FA8FF',
  positiveDim: '#1E4566',
  negative: '#FF6B5B',
  negativeDim: '#5A2A24',
  neutral: '#9AA5B1',
  generated: '#C792EA',
  generatedDim: '#4A3658',
  uncertain: '#FFB84D',
  uncertainDim: '#5C4420',
  error: '#FF5C5C',
};

const stateColor = (s: 'ON' | 'OFF') => (s === 'ON' ? C.on : C.off);
const signColor = (sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL') =>
  sign === 'POSITIVE' ? C.positive : sign === 'NEGATIVE' ? C.negative : C.neutral;
const modeColor = (mode: string) => {
  if (mode === 'UNCERTAIN_ZONE') return C.negative;
  if (mode === 'POSITIVE_OFFSET_PENDING') return C.positive;
  if (mode === 'COMMUNITY_SYNCED') return C.generated;
  if (mode === 'PREDICTION_RANGE' || mode === 'GRACE_MODE' || mode === 'WAITING_FOR_GROWATT') return C.uncertain;
  return C.on;
};

const globalCss = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');
  .tmms-root * { box-sizing: border-box; }
  .tmms-root { font-family: ${C.sans}; }
  .tmms-mono { font-family: ${C.mono}; }
  .tmms-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
  .tmms-scroll::-webkit-scrollbar-track { background: ${C.panelDeep}; }
  .tmms-scroll::-webkit-scrollbar-thumb { background: ${C.borderLight}; border-radius: 4px; }
  .tmms-scroll::-webkit-scrollbar-thumb:hover { background: ${C.textMuted}; }
  .tmms-btn { transition: all 0.12s ease; cursor: pointer; }
  .tmms-btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
  .tmms-btn:active { transform: translateY(0); }
  @keyframes tmms-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .tmms-led-pulse { animation: tmms-pulse 1.4s ease-in-out infinite; }
  @keyframes tmms-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }
  .tmms-cursor-blink { animation: tmms-blink 1s step-end infinite; }
  .tmms-fade-in { animation: tmms-fadein 0.25s ease; }
  @keyframes tmms-fadein { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 1100px) {
    .tmms-grid { grid-template-columns: 1fr !important; }
    .tmms-col { max-height: none !important; }
  }
`;

// ════════════════════════════════════════════════════════════════════════════
// PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

function Panel({
  title, subtitle, accent = C.borderLight, children, collapsible = false, defaultOpen = true, badge,
}: {
  title: string; subtitle?: string; accent?: string; children: React.ReactNode;
  collapsible?: boolean; defaultOpen?: boolean; badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
      marginBottom: 14, overflow: 'hidden', borderTop: `2px solid ${accent}`,
    }}>
      <div
        onClick={() => collapsible && setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', cursor: collapsible ? 'pointer' : 'default',
          userSelect: 'none', borderBottom: open ? `1px solid ${C.border}` : 'none',
        }}
      >
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.textPrimary, letterSpacing: 0.3 }}>
            {collapsible && <span style={{ color: C.textMuted, marginRight: 6, fontSize: 10 }}>{open ? '▾' : '▸'}</span>}
            {title}
          </div>
          {subtitle && <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2 }}>{subtitle}</div>}
        </div>
        {badge}
      </div>
      {open && <div style={{ padding: 14 }}>{children}</div>}
    </div>
  );
}

function Badge({ children, color = C.neutral, glow = false }: { children: React.ReactNode; color?: string; glow?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 20, fontSize: 10.5, fontWeight: 700,
      background: `${color}22`, color, border: `1px solid ${color}55`,
      fontFamily: C.mono, letterSpacing: 0.3, whiteSpace: 'nowrap',
    }}>
      <span className={glow ? 'tmms-led-pulse' : ''} style={{ width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}` }} />
      {children}
    </span>
  );
}

function Btn({
  children, onClick, color = C.borderLight, textColor = C.textPrimary, small = false, disabled = false, fullWidth = false,
}: {
  children: React.ReactNode; onClick?: () => void; color?: string; textColor?: string;
  small?: boolean; disabled?: boolean; fullWidth?: boolean;
}) {
  return (
    <button
      className="tmms-btn"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        background: `${color}1F`, color: disabled ? C.textMuted : textColor,
        border: `1px solid ${disabled ? C.border : color + '70'}`,
        borderRadius: 7, padding: small ? '5px 10px' : '7px 14px',
        fontSize: small ? 11 : 12, fontWeight: 600, fontFamily: C.sans,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        width: fullWidth ? '100%' : undefined,
      }}
    >
      {children}
    </button>
  );
}

function StatRow({ label, value, mono = true, valueColor }: { label: string; value: React.ReactNode; mono?: boolean; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ fontSize: 11.5, color: C.textSecondary }}>{label}</span>
      <span style={{ fontSize: 12, color: valueColor ?? C.textPrimary, fontFamily: mono ? C.mono : C.sans, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function fmtMin(min: number | null | undefined): string {
  if (min === null || min === undefined || !isFinite(min)) return '—';
  const sign = min < 0 ? '−' : '';
  const abs = Math.abs(Math.round(min));
  const h = Math.floor(abs / 60), m = abs % 60;
  if (h === 0) return `${sign}${m}m`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${m}m`;
}

function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Schedule Builder
// ════════════════════════════════════════════════════════════════════════════
function ScheduleBuilder({ world, onChange }: { world: SimWorld; onChange: (t: ScheduleEntryTemplate[]) => void }) {
  const template = world.scheduleTemplate;

  const update = (id: string, durationMin: number) =>
    onChange(template.map(t => (t.id === id ? { ...t, durationMin: Math.max(1, durationMin) } : t)));
  const remove = (id: string) => template.length > 1 && onChange(template.filter(t => t.id !== id));
  const add = () => onChange([...template, { id: `t${Date.now()}`, state: template.length % 2 === 0 ? 'ON' : 'OFF', durationMin: 120 }]);
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= template.length) return;
    const next = [...template];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };
  const toggleState = (id: string) =>
    onChange(template.map(t => (t.id === id ? { ...t, state: t.state === 'ON' ? 'OFF' : 'ON' } : t)));

  const totalMin = template.reduce((s, t) => s + t.durationMin, 0);

  return (
    <Panel title="① SCHEDULE BUILDER" subtitle="Defines the repeating ON/OFF pattern (the 'Growatt schedule')" accent={C.borderLight}>
      {/* Mini timeline preview */}
      <div style={{ display: 'flex', height: 22, borderRadius: 5, overflow: 'hidden', marginBottom: 12, border: `1px solid ${C.border}` }}>
        {template.map(t => (
          <div key={t.id} title={`${t.state} ${t.durationMin}m`} style={{
            width: `${(t.durationMin / totalMin) * 100}%`, background: t.state === 'ON' ? C.onDim : C.offDim,
            borderRight: `1px solid ${C.bg}`,
          }} />
        ))}
      </div>

      {template.map((t, i) => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <button className="tmms-btn" onClick={() => toggleState(t.id)} style={{
            width: 46, padding: '4px 0', borderRadius: 5, border: `1px solid ${stateColor(t.state)}66`,
            background: `${stateColor(t.state)}22`, color: stateColor(t.state), fontFamily: C.mono, fontSize: 11, fontWeight: 700,
          }}>{t.state}</button>
          <input
            type="number" min={1} value={t.durationMin}
            onChange={e => update(t.id, parseInt(e.target.value || '0', 10))}
            style={{
              width: 64, background: C.panelDeep, border: `1px solid ${C.border}`, borderRadius: 5,
              color: C.textPrimary, fontFamily: C.mono, fontSize: 12, padding: '5px 7px',
            }}
          />
          <span style={{ fontSize: 10, color: C.textMuted, width: 28 }}>min</span>
          <div style={{ flex: 1 }} />
          <button className="tmms-btn" onClick={() => move(i, -1)} disabled={i === 0} style={{ background: 'transparent', border: 'none', color: i === 0 ? C.textMuted : C.textSecondary, fontSize: 13 }}>↑</button>
          <button className="tmms-btn" onClick={() => move(i, 1)} disabled={i === template.length - 1} style={{ background: 'transparent', border: 'none', color: i === template.length - 1 ? C.textMuted : C.textSecondary, fontSize: 13 }}>↓</button>
          <button className="tmms-btn" onClick={() => remove(t.id)} style={{ background: 'transparent', border: 'none', color: C.negative, fontSize: 13 }}>✕</button>
        </div>
      ))}

      <Btn onClick={add} small fullWidth color={C.on} textColor={C.on}>+ Add State</Btn>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Growatt Simulator
// ════════════════════════════════════════════════════════════════════════════
function GrowattSimulator({
  world, onForce, onAdvance, onSetNow, onReset,
}: {
  world: SimWorld; onForce: (s: 'ON' | 'OFF') => void; onAdvance: (min: number) => void;
  onSetNow: (ms: number) => void; onReset: () => void;
}) {
  const elapsedMin = (world.simulatedNowMs - new Date(world.growattLastTransitionAt).getTime()) / 60_000;
  const raw = world.lastResult;
  const expectedEnd = raw?.communityTransitionMeta?.offsetReferenceKind?.includes('EXPECTED')
    ? raw.communityTransitionMeta.offsetReferenceIso : null;

  return (
    <Panel
      title="② GROWATT SIMULATOR"
      subtitle="Manual control of the simulated inverter sensor"
      accent={stateColor(world.growattCurrentState)}
      badge={<Badge color={stateColor(world.growattCurrentState)} glow>{world.growattCurrentState}</Badge>}
    >
      <StatRow label="Current Growatt State" value={world.growattCurrentState} valueColor={stateColor(world.growattCurrentState)} />
      <StatRow label="Last Transition Time" value={fmtClock(world.growattLastTransitionAt)} />
      <StatRow label="Current Duration" value={fmtMin(elapsedMin)} />
      <StatRow label="Expected End (reference)" value={expectedEnd ? fmtClock(expectedEnd) : '—'} />
      <StatRow label="Simulated Clock" value={fmtClock(new Date(world.simulatedNowMs).toISOString())} valueColor={C.uncertain} />

      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn onClick={() => onForce('ON')} color={C.on} textColor={C.on}>Force ON</Btn>
        <Btn onClick={() => onForce('OFF')} color={C.off} textColor={C.off}>Force OFF</Btn>
        <Btn onClick={onReset} color={C.negative} textColor={C.negative}>Reset All</Btn>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Btn small onClick={() => onAdvance(15)}>+15m</Btn>
        <Btn small onClick={() => onAdvance(30)}>+30m</Btn>
        <Btn small onClick={() => onAdvance(60)}>+1h</Btn>
        <Btn small onClick={() => onAdvance(180)}>+3h</Btn>
        <Btn small onClick={() => onAdvance(360)}>+6h</Btn>
      </div>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — User Timeline Simulator
// ════════════════════════════════════════════════════════════════════════════
function UserTimelineSimulator({ world }: { world: SimWorld }) {
  const r = world.lastResult;
  if (!r) return null;
  const activeSlot = r.daySchedule.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return world.simulatedNowMs >= start && world.simulatedNowMs < end;
  });
  const effectiveOffset = world.frozenCommunityOffsetMinutes ?? world.offsetMinutes;
  const elapsedMin = r.currentStateStartIso ? (world.simulatedNowMs - new Date(r.currentStateStartIso).getTime()) / 60_000 : null;
  const remainingMin = activeSlot?.endIso ? (new Date(activeSlot.endIso).getTime() - world.simulatedNowMs) / 60_000 : null;

  return (
    <Panel
      title="③ USER TIMELINE SIMULATOR"
      subtitle="Live calculation — what the user actually sees"
      accent={stateColor(r.currentState)}
      badge={<Badge color={modeColor(r.atc.mode)} glow={r.atc.mode === 'UNCERTAIN_ZONE'}>{r.atc.mode}</Badge>}
    >
      <StatRow label="Current User State" value={r.currentState} valueColor={stateColor(r.currentState)} />
      <StatRow label="Current Offset" value={`${effectiveOffset > 0 ? '+' : ''}${effectiveOffset}m`} valueColor={signColor(effectiveOffset > 0 ? 'POSITIVE' : effectiveOffset < 0 ? 'NEGATIVE' : 'NEUTRAL')} />
      <StatRow label="Current Cycle" value={activeSlot ? `${activeSlot.state} ${activeSlot.isResynced ? '(generated)' : ''}` : '—'} />
      <StatRow label="Cycle Start" value={fmtClock(r.currentStateStartIso)} />
      <StatRow label="Cycle End (planned)" value={fmtClock(activeSlot?.endIso ?? null)} />
      <StatRow label="Elapsed" value={fmtMin(elapsedMin)} />
      <StatRow label="Remaining" value={remainingMin !== null ? fmtMin(remainingMin) : '—'} valueColor={remainingMin !== null && remainingMin < 0 ? C.negative : undefined} />
      <StatRow label="Is Holding (ATC)" value={r.isHoldingState ? 'YES' : 'no'} valueColor={r.isHoldingState ? C.uncertain : C.textMuted} />
      {r.atc.statusLine && (
        <div style={{ marginTop: 10, padding: 8, background: `${modeColor(r.atc.mode)}15`, border: `1px solid ${modeColor(r.atc.mode)}40`, borderRadius: 6, fontSize: 11, color: modeColor(r.atc.mode), direction: 'rtl', textAlign: 'right' }}>
          {r.atc.statusLine}
        </div>
      )}
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Mode Selector
// ════════════════════════════════════════════════════════════════════════════
function ModeSelector({ world, onChange }: { world: SimWorld; onChange: (m: 'AUTO' | 'MANUAL') => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: C.textMuted, marginRight: 2, fontFamily: C.mono }}>④ MODE</span>
      {(['AUTO', 'MANUAL'] as const).map(m => (
        <button key={m} className="tmms-btn" onClick={() => onChange(m)} style={{
          padding: '6px 14px', borderRadius: 7, fontSize: 11.5, fontWeight: 700, fontFamily: C.mono,
          border: `1px solid ${world.transitionMode === m ? C.positive : C.border}`,
          background: world.transitionMode === m ? `${C.positive}22` : 'transparent',
          color: world.transitionMode === m ? C.positive : C.textSecondary,
        }}>{m}</button>
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Report Simulator
// ════════════════════════════════════════════════════════════════════════════
function ReportSimulator({ onAction }: { onAction: (state: 'ON' | 'OFF', kind: 'report' | 'confirm') => void }) {
  return (
    <Panel title="⑤ REPORT SIMULATOR" subtitle="Executes the REAL TMMS V2 engine — not a simulation of it" accent={C.generated}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Btn onClick={() => onAction('ON', 'report')} color={C.on} textColor={C.on}>Report ON</Btn>
        <Btn onClick={() => onAction('OFF', 'report')} color={C.off} textColor={C.off}>Report OFF</Btn>
        <Btn onClick={() => onAction('ON', 'confirm')} color={C.on} textColor={C.on}>Confirm ON</Btn>
        <Btn onClick={() => onAction('OFF', 'confirm')} color={C.off} textColor={C.off}>Confirm OFF</Btn>
      </div>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Generated State Analyzer
// ════════════════════════════════════════════════════════════════════════════
function GeneratedStateAnalyzer({ world }: { world: SimWorld }) {
  const meta = world.lastResult?.communityTransitionMeta;
  if (!meta) {
    return (
      <Panel title="⑥ GENERATED STATE ANALYZER" accent={C.generated}>
        <div style={{ fontSize: 11.5, color: C.textMuted, textAlign: 'center', padding: '10px 0' }}>No active resync — submit a report or confirmation to create a generated state.</div>
      </Panel>
    );
  }
  const durMin = (new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000;
  return (
    <Panel
      title="⑥ GENERATED STATE ANALYZER"
      accent={C.generated}
      badge={<Badge color={meta.generatedCycleActive ? C.generated : C.textMuted} glow={meta.generatedCycleActive}>{meta.generatedCycleActive ? 'ACTIVE' : 'COMPLETED'}</Badge>}
    >
      <StatRow label="Generated State Created" value="YES" valueColor={C.generated} />
      <StatRow label="Generated State Type" value={meta.generatedCycleState} valueColor={stateColor(meta.generatedCycleState)} />
      <StatRow label="Generated State Start" value={fmtClock(meta.generatedCycleStartIso)} />
      <StatRow label="Generated State End" value={fmtClock(meta.generatedCycleEndIso)} />
      <StatRow label="Generated State Duration" value={fmtMin(durMin)} />
      <StatRow label="Source" value={world.resyncPoint?.reporterName?.includes('Confirm') ? 'Confirmation' : 'Report'} />
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Duration Selection Inspector
// ════════════════════════════════════════════════════════════════════════════
function DurationSelectionInspector({ world }: { world: SimWorld }) {
  const meta = world.lastResult?.communityTransitionMeta;
  if (!meta) {
    return (
      <Panel title="⑦ DURATION SELECTION INSPECTOR" accent={C.generated}>
        <div style={{ fontSize: 11.5, color: C.textMuted, textAlign: 'center', padding: '10px 0' }}>No active resync — submit a report or confirmation to see Rule 3 duration selection.</div>
      </Panel>
    );
  }
  const ruleLabel: Record<string, string> = {
    OFF_PROGRESS_LT_50_BEFORE: 'OFF progress < 50% → PREVIOUS same-state duration',
    OFF_PROGRESS_GT_50_AFTER: 'OFF progress > 50% → NEXT same-state duration',
    ON_ALWAYS_BEFORE: 'ON interrupted → ALWAYS previous duration (no 50% rule)',
  };
  return (
    <Panel title="⑦ DURATION SELECTION INSPECTOR" accent={C.generated}>
      <StatRow label="Progress at Interruption" value={`${(meta.progressRatio * 100).toFixed(1)}%`} />
      <StatRow label="Selected Rule" value={meta.durationSelectionRule} valueColor={C.generated} />
      <div style={{ fontSize: 10.5, color: C.textMuted, margin: '4px 0 10px', lineHeight: 1.5 }}>{ruleLabel[meta.durationSelectionRule]}</div>
      <StatRow label="Selected Schedule Entry" value={meta.durationSourceSlot ? `${meta.durationSourceSlot.state} (${meta.durationSourceSlot.durationLabel})` : 'fallback'} />
      <StatRow label="Selected Duration" value={fmtMin((new Date(meta.generatedCycleEndIso).getTime() - new Date(meta.generatedCycleStartIso).getTime()) / 60_000)} valueColor={C.generated} />
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Offset Calculation Inspector
// ════════════════════════════════════════════════════════════════════════════
function OffsetCalculationInspector({ world }: { world: SimWorld }) {
  const meta = world.lastResult?.communityTransitionMeta;
  if (!meta) {
    return (
      <Panel title="⑧ OFFSET CALCULATION INSPECTOR" accent={C.borderLight}>
        <div style={{ fontSize: 11.5, color: C.textMuted, textAlign: 'center', padding: '10px 0' }}>No active resync — submit a report or confirmation to see Rule 4/5 offset calculation.</div>
      </Panel>
    );
  }
  const refLabel: Record<string, string> = {
    GROWATT_ON_START_ACTUAL: 'Growatt ON Start (actual)',
    GROWATT_ON_END_EXPECTED: 'Growatt ON End (expected, from raw schedule)',
    GROWATT_OFF_END_EXPECTED: 'Growatt OFF End (expected, from raw schedule)',
    GROWATT_OFF_START_ACTUAL: 'Growatt OFF Start (actual)',
  };
  return (
    <Panel title="⑧ OFFSET CALCULATION INSPECTOR" accent={signColor(meta.offsetSign)} badge={<Badge color={signColor(meta.offsetSign)}>{meta.offsetSign}</Badge>}>
      <StatRow label="Reference Kind" value={meta.offsetReferenceKind ?? '(frozen — not re-derived)'} />
      <StatRow label="Reference Time" value={fmtClock(meta.offsetReferenceIso)} />
      <StatRow label="Generated State Start" value={fmtClock(meta.generatedCycleStartIso)} />
      <div style={{
        margin: '10px 0', padding: 9, background: C.panelDeep, border: `1px solid ${C.border}`, borderRadius: 6,
        fontSize: 11, fontFamily: C.mono, color: C.textSecondary, lineHeight: 1.7,
      }}>
        Offset = GeneratedStateStart − ReferenceGrowattTime<br />
        Offset = {fmtClock(meta.generatedCycleStartIso)} − {fmtClock(meta.offsetReferenceIso)}<br />
        Offset = <span style={{ color: signColor(meta.offsetSign), fontWeight: 700 }}>{meta.offsetMinutes > 0 ? '+' : ''}{meta.offsetMinutes}m</span>
      </div>
      <StatRow label="Calculated Offset" value={`${meta.offsetMinutes > 0 ? '+' : ''}${meta.offsetMinutes}m`} valueColor={signColor(meta.offsetSign)} />
      <StatRow label="Offset Type" value={meta.offsetSign} valueColor={signColor(meta.offsetSign)} />
      <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 8, lineHeight: 1.5 }}>
        {meta.offsetSign === 'POSITIVE' && 'Reason: generated timeline started AFTER the Growatt reference — user is behind Growatt.'}
        {meta.offsetSign === 'NEGATIVE' && 'Reason: generated timeline started BEFORE the Growatt reference — user is ahead of Growatt.'}
        {meta.offsetSign === 'NEUTRAL' && 'Reason: generated timeline start exactly matches the Growatt reference.'}
      </div>
      {!meta.isFreshOffsetComputation && (
        <div style={{ marginTop: 8, fontSize: 10, color: C.textMuted, fontStyle: 'italic' }}>
          ⓘ Frozen value reused (Q2-A) — reference detail only shown at the moment of original computation.
        </div>
      )}
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Transition Decision Inspector
// ════════════════════════════════════════════════════════════════════════════
function TransitionDecisionInspector({ world }: { world: SimWorld }) {
  const trace = world.lastDecisionTrace;
  if (!trace || trace.length === 0) {
    return (
      <Panel title="⑨ TRANSITION DECISION INSPECTOR" accent={C.borderLight}>
        <div style={{ fontSize: 11.5, color: C.textMuted, textAlign: 'center', padding: '10px 0' }}>No decisions traced yet.</div>
      </Panel>
    );
  }
  return (
    <Panel title="⑨ TRANSITION DECISION INSPECTOR" subtitle="Step-by-step engine trace for the active resync" accent={C.borderLight}>
      {trace.map(step => (
        <div key={step.step} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.border}` }}>
          <div style={{
            width: 22, height: 22, borderRadius: '50%', background: C.panelDeep, border: `1px solid ${C.borderLight}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontFamily: C.mono, color: C.textSecondary, flexShrink: 0,
          }}>{step.step}</div>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: C.textPrimary }}>{step.label}</div>
            <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 1 }}>{step.detail}</div>
          </div>
        </div>
      ))}
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Timeline Visualization (signature element)
// ════════════════════════════════════════════════════════════════════════════
function TimelineViz({ world }: { world: SimWorld }) {
  const r = world.lastResult;
  if (!r) return null;

  const W = 1000, H = 150;
  const windowMs = 16 * 3600 * 1000; // show 16h window
  const startMs = world.simulatedNowMs - windowMs * 0.4;
  const endMs = startMs + windowMs;
  const xOf = (ms: number) => ((ms - startMs) / (endMs - startMs)) * W;

  const slots = r.daySchedule.filter(s => {
    const st = new Date(s.startIso).getTime();
    const en = s.endIso ? new Date(s.endIso).getTime() : st + 1;
    return en > startMs && st < endMs;
  });

  const nowX = xOf(world.simulatedNowMs);
  const growattX = xOf(new Date(world.growattLastTransitionAt).getTime());

  return (
    <Panel title="⑩ TIMELINE VISUALIZATION" subtitle="Growatt vs User timeline — live" accent={C.uncertain}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', background: C.panelDeep, borderRadius: 8, border: `1px solid ${C.border}` }}>
        {/* Track labels */}
        <text x={6} y={26} fontSize={9} fill={C.textMuted} fontFamily={C.mono}>GROWATT</text>
        <text x={6} y={96} fontSize={9} fill={C.textMuted} fontFamily={C.mono}>USER</text>

        {/* Growatt track (single segment showing current state since last transition) */}
        <rect x={Math.max(0, growattX)} y={34} width={Math.max(0, W - Math.max(0, growattX))} height={26} fill={stateColor(world.growattCurrentState)} opacity={0.35} rx={3} />
        <text x={Math.max(4, growattX + 4)} y={51} fontSize={10} fill={stateColor(world.growattCurrentState)} fontFamily={C.mono} fontWeight={700}>{world.growattCurrentState}</text>

        {/* User track — render each schedule slot */}
        {slots.map((s, i) => {
          const x1 = Math.max(0, xOf(new Date(s.startIso).getTime()));
          const x2 = Math.min(W, xOf(s.endIso ? new Date(s.endIso).getTime() : endMs));
          const isGen = (s as any).isResynced;
          const fill = isGen ? C.generated : stateColor(s.state);
          return (
            <g key={i}>
              <rect x={x1} y={104} width={Math.max(1, x2 - x1)} height={26} fill={fill} opacity={isGen ? 0.55 : 0.32} rx={3}
                stroke={isGen ? C.generated : 'none'} strokeWidth={isGen ? 1.5 : 0} strokeDasharray={isGen ? '3,2' : undefined} />
              {x2 - x1 > 38 && <text x={x1 + 4} y={121} fontSize={9} fill={fill} fontFamily={C.mono}>{s.state}{isGen ? '★' : ''}</text>}
            </g>
          );
        })}

        {/* UNCERTAIN_ZONE / mode indicator band */}
        {r.atc.mode === 'UNCERTAIN_ZONE' && (
          <rect x={Math.max(0, nowX - 60)} y={104} width={60} height={26} fill={C.negative} opacity={0.25} rx={3} className="tmms-led-pulse" />
        )}

        {/* Now cursor */}
        <line x1={nowX} y1={10} x2={nowX} y2={H - 10} stroke={C.textPrimary} strokeWidth={1.5} strokeDasharray="3,3" className="tmms-cursor-blink" />
        <text x={nowX + 4} y={142} fontSize={9} fill={C.textPrimary} fontFamily={C.mono}>NOW</text>
      </svg>
      <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
        <LegendDot color={C.on} label="ON" /><LegendDot color={C.off} label="OFF" />
        <LegendDot color={C.generated} label="Generated (★)" />
        <LegendDot color={C.negative} label="UNCERTAIN_ZONE" />
      </div>
    </Panel>
  );
}
function LegendDot({ color, label }: { color: string; label: string }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: C.textMuted }}><span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />{label}</div>;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 11 — UNCERTAIN_ZONE Simulator
// ════════════════════════════════════════════════════════════════════════════
function UncertainZoneSimulator({ world, onForceExit, onJumpToOverrun }: { world: SimWorld; onForceExit: (s: 'ON' | 'OFF') => void; onJumpToOverrun: () => void }) {
  const r = world.lastResult;
  if (!r) return null;
  const inZone = r.atc.mode === 'UNCERTAIN_ZONE';
  return (
    <Panel
      title="⑪ UNCERTAIN_ZONE SIMULATOR"
      accent={C.negative}
      badge={<Badge color={inZone ? C.negative : C.textMuted} glow={inZone}>{inZone ? 'IN ZONE' : 'inactive'}</Badge>}
    >
      <StatRow label="Currently In Zone" value={inZone ? 'YES' : 'no'} valueColor={inZone ? C.negative : C.textMuted} />
      <StatRow label="Overrun Minutes" value={fmtMin(r.atc.overrunMinutes)} valueColor={r.atc.overrunMinutes > 0 ? C.negative : undefined} />
      <StatRow label="Why Entry Occurred" value={inZone ? 'Negative offset + cycle overran prediction range' : '—'} mono={false} />
      <StatRow label="Reconciled Start (lost-time result)" value={fmtClock(r.reconciledCycleStartIso)} valueColor={r.reconciledCycleStartIso ? C.on : undefined} />
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <Btn small onClick={onJumpToOverrun} color={C.uncertain} textColor={C.uncertain}>Jump to Overrun (+25m past cycle end)</Btn>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <Btn small onClick={() => onForceExit('ON')} color={C.on} textColor={C.on}>Exit via Growatt → ON</Btn>
        <Btn small onClick={() => onForceExit('OFF')} color={C.off} textColor={C.off}>Exit via Growatt → OFF</Btn>
      </div>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Schedule Continuity Inspector
// ════════════════════════════════════════════════════════════════════════════
function ScheduleContinuityInspector({ world }: { world: SimWorld }) {
  const r = world.lastResult;
  if (!r) return null;
  const upcoming = r.daySchedule.filter(s => new Date(s.startIso).getTime() >= world.simulatedNowMs).slice(0, 5);
  const current = r.daySchedule.find(s => {
    const st = new Date(s.startIso).getTime();
    const en = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return world.simulatedNowMs >= st && world.simulatedNowMs < en;
  });
  return (
    <Panel title="⑫ SCHEDULE CONTINUITY INSPECTOR" collapsible defaultOpen={false} accent={C.borderLight}>
      <StatRow label="Current Position" value={current ? `${current.state} (${current.durationLabel ?? '—'})` : '—'} valueColor={current ? stateColor(current.state) : undefined} />
      <StatRow label="Next Position" value={upcoming[0] ? `${upcoming[0].state} (${upcoming[0].durationLabel ?? '—'})` : '—'} />
      <div style={{ fontSize: 10.5, color: C.textMuted, margin: '10px 0 6px', fontWeight: 700 }}>FUTURE STATES (expected progression)</div>
      {upcoming.map((s, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11 }}>
          <span style={{ color: stateColor(s.state), fontFamily: C.mono, fontWeight: 700 }}>{s.state}</span>
          <span style={{ color: C.textMuted, fontFamily: C.mono }}>{fmtClock(s.startIso)} → {fmtClock(s.endIso)}</span>
          <span style={{ color: C.textSecondary }}>{s.durationLabel}</span>
        </div>
      ))}
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Persistent Timeline Inspector
// ════════════════════════════════════════════════════════════════════════════
function PersistentTimelineInspector({ world }: { world: SimWorld }) {
  const r = world.lastResult;
  if (!r) return null;
  const history = r.daySchedule.filter(s => new Date(s.startIso).getTime() < world.simulatedNowMs).slice(-8);
  return (
    <Panel title="⑬ PERSISTENT TIMELINE INSPECTOR" subtitle="Generated states are never deleted" collapsible defaultOpen={false} accent={C.generated}>
      <div className="tmms-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
        {history.map((s, i) => {
          const isGen = (s as any).isResynced;
          return (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', marginBottom: 3,
              background: isGen ? `${C.generated}15` : 'transparent', borderRadius: 5,
              border: isGen ? `1px solid ${C.generated}40` : `1px solid transparent`, fontSize: 10.5,
            }}>
              <span style={{ color: stateColor(s.state), fontFamily: C.mono, fontWeight: 700 }}>{s.state}</span>
              <span style={{ color: C.textMuted, fontFamily: C.mono }}>{fmtClock(s.startIso)}</span>
              {isGen && <Badge color={C.generated}>GENERATED</Badge>}
              {(s as any).isEstimated && !isGen && <Badge color={C.textMuted}>estimated</Badge>}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 8 }}>
        Showing last {history.length} historical slots. Mode changes, offsets, and resync events are in the Event Log (⑮).
      </div>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 14 — Scenario Runner
// ════════════════════════════════════════════════════════════════════════════
function ScenarioRunner({
  results, onRun, onRunAll, onLoadWorld,
}: {
  results: Record<number, ScenarioResult>; onRun: (id: number) => void; onRunAll: () => void; onLoadWorld: (w: SimWorld) => void;
}) {
  const passCount = Object.values(results).filter(r => r.pass).length;
  const ranCount = Object.keys(results).length;
  return (
    <Panel
      title="⑭ SCENARIO RUNNER"
      subtitle="15 predefined validation scenarios — each executes automatically"
      accent={C.on}
      badge={ranCount > 0 ? <Badge color={passCount === SCENARIOS.length ? C.on : C.uncertain}>{passCount}/{SCENARIOS.length} PASS</Badge> : undefined}
    >
      <Btn onClick={onRunAll} fullWidth color={C.on} textColor={C.on}>▶ Run All 15 Scenarios</Btn>
      <div className="tmms-scroll" style={{ maxHeight: 360, overflowY: 'auto', marginTop: 10 }}>
        {SCENARIOS.map(sc => {
          const res = results[sc.id];
          return (
            <div key={sc.id} style={{ padding: '8px 4px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.textPrimary }}>#{sc.id} {sc.name}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  {res && <Badge color={res.pass ? C.on : C.error}>{res.pass ? 'PASS' : 'FAIL'}</Badge>}
                  <button className="tmms-btn" onClick={() => onRun(sc.id)} style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, color: C.textSecondary, fontSize: 10, padding: '3px 8px' }}>Run</button>
                  {res && <button className="tmms-btn" onClick={() => onLoadWorld(res.world)} style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, color: C.positive, fontSize: 10, padding: '3px 8px' }}>Inspect</button>}
                </div>
              </div>
              {res && (
                <div className="tmms-fade-in" style={{ fontSize: 10, color: C.textMuted, marginTop: 4, fontFamily: C.mono }}>
                  expected: {res.expected}<br />actual: {res.actual}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 15 — Debug Event Log
// ════════════════════════════════════════════════════════════════════════════
const eventKindColor: Record<SimEvent['kind'], string> = {
  info: C.textMuted, report: C.generated, confirm: C.generated, growatt: C.uncertain,
  offset: C.positive, zone: C.negative, error: C.error, time: C.textSecondary,
};
function DebugEventLog({ events, onClear }: { events: SimEvent[]; onClear: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reversed = useMemo(() => [...events].reverse(), [events]);
  return (
    <Panel
      title="⑮ DEBUG EVENT LOG"
      subtitle={`${events.length} events`}
      accent={C.borderLight}
      badge={<button className="tmms-btn" onClick={onClear} style={{ background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMuted, fontSize: 10, padding: '3px 8px' }}>Clear</button>}
    >
      <div ref={scrollRef} className="tmms-scroll" style={{ maxHeight: 420, overflowY: 'auto', fontFamily: C.mono }}>
        {reversed.map(ev => (
          <div key={ev.id} className="tmms-fade-in" style={{ padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ fontSize: 9.5, color: C.textMuted, flexShrink: 0 }}>{fmtClock(ev.simTimeIso)}</span>
              <span style={{ fontSize: 11, color: eventKindColor[ev.kind], fontWeight: 700 }}>{ev.action}</span>
            </div>
            {ev.result && <div style={{ fontSize: 10, color: C.textSecondary, marginLeft: 4, marginTop: 2 }}>→ {ev.result}</div>}
          </div>
        ))}
        {events.length === 0 && <div style={{ fontSize: 11, color: C.textMuted, textAlign: 'center', padding: '20px 0' }}>No events yet.</div>}
      </div>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════
export default function TMMSDebugSimulator({ initialWorld }: { initialWorld?: SimWorld } = {}) {
  const [world, setWorld] = useState<SimWorld>(() => initialWorld ?? createInitialWorld());
  const [scenarioResults, setScenarioResults] = useState<Record<number, ScenarioResult>>({});

  const handleForce = useCallback((s: 'ON' | 'OFF') => setWorld(w => forceGrowattState(w, s)), []);
  const handleAdvance = useCallback((min: number) => setWorld(w => advanceTime(w, min)), []);
  const handleSetNow = useCallback((ms: number) => setWorld(w => setSimulatedNow(w, ms)), []);
  const handleReset = useCallback(() => { setWorld(resetWorld()); setScenarioResults({}); }, []);
  const handleModeChange = useCallback((m: 'AUTO' | 'MANUAL') => setWorld(w => setTransitionMode(w, m)), []);
  const handleScheduleChange = useCallback((t: ScheduleEntryTemplate[]) => setWorld(w => setSchedule(w, t)), []);
  const handleReportAction = useCallback((s: 'ON' | 'OFF', kind: 'report' | 'confirm') => setWorld(w => submitReportOrConfirm(w, s, kind)), []);
  const handleJumpToOverrun = useCallback(() => {
    setWorld(w => {
      const r = w.lastResult;
      const active = r?.daySchedule.find(s => {
        const st = new Date(s.startIso).getTime();
        const en = s.endIso ? new Date(s.endIso).getTime() : Infinity;
        return w.simulatedNowMs >= st && w.simulatedNowMs < en;
      });
      const target = active?.endIso ? new Date(active.endIso).getTime() + 25 * 60_000 : w.simulatedNowMs + 25 * 60_000;
      return setSimulatedNow(w, target);
    });
  }, []);

  const handleRunScenario = useCallback((id: number) => {
    const sc = SCENARIOS.find(s => s.id === id);
    if (!sc) return;
    const result = sc.run();
    setScenarioResults(prev => ({ ...prev, [id]: result }));
  }, []);
  const handleRunAll = useCallback(() => {
    const results: Record<number, ScenarioResult> = {};
    for (const sc of SCENARIOS) results[sc.id] = sc.run();
    setScenarioResults(results);
  }, []);
  const handleLoadWorld = useCallback((w: SimWorld) => setWorld(w), []);
  const handleClearLog = useCallback(() => setWorld(w => ({ ...w, eventLog: [] })), []);

  const r = world.lastResult;

  return (
    <div className="tmms-root" style={{ minHeight: '100vh', background: C.bgGradient, color: C.textPrimary, padding: 18 }}>
      <style>{globalCss}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.5 }}>
            TMMS V2 <span style={{ color: C.uncertain }}>DEBUG SIMULATOR</span>
          </div>
          <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2 }}>Development tool only · drives the real engine, not a mock</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {r && <Badge color={modeColor(r.atc.mode)} glow={r.atc.mode === 'UNCERTAIN_ZONE'}>{r.atc.mode}</Badge>}
          <ModeSelector world={world} onChange={handleModeChange} />
          <Btn onClick={handleReset} color={C.negative} textColor={C.negative} small>⟲ Reset</Btn>
        </div>
      </div>

      {/* 3-column grid */}
      <div className="tmms-grid" style={{ display: 'grid', gridTemplateColumns: '300px 1fr 320px', gap: 16, alignItems: 'start' }}>
        {/* LEFT: controls */}
        <div className="tmms-col">
          <ScheduleBuilder world={world} onChange={handleScheduleChange} />
          <GrowattSimulator world={world} onForce={handleForce} onAdvance={handleAdvance} onSetNow={handleSetNow} onReset={handleReset} />
          <ReportSimulator onAction={handleReportAction} />
        </div>

        {/* CENTER: visualization + inspectors */}
        <div className="tmms-col">
          <TimelineViz world={world} />
          <UserTimelineSimulator world={world} />
          <GeneratedStateAnalyzer world={world} />
          <DurationSelectionInspector world={world} />
          <OffsetCalculationInspector world={world} />
          <TransitionDecisionInspector world={world} />
          <UncertainZoneSimulator world={world} onForceExit={handleForce} onJumpToOverrun={handleJumpToOverrun} />
          <ScheduleContinuityInspector world={world} />
          <PersistentTimelineInspector world={world} />
        </div>

        {/* RIGHT: scenario runner + event log */}
        <div className="tmms-col" style={{ position: 'sticky', top: 18, maxHeight: 'calc(100vh - 36px)', overflowY: 'auto' }}>
          <ScenarioRunner results={scenarioResults} onRun={handleRunScenario} onRunAll={handleRunAll} onLoadWorld={handleLoadWorld} />
          <DebugEventLog events={world.eventLog} onClear={handleClearLog} />
        </div>
      </div>
    </div>
  );
}
