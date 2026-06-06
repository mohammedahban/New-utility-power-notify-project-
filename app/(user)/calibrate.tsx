
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUserOffset } from '../../hooks/useUserOffset';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useMyReliability, getReliabilityBadge } from '../../hooks/useReliability';

const T = {
  bg: '#0a0f1e',
  surface: '#0f172a',
  elevated: '#1e293b',
  border: '#334155',
  primary: '#3b82f6',
  accent: '#38bdf8',
  textPrimary: '#f1f5f9',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
};

// ── Time Picker ───────────────────────────────────────────────────────────────
function TimePicker({
  hour, minute, onChangeHour, onChangeMinute,
}: {
  hour: number; minute: number;
  onChangeHour: (h: number) => void;
  onChangeMinute: (m: number) => void;
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);

  const fmtH = (h: number) => {
    const ampm = h < 12 ? 'AM' : 'PM';
    const d = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${d}:00 ${ampm}`;
  };

  return (
    <View style={tpStyles.container}>
      <View style={tpStyles.col}>
        <Text style={tpStyles.colLabel}>HOUR</Text>
        <ScrollView style={tpStyles.scroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {hours.map(h => (
            <TouchableOpacity
              key={h}
              style={[tpStyles.item, hour === h && tpStyles.itemActive]}
              onPress={() => onChangeHour(h)}
            >
              <Text style={[tpStyles.itemText, hour === h && tpStyles.itemTextActive]}>{fmtH(h)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
      <View style={tpStyles.col}>
        <Text style={tpStyles.colLabel}>MINUTE</Text>
        <ScrollView style={tpStyles.scroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {minutes.map(m => (
            <TouchableOpacity
              key={m}
              style={[tpStyles.item, minute === m && tpStyles.itemActive]}
              onPress={() => onChangeMinute(m)}
            >
              <Text style={[tpStyles.itemText, minute === m && tpStyles.itemTextActive]}>
                :{String(m).padStart(2, '0')}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const tpStyles = StyleSheet.create({
  container: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },
  colLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 8, textAlign: 'center' },
  scroll: { height: 200, backgroundColor: T.elevated, borderRadius: 12, borderWidth: 1, borderColor: T.border },
  item: { paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: T.surface },
  itemActive: { backgroundColor: T.primary + '44' },
  itemText: { color: T.textMuted, fontSize: 14, textAlign: 'center' },
  itemTextActive: { color: T.accent, fontWeight: '700' },
});

// ── Auto-Suggest Offset Banner ──────────────────────────────────────────────
interface OffsetSuggestion {
  suggestedOffset: number;   // absolute minutes
  correctionDelta: number;   // delta from current offset
  sampleCount: number;
  spread: number;            // max spread among deltas (consistency)
}

function useOffsetSuggestion(
  userId: string | undefined,
  currentOffset: number,
): { suggestion: OffsetSuggestion | null; loading: boolean } {
  const [suggestion, setSuggestion] = useState<OffsetSuggestion | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    (async () => {
      setLoading(true);
      try {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Fetch this week's resync history + admin prediction in parallel
        const [{ data: historyRows }, { data: predRow }] = await Promise.all([
          supabase
            .from('resync_history')
            .select('effective_transition_at, reported_state')
            .eq('user_id', userId)
            .gte('confirmed_at', weekAgo)
            .order('confirmed_at', { ascending: false })
            .limit(10),
          supabase
            .from('utility_predictions')
            .select('prediction')
            .eq('id', 1)
            .maybeSingle(),
        ]);

        const events = historyRows ?? [];
        if (events.length < 3) { setSuggestion(null); setLoading(false); return; }

        const pred = predRow?.prediction as any;
        if (!pred?.slots || !Array.isArray(pred.slots)) { setSuggestion(null); setLoading(false); return; }

        // Build a list of predicted slot timestamps for today (UTC+3) for comparison
        // We iterate over prediction slots and project them to the same date as each event
        const deltas: number[] = [];

        for (const event of events) {
          const effectiveMs = new Date(event.effective_transition_at).getTime();
          const effectiveHour = (new Date(effectiveMs + 3 * 60 * 60 * 1000).getUTCHours());
          const effectiveMin = (new Date(effectiveMs + 3 * 60 * 60 * 1000).getUTCMinutes());
          const effectiveTotalMin = effectiveHour * 60 + effectiveMin;

          // Find matching slot by reported_state type
          const matchType = event.reported_state === 'UTILITY_ON' ? 'on' : 'off';

          let closestDelta: number | null = null;
          let minDiff = Infinity;

          for (const slot of pred.slots) {
            if (slot.type !== matchType) continue;

            // Slot time is minutes-from-midnight in UTC+3, offset-adjusted
            const slotRaw = (typeof slot.time === 'number') ? slot.time : (slot.start ?? slot.median ?? 0);
            const slotAdjusted = slotRaw + currentOffset;
            const slotNorm = ((slotAdjusted % 1440) + 1440) % 1440;

            const diff = Math.abs(effectiveTotalMin - slotNorm);
            const diffWrapped = Math.min(diff, 1440 - diff);

            if (diffWrapped < minDiff) {
              minDiff = diffWrapped;
              // Delta: positive = event happened AFTER prediction (need to increase offset)
              let d = effectiveTotalMin - slotNorm;
              if (d > 720) d -= 1440;
              if (d < -720) d += 1440;
              closestDelta = d;
            }
          }

          // Only include if the closest slot is within 90 minutes (plausible match)
          if (closestDelta !== null && minDiff <= 90) {
            deltas.push(closestDelta);
          }
        }

        if (deltas.length < 3) { setSuggestion(null); setLoading(false); return; }

        // Check consistency: all deltas within 10 minutes of each other
        const minD = Math.min(...deltas);
        const maxD = Math.max(...deltas);
        const spread = maxD - minD;

        if (spread > 10) { setSuggestion(null); setLoading(false); return; }

        const avgDelta = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);
        const suggestedOffset = currentOffset + avgDelta;

        // Only suggest if the correction is meaningful (>= 3 minutes)
        if (Math.abs(avgDelta) < 3) { setSuggestion(null); setLoading(false); return; }

        setSuggestion({ suggestedOffset, correctionDelta: avgDelta, sampleCount: deltas.length, spread });
      } catch (err) {
        console.error('[useOffsetSuggestion]', err);
        setSuggestion(null);
      }
      setLoading(false);
    })();
  }, [userId, currentOffset]);

  return { suggestion, loading };
}

function AutoSuggestBanner({
  suggestion,
  onApply,
  onDismiss,
  applying,
}: {
  suggestion: OffsetSuggestion;
  onApply: (newOffset: number) => void;
  onDismiss: () => void;
  applying: boolean;
}) {
  const [fadeAnim] = React.useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
  }, []);

  const fmtOff = (min: number) => {
    const sign = min >= 0 ? '+' : '-';
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h === 0) return `${sign}${m}m`;
    if (m === 0) return `${sign}${h}h`;
    return `${sign}${h}h ${m}m`;
  };

  const dirLabel = suggestion.correctionDelta > 0
    ? `${suggestion.correctionDelta}m later than expected`
    : `${Math.abs(suggestion.correctionDelta)}m earlier than expected`;

  return (
    <Animated.View style={[asStyles.banner, { opacity: fadeAnim }]}>
      <View style={asStyles.pulseRow}>
        <View style={asStyles.pulseDot} />
        <Text style={asStyles.title}>COMMUNITY SUGGESTS AN OFFSET UPDATE</Text>
      </View>
      <Text style={asStyles.body}>
        Based on {suggestion.sampleCount} consistent community resyncs this week, your grid transitions are arriving{' '}
        <Text style={{ color: T.warning, fontWeight: '700' }}>{dirLabel}</Text>.
        All {suggestion.sampleCount} events agree within {suggestion.spread} minutes of each other.
      </Text>
      <View style={asStyles.offsetRow}>
        <View style={asStyles.offsetBox}>
          <Text style={asStyles.offsetLabel}>CURRENT</Text>
          <Text style={[asStyles.offsetVal, { color: T.textSecondary }]}>{fmtOff(suggestion.suggestedOffset - suggestion.correctionDelta)}</Text>
        </View>
        <Text style={asStyles.arrow}>{'>>'}</Text>
        <View style={[asStyles.offsetBox, asStyles.offsetBoxNew]}>
          <Text style={asStyles.offsetLabel}>SUGGESTED</Text>
          <Text style={[asStyles.offsetVal, { color: T.warning }]}>{fmtOff(suggestion.suggestedOffset)}</Text>
        </View>
      </View>
      <View style={asStyles.btnRow}>
        <TouchableOpacity
          style={[asStyles.applyBtn, applying && { opacity: 0.6 }]}
          onPress={() => onApply(suggestion.suggestedOffset)}
          disabled={applying}
          activeOpacity={0.85}
        >
          {applying
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={asStyles.applyText}>⚡  Apply Suggested Offset</Text>
          }
        </TouchableOpacity>
        <TouchableOpacity style={asStyles.dismissBtn} onPress={onDismiss} activeOpacity={0.8}>
          <Text style={asStyles.dismissText}>Not now</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const asStyles = StyleSheet.create({
  banner: {
    backgroundColor: '#1a1200',
    borderRadius: 18,
    padding: 18,
    marginBottom: 20,
    borderWidth: 1.5,
    borderColor: T.warning + '66',
  },
  pulseRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  pulseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: T.warning },
  title: { color: T.warning, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  body: { color: '#fde68a', fontSize: 13, lineHeight: 20, marginBottom: 14 },
  offsetRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  offsetBox: { flex: 1, backgroundColor: T.surface, borderRadius: 12, padding: 12, alignItems: 'center' },
  offsetBoxNew: { borderWidth: 1, borderColor: T.warning + '44', backgroundColor: '#1c1400' },
  offsetLabel: { color: T.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1.5, marginBottom: 6 },
  offsetVal: { fontSize: 22, fontWeight: '900' },
  arrow: { color: T.textMuted, fontSize: 18, fontWeight: '700' },
  btnRow: { flexDirection: 'row', gap: 10 },
  applyBtn: { flex: 1, backgroundColor: T.warning, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  applyText: { color: '#1a1200', fontWeight: '800', fontSize: 14 },
  dismissBtn: { backgroundColor: T.elevated, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: T.border },
  dismissText: { color: T.textMuted, fontWeight: '600', fontSize: 13 },
});

// ── Community Impact Card ─────────────────────────────────────────────────────
interface CommunityImpactData {
  weeklyCount: number;
  avgDeltaMin: number;
  topReporter: { username: string | null; reliability: number } | null;
}

function CommunityImpactCard({ userId }: { userId: string | undefined }) {
  const [data, setData] = useState<CommunityImpactData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    (async () => {
      setLoading(true);
      try {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Fetch this week's resync history
        const { data: history } = await supabase
          .from('resync_history')
          .select('effective_transition_at, reporter_id, reporter_username')
          .eq('user_id', userId)
          .gte('confirmed_at', weekAgo)
          .order('confirmed_at', { ascending: false });

        const rows = history ?? [];
        const weeklyCount = rows.length;

        // Fetch corresponding utility_predictions to compute average delta
        // Delta = |effective_transition_at - closest predicted slot|
        // Simplified: we store estimated_transition_at from the report
        // We compute average difference from confirmed_at as a proxy
        let avgDeltaMin = 0;
        if (rows.length > 0) {
          const deltas = rows.map(r => {
            // resync effective time vs "now" at confirmation (crude proxy)
            return 0; // placeholder — actual delta computed below
          });

          // Fetch the associated report's estimated_transition_at for true delta
          const { data: rHistory } = await supabase
            .from('resync_history')
            .select('effective_transition_at, confirmed_at')
            .eq('user_id', userId)
            .gte('confirmed_at', weekAgo);

          const ds = (rHistory ?? []).map(r => {
            const eff = new Date(r.effective_transition_at).getTime();
            const conf = new Date(r.confirmed_at).getTime();
            return Math.abs(conf - eff) / 60000;
          });
          avgDeltaMin = ds.length > 0 ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : 0;
        }

        // Find most reliable reporter in user's network (from this week's events)
        let topReporter: CommunityImpactData['topReporter'] = null;
        const reporterIds = [...new Set(rows.map(r => r.reporter_id).filter(Boolean) as string[])];
        if (reporterIds.length > 0) {
          const { data: reliabilities } = await supabase
            .from('user_reliability')
            .select('user_id, reliability_score')
            .in('user_id', reporterIds)
            .order('reliability_score', { ascending: false })
            .limit(1);

          if (reliabilities && reliabilities.length > 0) {
            const top = reliabilities[0];
            const matchRow = rows.find(r => r.reporter_id === top.user_id);
            topReporter = {
              username: matchRow?.reporter_username ?? null,
              reliability: Math.round(top.reliability_score),
            };
          }
        }

        setData({ weeklyCount, avgDeltaMin, topReporter });
      } catch (err) {
        console.error('[CommunityImpactCard]', err);
      }
      setLoading(false);
    })();
  }, [userId]);

  return (
    <View style={ciStyles.card}>
      <View style={ciStyles.header}>
        <Text style={ciStyles.headerIcon}>👥</Text>
        <Text style={ciStyles.headerTitle}>COMMUNITY IMPACT THIS WEEK</Text>
      </View>

      {loading ? (
        <View style={ciStyles.loadingRow}>
          <ActivityIndicator size="small" color={T.accent} />
          <Text style={ciStyles.loadingText}>Calculating impact…</Text>
        </View>
      ) : !data || data.weeklyCount === 0 ? (
        <View style={ciStyles.emptyRow}>
          <Text style={ciStyles.emptyText}>
            No community resyncs yet this week. Follow nearby users and respond to their grid reports to see your impact here.
          </Text>
        </View>
      ) : (
        <>
          <View style={ciStyles.statsRow}>
            <View style={ciStyles.statCell}>
              <Text style={ciStyles.statValue}>{data.weeklyCount}</Text>
              <Text style={ciStyles.statLabel}>SCHEDULE{' '}ADJUSTMENTS</Text>
            </View>
            <View style={ciStyles.statDivider} />
            <View style={ciStyles.statCell}>
              <Text style={ciStyles.statValue}>{data.avgDeltaMin}m</Text>
              <Text style={ciStyles.statLabel}>AVG{' '}DELTA</Text>
            </View>
            {data.topReporter && (
              <>
                <View style={ciStyles.statDivider} />
                <View style={ciStyles.statCell}>
                  <Text style={[ciStyles.statValue, { fontSize: 13 }]}>{data.topReporter.username ?? 'Unknown'}</Text>
                  <Text style={ciStyles.statLabel}>TOP{' '}REPORTER</Text>
                  <Text style={[ciStyles.statValue, { fontSize: 11, color: T.success }]}>{data.topReporter.reliability}%</Text>
                </View>
              </>
            )}
          </View>
          <Text style={ciStyles.hint}>
            Community reports have fine-tuned your schedule {data.weeklyCount} time{data.weeklyCount !== 1 ? 's' : ''} this week with an average correction of {data.avgDeltaMin} minutes. Stay active to keep receiving alerts.
          </Text>
        </>
      )}
    </View>
  );
}

const ciStyles = StyleSheet.create({
  card: { backgroundColor: '#0a1929', borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: '#1e3a5a' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  headerIcon: { fontSize: 16 },
  headerTitle: { color: T.accent, fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  loadingText: { color: T.textMuted, fontSize: 12 },
  emptyRow: { paddingVertical: 4 },
  emptyText: { color: T.textMuted, fontSize: 12, lineHeight: 19 },
  statsRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderRadius: 12, paddingVertical: 14, marginBottom: 12 },
  statCell: { flex: 1, alignItems: 'center' },
  statValue: { color: T.textPrimary, fontSize: 20, fontWeight: '900', marginBottom: 4 },
  statLabel: { color: T.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1, textAlign: 'center', lineHeight: 12 },
  statDivider: { width: 1, height: 36, backgroundColor: T.border },
  hint: { color: T.textMuted, fontSize: 11, lineHeight: 18 },
});

// ── Calibrate Screen ─────────────────────────────────────────────────────────
export default function CalibrateScreen() {
  const insets = useSafeAreaInsets();
  const { calibrate, offset, saveOffset } = useUserOffset();
  const { user } = useAuth();

  const [eventType, setEventType] = useState<'UTILITY_ON' | 'UTILITY_OFF'>('UTILITY_OFF');
  const [hour, setHour] = useState(14);
  const [minute, setMinute] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ offsetMin: number; error: string | null } | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [applyingSuggestion, setApplyingSuggestion] = useState(false);

  const currentOffset = offset?.offset_minutes ?? 0;
  const { suggestion, loading: suggestionLoading } = useOffsetSuggestion(user?.id, currentOffset);

  const handleCalibrate = useCallback(async () => {
    setLoading(true);
    setResult(null);
    const { offsetMinutes, error } = await calibrate(eventType, hour, minute);
    setLoading(false);
    setResult({ offsetMin: offsetMinutes, error });
  }, [calibrate, eventType, hour, minute]);

  const handleApplySuggestion = useCallback(async (newOffset: number) => {
    setApplyingSuggestion(true);
    try {
      await saveOffset(newOffset);
      setSuggestionDismissed(true);
      setResult({ offsetMin: newOffset, error: null });
    } catch (err) {
      console.error('[handleApplySuggestion]', err);
    }
    setApplyingSuggestion(false);
  }, [saveOffset]);

  const fmtTime = (h: number, m: number) => {
    const ampm = h < 12 ? 'AM' : 'PM';
    const d = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${d}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const fmtOffset = (min: number) => {
    const sign = min >= 0 ? '+' : '-';
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h === 0) return `${sign}${m}m`;
    if (m === 0) return `${sign}${h}h`;
    return `${sign}${h}h ${m}m`;
  };

  const showSuggestion = !suggestionDismissed && !suggestionLoading && suggestion !== null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Explanation */}
      <View style={styles.explainCard}>
        <Text style={styles.explainTitle}>How Your Offset Works</Text>
        <Text style={styles.explainText}>
          The main inverter records power events for the city's main grid segment. Your neighborhood may get power at a slightly different time — maybe 15 minutes earlier or 30 minutes later.{'\n\n'}
          Tell us when you last noticed power changing, and we will calculate your block's exact time offset from the main sensor. All predictions are then shifted automatically for your location.
        </Text>
      </View>

      {/* Auto-suggest banner — shown before current offset if suggestion is available */}
      {showSuggestion && suggestion && (
        <AutoSuggestBanner
          suggestion={suggestion}
          onApply={handleApplySuggestion}
          onDismiss={() => setSuggestionDismissed(true)}
          applying={applyingSuggestion}
        />
      )}

      {/* Current offset */}
      {offset && (
        <View style={[styles.currentCard, { borderColor: offset.offset_minutes === 0 ? T.border : T.accent + '44' }]}>
          <Text style={styles.currentLabel}>YOUR CURRENT OFFSET</Text>
          <Text style={[styles.currentValue, {
            color: offset.offset_minutes === 0 ? T.textSecondary
              : offset.offset_minutes > 0 ? T.warning : T.accent
          }]}>
            {fmtOffset(offset.offset_minutes)}
          </Text>
          <Text style={styles.currentSub}>
            {offset.offset_minutes === 0
              ? 'Your block matches the main grid'
              : offset.offset_minutes > 0
                ? `Your block gets power ${fmtOffset(offset.offset_minutes)} AFTER the main sensor`
                : `Your block gets power ${fmtOffset(offset.offset_minutes).replace('-', '')} BEFORE the main sensor`
            }
          </Text>
          {offset.last_event_type && (
            <Text style={styles.currentMeta}>
              Last calibrated with: {offset.last_event_type === 'UTILITY_ON' ? '⚡ Grid ON' : '🔴 Grid OFF'}
            </Text>
          )}
        </View>
      )}

      {/* Step 1: Event Type */}
      <Text style={styles.stepLabel}>STEP 1 — What event did you observe?</Text>
      <View style={styles.typeRow}>
        <TouchableOpacity
          style={[styles.typeBtn, eventType === 'UTILITY_OFF' && styles.typeBtnOff]}
          onPress={() => setEventType('UTILITY_OFF')}
          activeOpacity={0.8}
        >
          <Text style={styles.typeBtnIcon}>🔴</Text>
          <Text style={[styles.typeBtnLabel, eventType === 'UTILITY_OFF' && { color: T.danger }]}>Power Went OFF</Text>
          <Text style={styles.typeBtnSub}>Grid went out</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.typeBtn, eventType === 'UTILITY_ON' && styles.typeBtnOn]}
          onPress={() => setEventType('UTILITY_ON')}
          activeOpacity={0.8}
        >
          <Text style={styles.typeBtnIcon}>⚡</Text>
          <Text style={[styles.typeBtnLabel, eventType === 'UTILITY_ON' && { color: T.success }]}>Power Came ON</Text>
          <Text style={styles.typeBtnSub}>Grid came back</Text>
        </TouchableOpacity>
      </View>

      {/* Step 2: Time */}
      <Text style={styles.stepLabel}>STEP 2 — What time was it? (Yemen time, UTC+3)</Text>
      <View style={styles.timeDisplay}>
        <Text style={styles.timeValue}>{fmtTime(hour, minute)}</Text>
        <Text style={styles.timeNote}>{eventType === 'UTILITY_OFF' ? '🔴 Power went OFF at this time' : '⚡ Power came ON at this time'}</Text>
      </View>
      <TimePicker hour={hour} minute={minute} onChangeHour={setHour} onChangeMinute={setMinute} />

      {/* Result */}
      {result && (
        <View style={[styles.resultBox, result.error ? styles.resultErr : styles.resultOk]}>
          {result.error ? (
            <>
              <Text style={styles.resultErrTitle}>Could Not Calibrate</Text>
              <Text style={styles.resultErrText}>{result.error}</Text>
              <Text style={styles.resultErrHint}>Make sure there are recent power events in the last 48 hours to calibrate against.</Text>
            </>
          ) : (
            <>
              <Text style={styles.resultOkTitle}>✅ Calibrated!</Text>
              <Text style={styles.resultOkOffset}>{fmtOffset(result.offsetMin)}</Text>
              <Text style={styles.resultOkText}>
                Your block is {Math.abs(result.offsetMin)} min {result.offsetMin >= 0 ? 'after' : 'before'} the main Growatt readings.{'\n'}
                All predictions are now adjusted for your location.
              </Text>
            </>
          )}
        </View>
      )}

      {/* Calibrate button */}
      <TouchableOpacity
        style={[styles.calibrateBtn, loading && { opacity: 0.6 }]}
        onPress={handleCalibrate}
        disabled={loading}
        activeOpacity={0.8}
      >
        {loading
          ? <ActivityIndicator color="#fff" size="small" />
          : <Text style={styles.calibrateBtnText}>{offset ? '↻  Update My Offset' : '⚡  Calculate My Offset'}</Text>}
      </TouchableOpacity>

      {/* Skip info */}
      {!offset && (
        <Text style={styles.skipNote}>
          You can skip calibration and the app will use the raw Growatt data with no offset (0m). Calibrate anytime to personalize your predictions.
        </Text>
      )}

      {/* Community Impact */}
      <View style={styles.sectionDivider} />
      <CommunityImpactCard userId={user?.id} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 12 },

  explainCard: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: T.border },
  explainTitle: { color: T.textSecondary, fontSize: 13, fontWeight: '700', marginBottom: 10 },
  explainText: { color: T.textMuted, fontSize: 12, lineHeight: 20 },

  currentCard: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1, alignItems: 'center' },
  currentLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 8 },
  currentValue: { fontSize: 40, fontWeight: '900', marginBottom: 4 },
  currentSub: { color: T.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 18, marginBottom: 8 },
  currentMeta: { color: T.textMuted, fontSize: 11, marginTop: 4 },

  stepLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 12, textTransform: 'uppercase' },

  typeRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  typeBtn: { flex: 1, backgroundColor: T.surface, borderRadius: 16, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: T.border },
  typeBtnOff: { borderColor: T.danger, backgroundColor: '#1a0505' },
  typeBtnOn: { borderColor: T.success, backgroundColor: '#051a0a' },
  typeBtnIcon: { fontSize: 32, marginBottom: 8 },
  typeBtnLabel: { color: T.textSecondary, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  typeBtnSub: { color: T.textMuted, fontSize: 11 },

  timeDisplay: { backgroundColor: T.surface, borderRadius: 14, padding: 16, marginBottom: 14, alignItems: 'center', borderWidth: 1, borderColor: T.border },
  timeValue: { color: T.accent, fontSize: 36, fontWeight: '900', marginBottom: 4 },
  timeNote: { color: T.textMuted, fontSize: 11 },

  resultBox: { borderRadius: 14, padding: 16, marginTop: 16, marginBottom: 8, borderWidth: 1 },
  resultErr: { backgroundColor: '#1a0505', borderColor: '#7f1d1d' },
  resultOk: { backgroundColor: '#051a0a', borderColor: '#065f46' },
  resultErrTitle: { color: T.danger, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  resultErrText: { color: '#fca5a5', fontSize: 13, lineHeight: 19, marginBottom: 6 },
  resultErrHint: { color: T.textMuted, fontSize: 11, lineHeight: 17 },
  resultOkTitle: { color: T.success, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  resultOkOffset: { color: T.success, fontSize: 36, fontWeight: '900', marginBottom: 6 },
  resultOkText: { color: '#6ee7b7', fontSize: 13, lineHeight: 19 },

  calibrateBtn: { backgroundColor: T.primary, borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginTop: 20, marginBottom: 10 },
  calibrateBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  skipNote: { color: T.textMuted, fontSize: 11, textAlign: 'center', lineHeight: 18, marginTop: 4 },
  sectionDivider: { height: 1, backgroundColor: T.border, marginVertical: 24 },
});
