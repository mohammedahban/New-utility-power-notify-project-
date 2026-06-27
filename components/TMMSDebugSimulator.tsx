/**
 * components/TMMSDebugSimulator.tsx
 * ════════════════════════════════════════════════════════════════════════════
 * Admin debug simulator for the TMMS V2 engine.
 * Used by:
 *   - app/(admin)/simulator.web.tsx  (full-page web route)
 *   - app/(admin)/index.tsx          (embedded panel on admin dashboard)
 *
 * Wiring:
 *   TMMSDebugSimulator → tmmsSimulation → tmmsEngine (real production engine)
 *
 * All 15 automated scenarios run against the exact same
 * applyOffsetToPrediction() used in production.
 * ════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';

import {
  createInitialWorld,
  advanceTime,
  forceGrowattState,
  resetWorld,
  setTransitionMode,
  submitReportOrConfirm,
  SCENARIOS,
  fmtYemenTime,
  type SimWorld,
  type ScenarioResult,
} from '../app/(admin)/tmmsSimulation';

// ── Colour tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:      '#0A0E12',
  panel:   '#12181F',
  border:  '#212A34',
  text:    '#E4E9EE',
  muted:   '#8893A0',
  dim:     '#525C68',
  green:   '#3DDC84',
  red:     '#FF5A5A',
  blue:    '#4FA8FF',
  orange:  '#FFB84D',
  purple:  '#B794F4',
  mono:    Platform.OS === 'ios' ? 'Menlo' : 'monospace',
} as const;

// ── Small helpers ─────────────────────────────────────────────────────────────
function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[badgeStyles.wrap, { borderColor: color + '55', backgroundColor: color + '18' }]}>
      <Text style={[badgeStyles.text, { color }]}>{label}</Text>
    </View>
  );
}
const badgeStyles = StyleSheet.create({
  wrap: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  text: { fontSize: 11, fontWeight: '700' },
});

function SectionTitle({ children }: { children: string }) {
  return <Text style={secStyles.title}>{children}</Text>;
}
const secStyles = StyleSheet.create({
  title: { color: C.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 10, textTransform: 'uppercase' },
});

function Panel({ children, accent }: { children: React.ReactNode; accent?: string }) {
  return (
    <View style={[panelStyles.wrap, accent ? { borderLeftColor: accent, borderLeftWidth: 3 } : {}]}>
      {children}
    </View>
  );
}
const panelStyles = StyleSheet.create({
  wrap: { backgroundColor: C.panel, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 12 },
});

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={rowStyles.row}>
      <Text style={[rowStyles.value, color ? { color } : {}]}>{value}</Text>
      <Text style={rowStyles.label}>{label}</Text>
    </View>
  );
}
const rowStyles = StyleSheet.create({
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#0f172a' },
  label: { color: C.muted, fontSize: 12 },
  value: { color: C.text, fontSize: 12, fontWeight: '700' },
});

function Btn({ label, onPress, color, small }: { label: string; onPress: () => void; color?: string; small?: boolean }) {
  return (
    <TouchableOpacity
      style={[btnStyles.btn, small && btnStyles.small, color ? { borderColor: color + '55', backgroundColor: color + '18' } : {}]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Text style={[btnStyles.text, color ? { color } : {}]}>{label}</Text>
    </TouchableOpacity>
  );
}
const btnStyles = StyleSheet.create({
  btn: { borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.panel, alignItems: 'center' },
  small: { paddingHorizontal: 8, paddingVertical: 5 },
  text: { color: C.text, fontSize: 12, fontWeight: '700' },
});

// ── ATC mode → colour ─────────────────────────────────────────────────────────
const MODE_COLOR: Record<string, string> = {
  NORMAL:                  C.green,
  PREDICTION_RANGE:        C.blue,
  UNCERTAIN_ZONE:          C.orange,
  COMMUNITY_SYNCED:        C.purple,
  WAITING_FOR_GROWATT:     C.blue,
  GRACE_MODE:              C.orange,
  POSITIVE_OFFSET_PENDING: C.blue,
};

// ── World state panel ─────────────────────────────────────────────────────────
function WorldStatePanel({ world }: { world: SimWorld }) {
  const r = world.lastResult;
  if (!r) return null;
  const mode = r.atc.mode;
  const modeColor = MODE_COLOR[mode] ?? C.muted;
  const stateColor = r.currentState === 'ON' ? C.green : C.red;

  return (
    <Panel accent={modeColor}>
      <SectionTitle>حالة العالم الحالية</SectionTitle>
      <Row label="وضع ATC"     value={mode}               color={modeColor} />
      <Row label="الحالة"      value={r.currentState}     color={stateColor} />
      <Row label="Growatt"     value={world.growattCurrentState} color={world.growattCurrentState === 'ON' ? C.green : C.red} />
      <Row label="الفارق"      value={`${world.offsetMinutes >= 0 ? '+' : ''}${world.offsetMinutes}د`} color={world.offsetMinutes === 0 ? C.muted : world.offsetMinutes > 0 ? C.green : C.orange} />
      <Row label="وضع التحكم" value={world.transitionMode} color={world.transitionMode === 'AUTO' ? C.blue : C.orange} />
      <Row label="إعادة المزامنة" value={world.resyncPoint ? `${world.resyncPoint.syncedState} @ ${fmtYemenTime(world.resyncPoint.syncedAtIso)}` : 'لا يوجد'} />
      <Row label="الوقت المحاكى" value={fmtYemenTime(new Date(world.simulatedNowMs).toISOString())} />
      {r.atc.overrunMinutes > 0 && (
        <Row label="التجاوز" value={`${Math.round(r.atc.overrunMinutes)} د`} color={C.orange} />
      )}
      {r.atc.statusLine ? (
        <View style={{ marginTop: 8, backgroundColor: modeColor + '18', borderRadius: 8, padding: 8 }}>
          <Text style={{ color: modeColor, fontSize: 11, textAlign: 'right' }}>{r.atc.statusLine}</Text>
        </View>
      ) : null}
    </Panel>
  );
}

// ── Controls panel ────────────────────────────────────────────────────────────
function ControlsPanel({ world, setWorld }: { world: SimWorld; setWorld: (w: SimWorld) => void }) {
  return (
    <Panel>
      <SectionTitle>التحكم في المحاكاة</SectionTitle>

      {/* Time controls */}
      <Text style={{ color: C.dim, fontSize: 10, marginBottom: 6, textAlign: 'right' }}>⏱ تقدّم الزمن</Text>
      <View style={{ flexDirection: 'row-reverse', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {[5, 15, 30, 60, 120].map(m => (
          <Btn key={m} small label={`+${m}د`} onPress={() => setWorld(advanceTime(world, m))} color={C.blue} />
        ))}
      </View>

      {/* Growatt controls */}
      <Text style={{ color: C.dim, fontSize: 10, marginBottom: 6, textAlign: 'right' }}>⚡ Growatt</Text>
      <View style={{ flexDirection: 'row-reverse', gap: 6, marginBottom: 12 }}>
        <Btn small label="تشغيل ON"  onPress={() => setWorld(forceGrowattState(world, 'ON'))}  color={C.green} />
        <Btn small label="إطفاء OFF" onPress={() => setWorld(forceGrowattState(world, 'OFF'))} color={C.red} />
      </View>

      {/* Transition mode */}
      <Text style={{ color: C.dim, fontSize: 10, marginBottom: 6, textAlign: 'right' }}>🎛 وضع التحكم</Text>
      <View style={{ flexDirection: 'row-reverse', gap: 6, marginBottom: 12 }}>
        <Btn small label="AUTO"   onPress={() => setWorld(setTransitionMode(world, 'AUTO'))}   color={world.transitionMode === 'AUTO' ? C.blue : undefined} />
        <Btn small label="MANUAL" onPress={() => setWorld(setTransitionMode(world, 'MANUAL'))} color={world.transitionMode === 'MANUAL' ? C.orange : undefined} />
      </View>

      {/* Community report */}
      <Text style={{ color: C.dim, fontSize: 10, marginBottom: 6, textAlign: 'right' }}>👥 بلاغ مجتمعي</Text>
      <View style={{ flexDirection: 'row-reverse', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <Btn small label="بلاغ ON"  onPress={() => setWorld(submitReportOrConfirm(world, 'ON',  'report'))}  color={C.green} />
        <Btn small label="بلاغ OFF" onPress={() => setWorld(submitReportOrConfirm(world, 'OFF', 'report'))}  color={C.red} />
        <Btn small label="تأكيد ON"  onPress={() => setWorld(submitReportOrConfirm(world, 'ON',  'confirm'))} color={C.purple} />
        <Btn small label="تأكيد OFF" onPress={() => setWorld(submitReportOrConfirm(world, 'OFF', 'confirm'))} color={C.purple} />
      </View>

      {/* Reset */}
      <Btn label="♻ إعادة تهيئة العالم" onPress={() => setWorld(resetWorld())} color={C.orange} />
    </Panel>
  );
}

// ── Event log ─────────────────────────────────────────────────────────────────
function EventLogPanel({ world }: { world: SimWorld }) {
  const kindColor: Record<string, string> = {
    info: C.muted, report: C.purple, confirm: C.blue,
    growatt: C.green, offset: C.orange, zone: C.dim,
    error: C.red, time: C.dim,
  };
  const recent = [...world.eventLog].reverse().slice(0, 12);

  return (
    <Panel>
      <SectionTitle>سجل الأحداث</SectionTitle>
      {recent.length === 0 ? (
        <Text style={{ color: C.dim, fontSize: 11, textAlign: 'center' }}>لا توجد أحداث</Text>
      ) : (
        recent.map(ev => (
          <View key={ev.id} style={{ flexDirection: 'row-reverse', gap: 8, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <Text style={{ color: C.dim, fontSize: 9, minWidth: 44, textAlign: 'right' }}>{fmtYemenTime(ev.simTimeIso)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: kindColor[ev.kind] ?? C.muted, fontSize: 11, fontWeight: '700', textAlign: 'right' }}>{ev.action}</Text>
              {ev.result ? <Text style={{ color: C.dim, fontSize: 10, textAlign: 'right' }}>{ev.result}</Text> : null}
            </View>
          </View>
        ))
      )}
    </Panel>
  );
}

// ── Scenario runner ───────────────────────────────────────────────────────────
function ScenarioRunner({ onApply }: { onApply: (world: SimWorld) => void }) {
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [running, setRunning] = useState(false);

  const runAll = useCallback(() => {
    setRunning(true);
    const out: ScenarioResult[] = [];
    for (const sc of SCENARIOS) {
      try { out.push(sc.run()); } catch (e: any) {
        out.push({ id: sc.id, pass: false, expected: 'no error', actual: e?.message ?? String(e), world: createInitialWorld() });
      }
    }
    setResults(out);
    setRunning(false);
  }, []);

  const passed = results.filter(r => r.pass).length;

  return (
    <Panel>
      <SectionTitle>تشغيل السيناريوهات الـ 15</SectionTitle>
      <Btn label={running ? '⏳ جارٍ...' : '▶ تشغيل جميع السيناريوهات'} onPress={runAll} color={C.blue} />
      {results.length > 0 && (
        <>
          <View style={{ flexDirection: 'row-reverse', gap: 10, marginTop: 10, marginBottom: 6 }}>
            <Badge label={`✅ ${passed}/${results.length} نجح`}    color={C.green} />
            {passed < results.length && (
              <Badge label={`❌ ${results.length - passed} فشل`} color={C.red} />
            )}
          </View>
          {results.map(r => (
            <TouchableOpacity key={r.id} style={[scStyles.row, { borderLeftColor: r.pass ? C.green : C.red }]} onPress={() => onApply(r.world)} activeOpacity={0.8}>
              <Text style={[scStyles.id, { color: r.pass ? C.green : C.red }]}>#{r.id}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.text, fontSize: 11, fontWeight: '700', textAlign: 'right' }}>{SCENARIOS[r.id - 1]?.name}</Text>
                {!r.pass && (
                  <Text style={{ color: C.orange, fontSize: 10, textAlign: 'right', marginTop: 2 }}>
                    متوقع: {r.expected}{'\n'}فعلي: {r.actual}
                  </Text>
                )}
              </View>
              <Text style={{ color: r.pass ? C.green : C.red, fontSize: 14 }}>{r.pass ? '✓' : '✗'}</Text>
            </TouchableOpacity>
          ))}
        </>
      )}
    </Panel>
  );
}
const scStyles = StyleSheet.create({
  row: { flexDirection: 'row-reverse', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border, borderLeftWidth: 3, paddingLeft: 8, marginBottom: 2, alignItems: 'flex-start' },
  id: { fontSize: 11, fontWeight: '900', minWidth: 22 },
});

// ── Schedule preview ──────────────────────────────────────────────────────────
function SchedulePreview({ world }: { world: SimWorld }) {
  const slots = world.lastResult?.daySchedule ?? [];
  const nowMs = world.simulatedNowMs;
  const upcoming = slots.filter(s => !s.endIso || new Date(s.endIso).getTime() > nowMs - 3600_000).slice(0, 8);

  return (
    <Panel>
      <SectionTitle>الجدول الزمني (أول 8 فترات)</SectionTitle>
      {upcoming.length === 0 ? (
        <Text style={{ color: C.dim, fontSize: 11, textAlign: 'center' }}>لا يوجد جدول</Text>
      ) : (
        upcoming.map((slot, i) => {
          const isActive = new Date(slot.startIso).getTime() <= nowMs && (!slot.endIso || new Date(slot.endIso).getTime() > nowMs);
          const color = slot.state === 'ON' ? C.green : C.red;
          return (
            <View key={i} style={[spStyles.row, isActive && { backgroundColor: color + '12' }]}>
              <Text style={{ color: C.dim, fontSize: 9 }}>{slot.durationLabel ?? '—'}</Text>
              <Text style={{ color: C.dim, fontSize: 9 }}>{slot.endIso ? fmtYemenTime(slot.endIso) : '∞'}</Text>
              <Text style={{ color: C.muted, fontSize: 9 }}>←</Text>
              <Text style={{ color, fontSize: 9, fontWeight: '700' }}>{fmtYemenTime(slot.startIso)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[{ color, fontSize: 11, fontWeight: '800', textAlign: 'right' }]}>
                  {slot.state === 'ON' ? '⚡ شغّال' : '🔴 طافي'}
                  {isActive ? ' ◀ الآن' : ''}
                  {slot.isResynced ? ' 👥' : ''}
                  {slot.isEstimated ? ' ~' : ''}
                </Text>
              </View>
            </View>
          );
        })
      )}
    </Panel>
  );
}
const spStyles = StyleSheet.create({
  row: { flexDirection: 'row-reverse', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border, alignItems: 'center' },
});

// ── Community transition meta ─────────────────────────────────────────────────
function CommunityMeta({ world }: { world: SimWorld }) {
  const meta = world.lastResult?.communityTransitionMeta;
  if (!meta) return null;

  return (
    <Panel accent={C.purple}>
      <SectionTitle>بيانات الانتقال المجتمعي</SectionTitle>
      <Row label="الحالة المولودة"    value={meta.generatedCycleState} color={meta.generatedCycleState === 'ON' ? C.green : C.red} />
      <Row label="نشطة الآن"         value={meta.generatedCycleActive ? 'نعم' : 'لا'} color={meta.generatedCycleActive ? C.green : C.muted} />
      <Row label="نسبة التقدم"        value={`${(meta.progressRatio * 100).toFixed(1)}%`} />
      <Row label="الفارق المستنتج"    value={`${meta.offsetMinutes >= 0 ? '+' : ''}${meta.offsetMinutes}د`} color={meta.offsetSign === 'POSITIVE' ? C.green : meta.offsetSign === 'NEGATIVE' ? C.orange : C.muted} />
      <Row label="قاعدة الاختيار"     value={meta.durationSelectionRule} />
      {meta.durationSourceSlot && (
        <Row label="مصدر المدة" value={`${meta.durationSourceSlot.state} · ${meta.durationSourceSlot.durationLabel}`} />
      )}
      {meta.decisionTrace && meta.decisionTrace.length > 0 && (
        <View style={{ marginTop: 8 }}>
          <Text style={{ color: C.dim, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 6 }}>DECISION TRACE</Text>
          {meta.decisionTrace.map(step => (
            <View key={step.step} style={{ marginBottom: 4 }}>
              <Text style={{ color: C.blue, fontSize: 10, fontWeight: '700' }}>Step {step.step}: {step.label}</Text>
              <Text style={{ color: C.muted, fontSize: 10 }}>{step.detail}</Text>
            </View>
          ))}
        </View>
      )}
    </Panel>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function TMMSDebugSimulator() {
  const [world, setWorld] = useState<SimWorld>(() => createInitialWorld());

  return (
    <ScrollView style={mainStyles.scroll} contentContainerStyle={mainStyles.content} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={mainStyles.header}>
        <View style={mainStyles.led} />
        <Text style={mainStyles.title}>TMMS V2 DEBUG SIMULATOR</Text>
      </View>
      <Text style={mainStyles.subtitle}>يشغّل نفس المحرك الفعلي المستخدم في التطبيق</Text>

      <WorldStatePanel world={world} />
      <ControlsPanel world={world} setWorld={setWorld} />
      <SchedulePreview world={world} />
      <CommunityMeta world={world} />
      <ScenarioRunner onApply={setWorld} />
      <EventLogPanel world={world} />
    </ScrollView>
  );
}

const mainStyles = StyleSheet.create({
  scroll:    { flex: 1, backgroundColor: C.bg },
  content:   { padding: 16, paddingBottom: 40 },
  header:    { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  led:       { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green, marginRight: 8 },
  title:     { fontSize: 14, fontWeight: '800', color: C.text, letterSpacing: 0.5 },
  subtitle:  { color: C.dim, fontSize: 10, marginBottom: 16, textAlign: 'right' },
});
