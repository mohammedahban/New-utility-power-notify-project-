/**
 * Calibrate Screen — Wizard-style offset calibration
 * Redesigned for clarity and ease of use in Arabic.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Animated, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUserOffset } from '../../hooks/useUserOffset';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useMyReliability, getReliabilityBadge } from '../../hooks/useReliability';

const { width: W } = Dimensions.get('window');

const T = {
  bg: '#060d1a', surface: '#0d1526', elevated: '#162035',
  border: '#1e2d45', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#4a5e7a',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

// ── Wizard Steps ──────────────────────────────────────────────────────────────
const STEPS = [
  {
    key: 'intro',
    title: 'ما هو الفارق الزمني؟',
    icon: '🏘️',
  },
  {
    key: 'event_type',
    title: 'ما الحدث الذي لاحظته؟',
    icon: '⚡',
  },
  {
    key: 'time_picker',
    title: 'في أي وقت حدث؟',
    icon: '🕐',
  },
  {
    key: 'result',
    title: 'نتيجة المعايرة',
    icon: '✅',
  },
];

// ── Step Progress Bar ─────────────────────────────────────────────────────────
function StepProgress({ current, total }: { current: number; total: number }) {
  return (
    <View style={spStyles.wrap}>
      {Array.from({ length: total }).map((_, i) => (
        <View key={i} style={[
          spStyles.segment,
          { backgroundColor: i <= current ? T.accent : T.elevated },
          i === current && spStyles.segmentActive,
        ]} />
      ))}
    </View>
  );
}
const spStyles = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: 5, marginBottom: 24 },
  segment: { flex: 1, height: 4, borderRadius: 2 },
  segmentActive: { backgroundColor: T.accent },
});

// ── Time Picker ───────────────────────────────────────────────────────────────
function TimePicker({ hour, minute, onChangeHour, onChangeMinute }: {
  hour: number; minute: number;
  onChangeHour: (h: number) => void;
  onChangeMinute: (m: number) => void;
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);
  const fmtH = (h: number) => {
    const ampm = h < 12 ? 'ص' : 'م';
    const d = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${d}:00 ${ampm}`;
  };
  return (
    <View style={tpStyles.container}>
      <View style={tpStyles.col}>
        <Text style={tpStyles.colLabel}>الدقيقة</Text>
        <ScrollView style={tpStyles.scroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {minutes.map(m => (
            <TouchableOpacity key={m} style={[tpStyles.item, minute === m && tpStyles.itemActive]} onPress={() => onChangeMinute(m)} activeOpacity={0.7}>
              <Text style={[tpStyles.itemText, minute === m && tpStyles.itemTextActive]}>:{String(m).padStart(2, '0')}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
      <View style={tpStyles.col}>
        <Text style={tpStyles.colLabel}>الساعة</Text>
        <ScrollView style={tpStyles.scroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {hours.map(h => (
            <TouchableOpacity key={h} style={[tpStyles.item, hour === h && tpStyles.itemActive]} onPress={() => onChangeHour(h)} activeOpacity={0.7}>
              <Text style={[tpStyles.itemText, hour === h && tpStyles.itemTextActive]}>{fmtH(h)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}
const tpStyles = StyleSheet.create({
  container: { flexDirection: 'row-reverse', gap: 12 },
  col: { flex: 1 },
  colLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 8, textAlign: 'center' },
  scroll: { height: 220, backgroundColor: T.elevated, borderRadius: 14, borderWidth: 1, borderColor: T.border },
  item: { paddingVertical: 13, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: T.surface },
  itemActive: { backgroundColor: T.primary + '33' },
  itemText: { color: T.textMuted, fontSize: 15, textAlign: 'center' },
  itemTextActive: { color: T.accent, fontWeight: '800' },
});

// ── Community Impact Card ─────────────────────────────────────────────────────
function CommunityImpactCard({ userId }: { userId: string | undefined }) {
  const [data, setData] = useState<{ weeklyCount: number; avgDeltaMin: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    (async () => {
      try {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: history } = await supabase.from('resync_history')
          .select('effective_transition_at, confirmed_at')
          .eq('user_id', userId)
          .gte('confirmed_at', weekAgo);
        const rows = history ?? [];
        const weeklyCount = rows.length;
        const deltas = rows.map(r => Math.abs(
          new Date(r.confirmed_at).getTime() - new Date(r.effective_transition_at).getTime()
        ) / 60000);
        const avgDeltaMin = deltas.length > 0 ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
        setData({ weeklyCount, avgDeltaMin });
      } catch (_) {}
      setLoading(false);
    })();
  }, [userId]);

  return (
    <View style={ciStyles.card}>
      <Text style={ciStyles.title}>👥 تأثير المجتمع هذا الأسبوع</Text>
      {loading ? (
        <ActivityIndicator size="small" color={T.accent} style={{ marginVertical: 12 }} />
      ) : !data || data.weeklyCount === 0 ? (
        <Text style={ciStyles.empty}>لا توجد مزامنات هذا الأسبوع. ردّ على تنبيهات المجتمع لترى تأثيرك هنا.</Text>
      ) : (
        <View style={ciStyles.statsRow}>
          <View style={ciStyles.stat}>
            <Text style={ciStyles.statVal}>{data.weeklyCount}</Text>
            <Text style={ciStyles.statLabel}>تعديلات للجدول</Text>
          </View>
          <View style={ciStyles.divider} />
          <View style={ciStyles.stat}>
            <Text style={ciStyles.statVal}>{data.avgDeltaMin}د</Text>
            <Text style={ciStyles.statLabel}>متوسط الفرق</Text>
          </View>
        </View>
      )}
    </View>
  );
}
const ciStyles = StyleSheet.create({
  card: { backgroundColor: '#0a1929', borderRadius: 16, padding: 16, marginTop: 20, borderWidth: 1, borderColor: '#1e3a5a' },
  title: { color: T.accent, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 12, textAlign: 'right' },
  empty: { color: T.textMuted, fontSize: 12, lineHeight: 19, textAlign: 'right' },
  statsRow: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: T.surface, borderRadius: 12, paddingVertical: 16 },
  stat: { flex: 1, alignItems: 'center' },
  statVal: { color: T.textPrimary, fontSize: 26, fontWeight: '900', marginBottom: 4 },
  statLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, textAlign: 'center' },
  divider: { width: 1, height: 40, backgroundColor: T.border },
});

// ── Main Calibrate Screen ─────────────────────────────────────────────────────
export default function CalibrateScreen() {
  const insets = useSafeAreaInsets();
  const { calibrate, offset, saveOffset } = useUserOffset();
  const { user } = useAuth();
  const { score: myScore } = useMyReliability(user?.id);

  const [step, setStep] = useState(0); // 0=intro, 1=event_type, 2=time, 3=result
  const [eventType, setEventType] = useState<'UTILITY_ON' | 'UTILITY_OFF'>('UTILITY_OFF');
  const [hour, setHour] = useState(new Date().getHours());
  const [minute, setMinute] = useState(Math.floor(new Date().getMinutes() / 5) * 5);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ offsetMin: number; error: string | null } | null>(null);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const goStep = (n: number) => {
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 100, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
    setTimeout(() => setStep(n), 100);
  };

  const handleCalibrate = useCallback(async () => {
    setLoading(true);
    const { offsetMinutes, error } = await calibrate(eventType, hour, minute);
    setLoading(false);
    setResult({ offsetMin: offsetMinutes, error });
    goStep(3);
  }, [calibrate, eventType, hour, minute]);

  const fmtOffset = (min: number) => {
    const sign = min >= 0 ? '+' : '-';
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h === 0) return `${sign}${m}د`;
    if (m === 0) return `${sign}${h}س`;
    return `${sign}${h}س ${m}د`;
  };

  const fmtTime = (h: number, m: number) => {
    const ampm = h < 12 ? 'ص' : 'م';
    const d = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${d}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.pageHeader}>
        <Text style={styles.pageTitle}>⚡ فارقي الزمني</Text>
        <Text style={styles.pageSub}>خصّص توقعاتك لحيّك بدقة</Text>
      </View>

      {/* Current offset badge */}
      {offset && (
        <View style={[styles.currentBadge, {
          borderColor: offset.offset_minutes === 0 ? T.border : T.accent + '44',
        }]}>
          <View style={styles.currentBadgeRight}>
            <Text style={styles.currentBadgeLabel}>فارقك الحالي</Text>
            {offset.last_event_type && (
              <Text style={styles.currentBadgeMeta}>
                آخر معايرة: {offset.last_event_type === 'UTILITY_ON' ? '⚡ الكهرباء اشتغلت' : '🔴 الكهرباء طفت'}
              </Text>
            )}
          </View>
          <Text style={[styles.currentBadgeValue, {
            color: offset.offset_minutes === 0 ? T.textSecondary
              : offset.offset_minutes > 0 ? T.warning : T.accent,
          }]}>
            {fmtOffset(offset.offset_minutes)}
          </Text>
        </View>
      )}

      {/* Reliability badge */}
      {myScore && (
        <View style={styles.reliabilityCard}>
          <View style={[styles.reliabilityBadge, { borderColor: getReliabilityBadge(myScore.reliability_score).color + '44' }]}>
            <Text style={[styles.reliabilityScore, { color: getReliabilityBadge(myScore.reliability_score).color }]}>
              {myScore.reliability_score}%
            </Text>
            <Text style={styles.reliabilityLabel}>{getReliabilityBadge(myScore.reliability_score).label}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.reliabilityDesc}>
              {myScore.total_reports} بلاغ · {myScore.accepted_reports} مقبول · {myScore.total_responses} رد
            </Text>
            <Text style={styles.reliabilityHint}>موثوقيّتك في المجتمع</Text>
          </View>
        </View>
      )}

      {/* Step progress */}
      <StepProgress current={step} total={STEPS.length} />

      {/* Animated step content */}
      <Animated.View style={{ opacity: fadeAnim }}>

        {/* STEP 0: Intro */}
        {step === 0 && (
          <View>
            <View style={styles.stepCard}>
              <Text style={styles.stepIcon}>🏘️</Text>
              <Text style={styles.stepTitle}>لماذا فارق زمني مختلف لكل حيّ؟</Text>
              <Text style={styles.stepBody}>
                مُستشعر Growatt يسجّل الكهرباء من موقع محدد. أما حيّك فقد يحصل على الكهرباء{' '}
                <Text style={{ color: T.warning, fontWeight: '700' }}>قبل أو بعد</Text>{' '}
                ذلك الموقع بدقائق أو حتى ساعات.
              </Text>

              <View style={styles.exampleBox}>
                <Text style={styles.exampleTitle}>مثال توضيحي 📍</Text>
                <View style={styles.exampleRow}>
                  <Text style={styles.exampleText}>المستشعر يسجّل: الكهرباء اشتغلت الساعة <Text style={{ color: T.success, fontWeight: '700' }}>8:00 ص</Text></Text>
                </View>
                <View style={styles.exampleRow}>
                  <Text style={styles.exampleText}>أنت لاحظت: الكهرباء وصلت الساعة <Text style={{ color: T.warning, fontWeight: '700' }}>8:20 ص</Text></Text>
                </View>
                <View style={[styles.exampleRow, { backgroundColor: T.primary + '18', borderRadius: 8 }]}>
                  <Text style={[styles.exampleText, { color: T.accent }]}>→ فارقك الزمني = <Text style={{ fontWeight: '900' }}>+20 دقيقة</Text></Text>
                </View>
              </View>

              <View style={styles.infoBox}>
                <Text style={styles.infoIcon}>💡</Text>
                <Text style={styles.infoText}>بعد المعايرة، كل توقعاتك ستُضبط تلقائياً لتناسب حيّك بدقة أكبر.</Text>
              </View>
            </View>

            <TouchableOpacity style={styles.nextBtn} onPress={() => goStep(1)} activeOpacity={0.85}>
              <Text style={styles.nextBtnText}>ابدأ المعايرة ←</Text>
            </TouchableOpacity>

            {offset && (
              <TouchableOpacity style={styles.skipBtn} onPress={() => goStep(1)} activeOpacity={0.8}>
                <Text style={styles.skipBtnText}>تحديث المعايرة ↻</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* STEP 1: Event Type */}
        {step === 1 && (
          <View>
            <View style={styles.stepCard}>
              <Text style={styles.stepIcon}>🔍</Text>
              <Text style={styles.stepTitle}>ما الحدث الأخير الذي لاحظته في حيّك؟</Text>
              <Text style={styles.stepBody}>
                اختر الحدث الذي تتذكره بوضوح — كلما كان أقرب زمنياً، كانت المعايرة أدق.
              </Text>

              <View style={styles.typeRow}>
                <TouchableOpacity
                  style={[styles.typeBtn, eventType === 'UTILITY_ON' && styles.typeBtnOnActive]}
                  onPress={() => setEventType('UTILITY_ON')}
                  activeOpacity={0.8}
                >
                  <Text style={styles.typeBtnIcon}>⚡</Text>
                  <Text style={[styles.typeBtnText, eventType === 'UTILITY_ON' && { color: T.success }]}>
                    الكهرباء اشتغلت
                  </Text>
                  <Text style={styles.typeBtnHint}>عادت الكهرباء</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.typeBtn, eventType === 'UTILITY_OFF' && styles.typeBtnOffActive]}
                  onPress={() => setEventType('UTILITY_OFF')}
                  activeOpacity={0.8}
                >
                  <Text style={styles.typeBtnIcon}>🔴</Text>
                  <Text style={[styles.typeBtnText, eventType === 'UTILITY_OFF' && { color: T.danger }]}>
                    الكهرباء طفت
                  </Text>
                  <Text style={styles.typeBtnHint}>انقطعت الكهرباء</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.infoBox}>
                <Text style={styles.infoIcon}>💡</Text>
                <Text style={styles.infoText}>
                  إذا كنت غير متأكد، اختر الحدث الأكثر وضوحاً في ذاكرتك — مثلاً الكهرباء لها صوت أو ضوء عند الاشتغال.
                </Text>
              </View>
            </View>

            <View style={styles.btnRow}>
              <TouchableOpacity style={styles.backBtn} onPress={() => goStep(0)} activeOpacity={0.8}>
                <Text style={styles.backBtnText}>→ رجوع</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.nextBtn, { flex: 1 }]} onPress={() => goStep(2)} activeOpacity={0.85}>
                <Text style={styles.nextBtnText}>التالي ←</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* STEP 2: Time Picker */}
        {step === 2 && (
          <View>
            <View style={styles.stepCard}>
              <Text style={styles.stepIcon}>🕐</Text>
              <Text style={styles.stepTitle}>في أي وقت حدث ذلك؟</Text>
              <Text style={styles.stepBody}>
                اختر الوقت بتوقيت اليمن (UTC+3) — الوقت الذي لاحظت فيه{' '}
                <Text style={{ color: eventType === 'UTILITY_ON' ? T.success : T.danger, fontWeight: '700' }}>
                  {eventType === 'UTILITY_ON' ? 'اشتغال الكهرباء' : 'طفو الكهرباء'}
                </Text>
                {' '}في حيّك.
              </Text>

              <View style={styles.timeDisplay}>
                <Text style={[styles.timeDisplayValue, { color: eventType === 'UTILITY_ON' ? T.success : T.danger }]}>
                  {fmtTime(hour, minute)}
                </Text>
                <Text style={styles.timeDisplaySub}>توقيت اليمن</Text>
              </View>

              <TimePicker hour={hour} minute={minute} onChangeHour={setHour} onChangeMinute={setMinute} />

              <View style={styles.infoBox}>
                <Text style={styles.infoIcon}>💡</Text>
                <Text style={styles.infoText}>
                  لا تحتاج لدقة 100٪ — تقريب لأقرب 5 دقائق كافٍ. المهم أن تكون الذاكرة طازجة (آخر 24 ساعة أفضل).
                </Text>
              </View>
            </View>

            <View style={styles.btnRow}>
              <TouchableOpacity style={styles.backBtn} onPress={() => goStep(1)} activeOpacity={0.8}>
                <Text style={styles.backBtnText}>→ رجوع</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.nextBtn, { flex: 1, opacity: loading ? 0.6 : 1 }]}
                onPress={handleCalibrate}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading
                  ? <ActivityIndicator color="#0f172a" size="small" />
                  : <Text style={styles.nextBtnText}>احسب الفارق ←</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* STEP 3: Result */}
        {step === 3 && result && (
          <View>
            {result.error ? (
              <View style={styles.stepCard}>
                <Text style={styles.stepIcon}>⚠️</Text>
                <Text style={styles.stepTitle}>تعذّرت المعايرة</Text>
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{result.error}</Text>
                </View>
                <View style={styles.infoBox}>
                  <Text style={styles.infoIcon}>💡</Text>
                  <Text style={styles.infoText}>
                    تأكد من وجود أحداث كهرباء حديثة خلال آخر 48 ساعة. يحتاج النظام إلى حدث مسجّل قريب من الوقت الذي أدخلته.
                  </Text>
                </View>
                <TouchableOpacity style={styles.nextBtn} onPress={() => goStep(1)} activeOpacity={0.85}>
                  <Text style={styles.nextBtnText}>← حاول مجدداً</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View>
                <View style={[styles.stepCard, styles.resultCard]}>
                  <Text style={styles.successIcon}>✅</Text>
                  <Text style={styles.resultTitle}>تمت المعايرة بنجاح!</Text>
                  <Text style={[styles.resultOffset, {
                    color: result.offsetMin === 0 ? T.textSecondary
                      : result.offsetMin > 0 ? T.warning : T.accent,
                  }]}>
                    {fmtOffset(result.offsetMin)}
                  </Text>
                  <Text style={styles.resultDescription}>
                    {result.offsetMin === 0
                      ? 'حيّك يتزامن مع المستشعر الرئيسي تماماً!'
                      : result.offsetMin > 0
                        ? `حيّك يحصل على الكهرباء بعد المستشعر الرئيسي بـ ${Math.abs(result.offsetMin)} دقيقة`
                        : `حيّك يحصل على الكهرباء قبل المستشعر الرئيسي بـ ${Math.abs(result.offsetMin)} دقيقة`
                    }
                  </Text>
                  <View style={styles.checkList}>
                    <Text style={styles.checkItem}>✔ جميع التوقعات مُعدَّلة لموقعك</Text>
                    <Text style={styles.checkItem}>✔ الجدول اليومي محدَّث</Text>
                    <Text style={styles.checkItem}>✔ العدّاد التنازلي دقيق لحيّك</Text>
                  </View>
                </View>

                <TouchableOpacity style={styles.nextBtn} onPress={() => goStep(0)} activeOpacity={0.85}>
                  <Text style={styles.nextBtnText}>← إعادة المعايرة</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

      </Animated.View>

      {/* Community Impact */}
      <CommunityImpactCard userId={user?.id} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 16 },

  pageHeader: { marginBottom: 20 },
  pageTitle: { color: T.textPrimary, fontSize: 24, fontWeight: '900', textAlign: 'right', marginBottom: 4 },
  pageSub: { color: T.textMuted, fontSize: 13, textAlign: 'right' },

  currentBadge: {
    flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: T.surface,
    borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, gap: 12,
  },
  currentBadgeRight: { flex: 1 },
  currentBadgeLabel: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1, textAlign: 'right', marginBottom: 4 },
  currentBadgeMeta: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  currentBadgeValue: { fontSize: 34, fontWeight: '900' },

  reliabilityCard: {
    flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: T.surface,
    borderRadius: 14, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: T.border, gap: 12,
  },
  reliabilityBadge: { alignItems: 'center', borderRadius: 12, borderWidth: 1, padding: 10, minWidth: 64 },
  reliabilityScore: { fontSize: 20, fontWeight: '900', marginBottom: 2 },
  reliabilityLabel: { color: T.textMuted, fontSize: 9, fontWeight: '600' },
  reliabilityDesc: { color: T.textSecondary, fontSize: 12, textAlign: 'right', marginBottom: 3 },
  reliabilityHint: { color: T.textMuted, fontSize: 10, textAlign: 'right' },

  stepCard: { backgroundColor: T.surface, borderRadius: 20, padding: 22, marginBottom: 16, borderWidth: 1, borderColor: T.border },
  stepIcon: { fontSize: 44, textAlign: 'center', marginBottom: 16 },
  stepTitle: { color: T.textPrimary, fontSize: 20, fontWeight: '800', textAlign: 'right', marginBottom: 12, lineHeight: 29 },
  stepBody: { color: T.textSecondary, fontSize: 14, lineHeight: 24, textAlign: 'right', marginBottom: 18 },

  exampleBox: { backgroundColor: T.elevated, borderRadius: 14, padding: 16, marginBottom: 16, gap: 10 },
  exampleTitle: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1, textAlign: 'right', marginBottom: 4 },
  exampleRow: { padding: 8 },
  exampleText: { color: T.textSecondary, fontSize: 13, textAlign: 'right', lineHeight: 22 },

  infoBox: { flexDirection: 'row-reverse', gap: 10, backgroundColor: '#001a2e', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: T.accent + '33' },
  infoIcon: { fontSize: 16, flexShrink: 0 },
  infoText: { color: T.textMuted, fontSize: 12, lineHeight: 20, flex: 1, textAlign: 'right' },

  typeRow: { flexDirection: 'row-reverse', gap: 12, marginBottom: 18 },
  typeBtn: { flex: 1, backgroundColor: T.elevated, borderRadius: 18, padding: 18, alignItems: 'center', borderWidth: 1, borderColor: T.border, gap: 8 },
  typeBtnOnActive: { borderColor: T.success, backgroundColor: '#052e16' },
  typeBtnOffActive: { borderColor: T.danger, backgroundColor: '#2d0a0a' },
  typeBtnIcon: { fontSize: 36 },
  typeBtnText: { color: T.textSecondary, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  typeBtnHint: { color: T.textMuted, fontSize: 11, textAlign: 'center' },

  timeDisplay: { backgroundColor: T.elevated, borderRadius: 16, padding: 20, marginBottom: 16, alignItems: 'center' },
  timeDisplayValue: { fontSize: 40, fontWeight: '900', marginBottom: 6 },
  timeDisplaySub: { color: T.textMuted, fontSize: 12 },

  nextBtn: { backgroundColor: T.primary, borderRadius: 18, paddingVertical: 18, alignItems: 'center', marginBottom: 10 },
  nextBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  backBtn: { backgroundColor: T.elevated, borderRadius: 18, paddingVertical: 18, paddingHorizontal: 20, alignItems: 'center', borderWidth: 1, borderColor: T.border },
  backBtnText: { color: T.textMuted, fontWeight: '600', fontSize: 14 },
  skipBtn: { alignItems: 'center', paddingVertical: 14 },
  skipBtnText: { color: T.textMuted, fontSize: 13, fontWeight: '600' },
  btnRow: { flexDirection: 'row-reverse', gap: 10 },

  errorBox: { backgroundColor: '#1a0505', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#7f1d1d' },
  errorText: { color: '#fca5a5', fontSize: 13, lineHeight: 20, textAlign: 'right' },

  resultCard: { alignItems: 'center', borderColor: T.success + '44', borderWidth: 1.5 },
  successIcon: { fontSize: 52, marginBottom: 12 },
  resultTitle: { color: T.success, fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 12 },
  resultOffset: { fontSize: 52, fontWeight: '900', marginBottom: 12 },
  resultDescription: { color: T.textSecondary, fontSize: 14, lineHeight: 22, textAlign: 'center', marginBottom: 20, paddingHorizontal: 8 },
  checkList: { alignSelf: 'stretch', backgroundColor: T.elevated, borderRadius: 14, padding: 16, gap: 10 },
  checkItem: { color: T.success, fontSize: 14, fontWeight: '600', textAlign: 'right' },
});
