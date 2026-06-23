/**
 * TMMS V2 Debug Simulator — Expo / React Native port
 * ════════════════════════════════════════════════════════════════════════════
 * Development/debug tool only. Does NOT touch production users or data.
 *
 * Architecture (unchanged from the web version):
 *   UI Layer                 → this file (components only, no business logic)
 *   TMMS Engine Layer         → ./tmmsEngine.ts   (pure, reusable, copy-paste
 *                                                   ready for production)
 *   Simulation Layer          → ./tmmsSimulation.ts (world state, scenarios —
 *                                                     built ON the real engine)
 *   Debug Visualization Layer → the Timeline / Inspector components below,
 *                                which only ever READ engine/simulation output
 *
 * ./tmmsEngine.ts and ./tmmsSimulation.ts are NOT changed for this port — they
 * have zero DOM/React dependencies (pure TS, framework-agnostic by design), so
 * they run identically under Hermes/React Native. Only this file, which used
 * web-only primitives (div/button/input/svg + injected <style> CSS), needed a
 * real rewrite for React Native.
 *
 * REQUIRED DEPENDENCY (not in core React Native):
 *   npx expo install react-native-svg
 * Everything else here uses only core React Native components.
 *
 * NOTES / PLATFORM CAVEATS:
 *   - Uses flexbox `gap` (RN ≥0.71 / Expo SDK ≥49). If you're on an older SDK,
 *     replace the `gap` style props with explicit margins.
 *   - fmtYemenTime/fmtClock use Date#toLocaleString with a timeZone option,
 *     which needs full ICU data in Hermes (default on Expo SDK 47+). If dates
 *     render oddly on an older/bare RN setup, add the `Intl` polyfill (e.g.
 *     `@formatjs/intl-locale` + related polyfills) or swap to a date library.
 *   - No CSS gradient/box-shadow glow equivalents are used — kept to solid
 *     fills + Animated opacity pulses, which look right on every platform
 *     (iOS/Android/web-via-react-native-web) without extra libraries.
 *   - This is a component, not a screen: mount it behind your own admin/dev
 *     gate, e.g. inside a stack screen:
 *       {__DEV__ && <TMMSDebugSimulator />}
 *     Wrap it in your own SafeAreaView/SafeAreaProvider if you need inset
 *     handling — left out here so this drops into any navigator cleanly.
 * ════════════════════════════════════════════════════════════════════════════
 */
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Animated,
  Easing,
  Platform,
  useWindowDimensions,
} from 'react-native';
import Svg, { Rect, Line, Text as SvgText, G } from 'react-native-svg';
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
  SPEC_SCENARIOS,
  type SimWorld,
  type SimEvent,
  type ScheduleEntryTemplate,
  type ScenarioResult,
  type SpecScenarioResult,
} from './tmmsSimulation';
import { type ReportRecord, type TrustLevel } from './tmmsEngine';

// ════════════════════════════════════════════════════════════════════════════
// THEME — instrument-panel / oscilloscope aesthetic (same palette as the web
// version). Subject-grounded choice: this tool monitors an inverter's ON/OFF
// cycles, so a dark control-panel look with LED-style semantic colors fits.
// ════════════════════════════════════════════════════════════════════════════
const C = {
  bg: '#0A0E12',
  panel: '#12181F',
  panelDeep: '#0D1116',
  border: '#212A34',
  borderLight: '#2C3744',
  textPrimary: '#E4E9EE',
  textSecondary: '#8893A0',
  textMuted: '#525C68',
  on: '#3DDC84',
  onDim: '#1F6B40',
  off: '#5C7A99',
  offDim: '#2E3F4F',
  positive: '#4FA8FF',
  negative: '#FF6B5B',
  neutral: '#9AA5B1',
  generated: '#C792EA',
  uncertain: '#FFB84D',
  error: '#FF5C5C',
};

// System-font fallback — zero extra deps. Swap for loaded Google Fonts
// (expo-font + @expo-google-fonts/jetbrains-mono / inter) if you want the
// exact web look; FONT_MONO/FONT_SANS are the only two lines to change.
const FONT_MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) as string;
const FONT_SANS = Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }) as string;

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

// ════════════════════════════════════════════════════════════════════════════
// ANIMATION HELPERS — replace the web version's CSS keyframes
// (tmms-pulse / tmms-blink / tmms-fadein) with RN Animated equivalents.
// ════════════════════════════════════════════════════════════════════════════

/** Smooth opacity loop 1 → 0.4 → 1, ~1.4s — used for "LED" glow badges. */
function usePulse(active: boolean): Animated.Value {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, opacity]);
  return opacity;
}

/** Hard on/off blink every 500ms — used for the timeline's "NOW" cursor. */
function useBlink(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn(o => !o), 500);
    return () => clearInterval(id);
  }, []);
  return on;
}

/** Fade + slide-in on mount — used for newly-appeared list rows (decision
 *  trace steps, event log lines, scenario results). */
function FadeIn({ children, style }: { children: React.ReactNode; style?: any }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-4)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start();
  }, [opacity, translateY]);
  return <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedLine = Animated.createAnimatedComponent(Line);

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
    <View style={{
      backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 10,
      marginBottom: 14, overflow: 'hidden', borderTopWidth: 2, borderTopColor: accent,
    }}>
      <Pressable
        onPress={() => collapsible && setOpen(o => !o)}
        style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingVertical: 10, paddingHorizontal: 14,
          borderBottomWidth: open ? 1 : 0, borderBottomColor: C.border,
        }}
      >
        <View>
          <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.textPrimary, letterSpacing: 0.3, fontFamily: FONT_SANS }}>
            {collapsible && <Text style={{ color: C.textMuted, fontSize: 10 }}>{open ? '▾ ' : '▸ '}</Text>}
            {title}
          </Text>
          {subtitle && <Text style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2, fontFamily: FONT_SANS }}>{subtitle}</Text>}
        </View>
        {badge}
      </Pressable>
      {open && <View style={{ padding: 14 }}>{children}</View>}
    </View>
  );
}

function Badge({ children, color = C.neutral, glow = false }: { children: React.ReactNode; color?: string; glow?: boolean }) {
  const pulse = usePulse(glow);
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingVertical: 3, paddingHorizontal: 9, borderRadius: 20,
      backgroundColor: `${color}22`, borderWidth: 1, borderColor: `${color}55`,
    }}>
      <Animated.View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: glow ? pulse : 1 }} />
      <Text style={{ fontSize: 10.5, fontWeight: '700', color, fontFamily: FONT_MONO, letterSpacing: 0.3 }}>{children}</Text>
    </View>
  );
}

function Btn({
  children, onClick, color = C.borderLight, textColor = C.textPrimary, small = false, disabled = false, fullWidth = false,
}: {
  children: React.ReactNode; onClick?: () => void; color?: string; textColor?: string;
  small?: boolean; disabled?: boolean; fullWidth?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onClick}
      disabled={disabled}
      style={({ pressed }) => ({
        backgroundColor: `${color}${pressed ? '38' : '1F'}`,
        borderWidth: 1, borderColor: disabled ? C.border : `${color}70`,
        borderRadius: 7, paddingVertical: small ? 5 : 7, paddingHorizontal: small ? 10 : 14,
        opacity: disabled ? 0.5 : 1, width: fullWidth ? '100%' : undefined,
        alignItems: 'center', justifyContent: 'center',
      })}
    >
      <Text style={{ color: disabled ? C.textMuted : textColor, fontSize: small ? 11 : 12, fontWeight: '600', fontFamily: FONT_SANS, textAlign: 'center' }}>
        {children}
      </Text>
    </Pressable>
  );
}

function StatRow({ label, value, mono = true, valueColor }: { label: string; value: React.ReactNode; mono?: boolean; valueColor?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.border }}>
      <Text style={{ fontSize: 11.5, color: C.textSecondary, fontFamily: FONT_SANS }}>{label}</Text>
      <Text style={{ fontSize: 12, color: valueColor ?? C.textPrimary, fontFamily: mono ? FONT_MONO : FONT_SANS, fontWeight: '600' }}>{value}</Text>
    </View>
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

  return (
    <Panel title="① SCHEDULE BUILDER" subtitle="Defines the repeating ON/OFF pattern (the 'Growatt schedule')" accent={C.borderLight}>
      {/* Mini timeline preview */}
      <View style={{ flexDirection: 'row', height: 22, borderRadius: 5, overflow: 'hidden', marginBottom: 12, borderWidth: 1, borderColor: C.border }}>
        {template.map(t => (
          <View key={t.id} style={{ flex: t.durationMin, backgroundColor: t.state === 'ON' ? C.onDim : C.offDim, borderRightWidth: 1, borderRightColor: C.bg }} />
        ))}
      </View>

      {template.map((t, i) => (
        <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Pressable onPress={() => toggleState(t.id)} style={{
            width: 46, paddingVertical: 4, borderRadius: 5, alignItems: 'center',
            borderWidth: 1, borderColor: `${stateColor(t.state)}66`, backgroundColor: `${stateColor(t.state)}22`,
          }}>
            <Text style={{ color: stateColor(t.state), fontFamily: FONT_MONO, fontSize: 11, fontWeight: '700' }}>{t.state}</Text>
          </Pressable>
          <TextInput
            value={String(t.durationMin)}
            onChangeText={txt => update(t.id, parseInt(txt || '0', 10))}
            keyboardType="numeric"
            style={{
              width: 64, backgroundColor: C.panelDeep, borderWidth: 1, borderColor: C.border, borderRadius: 5,
              color: C.textPrimary, fontFamily: FONT_MONO, fontSize: 12, paddingVertical: 5, paddingHorizontal: 7,
            }}
          />
          <Text style={{ fontSize: 10, color: C.textMuted, width: 28, fontFamily: FONT_SANS }}>min</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => move(i, -1)} disabled={i === 0} hitSlop={8}>
            <Text style={{ color: i === 0 ? C.textMuted : C.textSecondary, fontSize: 13 }}>↑</Text>
          </Pressable>
          <Pressable onPress={() => move(i, 1)} disabled={i === template.length - 1} hitSlop={8}>
            <Text style={{ color: i === template.length - 1 ? C.textMuted : C.textSecondary, fontSize: 13 }}>↓</Text>
          </Pressable>
          <Pressable onPress={() => remove(t.id)} hitSlop={8}>
            <Text style={{ color: C.negative, fontSize: 13 }}>✕</Text>
          </Pressable>
        </View>
      ))}

      <Btn onClick={add} small fullWidth color={C.on} textColor={C.on}>+ Add State</Btn>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Growatt Simulator
// ════════════════════════════════════════════════════════════════════════════
function GrowattSimulator({
  world, onForce, onAdvance, onReset,
}: {
  world: SimWorld; onForce: (s: 'ON' | 'OFF') => void; onAdvance: (min: number) => void;
  onReset: () => void;
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

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn onClick={() => onForce('ON')} color={C.on} textColor={C.on}>Force ON</Btn>
        <Btn onClick={() => onForce('OFF')} color={C.off} textColor={C.off}>Force OFF</Btn>
        <Btn onClick={onReset} color={C.negative} textColor={C.negative}>Reset All</Btn>
      </View>
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Btn small onClick={() => onAdvance(15)}>+15m</Btn>
        <Btn small onClick={() => onAdvance(30)}>+30m</Btn>
        <Btn small onClick={() => onAdvance(60)}>+1h</Btn>
        <Btn small onClick={() => onAdvance(180)}>+3h</Btn>
        <Btn small onClick={() => onAdvance(360)}>+6h</Btn>
      </View>
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
  const verificationWindowActive = r.atc.mode === 'POSITIVE_OFFSET_PENDING' || r.atc.inValidationWindow;

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
      <StatRow label="Verification Window Active" value={verificationWindowActive ? 'YES' : 'no'} valueColor={verificationWindowActive ? C.positive : C.textMuted} />
      {r.atc.statusLine && (
        <View style={{ marginTop: 10, padding: 8, backgroundColor: `${modeColor(r.atc.mode)}15`, borderWidth: 1, borderColor: `${modeColor(r.atc.mode)}40`, borderRadius: 6 }}>
          <Text style={{ fontSize: 11, color: modeColor(r.atc.mode), textAlign: 'right', writingDirection: 'rtl' }}>{r.atc.statusLine}</Text>
        </View>
      )}
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Mode Selector
// ════════════════════════════════════════════════════════════════════════════
function ModeSelector({ world, onChange }: { world: SimWorld; onChange: (m: 'AUTO' | 'MANUAL') => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
      <Text style={{ fontSize: 10, color: C.textMuted, marginRight: 2, fontFamily: FONT_MONO }}>④ MODE</Text>
      {(['AUTO', 'MANUAL'] as const).map(m => {
        const active = world.transitionMode === m;
        return (
          <Pressable key={m} onPress={() => onChange(m)} style={{
            paddingVertical: 6, paddingHorizontal: 14, borderRadius: 7,
            borderWidth: 1, borderColor: active ? C.positive : C.border,
            backgroundColor: active ? `${C.positive}22` : 'transparent',
          }}>
            <Text style={{ fontSize: 11.5, fontWeight: '700', fontFamily: FONT_MONO, color: active ? C.positive : C.textSecondary }}>{m}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Report Simulator
// ════════════════════════════════════════════════════════════════════════════
function ReportSimulator({ onAction }: { onAction: (state: 'ON' | 'OFF', kind: 'report' | 'confirm') => void }) {
  return (
    <Panel title="⑤ REPORT SIMULATOR" subtitle="Confirm looks up an existing report and bumps confidence only — it never creates its own transition" accent={C.generated}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8 }}>
        <View style={{ width: '48%' }}><Btn onClick={() => onAction('ON', 'report')} color={C.on} textColor={C.on} fullWidth>Report ON</Btn></View>
        <View style={{ width: '48%' }}><Btn onClick={() => onAction('OFF', 'report')} color={C.off} textColor={C.off} fullWidth>Report OFF</Btn></View>
        <View style={{ width: '48%' }}><Btn onClick={() => onAction('ON', 'confirm')} color={C.on} textColor={C.on} fullWidth>Confirm ON</Btn></View>
        <View style={{ width: '48%' }}><Btn onClick={() => onAction('OFF', 'confirm')} color={C.off} textColor={C.off} fullWidth>Confirm OFF</Btn></View>
      </View>
      <Text style={{ fontSize: 10, color: C.textMuted, marginTop: 8, lineHeight: 15 }}>
        Confirm = community confirmation of an existing report (uses the original report's timestamp — see Ledger panel below). If no matching report exists, a "bare" confirmation is itself treated as authoritative (Scenario Group C).
      </Text>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Generated State Analyzer
// ════════════════════════════════════════════════════════════════════════════
function GeneratedStateAnalyzer({ world }: { world: SimWorld }) {
  const meta = world.lastResult?.communityTransitionMeta;
  const activeReport = world.resyncPoint
    ? world.reports.find(r => r.state === world.resyncPoint!.syncedState && r.originalReportAtIso === world.resyncPoint!.syncedAtIso)
    : undefined;
  if (!meta) {
    return (
      <Panel title="⑥ GENERATED STATE ANALYZER" accent={C.generated}>
        <Text style={{ fontSize: 11.5, color: C.textMuted, textAlign: 'center', paddingVertical: 10 }}>No active resync — submit a report or confirmation to create a generated state.</Text>
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
      <StatRow label="Originating Event" value={activeReport ? (activeReport.confirmations.length > 0 ? `Report (+${activeReport.confirmations.length} confirmation${activeReport.confirmations.length > 1 ? 's' : ''})` : 'Report (unconfirmed)') : (world.resyncPoint ? 'Report/Confirmation' : '—')} />
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6B — Confidence & Community Confirmation Ledger (spec panels ⑯/⑰)
// ════════════════════════════════════════════════════════════════════════════
const trustColor = (t: TrustLevel) => (t === 'VERIFIED' ? C.on : t === 'HIGH' ? C.positive : t === 'MEDIUM' ? C.uncertain : C.textMuted);

function ConfidenceConfirmationLedger({ world }: { world: SimWorld }) {
  const reports = [...world.reports].sort((a, b) => new Date(b.originalReportAtIso).getTime() - new Date(a.originalReportAtIso).getTime());
  const activeReport = world.resyncPoint
    ? world.reports.find(r => r.state === world.resyncPoint!.syncedState && r.originalReportAtIso === world.resyncPoint!.syncedAtIso)
    : undefined;

  return (
    <Panel
      title="⑯ CONFIDENCE & COMMUNITY CONFIRMATION LEDGER"
      subtitle="Confirmation Timestamp Rule — confirmations affect ONLY confidence, never the transition"
      accent={C.positive}
      collapsible
      defaultOpen={true}
      badge={<Badge color={C.positive}>{reports.length} report{reports.length === 1 ? '' : 's'}</Badge>}
    >
      {activeReport && (
        <View style={{ marginBottom: 12, padding: 9, backgroundColor: `${trustColor(activeReport.trustLevel)}12`, borderWidth: 1, borderColor: `${trustColor(activeReport.trustLevel)}45`, borderRadius: 6 }}>
          <Text style={{ fontSize: 10, color: C.textMuted, marginBottom: 4, fontWeight: '700', letterSpacing: 0.3 }}>ACTIVE REPORT (drives current generated state)</Text>
          <StatRow label="Original Report Timestamp" value={fmtClock(activeReport.originalReportAtIso)} valueColor={C.generated} />
          <StatRow label="Processed" value={activeReport.processedAtIso ? `YES — ${fmtClock(activeReport.processedAtIso)}` : 'NO (pending — unprocessed report)'} valueColor={activeReport.processedAtIso ? C.on : C.uncertain} />
          <StatRow label="Confidence Score" value={`${activeReport.confidenceScore} / 100`} valueColor={trustColor(activeReport.trustLevel)} />
          <StatRow label="Trust Level" value={activeReport.trustLevel} valueColor={trustColor(activeReport.trustLevel)} />
          <StatRow label="Confirmations Received" value={activeReport.confirmations.length} />
          {activeReport.confirmations.length > 0 && (
            <View style={{ marginTop: 6 }}>
              {activeReport.confirmations.map((c, i) => (
                <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, borderTopWidth: 1, borderTopColor: C.border }}>
                  <Text style={{ fontSize: 10, color: C.textSecondary }}>#{i + 1} {c.confirmerName ?? 'confirmer'}</Text>
                  <Text style={{ fontSize: 10, color: C.textSecondary, fontFamily: FONT_MONO }}>{c.hoursAfterReport.toFixed(1)}h after report</Text>
                  <Text style={{ fontSize: 10, color: C.positive, fontFamily: FONT_MONO }}>conf→{c.confidenceScoreAfter}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={{ fontSize: 10, color: C.textMuted, marginTop: 8, lineHeight: 15 }}>
            Generated state start, offset, and duration above are ALL still anchored to{' '}
            <Text style={{ color: C.generated, fontFamily: FONT_MONO }}>{fmtClock(activeReport.originalReportAtIso)}</Text> — the original report time — never any confirmation's own timestamp, no matter how many confirmations arrived or how late.
          </Text>
        </View>
      )}

      <Text style={{ fontSize: 10.5, color: C.textMuted, marginTop: 4, marginBottom: 6, fontWeight: '700' }}>FULL PERSISTENT REPORT LEDGER (never cleared — Rule 2)</Text>
      <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
        {reports.length === 0 && <Text style={{ fontSize: 11, color: C.textMuted, textAlign: 'center', paddingVertical: 12 }}>No reports submitted yet this session.</Text>}
        {reports.map(r => (
          <View key={r.id} style={{
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 8, marginBottom: 3,
            backgroundColor: C.panelDeep, borderRadius: 5, borderWidth: 1, borderColor: C.border,
          }}>
            <Text style={{ color: stateColor(r.state), fontFamily: FONT_MONO, fontWeight: '700', width: 32, fontSize: 10.5 }}>{r.state}</Text>
            <Text style={{ color: C.textMuted, fontFamily: FONT_MONO, flex: 1, fontSize: 10.5 }}>{fmtClock(r.originalReportAtIso)}</Text>
            <Text style={{ color: C.textSecondary, width: 50, textAlign: 'right', fontSize: 10.5 }}>{r.confirmations.length}✓</Text>
            <Badge color={trustColor(r.trustLevel)}>{r.confidenceScore}</Badge>
          </View>
        ))}
      </ScrollView>
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
        <Text style={{ fontSize: 11.5, color: C.textMuted, textAlign: 'center', paddingVertical: 10 }}>No active resync — submit a report or confirmation to see Rule 3 duration selection.</Text>
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
      <Text style={{ fontSize: 10.5, color: C.textMuted, marginVertical: 6, lineHeight: 16 }}>{ruleLabel[meta.durationSelectionRule]}</Text>
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
        <Text style={{ fontSize: 11.5, color: C.textMuted, textAlign: 'center', paddingVertical: 10 }}>No active resync — submit a report or confirmation to see Rule 4/5 offset calculation.</Text>
      </Panel>
    );
  }
  return (
    <Panel title="⑧ OFFSET CALCULATION INSPECTOR" accent={signColor(meta.offsetSign)} badge={<Badge color={signColor(meta.offsetSign)}>{meta.offsetSign}</Badge>}>
      <StatRow label="Reference Kind" value={meta.offsetReferenceKind ?? '(frozen — not re-derived)'} />
      <StatRow label="Reference Time" value={fmtClock(meta.offsetReferenceIso)} />
      <StatRow label="Generated State Start" value={fmtClock(meta.generatedCycleStartIso)} />
      <View style={{ marginVertical: 10, padding: 9, backgroundColor: C.panelDeep, borderWidth: 1, borderColor: C.border, borderRadius: 6 }}>
        <Text style={{ fontSize: 11, fontFamily: FONT_MONO, color: C.textSecondary, lineHeight: 19 }}>Offset = GeneratedStateStart − ReferenceGrowattTime</Text>
        <Text style={{ fontSize: 11, fontFamily: FONT_MONO, color: C.textSecondary, lineHeight: 19 }}>Offset = {fmtClock(meta.generatedCycleStartIso)} − {fmtClock(meta.offsetReferenceIso)}</Text>
        <Text style={{ fontSize: 11, fontFamily: FONT_MONO, color: C.textSecondary, lineHeight: 19 }}>
          Offset = <Text style={{ color: signColor(meta.offsetSign), fontWeight: '700' }}>{meta.offsetMinutes > 0 ? '+' : ''}{meta.offsetMinutes}m</Text>
        </Text>
      </View>
      <StatRow label="Calculated Offset" value={`${meta.offsetMinutes > 0 ? '+' : ''}${meta.offsetMinutes}m`} valueColor={signColor(meta.offsetSign)} />
      <StatRow label="Offset Type" value={meta.offsetSign} valueColor={signColor(meta.offsetSign)} />
      <Text style={{ fontSize: 10.5, color: C.textMuted, marginTop: 8, lineHeight: 16 }}>
        {meta.offsetSign === 'POSITIVE' && 'Reason: generated timeline started AFTER the Growatt reference — user is behind Growatt.'}
        {meta.offsetSign === 'NEGATIVE' && 'Reason: generated timeline started BEFORE the Growatt reference — user is ahead of Growatt.'}
        {meta.offsetSign === 'NEUTRAL' && 'Reason: generated timeline start exactly matches the Growatt reference.'}
      </Text>
      {!meta.isFreshOffsetComputation && (
        <Text style={{ marginTop: 8, fontSize: 10, color: C.textMuted, fontStyle: 'italic' }}>
          ⓘ Frozen value reused (Q2-A) — reference detail only shown at the moment of original computation.
        </Text>
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
        <Text style={{ fontSize: 11.5, color: C.textMuted, textAlign: 'center', paddingVertical: 10 }}>No decisions traced yet.</Text>
      </Panel>
    );
  }
  return (
    <Panel title="⑨ TRANSITION DECISION INSPECTOR" subtitle="Step-by-step engine trace for the active resync" accent={C.borderLight}>
      {trace.map(step => (
        <View key={step.step} style={{ flexDirection: 'row', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <View style={{
            width: 22, height: 22, borderRadius: 11, backgroundColor: C.panelDeep, borderWidth: 1, borderColor: C.borderLight,
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Text style={{ fontSize: 10, fontFamily: FONT_MONO, color: C.textSecondary }}>{step.step}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11.5, fontWeight: '700', color: C.textPrimary }}>{step.label}</Text>
            <Text style={{ fontSize: 10.5, color: C.textMuted, marginTop: 1 }}>{step.detail}</Text>
          </View>
        </View>
      ))}
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Timeline Visualization (signature element, react-native-svg)
// ════════════════════════════════════════════════════════════════════════════
function TimelineViz({ world }: { world: SimWorld }) {
  const r = world.lastResult;
  const blinkOn = useBlink();
  const uncertainPulse = usePulse(r?.atc.mode === 'UNCERTAIN_ZONE');
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
      <View style={{ backgroundColor: C.panelDeep, borderRadius: 8, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={170}>
          {/* Track labels */}
          <SvgText x={6} y={26} fontSize={9} fill={C.textMuted} fontFamily={FONT_MONO}>GROWATT</SvgText>
          <SvgText x={6} y={96} fontSize={9} fill={C.textMuted} fontFamily={FONT_MONO}>USER</SvgText>

          {/* Growatt track (single segment showing current state since last transition) */}
          <Rect x={Math.max(0, growattX)} y={34} width={Math.max(0, W - Math.max(0, growattX))} height={26} fill={stateColor(world.growattCurrentState)} opacity={0.35} rx={3} />
          <SvgText x={Math.max(4, growattX + 4)} y={51} fontSize={10} fill={stateColor(world.growattCurrentState)} fontFamily={FONT_MONO} fontWeight="700">{world.growattCurrentState}</SvgText>

          {/* User track — render each schedule slot */}
          {slots.map((s, i) => {
            const x1 = Math.max(0, xOf(new Date(s.startIso).getTime()));
            const x2 = Math.min(W, xOf(s.endIso ? new Date(s.endIso).getTime() : endMs));
            const isGen = (s as any).isResynced;
            const fill = isGen ? C.generated : stateColor(s.state);
            return (
              <G key={i}>
                <Rect x={x1} y={104} width={Math.max(1, x2 - x1)} height={26} fill={fill} opacity={isGen ? 0.55 : 0.32} rx={3}
                  stroke={isGen ? C.generated : 'none'} strokeWidth={isGen ? 1.5 : 0} strokeDasharray={isGen ? '3,2' : undefined} />
                {x2 - x1 > 38 && <SvgText x={x1 + 4} y={121} fontSize={9} fill={fill} fontFamily={FONT_MONO}>{s.state}{isGen ? '★' : ''}</SvgText>}
              </G>
            );
          })}

          {/* UNCERTAIN_ZONE / mode indicator band — pulses via Animated opacity */}
          {r.atc.mode === 'UNCERTAIN_ZONE' && (
            <AnimatedRect x={Math.max(0, nowX - 60)} y={104} width={60} height={26} fill={C.negative} opacity={uncertainPulse as any} rx={3} />
          )}

          {/* Now cursor — blinks via boolean toggle */}
          <Line x1={nowX} y1={10} x2={nowX} y2={H - 10} stroke={C.textPrimary} strokeWidth={1.5} strokeDasharray="3,3" opacity={blinkOn ? 1 : 0.15} />
          <SvgText x={nowX + 4} y={142} fontSize={9} fill={C.textPrimary} fontFamily={FONT_MONO}>NOW</SvgText>
        </Svg>
      </View>
      <View style={{ flexDirection: 'row', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
        <LegendDot color={C.on} label="ON" /><LegendDot color={C.off} label="OFF" />
        <LegendDot color={C.generated} label="Generated (★)" />
        <LegendDot color={C.negative} label="UNCERTAIN_ZONE" />
      </View>
    </Panel>
  );
}
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
      <Text style={{ fontSize: 10, color: C.textMuted }}>{label}</Text>
    </View>
  );
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
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
        <Btn small onClick={onJumpToOverrun} color={C.uncertain} textColor={C.uncertain}>Jump to Overrun (+25m past cycle end)</Btn>
      </View>
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
        <Btn small onClick={() => onForceExit('ON')} color={C.on} textColor={C.on}>Exit via Growatt → ON</Btn>
        <Btn small onClick={() => onForceExit('OFF')} color={C.off} textColor={C.off}>Exit via Growatt → OFF</Btn>
      </View>
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
      <Text style={{ fontSize: 10.5, color: C.textMuted, marginTop: 10, marginBottom: 6, fontWeight: '700' }}>FUTURE STATES (expected progression)</Text>
      {upcoming.map((s, i) => (
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
          <Text style={{ color: stateColor(s.state), fontFamily: FONT_MONO, fontWeight: '700', fontSize: 11 }}>{s.state}</Text>
          <Text style={{ color: C.textMuted, fontFamily: FONT_MONO, fontSize: 11 }}>{fmtClock(s.startIso)} → {fmtClock(s.endIso)}</Text>
          <Text style={{ color: C.textSecondary, fontSize: 11 }}>{s.durationLabel}</Text>
        </View>
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
      <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
        {history.map((s, i) => {
          const isGen = (s as any).isResynced;
          return (
            <View key={i} style={{
              flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, paddingHorizontal: 8, marginBottom: 3,
              backgroundColor: isGen ? `${C.generated}15` : 'transparent', borderRadius: 5,
              borderWidth: 1, borderColor: isGen ? `${C.generated}40` : 'transparent',
            }}>
              <Text style={{ color: stateColor(s.state), fontFamily: FONT_MONO, fontWeight: '700', fontSize: 10.5 }}>{s.state}</Text>
              <Text style={{ color: C.textMuted, fontFamily: FONT_MONO, fontSize: 10.5 }}>{fmtClock(s.startIso)}</Text>
              {isGen && <Badge color={C.generated}>GENERATED</Badge>}
              {(s as any).isEstimated && !isGen && <Badge color={C.textMuted}>estimated</Badge>}
            </View>
          );
        })}
      </ScrollView>
      <Text style={{ fontSize: 10, color: C.textMuted, marginTop: 8 }}>
        Showing last {history.length} historical slots. Mode changes, offsets, and resync events are in the Event Log (⑮).
      </Text>
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
      <ScrollView style={{ maxHeight: 360, marginTop: 10 }} nestedScrollEnabled>
        {SCENARIOS.map(sc => {
          const res = results[sc.id];
          return (
            <View key={sc.id} style={{ paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 11, fontWeight: '600', color: C.textPrimary, flex: 1 }}>#{sc.id} {sc.name}</Text>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  {res && <Badge color={res.pass ? C.on : C.error}>{res.pass ? 'PASS' : 'FAIL'}</Badge>}
                  <Pressable onPress={() => onRun(sc.id)} style={{ borderWidth: 1, borderColor: C.border, borderRadius: 5, paddingVertical: 3, paddingHorizontal: 8 }}>
                    <Text style={{ color: C.textSecondary, fontSize: 10 }}>Run</Text>
                  </Pressable>
                  {res && (
                    <Pressable onPress={() => onLoadWorld(res.world)} style={{ borderWidth: 1, borderColor: C.border, borderRadius: 5, paddingVertical: 3, paddingHorizontal: 8 }}>
                      <Text style={{ color: C.positive, fontSize: 10 }}>Inspect</Text>
                    </Pressable>
                  )}
                </View>
              </View>
              {res && (
                <FadeIn style={{ marginTop: 4 }}>
                  <Text style={{ fontSize: 10, color: C.textMuted, fontFamily: FONT_MONO }}>expected: {res.expected}</Text>
                  <Text style={{ fontSize: 10, color: C.textMuted, fontFamily: FONT_MONO }}>actual: {res.actual}</Text>
                </FadeIn>
              )}
            </View>
          );
        })}
      </ScrollView>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 14B — Master TMMS V2 Spec Validator (Scenario Groups A-K, 50 cases)
// ════════════════════════════════════════════════════════════════════════════
function SpecScenarioRunner({
  results, onRunAll, onLoadWorld,
}: {
  results: Record<string, SpecScenarioResult>; onRunAll: () => void; onLoadWorld: (w: SimWorld) => void;
}) {
  const groups = useMemo(() => {
    const order: string[] = [];
    for (const sc of SPEC_SCENARIOS) if (!order.includes(sc.group)) order.push(sc.group);
    return order;
  }, []);
  const passCount = Object.values(results).filter(r => r.pass).length;
  const ranCount = Object.keys(results).length;
  const allPass = ranCount === SPEC_SCENARIOS.length && passCount === SPEC_SCENARIOS.length;

  return (
    <Panel
      title="⑭ᴮ MASTER TMMS V2 SPEC VALIDATOR"
      subtitle="50 scenarios · Groups A-K · the literal spec scenario set, against the Master Test Schedule"
      accent={C.positive}
      badge={ranCount > 0 ? <Badge color={allPass ? C.on : C.uncertain} glow={allPass}>{passCount}/{SPEC_SCENARIOS.length} PASS</Badge> : undefined}
    >
      <Btn onClick={onRunAll} fullWidth color={C.positive} textColor={C.positive}>▶ Run All 50 Spec Scenarios (A–K)</Btn>
      <ScrollView style={{ maxHeight: 480, marginTop: 10 }} nestedScrollEnabled>
        {groups.map(group => {
          const scs = SPEC_SCENARIOS.filter(s => s.group === group);
          const groupPass = scs.filter(s => results[s.id]?.pass).length;
          const groupRan = scs.filter(s => results[s.id] !== undefined).length;
          return (
            <View key={group} style={{ marginBottom: 6 }}>
              <View style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingVertical: 6, paddingHorizontal: 4, borderTopWidth: 1, borderTopColor: C.border, marginTop: 4,
              }}>
                <Text style={{ fontSize: 10.5, fontWeight: '700', color: C.textSecondary }}>{group}</Text>
                {groupRan > 0 && <Badge color={groupPass === scs.length ? C.on : C.uncertain}>{groupPass}/{scs.length}</Badge>}
              </View>
              {scs.map(sc => {
                const res = results[sc.id];
                return (
                  <View key={sc.id} style={{ paddingVertical: 6, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: C.border }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <Text style={{ fontSize: 10.5, fontWeight: '600', color: C.textPrimary, flex: 1 }}>{sc.id} — {sc.name}</Text>
                      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                        {res && <Badge color={res.pass ? C.on : C.error}>{res.pass ? 'PASS' : 'FAIL'}</Badge>}
                        {res && (
                          <Pressable onPress={() => onLoadWorld(res.world)} style={{ borderWidth: 1, borderColor: C.border, borderRadius: 5, paddingVertical: 2, paddingHorizontal: 7 }}>
                            <Text style={{ color: C.positive, fontSize: 9.5 }}>Inspect</Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                    {res && (
                      <FadeIn style={{ marginTop: 3 }}>
                        <Text style={{ fontSize: 9.5, color: C.textMuted, fontFamily: FONT_MONO }}>expected: {res.expected}</Text>
                        <Text style={{ fontSize: 9.5, color: C.textMuted, fontFamily: FONT_MONO }}>actual: {res.actual}</Text>
                      </FadeIn>
                    )}
                  </View>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
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
  const reversed = useMemo(() => [...events].reverse(), [events]);
  return (
    <Panel
      title="⑮ DEBUG EVENT LOG"
      subtitle={`${events.length} events`}
      accent={C.borderLight}
      badge={
        <Pressable onPress={onClear} style={{ borderWidth: 1, borderColor: C.border, borderRadius: 5, paddingVertical: 3, paddingHorizontal: 8 }}>
          <Text style={{ color: C.textMuted, fontSize: 10 }}>Clear</Text>
        </Pressable>
      }
    >
      <ScrollView style={{ maxHeight: 420 }} nestedScrollEnabled>
        {reversed.map(ev => (
          <FadeIn key={ev.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'baseline' }}>
              <Text style={{ fontSize: 9.5, color: C.textMuted, flexShrink: 0, fontFamily: FONT_MONO }}>{fmtClock(ev.simTimeIso)}</Text>
              <Text style={{ fontSize: 11, color: eventKindColor[ev.kind], fontWeight: '700', fontFamily: FONT_MONO }}>{ev.action}</Text>
            </View>
            {ev.result && <Text style={{ fontSize: 10, color: C.textSecondary, marginLeft: 4, marginTop: 2, fontFamily: FONT_MONO }}>→ {ev.result}</Text>}
          </FadeIn>
        ))}
        {events.length === 0 && <Text style={{ fontSize: 11, color: C.textMuted, textAlign: 'center', paddingVertical: 20 }}>No events yet.</Text>}
      </ScrollView>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════
export default function TMMSDebugSimulator({ initialWorld }: { initialWorld?: SimWorld } = {}) {
  const { width } = useWindowDimensions();
  const isWide = width >= 1000; // matches the web version's 1100px breakpoint, adjusted for RN's narrower default chrome

  const [world, setWorld] = useState<SimWorld>(() => initialWorld ?? createInitialWorld());
  const [scenarioResults, setScenarioResults] = useState<Record<number, ScenarioResult>>({});
  const [specResults, setSpecResults] = useState<Record<string, SpecScenarioResult>>({});

  const handleForce = useCallback((s: 'ON' | 'OFF') => setWorld(w => forceGrowattState(w, s)), []);
  const handleAdvance = useCallback((min: number) => setWorld(w => advanceTime(w, min)), []);
  const handleReset = useCallback(() => { setWorld(resetWorld()); setScenarioResults({}); setSpecResults({}); }, []);
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
  const handleRunAllSpec = useCallback(() => {
    const results: Record<string, SpecScenarioResult> = {};
    for (const sc of SPEC_SCENARIOS) results[sc.id] = sc.run();
    setSpecResults(results);
  }, []);
  const handleLoadWorld = useCallback((w: SimWorld) => setWorld(w), []);
  const handleClearLog = useCallback(() => setWorld(w => ({ ...w, eventLog: [] })), []);

  const r = world.lastResult;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 10 }}>
        <View>
          <Text style={{ fontSize: 17, fontWeight: '800', letterSpacing: 0.5, color: C.textPrimary, fontFamily: FONT_SANS }}>
            TMMS V2 <Text style={{ color: C.uncertain }}>DEBUG SIMULATOR</Text>
          </Text>
          <Text style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2 }}>
            Development tool only · drives the real engine, not a mock · 50 spec scenarios (A–K) + 15 mechanism tests
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {r && <Badge color={modeColor(r.atc.mode)} glow={r.atc.mode === 'UNCERTAIN_ZONE'}>{r.atc.mode}</Badge>}
          <ModeSelector world={world} onChange={handleModeChange} />
          <Btn onClick={handleReset} color={C.negative} textColor={C.negative} small>⟲ Reset</Btn>
        </View>
      </View>

      {/* Responsive layout: 3 columns side-by-side when wide enough, stacked otherwise */}
      <View style={{ flexDirection: isWide ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
        {/* LEFT: controls */}
        <View style={{ width: isWide ? 300 : '100%' }}>
          <ScheduleBuilder world={world} onChange={handleScheduleChange} />
          <GrowattSimulator world={world} onForce={handleForce} onAdvance={handleAdvance} onReset={handleReset} />
          <ReportSimulator onAction={handleReportAction} />
        </View>

        {/* CENTER: visualization + inspectors */}
        <View style={{ flex: isWide ? 1 : undefined, width: isWide ? undefined : '100%' }}>
          <TimelineViz world={world} />
          <UserTimelineSimulator world={world} />
          <GeneratedStateAnalyzer world={world} />
          <ConfidenceConfirmationLedger world={world} />
          <DurationSelectionInspector world={world} />
          <OffsetCalculationInspector world={world} />
          <TransitionDecisionInspector world={world} />
          <UncertainZoneSimulator world={world} onForceExit={handleForce} onJumpToOverrun={handleJumpToOverrun} />
          <ScheduleContinuityInspector world={world} />
          <PersistentTimelineInspector world={world} />
        </View>

        {/* RIGHT: scenario runners + event log */}
        <View style={{ width: isWide ? 320 : '100%' }}>
          <SpecScenarioRunner results={specResults} onRunAll={handleRunAllSpec} onLoadWorld={handleLoadWorld} />
          <ScenarioRunner results={scenarioResults} onRun={handleRunScenario} onRunAll={handleRunAll} onLoadWorld={handleLoadWorld} />
          <DebugEventLog events={world.eventLog} onClear={handleClearLog} />
        </View>
      </View>
    </ScrollView>
  );
}
