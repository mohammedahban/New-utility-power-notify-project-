import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert, Platform, ScrollView, Modal,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useNearbyUsers } from '../../hooks/useNearbyUsers';
import { useFollows } from '../../hooks/useFollows';
import { useUtilityReports, TimeOption } from '../../hooks/useUtilityReports';
// TMMS V2.2: ReportedState import removed — V2.2 is ON-ONLY reporting.
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useMyReliability, getReliabilityBadge } from '../../hooks/useReliability';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { registerPushToken } from '../../lib/notifications';
import { useResync } from '../../contexts/ResyncContext';
import { useStatusSnapshot } from '../../hooks/useStatusSnapshot';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useTransitionMode } from '../../hooks/useTransitionMode';
import { useUserPredictions } from '../../hooks/useUserPredictions';
import { AR } from '../../constants/arabic';

const T = {
  bg: '#0a0f1e', surface: '#0f172a', elevated: '#1e293b',
  border: '#334155', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

type Tab = 'nearby' | 'notifications' | 'history' | 'following' | 'leaderboard';

const TIME_OPTS: { key: TimeOption; label: string }[] = [
  { key: 'now', label: AR.timeNow },
  { key: '5min', label: AR.time5min },
  { key: '10min', label: AR.time10min },
  { key: '15min', label: AR.time15min },
  { key: '20min', label: AR.time20min },
];

const TIME_LABELS_AR: Record<string, string> = {
  now: AR.timeNow,
  '5min': AR.time5min,
  '10min': AR.time10min,
  '15min': AR.time15min,
  '20min': AR.time20min,
};

// ── Report Modal ──────────────────────────────────────────────────────────────
// TMMS V2.2: users NEVER report OFF. The modal is a single-purpose
// "Report Electricity ON" dialog. The reporter's OffsetState is computed
// by the engine at submission time per Period 1/2/3 rules.
function ReportModal({ visible, onClose, onSubmit, submitting }: {
  visible: boolean; onClose: () => void;
  onSubmit: (time: TimeOption) => void;
  submitting: boolean;
}) {
  const [time, setTime] = useState<TimeOption>('now');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={rmStyles.overlay}>
        <View style={rmStyles.sheet}>
          <View style={rmStyles.handle} />
          <Text style={rmStyles.title}>⚡ الإبلاغ عن تشغيل الكهرباء</Text>
          <Text style={rmStyles.sub}>
            أبلغ فقط عندما تشتعل الكهرباء. النظام يتعامل مع الإطفاء تلقائياً
            حسب التوقّعات ولا يحتاج إلى بلاغ منك. سيتم إنشاء "حالة تشغيل
            مُولّدة" فوراً وتُحدَّث الجداول لديك ولدى من يتابعك.
          </Text>

          <View style={rmStyles.onOnlyBanner}>
            <Text style={rmStyles.onOnlyEmoji}>⚡</Text>
            <View style={{ flex: 1 }}>
              <Text style={rmStyles.onOnlyTitle}>بلاغ تشغيل فقط</Text>
              <Text style={rmStyles.onOnlySub}>
                لا حاجة للإبلاغ عن الانطفاء — النظام يتوقّعه ويُنهيه تلقائياً.
              </Text>
            </View>
          </View>

          <Text style={rmStyles.sectionLabel}>{AR.whenHappened}</Text>
          <View style={rmStyles.timeGrid}>
            {TIME_OPTS.map(opt => (
              <TouchableOpacity
                key={opt.key}
                style={[rmStyles.timeBtn, time === opt.key && rmStyles.timeBtnActive]}
                onPress={() => setTime(opt.key)}
                activeOpacity={0.8}
              >
                <Text style={[rmStyles.timeBtnText, time === opt.key && { color: T.accent }]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[rmStyles.submitBtn, submitting && { opacity: 0.6 }]}
            onPress={() => onSubmit(time)}
            disabled={submitting}
            activeOpacity={0.85}
          >
            {submitting
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={rmStyles.submitText}>⚡ {AR.shareWithFollowers}</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity style={rmStyles.cancelBtn} onPress={onClose}>
            <Text style={rmStyles.cancelText}>{AR.cancel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const rmStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: T.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  handle: { width: 40, height: 4, backgroundColor: T.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  title: { color: T.textPrimary, fontSize: 20, fontWeight: '800', marginBottom: 6, textAlign: 'right' },
  sub: { color: T.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 20, textAlign: 'right' },
  sectionLabel: { color: T.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 10, textAlign: 'right' },
  onOnlyBanner: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 12,
    backgroundColor: '#052e16', borderRadius: 14, padding: 14, marginBottom: 20,
    borderWidth: 1.5, borderColor: T.success + '55',
  },
  onOnlyEmoji: { fontSize: 28 },
  onOnlyTitle: { color: T.success, fontSize: 14, fontWeight: '800', marginBottom: 4, textAlign: 'right' },
  onOnlySub: { color: T.success + 'cc', fontSize: 11, lineHeight: 16, textAlign: 'right' },
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  timeBtn: { backgroundColor: T.elevated, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: T.border },
  timeBtnActive: { borderColor: T.accent, backgroundColor: '#001a2e' },
  timeBtnText: { color: T.textMuted, fontSize: 13, fontWeight: '600' },
  submitBtn: { backgroundColor: T.primary, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cancelBtn: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { color: T.textMuted, fontSize: 14 },
});

// ── Notification Card ─────────────────────────────────────────────────────────
// TMMS V2.2: only ON reports exist. Added: Reporter Offset State badge so
// the Approver can see EXACTLY what they will clone by pressing YES.
function NotifCard({ notif, onRespond, onReporterPress }: {
  notif: any;
  onRespond: (notif: any, response: 'yes' | 'no' | 'ignore') => void;
  onReporterPress?: (reporterId: string) => void;
}) {
  const isExpired = new Date(notif.expires_at) < new Date();
  const stateLabel = AR.electricityCameOn;
  const stateEmoji = '⚡';
  const expiresMin = Math.max(0, Math.round((new Date(notif.expires_at).getTime() - Date.now()) / 60000));
  const timeLabel = TIME_LABELS_AR[notif.time_option] ?? '';

  // V2.2: decode the reporter's offset snapshot for the "you will clone" badge.
  const reporterState: string = notif.reporter_offset_state ?? null;
  const reporterValue: number | 'PENDING' | null = notif.reporter_offset_value ?? null;
  const offsetBadge = (() => {
    if (!reporterState) return null;
    const stateLabelAr: Record<string, string> = {
      POSITIVE: 'إيجابي',
      NEGATIVE: 'سلبي',
      NEUTRAL: 'محايد',
      PENDING_NEGATIVE: 'سلبي معلَّق',
    };
    const stateColor: Record<string, string> = {
      POSITIVE: T.success,
      NEGATIVE: T.warning,
      NEUTRAL: T.textMuted,
      PENDING_NEGATIVE: T.warning,
    };
    const valueLabel = reporterValue === 'PENDING' || reporterState === 'PENDING_NEGATIVE'
      ? 'بانتظار Growatt'
      : reporterValue !== null
        ? `${reporterValue > 0 ? '+' : ''}${reporterValue}د`
        : '?';
    return {
      label: stateLabelAr[reporterState] ?? reporterState,
      value: valueLabel,
      color: stateColor[reporterState] ?? T.textMuted,
    };
  })();

  if (notif.response) {
    const colors = { yes: T.success, no: T.danger, ignore: T.textMuted };
    const labels = {
      yes: AR.youConfirmedYes,
      no: AR.youSaidNo,
      ignore: AR.ignored,
    };
    return (
      <View style={[ncStyles.card, { borderColor: T.border, opacity: 0.6 }]}>
        <Text style={ncStyles.reporterLine}>{stateEmoji} {notif.reporter_username ?? 'شخص ما'} — {stateLabel} ({timeLabel})</Text>
        <Text style={[ncStyles.responseLabel, { color: colors[notif.response] }]}>{labels[notif.response]}</Text>
      </View>
    );
  }

  if (isExpired) {
    return (
      <View style={[ncStyles.card, { opacity: 0.4 }]}>
        <Text style={ncStyles.reporterLine}>{stateEmoji} {notif.reporter_username ?? 'شخص ما'} — {stateLabel}</Text>
        <Text style={{ color: T.textMuted, fontSize: 11, marginTop: 4, textAlign: 'right' }}>{AR.expired}</Text>
      </View>
    );
  }

  return (
    <View style={ncStyles.card}>
      <View style={ncStyles.header}>
        <Text style={ncStyles.expiry}>⏱ {expiresMin} {AR.minutesLeft}</Text>
        <Text style={ncStyles.reporterLine}>
          {stateEmoji} <TouchableOpacity onPress={() => onReporterPress?.(notif.reporter_id)} activeOpacity={0.7} disabled={!onReporterPress}>
            <Text style={[ncStyles.reporterLine, { color: T.accent, fontWeight: '700' }]}>{notif.reporter_username ?? 'شخص ما'}</Text>
          </TouchableOpacity>
          {' '}{AR.reportedBy} {stateLabel}
        </Text>
      </View>
      <Text style={ncStyles.timeLabel}>{timeLabel}</Text>

      {/* V2.2: "Approving will clone" banner */}
      {offsetBadge && (
        <View style={[ncStyles.cloneBanner, { borderColor: offsetBadge.color + '44' }]}>
          <Text style={ncStyles.cloneBannerTitle}>عند الموافقة ستُنسخ حالة المُبلِّغ:</Text>
          <View style={ncStyles.cloneBadgeRow}>
            <View style={[ncStyles.cloneChip, { borderColor: offsetBadge.color + '66', backgroundColor: offsetBadge.color + '15' }]}>
              <Text style={[ncStyles.cloneChipText, { color: offsetBadge.color }]}>{offsetBadge.label}</Text>
            </View>
            <Text style={[ncStyles.cloneValue, { color: offsetBadge.color }]}>{offsetBadge.value}</Text>
          </View>
          {reporterState === 'PENDING_NEGATIVE' && (
            <Text style={ncStyles.clonePendingNote}>
              ⏳ الفارق سيُحسب تلقائياً عند تحوّل Growatt القادم — لك وللمُبلِّغ معاً.
            </Text>
          )}
        </View>
      )}

      <Text style={ncStyles.question}>{AR.isThisCorrect}</Text>
      <View style={ncStyles.btnRow}>
        <TouchableOpacity style={[ncStyles.btn, ncStyles.ignBtn]} onPress={() => onRespond(notif, 'ignore')} activeOpacity={0.85}>
          <Text style={ncStyles.ignBtnText}>{AR.skipBtn}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[ncStyles.btn, ncStyles.noBtn]} onPress={() => onRespond(notif, 'no')} activeOpacity={0.85}>
          <Text style={ncStyles.noBtnText}>{AR.noBtn}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[ncStyles.btn, ncStyles.yesBtn]} onPress={() => onRespond(notif, 'yes')} activeOpacity={0.85}>
          <Text style={ncStyles.yesBtnText}>{AR.yesBtn}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const ncStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: '#1e3a5a' },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 },
  reporterLine: { color: T.textSecondary, fontSize: 14, lineHeight: 20, flex: 1, textAlign: 'right' },
  expiry: { color: T.textMuted, fontSize: 11, marginRight: 8 },
  timeLabel: { color: T.textMuted, fontSize: 12, marginBottom: 10, fontStyle: 'italic', textAlign: 'right' },
  question: { color: T.textPrimary, fontSize: 15, fontWeight: '700', marginBottom: 14, textAlign: 'right' },
  btnRow: { flexDirection: 'row-reverse', gap: 8 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1 },
  yesBtn: { backgroundColor: '#052e16', borderColor: T.success },
  yesBtnText: { color: T.success, fontWeight: '700', fontSize: 13 },
  noBtn: { backgroundColor: '#2d0a0a', borderColor: T.danger },
  noBtnText: { color: T.danger, fontWeight: '700', fontSize: 13 },
  ignBtn: { backgroundColor: T.elevated, borderColor: T.border, flex: 0.6 },
  ignBtnText: { color: T.textMuted, fontWeight: '600', fontSize: 12 },
  responseLabel: { fontSize: 13, fontWeight: '700', marginTop: 6, textAlign: 'right' },
  cloneBanner: {
    backgroundColor: '#0a1929', borderRadius: 12, padding: 12, marginBottom: 12,
    borderWidth: 1,
  },
  cloneBannerTitle: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8, textAlign: 'right' },
  cloneBadgeRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  cloneChip: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  cloneChipText: { fontSize: 12, fontWeight: '800' },
  cloneValue: { fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
  clonePendingNote: { color: T.warning, fontSize: 10, marginTop: 8, textAlign: 'right', lineHeight: 15 },
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
function LeaderboardTab({ myLat, myLon }: { myLat: number | null; myLon: number | null }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (myLat === null || myLon === null) { setLoading(false); return; }
    (async () => {
      setLoading(true);
      try {
        const latDelta = 2 / 111.0;
        const lonDelta = 2 / (111.0 * Math.cos(myLat * (Math.PI / 180)));
        const { data: locations } = await supabase
          .from('user_locations')
          .select('user_id, latitude, longitude')
          .gte('latitude', myLat - latDelta)
          .lte('latitude', myLat + latDelta)
          .gte('longitude', myLon - lonDelta)
          .lte('longitude', myLon + lonDelta);

        if (!locations || locations.length === 0) { setEntries([]); setLoading(false); return; }

        const nearby2km = locations.filter(loc => {
          const R = 6371;
          const dLat = (loc.latitude - myLat) * Math.PI / 180;
          const dLon = (loc.longitude - myLon) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(myLat * Math.PI / 180) * Math.cos(loc.latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
          return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= 2.0;
        });

        if (nearby2km.length === 0) { setEntries([]); setLoading(false); return; }

        const userIds = nearby2km.map(l => l.user_id);

        const [{ data: profiles }, { data: reliabilities }, { data: responses }] = await Promise.all([
          supabase.from('user_profiles').select('id, username').in('id', userIds),
          supabase.from('user_reliability').select('user_id, reliability_score, accepted_reports, total_reports, yes_responses, total_responses').in('user_id', userIds),
          supabase.from('resync_responses').select('responder_id, response').in('responder_id', userIds),
        ]);

        const profileMap: Record<string, string | null> = {};
        for (const p of profiles ?? []) profileMap[p.id] = p.username;

        const yesMap: Record<string, number> = {};
        const totalRespMap: Record<string, number> = {};
        for (const r of responses ?? []) {
          totalRespMap[r.responder_id] = (totalRespMap[r.responder_id] ?? 0) + 1;
          if (r.response === 'yes') yesMap[r.responder_id] = (yesMap[r.responder_id] ?? 0) + 1;
        }

        const enriched = (reliabilities ?? []).map(rel => ({
          user_id: rel.user_id,
          username: profileMap[rel.user_id] ?? `مستخدم_${rel.user_id.slice(0, 6)}`,
          reliability_score: Math.round(rel.reliability_score ?? 50),
          accepted_reports: rel.accepted_reports ?? 0,
          total_reports: rel.total_reports ?? 0,
          yes_rate: totalRespMap[rel.user_id] > 0
            ? Math.round((yesMap[rel.user_id] ?? 0) / totalRespMap[rel.user_id] * 100)
            : 0,
        }))
          .sort((a, b) => b.reliability_score - a.reliability_score || b.accepted_reports - a.accepted_reports)
          .slice(0, 5);

        setEntries(enriched);
      } catch (err) {
        console.error('[LeaderboardTab]', err);
      }
      setLoading(false);
    })();
  }, [myLat, myLon]);

  if (myLat === null || myLon === null) {
    return (
      <View style={lbStyles.noLocBox}>
        <Text style={lbStyles.noLocText}>📍 شارك موقعك في تبويب القريبون لرؤية المتميزين المحليين.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={lbStyles.center}>
        <ActivityIndicator color={T.accent} size="large" />
        <Text style={lbStyles.loadingText}>جارٍ البحث عن المُبلِّغين المحليين…</Text>
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <View style={lbStyles.emptyBox}>
        <Text style={{ fontSize: 48, marginBottom: 14 }}>🏆</Text>
        <Text style={lbStyles.emptyTitle}>لا يوجد مميزون محليون بعد</Text>
        <Text style={lbStyles.emptySub}>لا يوجد مُبلِّغون ضمن 2 كم. ادعُ الجيران للانضمام وابدأ مشاركة بلاغات الكهرباء.</Text>
      </View>
    );
  }

  return (
    <View style={lbStyles.root}>
      <View style={lbStyles.headerRow}>
        <Text style={lbStyles.subtitle}>{entries.length} مُبلِّغ محلي</Text>
        <Text style={lbStyles.sectionLabel}>أفضل المُبلِّغين ضمن 2 كم</Text>
      </View>
      {entries.map((e, i) => {
        const badge = getReliabilityBadge(e.reliability_score);
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
        return (
          <View key={e.user_id} style={[lbStyles.row, i === 0 && lbStyles.rowFirst]}>
            <View style={lbStyles.info}>
              <View style={lbStyles.nameRow}>
                <View style={[lbStyles.badge, { borderColor: badge.color + '44' }]}>
                  <Text style={[lbStyles.badgeText, { color: badge.color }]}>{badge.label}</Text>
                </View>
                <Text style={lbStyles.username}>{e.username}</Text>
              </View>
              <View style={lbStyles.statsRow}>
                <Text style={lbStyles.stat}><Text style={{ color: T.accent, fontWeight: '700' }}>{e.yes_rate}%</Text> نسبة نعم</Text>
                <Text style={lbStyles.dot}> · </Text>
                <Text style={lbStyles.stat}><Text style={{ color: T.textPrimary, fontWeight: '700' }}>{e.accepted_reports}</Text> بلاغ مقبول</Text>
                <Text style={lbStyles.dot}> · </Text>
                <Text style={lbStyles.stat}><Text style={{ color: T.success, fontWeight: '700' }}>{e.reliability_score}%</Text> موثوقية</Text>
              </View>
            </View>
            <Text style={lbStyles.medal}>{medal}</Text>
          </View>
        );
      })}
    </View>
  );
}

const lbStyles = StyleSheet.create({
  root: { paddingTop: 4 },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  subtitle: { color: T.textMuted, fontSize: 11 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, backgroundColor: T.surface, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: T.border },
  rowFirst: { borderColor: '#854d0e', backgroundColor: '#1c1000' },
  medal: { fontSize: 24, minWidth: 32, textAlign: 'center' },
  info: { flex: 1 },
  nameRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 5 },
  username: { color: T.textPrimary, fontSize: 15, fontWeight: '700' },
  badge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2 },
  badgeText: { fontSize: 9, fontWeight: '600' },
  statsRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', alignItems: 'center' },
  stat: { color: T.textMuted, fontSize: 11 },
  dot: { color: T.border, fontSize: 11 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  loadingText: { color: T.textMuted, marginTop: 12, fontSize: 13 },
  emptyBox: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 24 },
  emptyTitle: { color: T.textSecondary, fontSize: 18, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  emptySub: { color: T.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 22 },
  noLocBox: { backgroundColor: T.surface, borderRadius: 14, padding: 20, margin: 16, borderWidth: 1, borderColor: T.border },
  noLocText: { color: T.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
});

// ── Suggested Users ───────────────────────────────────────────────────────────
function SuggestedUsers({ nearbyUsers, following, outgoing, offsetMinutes, onFollow }: {
  nearbyUsers: any[];
  following: any[];
  outgoing: any[];
  offsetMinutes: number;
  onFollow: (userId: string) => void;
}) {
  const scored = nearbyUsers
    .filter(u => {
      const alreadyFollowing = following.some(f => f.target_id === u.user_id);
      const alreadySent = outgoing.some(f => f.target_id === u.user_id);
      return !alreadyFollowing && !alreadySent;
    })
    .map(u => {
      const relScore = (u.reliabilityScore ?? 50) / 100;
      const offsetDiff = Math.abs((u.offsetMinutes ?? 0) - offsetMinutes);
      const offsetSim = Math.max(0, 1 - offsetDiff / 60);
      const participationScore = Math.min(1, (u.totalReports ?? 0) / 10);
      const total = relScore * 0.6 + offsetSim * 0.2 + participationScore * 0.2;
      return { ...u, suggestionScore: total };
    })
    .sort((a, b) => b.suggestionScore - a.suggestionScore)
    .slice(0, 3);

  if (scored.length === 0) return null;

  return (
    <View style={suStyles.section}>
      <View style={suStyles.header}>
        <Text style={suStyles.headerSub}>بناءً على الموثوقية وسلوك الكهرباء</Text>
        <Text style={suStyles.headerTitle}>⭐ مستخدمون مقترحون</Text>
      </View>
      {scored.map(u => {
        const badge = getReliabilityBadge(u.reliabilityScore);
        const dist = u.distanceKm < 0.1
          ? `${Math.round(u.distanceKm * 1000)}م`
          : `${u.distanceKm.toFixed(2)}كم`;
        return (
          <View key={u.user_id} style={suStyles.card}>
            <TouchableOpacity style={suStyles.followBtn} onPress={() => onFollow(u.user_id)} activeOpacity={0.85}>
              <Text style={suStyles.followBtnText}>+ {AR.follow}</Text>
            </TouchableOpacity>
            <View style={suStyles.left}>
              <View style={{ flex: 1 }}>
                <View style={suStyles.nameRow}>
                  <View style={[suStyles.badge, { borderColor: badge.color + '44' }]}>
                    <Text style={[suStyles.badgeText, { color: badge.color }]}>{badge.label}</Text>
                  </View>
                  <Text style={suStyles.username}>{u.username ?? 'مجهول'}</Text>
                </View>
                <Text style={suStyles.meta}>
                  {dist} {AR.away} · {u.reliabilityScore}% موثوقية
                  {u.totalReports > 0 ? ` · ${u.totalReports} بلاغات` : ''}
                </Text>
              </View>
              <View style={suStyles.avatarCircle}>
                <Text style={suStyles.avatarText}>{(u.username ?? '?')[0].toUpperCase()}</Text>
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const suStyles = StyleSheet.create({
  section: { backgroundColor: '#0a1929', borderRadius: 16, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#1e3a5a' },
  header: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 12 },
  headerTitle: { color: T.accent, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  headerSub: { color: T.textMuted, fontSize: 10, marginRight: 'auto' },
  card: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#122238' },
  left: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  avatarCircle: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1e3a5a', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: T.accent, fontSize: 15, fontWeight: '800' },
  nameRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 2 },
  username: { color: T.textPrimary, fontSize: 14, fontWeight: '700' },
  badge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2 },
  badgeText: { fontSize: 9, fontWeight: '600' },
  meta: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  followBtn: { backgroundColor: T.primary, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  followBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});

// ── Nearby User Card ──────────────────────────────────────────────────────────
function NearbyUserCard({ item, followStatus, onFollowAction }: {
  item: any;
  followStatus: 'none' | 'pending' | 'accepted' | 'incoming';
  onFollowAction: (userId: string) => void;
}) {
  const badge = getReliabilityBadge(item.reliabilityScore);
  const distLabel = item.distanceKm < 0.1
    ? `${Math.round(item.distanceKm * 1000)}م`
    : `${item.distanceKm.toFixed(2)}كم`;

  const followBtnLabel =
    followStatus === 'accepted' ? `✓ ${AR.following}`
    : followStatus === 'pending' ? AR.followPending
    : followStatus === 'incoming' ? AR.followAccept
    : `+ ${AR.follow}`;

  const followBtnStyle =
    followStatus === 'accepted' ? nuStyles.followBtnActive
    : followStatus === 'pending' ? nuStyles.followBtnPending
    : followStatus === 'incoming' ? nuStyles.followBtnIncoming
    : nuStyles.followBtnDefault;

  return (
    <View style={nuStyles.card}>
      <View style={nuStyles.header}>
        <TouchableOpacity
          style={[nuStyles.followBtn, followBtnStyle]}
          onPress={() => onFollowAction(item.user_id)}
          activeOpacity={0.8}
          disabled={followStatus === 'pending'}
        >
          <Text style={[nuStyles.followBtnText,
            followStatus === 'accepted' && { color: T.accent },
            followStatus === 'incoming' && { color: T.warning },
          ]}>
            {followBtnLabel}
          </Text>
        </TouchableOpacity>
        <View style={nuStyles.headerLeft}>
          <Text style={nuStyles.username}>{item.username ?? 'مجهول'}</Text>
          <View style={nuStyles.metaRow}>
            <View style={[nuStyles.badge, { borderColor: badge.color + '44' }]}>
              <Text style={[nuStyles.badgeText, { color: badge.color }]}>{badge.label}</Text>
            </View>
            <Text style={nuStyles.distance}>{distLabel}</Text>
          </View>
        </View>
      </View>

      <View style={nuStyles.statsRow}>
        {item.lastReportAt && (
          <>
            <View style={nuStyles.stat}>
              <Text style={[nuStyles.statVal, { fontSize: 10 }]}>
                {new Date(item.lastReportAt).toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' })}
              </Text>
              <Text style={nuStyles.statLabel}>آخر نشاط</Text>
            </View>
            <View style={nuStyles.statDivider} />
          </>
        )}
        <View style={nuStyles.stat}>
          <Text style={[nuStyles.statVal, { fontSize: 11 }]}>
            {item.offsetMinutes > 0 ? '+' : ''}{item.offsetMinutes}د
          </Text>
          <Text style={nuStyles.statLabel}>الفارق</Text>
        </View>
        <View style={nuStyles.statDivider} />
        <View style={nuStyles.stat}>
          <Text style={nuStyles.statVal}>{item.totalReports}</Text>
          <Text style={nuStyles.statLabel}>بلاغات</Text>
        </View>
        <View style={nuStyles.statDivider} />
        <View style={nuStyles.stat}>
          <Text style={nuStyles.statVal}>{item.reliabilityScore}%</Text>
          <Text style={nuStyles.statLabel}>موثوقية</Text>
        </View>
      </View>
    </View>
  );
}

const nuStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: T.border },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  headerLeft: { flex: 1 },
  username: { color: T.textPrimary, fontSize: 16, fontWeight: '700', marginBottom: 4, textAlign: 'right' },
  metaRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  distance: { color: T.textMuted, fontSize: 12 },
  badge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  followBtn: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1 },
  followBtnDefault: { backgroundColor: T.primary, borderColor: T.primary },
  followBtnActive: { backgroundColor: '#001a2e', borderColor: T.accent },
  followBtnPending: { backgroundColor: T.elevated, borderColor: T.border, opacity: 0.7 },
  followBtnIncoming: { backgroundColor: '#1a120a', borderColor: T.warning },
  followBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  statsRow: { flexDirection: 'row-reverse', backgroundColor: T.bg, borderRadius: 10, paddingVertical: 10, alignItems: 'center', justifyContent: 'space-evenly' },
  stat: { alignItems: 'center', flex: 1 },
  statVal: { color: T.textPrimary, fontSize: 14, fontWeight: '800', marginBottom: 2 },
  statLabel: { color: T.textMuted, fontSize: 9, fontWeight: '600', letterSpacing: 0.5 },
  statDivider: { width: 1, height: 28, backgroundColor: T.border },
});

// ── Follow Request Card ───────────────────────────────────────────────────────
function FollowRequestCard({ follow, onAccept, onReject }: {
  follow: any; onAccept: () => void; onReject: () => void;
}) {
  return (
    <View style={frStyles.card}>
      <View style={frStyles.btns}>
        <TouchableOpacity style={frStyles.rejectBtn} onPress={onReject} activeOpacity={0.85}>
          <Text style={frStyles.rejectText}>{AR.decline}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={frStyles.acceptBtn} onPress={onAccept} activeOpacity={0.85}>
          <Text style={frStyles.acceptText}>{AR.accept}</Text>
        </TouchableOpacity>
      </View>
      <View style={frStyles.info}>
        <View>
          <Text style={frStyles.name}>{follow.requester_username ?? 'مجهول'}</Text>
          <Text style={frStyles.sub}>{AR.wantsToFollow}</Text>
        </View>
        <Text style={frStyles.icon}>👤</Text>
      </View>
    </View>
  );
}

const frStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: T.border, flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  info: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  icon: { fontSize: 24 },
  name: { color: T.textPrimary, fontSize: 15, fontWeight: '700', textAlign: 'right' },
  sub: { color: T.textMuted, fontSize: 11, marginTop: 2, textAlign: 'right' },
  btns: { flexDirection: 'row-reverse', gap: 8 },
  acceptBtn: { backgroundColor: T.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  acceptText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  rejectBtn: { backgroundColor: T.elevated, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: T.border },
  rejectText: { color: T.textMuted, fontWeight: '600', fontSize: 13 },
});

// ── History Card ──────────────────────────────────────────────────────────────
// TMMS V2.2: only ON entries appear (OFF filtered out at the data layer).
// Added: Offset State badge + Generated ON metadata for each entry.
function HistoryCard({ entry, onReporterPress }: {
  entry: any;
  onReporterPress?: (reporterId: string) => void;
}) {
  const isOn = true;
  const color = T.success;
  const effectiveTime = new Date(entry.effective_transition_at).toLocaleString('ar-SA', {
    timeZone: 'Asia/Aden', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const confirmedTime = new Date(entry.confirmed_at).toLocaleString('ar-SA', {
    timeZone: 'Asia/Aden', timeStyle: 'short',
  });

  // V2.2: decode the entry's cloned offset state for the badge.
  const offsetState: string | null = entry.offset_state ?? null;
  const offsetValue: number | 'PENDING' | null = entry.offset_value ?? null;
  const stateLabelAr: Record<string, string> = {
    POSITIVE: 'إيجابي',
    NEGATIVE: 'سلبي',
    NEUTRAL: 'محايد',
    PENDING_NEGATIVE: 'سلبي معلَّق',
  };
  const stateColor: Record<string, string> = {
    POSITIVE: T.success,
    NEGATIVE: T.warning,
    NEUTRAL: T.textMuted,
    PENDING_NEGATIVE: T.warning,
  };
  const badgeColor = offsetState ? (stateColor[offsetState] ?? T.textMuted) : T.textMuted;
  const badgeLabel = offsetState ? (stateLabelAr[offsetState] ?? offsetState) : null;
  const valueLabel = offsetValue === 'PENDING' || offsetState === 'PENDING_NEGATIVE'
    ? 'بانتظار Growatt'
    : (typeof offsetValue === 'number' ? `${offsetValue > 0 ? '+' : ''}${offsetValue}د` : null);

  // V2.2: Generated ON metadata
  const genOnStart = entry.generated_on_start_iso;
  const genOnDuration = entry.generated_on_duration_min;
  const genOnRefKind = entry.generated_on_reference_kind;

  return (
    <View style={hcStyles.card}>
      <View style={hcStyles.content}>
        <View style={hcStyles.headerRow}>
          <Text style={hcStyles.source}>{entry.source === 'community_resync' ? '👥 مجتمعي' : entry.source}</Text>
          <Text style={[hcStyles.state, { color }]}>⚡ {AR.gridOn}</Text>
        </View>
        <Text style={hcStyles.time}>الوقت الفعلي: {effectiveTime} (اليمن)</Text>
        <Text style={hcStyles.reporter}>
          {AR.reportedByLabel}:{' '}
          {entry.reporter_id && onReporterPress ? (
            <Text
              style={{ color: T.accent, fontWeight: '700' }}
              onPress={() => onReporterPress(entry.reporter_id)}
            >
              {entry.reporter_username ?? 'مجهول'}
            </Text>
          ) : (
            <Text style={{ color: T.textSecondary }}>{entry.reporter_username ?? 'مجهول'}</Text>
          )}
          {'  '}· أُكّد في {confirmedTime}
        </Text>

        {/* V2.2: Offset State badge */}
        {badgeLabel && (
          <View style={hcStyles.offsetRow}>
            <View style={[hcStyles.offsetChip, { borderColor: badgeColor + '55', backgroundColor: badgeColor + '12' }]}>
              <Text style={[hcStyles.offsetChipLabel, { color: badgeColor }]}>{badgeLabel}</Text>
            </View>
            {valueLabel && (
              <Text style={[hcStyles.offsetValue, { color: badgeColor }]}>{valueLabel}</Text>
            )}
            {offsetState === 'PENDING_NEGATIVE' && (
              <Text style={hcStyles.pendingNote}>⏳ سيُحسب تلقائياً</Text>
            )}
          </View>
        )}

        {/* V2.2: Generated ON metadata */}
        {genOnStart && genOnDuration && (
          <View style={hcStyles.genOnRow}>
            <Text style={hcStyles.genOnText}>
              ⚡ حالة تشغيل مُولّدة · {genOnDuration >= 60 ? `${Math.floor(genOnDuration / 60)}س ${genOnDuration % 60}د` : `${genOnDuration}د`}
              {genOnRefKind === 'active' ? ' · متابعة دورة مرجعية نشطة' : ''}
            </Text>
          </View>
        )}
      </View>
      <View style={[hcStyles.bar, { backgroundColor: color }]} />
    </View>
  );
}

const hcStyles = StyleSheet.create({
  card: { flexDirection: 'row-reverse', backgroundColor: T.surface, borderRadius: 14, marginBottom: 8, overflow: 'hidden', borderWidth: 1, borderColor: T.border },
  bar: { width: 4 },
  content: { flex: 1, padding: 14 },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  state: { fontSize: 15, fontWeight: '800' },
  source: { color: T.textMuted, fontSize: 11 },
  time: { color: T.textSecondary, fontSize: 12, marginBottom: 3, textAlign: 'right' },
  reporter: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  offsetRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginTop: 8 },
  offsetChip: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  offsetChipLabel: { fontSize: 10, fontWeight: '700' },
  offsetValue: { fontSize: 13, fontWeight: '800' },
  pendingNote: { color: T.warning, fontSize: 10, fontWeight: '600' },
  genOnRow: { marginTop: 6, backgroundColor: '#052e16', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.success + '33' },
  genOnText: { color: T.success, fontSize: 10, fontWeight: '600', textAlign: 'right' },
});

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function CommunityScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('nearby');
  const [myLat, setMyLat] = useState<number | null>(null);
  const [myLon, setMyLon] = useState<number | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'requesting' | 'denied' | 'granted'>('idle');
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationSaved, setLocationSaved] = useState(false);
  const [reportModalVisible, setReportModalVisible] = useState(false);

  const { nearbyUsers, loading: nearbyLoading, refresh: refreshNearby } = useNearbyUsers(myLat, myLon);
  const { following, followers, pending, outgoing, loading: followsLoading, sendRequest, respondToRequest, cancelOrUnfollow, getStatusWith, refresh: refreshFollows } = useFollows();
  const { submitting, submitReport } = useUtilityReports();
  const { notifications, history, loading: notifLoading, pendingCount, respond, refresh: refreshNotifs } = useResyncNotifications();
  const { score: myScore } = useMyReliability(user?.id);
  const [myOffsetMinutes, setMyOffsetMinutes] = React.useState(0);
  const { applyResync, resyncPoint } = useResync();
  const { offset } = useUserOffset();
  const { mode: transitionMode } = useTransitionMode();
  const { userPrediction } = useUserPredictions(offset?.offset_minutes ?? 0, resyncPoint, transitionMode, null);
  const { captureSnapshot } = useStatusSnapshot();

  useEffect(() => { registerPushToken(); }, []);

  useEffect(() => {
    if (!user) return;
    supabase.from('user_offsets').select('offset_minutes').eq('user_id', user.id).maybeSingle()
      .then(({ data }) => { if (data) setMyOffsetMinutes(data.offset_minutes ?? 0); });
  }, [user]);

  useEffect(() => { requestLocation(); }, []);

  const requestLocation = useCallback(async () => {
    setLocationStatus('requesting');
    try {
      const { status: current } = await Location.getForegroundPermissionsAsync();
      let finalStatus = current;

      if (current !== 'granted') {
        const { status: requested } = await Location.requestForegroundPermissionsAsync();
        finalStatus = requested;
      }

      if (finalStatus !== 'granted') {
        setLocationStatus('denied');
        return;
      }

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 5000,
        distanceInterval: 0,
      });
      setMyLat(loc.coords.latitude);
      setMyLon(loc.coords.longitude);
      setLocationStatus('granted');
    } catch (err) {
      console.warn('[Community] Location error:', err);
      setLocationStatus('denied');
    }
  }, []);

  const handleSaveLocation = useCallback(async () => {
    if (!myLat || !myLon || !user) return;
    setSavingLocation(true);
    const { error } = await supabase
      .from('user_locations')
      .upsert({ user_id: user.id, latitude: myLat, longitude: myLon, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) { Alert.alert(AR.error, error.message); }
    else {
      setLocationSaved(true);
      setTimeout(() => setLocationSaved(false), 4000);
      await refreshNearby();
    }
    setSavingLocation(false);
  }, [myLat, myLon, user, refreshNearby]);

  const handleFollowAction = useCallback(async (userId: string) => {
    const status = getStatusWith(userId);
    if (status === 'accepted') {
      const row = following.find(f => f.target_id === userId);
      if (row) await cancelOrUnfollow(row.id);
    } else if (status === 'incoming') {
      const row = pending.find(f => f.requester_id === userId);
      if (row) await respondToRequest(row.id, true);
    } else if (status === 'none') {
      await sendRequest(userId);
    }
  }, [getStatusWith, following, pending, cancelOrUnfollow, respondToRequest, sendRequest]);

  // TMMS V2.2: handleReport — always UTILITY_ON, engine computes Period 1/2/3.
  const handleReport = useCallback(async (time: TimeOption) => {
    await captureSnapshot(
      userPrediction?.currentState ?? 'OFF',
      userPrediction?.currentStateStartIso ?? null,
      offset?.offset_minutes ?? 0,
      resyncPoint ?? null,
      'user_report',
    );

    const { selfResync, error } = await submitReport('UTILITY_ON' as any, time);
    setReportModalVisible(false);
    if (error) {
      Alert.alert(AR.error, error);
    } else {
      if (selfResync) await applyResync(selfResync);
      Alert.alert(
        AR.reportShared,
        'تم إنشاء "حالة تشغيل مُولّدة" في خطّك الزمني وتحديث الجداول لديك ولدى من يتابعك. لا حاجة للإبلاغ عن الانطفاء — سيتولّاه النظام تلقائياً.',
      );
    }
  }, [submitReport, applyResync, captureSnapshot, userPrediction, offset, resyncPoint]);

  // TMMS V2.2: handleRespond — YES clones reporter's sync state.
  const handleRespond = useCallback(async (notif: any, response: 'yes' | 'no' | 'ignore') => {
    const { yesResult, error } = await respond(notif, response);
    if (error) {
      Alert.alert(AR.error, error);
    } else if (response === 'yes' && yesResult) {
      await captureSnapshot(
        userPrediction?.currentState ?? 'OFF',
        userPrediction?.currentStateStartIso ?? null,
        offset?.offset_minutes ?? 0,
        resyncPoint ?? null,
        'community_confirm',
      );
      let reporterReliability: number | null = null;
      if (notif.reporter_id) {
        try {
          const { data } = await supabase
            .from('user_reliability')
            .select('reliability_score')
            .eq('user_id', notif.reporter_id)
            .maybeSingle();
          if (data) reporterReliability = Math.round(data.reliability_score ?? 50);
        } catch (_) {}
      }
      await applyResync({
        syncedState: 'ON',
        syncedAtIso: yesResult.effectiveTransitionAt,
        appliedAtIso: new Date().toISOString(),
        reporterName: yesResult.reporterName ?? notif.reporter_username ?? null,
        reporterReliability,
        offsetState: yesResult.offsetState,
        offsetValue: yesResult.offsetValue,
        timelineAlignment: yesResult.timelineAlignment,
        generatedOnStartIso: yesResult.generatedOnStartIso,
        generatedOnDurationMin: yesResult.generatedOnDurationMin,
        generatedOnReferenceIso: yesResult.generatedOnReferenceIso,
        generatedOnReferenceKind: yesResult.generatedOnReferenceKind,
      } as any);

      const stateLabelAr: Record<string, string> = {
        POSITIVE: 'إيجابي',
        NEGATIVE: 'سلبي',
        NEUTRAL: 'محايد',
        PENDING_NEGATIVE: 'سلبي معلَّق',
      };
      const valueLabel = yesResult.offsetValue === 'PENDING' || yesResult.offsetState === 'PENDING_NEGATIVE'
        ? 'بانتظار تحوّل Growatt القادم'
        : `${(yesResult.offsetValue as number) > 0 ? '+' : ''}${yesResult.offsetValue}د`;
      Alert.alert(
        AR.scheduleUpdated,
        `تمت مزامنة خطّك الزمني مع بلاغ المُبلِّغ وفق قواعد TMMS V2.2. الفارق المنسوخ: ${stateLabelAr[yesResult.offsetState]} · ${valueLabel}. لا يؤثر تأكيدك على وقت البلاغ الأصلي — يُؤثّر فقط على موثوقية المُبلِّغ.`,
      );
    }
  }, [respond, applyResync, captureSnapshot, userPrediction, offset, resyncPoint]);

  const myBadge = myScore ? getReliabilityBadge(myScore.reliability_score) : null;
  const { profile } = useAuth();
  const displayName = profile?.username ?? profile?.email?.split('@')[0] ?? null;

  const isParticipationRestricted = myScore
    ? myScore.total_responses >= 10 &&
      (myScore.yes_responses ?? 0) / myScore.total_responses < 0.3
    : false;

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            {myBadge && (
              <View style={[styles.badge, { borderColor: myBadge.color + '44' }]}>
                <Text style={[styles.badgeText, { color: myBadge.color }]}>{myBadge.label}</Text>
              </View>
            )}
            <Text style={styles.headerName}>{displayName ?? 'مستخدم'}</Text>
          </View>
          <Text style={styles.headerTitle}>👥 المجتمع</Text>
        </View>

        {/* Tab bar */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabBar}>
          {([
            { key: 'nearby', label: 'القريبون', icon: '📍' },
            { key: 'notifications', label: `الإشعارات${pendingCount > 0 ? ` (${pendingCount})` : ''}`, icon: '🔔' },
            { key: 'history', label: 'السجل', icon: '📋' },
            { key: 'following', label: 'المتابَعون', icon: '👥' },
            { key: 'leaderboard', label: 'المتصدرون', icon: '🏆' },
          ] as const).map(t => (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, tab === t.key && styles.tabActive]}
              onPress={() => setTab(t.key)}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>
                {t.icon} {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Content */}
      <View style={{ flex: 1 }}>
        {tab === 'nearby' && (
          <>
            {/* Location bar */}
            <View style={styles.locBar}>
              {locationStatus === 'granted' ? (
                <View style={styles.locGranted}>
                  <TouchableOpacity
                    style={[styles.locSaveBtn, savingLocation && { opacity: 0.6 }]}
                    onPress={handleSaveLocation}
                    disabled={savingLocation}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.locSaveText}>
                      {savingLocation ? '...' : locationSaved ? '✓ تم الحفظ' : '💾 حفظ'}
                    </Text>
                  </TouchableOpacity>
                  <Text style={styles.locText}>📍 {myLat?.toFixed(4)}, {myLon?.toFixed(4)}</Text>
                </View>
              ) : locationStatus === 'denied' ? (
                <View style={styles.locDenied}>
                  <TouchableOpacity style={styles.locRetryBtn} onPress={requestLocation} activeOpacity={0.85}>
                    <Text style={styles.locRetryText}>إعادة المحاولة</Text>
                  </TouchableOpacity>
                  <Text style={styles.locDeniedText}>📍 تم رفض إذن الموقع</Text>
                </View>
              ) : (
                <View style={styles.locRequesting}>
                  <ActivityIndicator color={T.accent} size="small" />
                  <Text style={styles.locText}>جارٍ طلب الموقع...</Text>
                </View>
              )}
            </View>

            {/* Report button */}
            <View style={styles.reportBar}>
              <TouchableOpacity
                style={[styles.reportBtn, isParticipationRestricted && { opacity: 0.5 }]}
                onPress={() => setReportModalVisible(true)}
                disabled={isParticipationRestricted}
                activeOpacity={0.85}
              >
                <Text style={styles.reportBtnText}>⚡ {AR.reportUtilityOn}</Text>
              </TouchableOpacity>
              {isParticipationRestricted && (
                <Text style={styles.restrictionText}>⚠️ مُقيّد — نسبة الموافقة منخفضة</Text>
              )}
            </View>

            <ReportModal
              visible={reportModalVisible}
              onClose={() => setReportModalVisible(false)}
              onSubmit={handleReport}
              submitting={submitting}
            />

            <FlatList
              data={nearbyUsers}
              keyExtractor={u => u.user_id}
              contentContainerStyle={{ padding: 16, paddingTop: 0 }}
              renderItem={({ item }) => (
                <NearbyUserCard
                  item={item}
                  followStatus={getStatusWith(item.user_id)}
                  onFollowAction={handleFollowAction}
                />
              )}
              ListEmptyComponent={
                nearbyLoading ? (
                  <View style={styles.center}>
                    <ActivityIndicator color={T.accent} />
                    <Text style={styles.emptySub}>جارٍ البحث...</Text>
                  </View>
                ) : (
                  <View style={styles.emptyBox}>
                    <Text style={{ fontSize: 48, marginBottom: 14 }}>📍</Text>
                    <Text style={styles.emptyTitle}>لا يوجد مستخدمون قريبون</Text>
                    <Text style={styles.emptySub}>جرب حفظ موقعك أو عد لاحقاً.</Text>
                  </View>
                )
              }
            />

            <SuggestedUsers
              nearbyUsers={nearbyUsers}
              following={following}
              outgoing={outgoing}
              offsetMinutes={myOffsetMinutes}
              onFollow={handleFollowAction}
            />
          </>
        )}

        {tab === 'notifications' && (
          <FlatList
            data={notifications}
            keyExtractor={n => String(n.id)}
            contentContainerStyle={{ padding: 16 }}
            renderItem={({ item }) => (
              <NotifCard
                notif={item}
                onRespond={handleRespond}
                onReporterPress={(reporterId) => router.push(`/user/${reporterId}`)}
              />
            )}
            ListEmptyComponent={
              notifLoading ? (
                <View style={styles.center}>
                  <ActivityIndicator color={T.accent} />
                  <Text style={styles.emptySub}>جارٍ التحميل...</Text>
                </View>
              ) : (
                <View style={styles.emptyBox}>
                  <Text style={{ fontSize: 48, marginBottom: 14 }}>🔔</Text>
                  <Text style={styles.emptyTitle}>لا توجد إشعارات</Text>
                  <Text style={styles.emptySub}>ستظهر هنا بلاغات المجتمع من المستخدمين الذين تتابعهم.</Text>
                </View>
              )
            }
          />
        )}

        {tab === 'history' && (
          <FlatList
            data={history}
            keyExtractor={h => String(h.id)}
            contentContainerStyle={{ padding: 16 }}
            renderItem={({ item }) => (
              <HistoryCard
                entry={item}
                onReporterPress={(reporterId) => router.push(`/user/${reporterId}`)}
              />
            )}
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Text style={{ fontSize: 48, marginBottom: 14 }}>📋</Text>
                <Text style={styles.emptyTitle}>لا يوجد سجل</Text>
                <Text style={styles.emptySub}>ستظهر هنا بلاغاتك وتأكيداتك السابقة.</Text>
              </View>
            }
          />
        )}

        {tab === 'following' && (
          <FlatList
            data={[...following, ...pending]}
            keyExtractor={f => String(f.id)}
            contentContainerStyle={{ padding: 16 }}
            renderItem={({ item }) => {
              const isPending = !item.target_id; // pending requests don't have target_id in this shape
              return (
                <View style={styles.followRow}>
                  <Text style={styles.followName}>
                    {isPending ? `⏳ ${item.requester_username ?? 'مجهول'}` : `👤 ${item.target_username ?? 'مجهول'}`}
                  </Text>
                  {isPending && (
                    <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
                      <TouchableOpacity onPress={() => respondToRequest(item.id, false)} style={styles.followReject}>
                        <Text style={styles.followRejectText}>رفض</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => respondToRequest(item.id, true)} style={styles.followAccept}>
                        <Text style={styles.followAcceptText}>قبول</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Text style={{ fontSize: 48, marginBottom: 14 }}>👥</Text>
                <Text style={styles.emptyTitle}>لا تتابع أحداً بعد</Text>
                <Text style={styles.emptySub}>ابحث عن مستخدمين قريبين وابدأ بالمتابعة.</Text>
              </View>
            }
          />
        )}

        {tab === 'leaderboard' && (
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            <LeaderboardTab myLat={myLat} myLon={myLon} />
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.border, paddingHorizontal: 16, paddingBottom: 8 },
  headerRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  headerLeft: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  headerName: { color: T.textPrimary, fontSize: 14, fontWeight: '700' },
  headerTitle: { color: T.textPrimary, fontSize: 18, fontWeight: '800' },
  badge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 9, fontWeight: '600' },
  tabBar: { flexDirection: 'row-reverse', gap: 6, paddingBottom: 4 },
  tab: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: T.elevated },
  tabActive: { backgroundColor: T.primary + '33', borderWidth: 1, borderColor: T.primary + '66' },
  tabText: { color: T.textMuted, fontSize: 11, fontWeight: '600' },
  tabTextActive: { color: T.accent, fontWeight: '700' },
  locBar: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.border },
  locGranted: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  locText: { color: T.textMuted, fontSize: 12 },
  locSaveBtn: { backgroundColor: T.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  locSaveText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  locDenied: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  locDeniedText: { color: T.danger, fontSize: 12 },
  locRetryBtn: { backgroundColor: T.elevated, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border },
  locRetryText: { color: T.textSecondary, fontSize: 11 },
  locRequesting: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  reportBar: { paddingHorizontal: 16, paddingVertical: 10 },
  reportBtn: { backgroundColor: T.success, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  reportBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  restrictionText: { color: T.warning, fontSize: 10, textAlign: 'center', marginTop: 6 },
  center: { alignItems: 'center', paddingVertical: 40 },
  emptyBox: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle: { color: T.textSecondary, fontSize: 18, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  emptySub: { color: T.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 22 },
  followRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', backgroundColor: T.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: T.border },
  followName: { color: T.textPrimary, fontSize: 14, fontWeight: '700' },
  followAccept: { backgroundColor: T.success, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  followAcceptText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  followReject: { backgroundColor: T.elevated, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border },
  followRejectText: { color: T.textMuted, fontSize: 11 },
});
