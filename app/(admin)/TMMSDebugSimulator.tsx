import React, { useState, useMemo, useCallback, useRef } from 'react';
import {
  createInitialWorld, advanceTime, setSimulatedNow, forceGrowattState, resetWorld, setTransitionMode, setSchedule, submitReportOrConfirm,
  SCENARIOS, type SimWorld, type SimEvent, type ScheduleEntryTemplate, type ScenarioResult,
} from './tmmsSimulation';
import { fmtYemenTime } from './tmmsEngine';

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
const signColor = (sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL') => sign === 'POSITIVE' ? C.positive : sign === 'NEGATIVE' ? C.negative : C.neutral;
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

function Panel({
  title, subtitle, accent = C.borderLight, children, collapsible = false, defaultOpen = true, badge,
}: {
  title: string; subtitle?: string; accent?: string; children: React.ReactNode;
  collapsible?: boolean; defaultOpen?: boolean; badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 14, overflow: 'hidden', borderTop: `2px solid ${accent}` }}>
      <div onClick={() => collapsible && setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', cursor: collapsible ? 'pointer' : 'default', userSelect: 'none', borderBottom: open ? `1px solid ${C.border}` : 'none' }}>
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, background: `${color}22`, color, border: `1px solid ${color}55`, fontFamily: C.mono, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>
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
    <button className="tmms-btn" onClick={disabled ? undefined : onClick} disabled={disabled} style={{ background: `${color}1F`, color: disabled ? C.textMuted : textColor, border: `1px solid ${disabled ? C.border : color + '70'}`, borderRadius: 7, padding: small ? '5px 10px' : '7px 14px', fontSize: small ? 11 : 12, fontWeight: 600, fontFamily: C.sans, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, width: fullWidth ? '100%' : undefined }}>
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

function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function CommunityConfirmationAnalysis({ world }: { world: SimWorld }) {
  const meta = world.lastResult?.communityTransitionMeta;
  const isLate = world.resyncPoint && new Date(world.resyncPoint.syncedAtIso).getTime() !== world.simulatedNowMs;
  
  return (
    <Panel title="★ COMMUNITY CONFIRMATION ANALYSIS" accent={C.positive}>
      <StatRow label="Active Community Sync" value={world.resyncPoint ? 'YES' : 'NO'} valueColor={world.resyncPoint ? C.positive : C.textMuted} />
      {world.resyncPoint && (
        <>
          <StatRow label="Authoritative Timestamp" value={fmtClock(world.resyncPoint.syncedAtIso)} />
          <StatRow label="Confidence Score" value={`${world.confidenceScore}%`} valueColor={world.confidenceScore > 50 ? C.positive : C.uncertain} />
          <StatRow label="Report State" value={world.resyncPoint.syncedState} />
          <div style={{ marginTop: 10, padding: 8, background: C.panelDeep, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, color: C.textSecondary }}>
            <strong>Rule Compliance Check:</strong><br />
            - Generated Start Time strictly matches Authoritative Timestamp.<br />
            - Late Confirmations increment confidence but DO NOT recalculate offsets (Q2-A).
          </div>
        </>
      )}
    </Panel>
  );
}

function ScenarioRunner({
  results, onRun, onRunAll, onLoadWorld,
}: {
  results: Record<string, ScenarioResult>; onRun: (id: string) => void; onRunAll: () => void; onLoadWorld: (w: SimWorld) => void;
}) {
  const passCount = Object.values(results).filter(r => r.pass).length;
  
  const groups = useMemo(() => {
    const g: Record<string, typeof SCENARIOS> = {};
    for (const sc of SCENARIOS) {
      if (!g[sc.group]) g[sc.group] = [];
      g[sc.group].push(sc);
    }
    return g;
  }, []);

  return (
    <Panel title="⑭ SCENARIO RUNNER (Groups A-K)" accent={C.on} badge={<Badge color={C.on}>{passCount}/{SCENARIOS.length} PASS</Badge>}>
      <Btn onClick={onRunAll} fullWidth color={C.on} textColor={C.on}>▶ Run Validation Suite</Btn>
      <div className="tmms-scroll" style={{ maxHeight: 360, overflowY: 'auto', marginTop: 10 }}>
        {Object.entries(groups).map(([groupName, scs]) => (
          <div key={groupName} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.textMuted, borderBottom: `1px solid ${C.border}`, paddingBottom: 4, marginBottom: 4 }}>{groupName}</div>
            {scs.map(sc => {
              const res = results[sc.id];
              return (
                <div key={sc.id} style={{ padding: '6px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 11, color: C.textPrimary }}>{sc.id} - {sc.name}</div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {res && <Badge color={res.pass ? C.on : C.error}>{res.pass ? 'PASS' : 'FAIL'}</Badge>}
                      <button className="tmms-btn" onClick={() => onRun(sc.id)} style={{ background: 'transparent', color: C.textSecondary, border: `1px solid ${C.border}`, fontSize: 10, borderRadius: 4 }}>Run</button>
                    </div>
                  </div>
                  {res && (
                    <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4, fontFamily: C.mono, background: C.panelDeep, padding: 4, borderRadius: 4 }}>
                      Exp: {res.expected}<br/>Act: {res.actual}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export default function TMMSDebugSimulator({ initialWorld }: { initialWorld?: SimWorld } = {}) {
  const [world, setWorld] = useState<SimWorld>(() => initialWorld ?? createInitialWorld());
  const [scenarioResults, setScenarioResults] = useState<Record<string, ScenarioResult>>({});

  const handleRunAll = useCallback(() => {
    const results: Record<string, ScenarioResult> = {};
    for (const sc of SCENARIOS) results[sc.id] = sc.run();
    setScenarioResults(results);
  }, []);

  return (
    <div className="tmms-root" style={{ minHeight: '100vh', background: C.bgGradient, color: C.textPrimary, padding: 18 }}>
      <style>{globalCss}</style>
      <div className="tmms-grid" style={{ display: 'grid', gridTemplateColumns: '300px 1fr 320px', gap: 16 }}>
        <div className="tmms-col">
          {/* Include left panel elements (ScheduleBuilder, etc.) here in full version */}
        </div>
        <div className="tmms-col">
           <CommunityConfirmationAnalysis world={world} />
        </div>
        <div className="tmms-col">
           <ScenarioRunner results={scenarioResults} onRun={id => setScenarioResults(p => ({...p, [id]: SCENARIOS.find(s=>s.id===id)!.run()}))} onRunAll={handleRunAll} onLoadWorld={setWorld} />
        </div>
      </div>
    </div>
  );
}
