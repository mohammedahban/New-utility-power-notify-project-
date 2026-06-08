import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Animated,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../../lib/supabase';
import { useFollows } from '../../../hooks/useFollows';
import { useAuth } from '../../../contexts/AuthContext';
import { getReliabilityBadge } from '../../../hooks/useReliability';

const T = {
  bg: '#060d1a', surface: '#0d1526', elevated: '#162035',
  border: '#1e2d45', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#4a5e7a',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

interface ReporterProfile {
  id: string;
  username: string | null;
  email: string | null;
  created_at: string;
}

interface ReporterReliability {
  reliability_score: number;
  community_trust_score: number;
  total_reports: number;
  accepted_reports: number;
  rejected_reports: number;
  total_responses: number;
  yes_responses: number;
  no_responses: number;
  ignored_notifications: number;
  last_report_at: string | null;
}

interface RecentReport {
  id: number;
  reported_state: 'UTILITY_ON' | 'UTILITY_OFF';
  time_option: string;
  estimated_transition_at: string;
  created_at: string;
  yesCount: number;
}

function StatCard({ value, label, color, sub }: {
  value: string; label: string; color?: string; sub?: string;
}) {
  return (
    <View style={scStyles.card}>
      <Text style={[scStyles.value, color ? { color } : {}]}>{value}</Text>
      {sub ? <Text style={scStyles.sub}>{sub}</Text> : null}
      <Text style={scStyles.label}>{label}</Text>
    </View>
  );
}
const scStyles = StyleSheet.create({
  card: { flex: 1, backgroundColor: T.elevated, borderRadius: 14, padding: 14, alignItems: 'center', gap: 2, borderWidth: 1, borderColor: T.border },
  value: { color: T.textPrimary, fontSize: 22, fontWeight: '900' },
  sub: { color: T.textMuted, fontSize: 10, marginTop: -2 },
  label: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 0.8, textAlign: 'center', marginTop: 2 },
});

function ReliabilityRing({ score }: { score: number }) {
  const badge = getReliabilityBadge(score);
  const animVal = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animVal, { toValue: score, duration: 900, useNativeDriver: false }).start();
  }, [score]);

  return (
    <View style={rrStyles.wrap}>
      <View style={[rrStyles.ring, { borderColor: badge.color }]}>
        <Text style={[rrStyles.score, { color: badge.color }]}>{score}%</Text>
        <Text style={rrStyles.label}>موثوقية</Text>
      </View>
      <View style={[rrStyles.badge, { borderColor: badge.color + '55', backgroundColor: badge.color + '18' }]}>
        <Text style={[rrStyles.badgeText, { color: badge.color }]}>{badge.label}</Text>
      </View>
    </View>
  );
}
const rrStyles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 10 },
  ring: { width: 100, height: 100, borderRadius: 50, borderWidth: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: T.elevated },
  score: { fontSize: 26, fontWeight: '900' },
  label: { color: T.textMuted, fontSize: 10, fontWeight: '600' },
  badge: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1 },
  badgeText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
});

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, max > 0 ? Math.round((value / max) * 100) : 0);
  return (
    <View style={{ height: 4, backgroundColor: T.elevated, borderRadius: 2, overflow: 'hidden', flex: 1 }}>
      <View style={{ width: `${pct}%`, height: 4, backgroundColor: color, borderRadius: 2 }} />
    </View>
  );
}

const TIME_LABELS: Record<string, string> = {
  now: 'الآن',
  '5min': 'منذ 5 د',
  '10min': 'منذ 10 د',
  '15min': 'منذ 15 د',
  '20min': 'منذ 20 د',
};

export default function ReporterDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();

  const [profile, setProfile] = useState<ReporterProfile | null>(null);
  const [reliability, setReliability] = useState<ReporterReliability | null>(null);
  const [recentReports, setRecentReports] = useState<RecentReport[]>([]);
  const [loading, setLoading] = useState(true);

  const { following, outgoing, pending, sendRequest, respondToRequest, cancelOrUnfollow, getStatusWith, refresh: refreshFollows } = useFollows();

  const isOwnProfile = user?.id === id;

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [{ data: profileData }, { data: reliabilityData }, { data: reportsData }] = await Promise.all([
        supabase.from('user_profiles').select('id, username, email, created_at').eq('id', id).maybeSingle(),
        supabase.from('user_reliability').select('*').eq('user_id', id).maybeSingle(),
        supabase.from('utility_reports')
          .select('id, reported_state, time_option, estimated_transition_at, created_at')
          .eq('reporter_id', id)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      setProfile(profileData as ReporterProfile | null);
      setReliability(reliabilityData as ReporterReliability | null);

      if (reportsData && reportsData.length > 0) {
        const reportIds = reportsData.map((r: any) => r.id);
        const { data: responses } = await supabase
          .from('resync_responses')
          .select('report_id, response')
          .in('report_id', reportIds)
          .eq('response', 'yes');

        const yesCounts: Record<number, number> = {};
        (responses ?? []).forEach((r: any) => {
          yesCounts[r.report_id] = (yesCounts[r.report_id] ?? 0) + 1;
        });

        setRecentReports(reportsData.map((r: any) => ({
          ...r,
          yesCount: yesCounts[r.id] ?? 0,
        })));
      } else {
        setRecentReports([]);
      }
    } catch (err) {
      console.error('[ReporterDetail]', err);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleFollowAction = useCallback(async () => {
    if (!id) return;
    const status = getStatusWith(id);
    if (status === 'accepted') {
      const row = following.find(f => f.target_id === id);
      if (row) { await cancelOrUnfollow(row.id); await refreshFollows(); }
    } else if (status === 'incoming') {
      const row = pending.find(f => f.requester_id === id);
      if (row) { await respondToRequest(row.id, true); await refreshFollows(); }
    } else if (status === 'none') {
      await sendRequest(id);
      await refreshFollows();
    }
  }, [id, getStatusWith, following, pending, cancelOrUnfollow, respondToRequest, sendRequest, refreshFollows]);

  const followStatus = id ? getStatusWith(id) : 'none';
  const displayName = profile?.username ?? profile?.email?.split('@')[0] ?? 'مجهول';
  const badge = reliability ? getReliabilityBadge(reliability.reliability_score) : null;
  const reliabilityScore = Math.round(reliability?.reliability_score ?? 50);

  const yesRate = reliability && reliability.total_responses > 0
    ? Math.round((reliability.yes_responses / reliability.total_responses) * 100)
    : 0;

  const acceptanceRate = reliability && reliability.total_reports > 0
    ? Math.round((reliability.accepted_reports / reliability.total_reports) * 100)
    : 0;

  const memberSince = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString('ar-SA', { year: 'numeric', month: 'long' })
    : null;

  const lastActive = reliability?.last_report_at
    ? new Date(reliability.last_report_at).toLocaleDateString('ar-SA', {
        timeZone: 'Asia/Aden', year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

  const followBtnConfig = (() => {
    if (isOwnProfile) return null;
    switch (followStatus) {
      case 'accepted': return { label: '✓ تتابعه', bg: '#001a2e', border: T.accent + '88', color: T.accent };
      case 'pending':  return { label: '⏳ بانتظار القبول', bg: T.elevated, border: T.border, color: T.textMuted };
      case 'incoming': return { label: '← قبول طلبه', bg: '#1a120a', border: T.warning + '88', color: T.warning };
      default:         return { label: '+ تابع', bg: T.primary, border: T.primary, color: '#fff' };
    }
  })();

  if (loading) {
    return (
      <View style={[styles.root, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={T.accent} />
        <Text style={{ color: T.textMuted, marginTop: 12, fontSize: 13 }}>جارٍ تحميل الملف الشخصي…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Back button */}
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.8}>
        <Text style={styles.backIcon}>→</Text>
        <Text style={styles.backLabel}>رجوع</Text>
      </TouchableOpacity>

      {/* Hero card */}
      <View style={[styles.heroCard, { borderColor: badge ? badge.color + '44' : T.border }]}>
        <View style={styles.heroTop}>
          {/* Follow button */}
          {followBtnConfig && (
            <TouchableOpacity
              style={[styles.followBtn, { backgroundColor: followBtnConfig.bg, borderColor: followBtnConfig.border }]}
              onPress={handleFollowAction}
              disabled={followStatus === 'pending'}
              activeOpacity={0.85}
            >
              <Text style={[styles.followBtnText, { color: followBtnConfig.color }]}>{followBtnConfig.label}</Text>
            </TouchableOpacity>
          )}

          {/* Profile info */}
          <View style={styles.heroInfo}>
            <Text style={styles.heroName}>{displayName}</Text>
            {memberSince && (
              <Text style={styles.heroMeta}>عضو منذ {memberSince}</Text>
            )}
            {lastActive && (
              <Text style={styles.heroMeta}>آخر نشاط: {lastActive}</Text>
            )}
          </View>

          {/* Avatar */}
          <View style={[styles.avatar, { borderColor: badge ? badge.color + '66' : T.border }]}>
            <Text style={[styles.avatarText, { color: badge?.color ?? T.accent }]}>
              {displayName[0]?.toUpperCase() ?? '?'}
            </Text>
          </View>
        </View>

        {/* Reliability ring + stats */}
        <View style={styles.heroBottom}>
          <ReliabilityRing score={reliabilityScore} />

          <View style={styles.heroMiniStats}>
            <View style={styles.miniStatRow}>
              <MiniBar value={acceptanceRate} max={100} color={T.success} />
              <Text style={styles.miniStatLabel}>معدل القبول</Text>
              <Text style={[styles.miniStatVal, { color: T.success }]}>{acceptanceRate}%</Text>
            </View>
            <View style={styles.miniStatRow}>
              <MiniBar value={yesRate} max={100} color={T.accent} />
              <Text style={styles.miniStatLabel}>نسبة نعم</Text>
              <Text style={[styles.miniStatVal, { color: T.accent }]}>{yesRate}%</Text>
            </View>
            <View style={styles.miniStatRow}>
              <MiniBar
                value={reliability?.total_responses ? reliability.total_responses - reliability.ignored_notifications : 0}
                max={reliability?.total_responses ?? 1}
                color={T.warning}
              />
              <Text style={styles.miniStatLabel}>استجابة الإشعارات</Text>
              <Text style={[styles.miniStatVal, { color: T.warning }]}>
                {reliability && reliability.total_responses > 0
                  ? Math.round(((reliability.total_responses - reliability.ignored_notifications) / reliability.total_responses) * 100)
                  : 0}%
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Stats grid */}
      <View style={styles.statsGrid}>
        <StatCard
          value={String(reliability?.total_reports ?? 0)}
          label="إجمالي البلاغات"
          color={T.textPrimary}
        />
        <StatCard
          value={String(reliability?.accepted_reports ?? 0)}
          label="بلاغات مقبولة"
          color={T.success}
        />
      </View>
      <View style={[styles.statsGrid, { marginTop: -6 }]}>
        <StatCard
          value={String(reliability?.yes_responses ?? 0)}
          label="ردود نعم"
          color={T.accent}
        />
        <StatCard
          value={String(reliability?.total_responses ?? 0)}
          label="إجمالي الردود"
          color={T.textSecondary}
        />
      </View>

      {/* Response breakdown */}
      {reliability && reliability.total_responses > 0 && (
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>توزيع الردود</Text>
          {[
            { label: 'نعم (أكّد)', val: reliability.yes_responses, color: T.success },
            { label: 'لا (رفض)', val: reliability.no_responses, color: T.danger },
            { label: 'تجاهل', val: reliability.ignored_notifications, color: T.textMuted },
          ].map(item => (
            <View key={item.label} style={styles.breakdownRow}>
              <View style={styles.breakdownRight}>
                <MiniBar value={item.val} max={reliability.total_responses} color={item.color} />
              </View>
              <Text style={[styles.breakdownVal, { color: item.color }]}>{item.val}</Text>
              <Text style={styles.breakdownLabel}>{item.label}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Recent reports */}
      <Text style={styles.listHeader}>آخر البلاغات</Text>
      {recentReports.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={{ fontSize: 36, marginBottom: 10 }}>📋</Text>
          <Text style={styles.emptyText}>لا توجد بلاغات حتى الآن</Text>
        </View>
      ) : (
        recentReports.map((report) => {
          const isOn = report.reported_state === 'UTILITY_ON';
          const color = isOn ? T.success : T.danger;
          const minutesAgo = Math.round((Date.now() - new Date(report.created_at).getTime()) / 60000);
          const timeAgoLabel = minutesAgo < 60
            ? `منذ ${minutesAgo} دقيقة`
            : minutesAgo < 1440
            ? `منذ ${Math.round(minutesAgo / 60)} ساعة`
            : new Date(report.created_at).toLocaleDateString('ar-SA', {
                timeZone: 'Asia/Aden', month: 'short', day: 'numeric',
              });
          const timeOptLabel = TIME_LABELS[report.time_option] ?? report.time_option;
          return (
            <View key={report.id} style={[styles.reportCard, { borderRightColor: color }]}>
              <View style={styles.reportTop}>
                <View style={styles.reportMeta}>
                  {report.yesCount > 0 && (
                    <View style={styles.yesChip}>
                      <Text style={styles.yesChipText}>✓ {report.yesCount} موافقة</Text>
                    </View>
                  )}
                  <Text style={styles.reportTime}>{timeAgoLabel}</Text>
                </View>
                <View style={styles.reportLeft}>
                  <Text style={[styles.reportState, { color }]}>
                    {isOn ? '⚡ اشتغلت الكهرباء' : '🔴 طفت الكهرباء'}
                  </Text>
                  <Text style={styles.reportOpt}>{timeOptLabel}</Text>
                </View>
              </View>
              <Text style={styles.reportDate}>
                {new Date(report.estimated_transition_at).toLocaleString('ar-SA', {
                  timeZone: 'Asia/Aden', dateStyle: 'medium', timeStyle: 'short',
                })} (اليمن)
              </Text>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16, alignSelf: 'flex-end' },
  backIcon: { color: T.accent, fontSize: 18, fontWeight: '700' },
  backLabel: { color: T.accent, fontSize: 14, fontWeight: '600' },

  heroCard: { backgroundColor: T.surface, borderRadius: 22, padding: 20, marginBottom: 12, borderWidth: 1.5 },
  heroTop: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 14, marginBottom: 20 },
  heroInfo: { flex: 1 },
  heroName: { color: T.textPrimary, fontSize: 22, fontWeight: '900', textAlign: 'right', marginBottom: 5 },
  heroMeta: { color: T.textMuted, fontSize: 11, textAlign: 'right', marginBottom: 2 },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', borderWidth: 2, flexShrink: 0 },
  avatarText: { fontSize: 24, fontWeight: '900' },
  followBtn: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1.5, alignSelf: 'flex-start' },
  followBtnText: { fontSize: 13, fontWeight: '800' },

  heroBottom: { flexDirection: 'row-reverse', gap: 18, alignItems: 'center' },
  heroMiniStats: { flex: 1, gap: 10 },
  miniStatRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  miniStatLabel: { color: T.textMuted, fontSize: 10, width: 90, textAlign: 'right' },
  miniStatVal: { fontSize: 12, fontWeight: '800', width: 34, textAlign: 'left' },

  statsGrid: { flexDirection: 'row-reverse', gap: 8, marginBottom: 8 },

  sectionCard: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: T.border },
  sectionTitle: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 12, textAlign: 'right' },
  breakdownRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 8 },
  breakdownLabel: { color: T.textMuted, fontSize: 11, width: 74, textAlign: 'right' },
  breakdownVal: { fontSize: 13, fontWeight: '800', width: 28, textAlign: 'center' },
  breakdownRight: { flex: 1 },

  listHeader: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 10, textAlign: 'right' },

  reportCard: { backgroundColor: T.surface, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: T.border, borderRightWidth: 3 },
  reportTop: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 },
  reportLeft: { flex: 1 },
  reportState: { fontSize: 15, fontWeight: '800', textAlign: 'right', marginBottom: 3 },
  reportOpt: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  reportMeta: { alignItems: 'flex-end', gap: 4 },
  reportTime: { color: T.textMuted, fontSize: 10 },
  yesChip: { backgroundColor: T.success + '18', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: T.success + '44' },
  yesChipText: { color: T.success, fontSize: 9, fontWeight: '700' },
  reportDate: { color: T.textMuted, fontSize: 10, textAlign: 'right' },

  emptyBox: { alignItems: 'center', paddingVertical: 32 },
  emptyText: { color: T.textMuted, fontSize: 13 },
});
