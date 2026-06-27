/**
 * app/(admin)/simulator.tsx
 * ════════════════════════════════════════════════════════════════════════════
 * NATIVE fallback for the /simulator admin route.
 *
 * Expo Router picks `simulator.web.tsx` on web and this file on iOS/Android.
 * TMMSDebugSimulator uses raw HTML elements (div / style / svg) which are
 * web-only and cannot render in the native React Native renderer, so we
 * show an informational screen instead.
 *
 * To inspect the TMMS engine on-device, open the app in a browser
 * (Expo web target) and navigate to /simulator.
 * ════════════════════════════════════════════════════════════════════════════
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';

export default function SimulatorNativeFallback() {
  return (
    <ScrollView
      contentContainerStyle={styles.container}
      style={styles.scroll}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={styles.ledOn} />
        <Text style={styles.title}>TMMS V2 DEBUG SIMULATOR</Text>
      </View>
      <Text style={styles.subtitle}>Development tool · drives the real engine, not a mock</Text>

      {/* Notice */}
      <View style={styles.noticeBg}>
        <Text style={styles.noticeTitle}>⚠  Web-only tool</Text>
        <Text style={styles.noticeBody}>
          The Debug Simulator uses SVG, CSS animations, and HTML canvas — all
          web-only APIs.  It cannot render in the iOS or Android native renderer.
        </Text>
      </View>

      {/* Instructions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>How to open on web</Text>
        <View style={styles.row}>
          <Text style={styles.step}>1</Text>
          <Text style={styles.stepText}>Start the Expo dev server with web support:</Text>
        </View>
        <View style={styles.codeBg}>
          <Text style={styles.code}>npx expo start --web</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.step}>2</Text>
          <Text style={styles.stepText}>Open a browser and navigate to:</Text>
        </View>
        <View style={styles.codeBg}>
          <Text style={styles.code}>http://localhost:8081/simulator</Text>
        </View>
      </View>

      {/* What you can verify */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>What the simulator validates</Text>
        {[
          '① Schedule Builder — define ON/OFF pattern',
          '② Growatt Simulator — advance clock, force state',
          '③ User Timeline — live ATC state from real engine',
          '④ AUTO / MANUAL mode switching',
          '⑤ Report & Confirmation — same code as community.tsx',
          '⑥ Generated State Analyzer — duration & start time',
          '⑦ Duration Selection Inspector — 50% rule / ON rule',
          '⑧ Offset Calculation Inspector — POSITIVE/NEGATIVE/NEUTRAL',
          '⑨ Transition Decision Inspector — step-by-step trace',
          '⑩ Timeline Visualization — Growatt vs User tracks',
          '⑪ UNCERTAIN_ZONE Simulator — overrun + exit paths',
          '⑫ Schedule Continuity Inspector — future states',
          '⑬ Persistent Timeline Inspector — generated states',
          '⑭ Scenario Runner — 15 automated TMMS V2 scenarios',
          '⑮ Debug Event Log — full action trace',
        ].map((item, i) => (
          <View key={i} style={styles.bulletRow}>
            <View style={styles.bullet} />
            <Text style={styles.bulletText}>{item}</Text>
          </View>
        ))}
      </View>

      {/* Architecture note */}
      <View style={styles.archBg}>
        <Text style={styles.archTitle}>Architecture</Text>
        <Text style={styles.archLine}>
          {'simulator.web.tsx\n  → TMMSDebugSimulator\n      → tmmsSimulation\n          → tmmsEngine (same engine as production)'}
        </Text>
        <Text style={styles.archNote}>
          Every scenario in the simulator runs against the exact same
          applyOffsetToPrediction() call that index.tsx, schedule.tsx, and
          community.tsx use via useUserPredictions.ts.
        </Text>
      </View>
    </ScrollView>
  );
}

const BG       = '#0A0E12';
const PANEL    = '#12181F';
const BORDER   = '#212A34';
const TEXT     = '#E4E9EE';
const MUTED    = '#8893A0';
const DIM      = '#525C68';
const GREEN    = '#3DDC84';
const BLUE     = '#4FA8FF';
const ORANGE   = '#FFB84D';
const MONO     = 'monospace';

const styles = StyleSheet.create({
  scroll:       { flex: 1, backgroundColor: BG },
  container:    { padding: 20, paddingBottom: 48 },
  headerRow:    { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  ledOn:        { width: 10, height: 10, borderRadius: 5, backgroundColor: GREEN, marginRight: 10 },
  title:        { fontSize: 18, fontWeight: '800', color: TEXT, letterSpacing: 0.5 },
  subtitle:     { fontSize: 12, color: DIM, marginBottom: 20 },

  noticeBg:     { backgroundColor: `${ORANGE}18`, borderWidth: 1, borderColor: `${ORANGE}55`, borderRadius: 10, padding: 14, marginBottom: 20 },
  noticeTitle:  { fontSize: 14, fontWeight: '700', color: ORANGE, marginBottom: 6 },
  noticeBody:   { fontSize: 13, color: MUTED, lineHeight: 20 },

  section:      { backgroundColor: PANEL, borderRadius: 10, borderWidth: 1, borderColor: BORDER, padding: 14, marginBottom: 14 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: TEXT, marginBottom: 12 },
  row:          { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  step:         { width: 22, height: 22, borderRadius: 11, backgroundColor: `${BLUE}22`, color: BLUE, fontFamily: MONO, fontSize: 11, fontWeight: '700', textAlign: 'center', lineHeight: 22, marginRight: 8, overflow: 'hidden' },
  stepText:     { flex: 1, fontSize: 13, color: MUTED, lineHeight: 20 },
  codeBg:       { backgroundColor: '#0D1116', borderRadius: 6, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: BORDER },
  code:         { fontFamily: MONO, fontSize: 13, color: GREEN },

  bulletRow:    { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  bullet:       { width: 5, height: 5, borderRadius: 2.5, backgroundColor: BLUE, marginTop: 7, marginRight: 10 },
  bulletText:   { flex: 1, fontSize: 12.5, color: MUTED, lineHeight: 19, fontFamily: MONO },

  archBg:       { backgroundColor: `${BLUE}10`, borderRadius: 10, borderWidth: 1, borderColor: `${BLUE}30`, padding: 14 },
  archTitle:    { fontSize: 12, fontWeight: '700', color: BLUE, marginBottom: 8, letterSpacing: 0.5 },
  archLine:     { fontFamily: MONO, fontSize: 11.5, color: TEXT, lineHeight: 19, marginBottom: 10 },
  archNote:     { fontSize: 12, color: MUTED, lineHeight: 18 },
});
