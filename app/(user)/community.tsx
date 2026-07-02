/**
 * community.tsx — Community Resync Centre (TMMS V2.2)
 *
 * Displays community resync notifications with the user's action history.
 * All visual design language follows the V2.2 specification.
 *
 * TMMS V2.2 changes:
 * - ON-ONLY reporting (removed all OFF-confirm flows)
 * - PENDING_NEGATIVE is a real first-class state (Period 2 behavior)
 * - YES response clones the reporter's full sync state including:
 *   OffsetState, OffsetValue, TimelineAlignment, and Generated ON metadata
 * - Notifications display V2.2 tags: Generated ON, Offset State
 * - History shows Offset State + Generated ON metadata
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Platform, Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import {
  useResyncNotifications,
  type ResyncNotification,
  type ResyncHistoryEntry,
  type OffsetState,
  type YesResyncResult,
} from '../../hooks/useResyncNotifications';
import { useResync } from '../../contexts/ResyncContext';
import { useStateAnchor } from '../../hooks/useStateAnchor';
import { supabase } from '../../lib/supabase';

const T = {
  bg: '#060d1a', surface: '#0d1526', elevated: '#162035',
  border: '#1e2d45', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#4a5e7a',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

function fmtTimeAr(iso: string): string {
  const r = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return r.replace('AM', ' ص').replace('PM', ' م');
}
function fmtDateAr(iso: string): string {
  return new Date(iso).toLocaleString('ar-YE', {
    timeZone: 'Asia/Aden', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// V2.2: OFFSET STATE CHIP (shared between NotifCard and HistoryCard)
// Renders a small badge showing the OffsetState (POSITIVE, NEGATIVE,
// NEUTRAL, or PENDING_NEGATIVE) with appropriate color.
// ════════════════════════════════════════════════════════════════════════════
function OffsetStateChip({ state, value }: { state?: OffsetState | null; value?: number | 'PENDING' | null }) {
  if (!state) return null;
  const stateLabels: Record<string, string> = {
    POSITIVE: 'فارق إيجابي',
    NEGATIVE: 'فارق سلبي',
    NEUTRAL: 'فارق محايد',
    PENDING_NEGATIVE: 'فارق معلَّق',
  };
  const stateColors: Record<string, string> = {
    POSITIVE: T.success,
    NEGATIVE: T.warning,
    NEUTRAL: T.textMuted,
    PENDING_NEGATIVE: T.warning,
  };
  const color = stateColors[state] ?? T.textMuted;
  const valueLabel = value === 'PENDING' || state === 'PENDING_NEGATIVE'
    ? 'بانتظار Growatt'
    : typeof value === 'number' ? `${value > 0 ? '+' : ''}${value}د` : '';
  return (
    <View style={[osStyles.chip, { borderColor: color + '55', backgroundColor: color + '12' }]}>
      <Text style={[osStyles.label, { color }]}>{stateLabels[state] ?? state}</Text>
      {valueLabel ? <Text style={[osStyles.value, { color }]}>{valueLabel}</Text> : null}
    </View>
  );
}

const osStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 8,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1,
    alignSelf: 'flex-start', marginTop: 8,
  },
  label: { fontSize: 11, fontWeight: '700' },
  value: { fontSize: 13, fontWeight: '900' },
});

// ════════════════════════════════════════════════════════════════════════════
// V2.2: NOTIFICATION CARD — displays the reporter's resync notification
// with all V2.2 fields including Generated ON metadata.
// ════════════════════════════════════════════════════════════════════════════
function NotifCard({ notif, onRespond }: {
  notif: ResyncNotification;
  onRespond: (notif: ResyncNotification, resp: 'yes' | 'no' | 'ignore') => void;
}) {
  const [busy, setBusy] = useState(false);
  const eventText = 'بلاغ تشغيل كهرباء';
  const timeLabel = notif.estimated_transition_at
    ? fmtTimeAr(notif.estimated_transition_at)
    : 'للتو';

  const hasResponded = !!notif.response;

  const handle = useCallback(async (resp: 'yes' | 'no' | 'ignore') => {
    setBusy(true);
    try { await onRespond(notif, resp); } finally { setBusy(false); }
  }, [notif, onRespond]);

  // V2.2: Read Generated ON metadata from the notification (now properly enriched)
  const hasGeneratedOn = notif.generated_on_duration_min != null;

  return (
    <View style={ncStyles.card}>
      {/* Reporter info */}
      <View style={ncStyles.header}>
        <View style={ncStyles.badge}>
          <Text style={ncStyles.badgeText}>👤 {notif.reporter_username ?? `User_${notif.reporter_id.slice(0, 6)}`}</Text>
        </View>
        <Text style={ncStyles.date}>{timeLabel}</Text>
      </View>

      {/* Event description */}
      <Text style={ncStyles.eventText}>{eventText}</Text>

      {/* V2.2: Offset State chip */}
      {notif.reporter_offset_state && (
        <View style={ncStyles.tagRow}>
          <OffsetStateChip
            state={notif.reporter_offset_state}
            value={notif.reporter_offset_value}
          />
        </View>
      )}

      {/* V2.2: Generated ON metadata tag */}
      {hasGeneratedOn && (
        <View style={ncStyles.tagRow}>
          <View style={[ncStyles.tagChip, { backgroundColor: T.success + '15', borderColor: T.success + '44' }]}>
            <Text style={[ncStyles.tagChipText, { color: T.success }]}>
              ⚡ مولّدة · مدة منسوخة: {notif.generated_on_duration_min}د
            </Text>
          </View>
          {notif.generated_on_reference_kind === 'active' && (
            <View style={[ncStyles.tagChip, { backgroundColor: T.accent + '15', borderColor: T.accent + '44' }]}>
              <Text style={[ncStyles.tagChipText, { color: T.accent }]}>
                🔄 تتبّع دورة نشطة
              </Text>
            </View>
          )}
        </View>
      )}

      {/* V2.2: Time option indicator */}
      <View style={ncStyles.timeRow}>
        <Text style={ncStyles.timeLabel}>وقت البلاغ:</Text>
        <Text style={ncStyles.timeValue}>{timeLabel}</Text>
      </View>

      {/* Action buttons */}
      {!hasResponded && (
        <View style={ncStyles.btnRow}>
          <TouchableOpacity
            style={[ncStyles.btn, ncStyles.btnNo]}
            onPress={() => handle('no')}
            activeOpacity={0.8}
            disabled={busy}
          >
            <Text style={ncStyles.btnNoText}>{busy ? '⏳' : '❌'}  لا</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[ncStyles.btn, ncStyles.btnYes]}
            onPress={() => handle('yes')}
            activeOpacity={0.8}
            disabled={busy}
          >
            <Text style={ncStyles.btnYesText}>{busy ? '⏳' : '✅'}  نعم</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Response result */}
      {hasResponded && (
        <View style={ncStyles.respondedBadge}>
          <Text style={ncStyles.respondedText}>
            {notif.response === 'yes' ? '✅ أنت متفق' : notif.response === 'no' ? '❌ أنت غير متفق' : '⏭ تم التجاهل'}
          </Text>
        </View>
      )}

      <Text style={ncStyles.note}>
        ℹ الردّ يُحدّث سجلّك فقط — لا يؤثر على الخطّ الزمني المجتمعي.
      </Text>
    </View>
  );
}

const ncStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface, borderRadius: 18, padding: 16, marginBottom: 12, borderWidth: 1.5, borderColor: T.border,
  },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  badge: { backgroundColor: T.elevated, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 },
  badgeText: { color: T.textPrimary, fontSize: 12, fontWeight: '700' },
  date: { color: T.textMuted, fontSize: 11 },
  eventText: { color: T.textPrimary, fontSize: 14, fontWeight: '800', textAlign: 'right', marginBottom: 10 },
  tagRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  tagChip: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1 },
  tagChipText: { fontSize: 10, fontWeight: '700' },
  timeRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 14 },
  timeLabel: { color: T.textMuted, fontSize: 11 },
  timeValue: { color: T.textSecondary, fontSize: 13, fontWeight: '700' },
  btnRow: { flexDirection: 'row-reverse', gap: 10 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1 },
  btnYes: { backgroundColor: '#052e16', borderColor: T.success + '66' },
  btnYesText: { color: T.success, fontSize: 14, fontWeight: '800' },
  btnNo: { backgroundColor: '#1a0505', borderColor: T.danger + '55' },
  btnNoText: { color: T.danger, fontSize: 14, fontWeight: '800' },
  respondedBadge: {
    backgroundColor: T.elevated, borderRadius: 12, paddingVertical: 10,
    alignItems: 'center', borderWidth: 1, borderColor: T.border,
  },
  respondedText: { color: T.textSecondary, fontSize: 13, fontWeight: '700' },
  note: { color: T.textMuted, fontSize: 10, textAlign: 'right', marginTop: 10, lineHeight: 15 },
});

// ════════════════════════════════════════════════════════════════════════════
// HISTORY CARD — displays past community sync events with V2.2 metadata.
// ════════════════════════════════════════════════════════════════════════════
function HistoryCard({ entry }: { entry: ResyncHistoryEntry }) {
  const timeLabel = fmtTimeAr(entry.effective_transition_at);
  const dateLabel = fmtDateAr(entry.confirmed_at);
  const isGeneratedOn = entry.generated_on_start_iso != null;

  return (
    <View style={hcStyles.card}>
      <View style={hcStyles.row}>
        <View style={{ flex: 1 }}>
          <Text style={hcStyles.title}>
            {entry.reported_state === 'UTILITY_ON' ? '⚡ تشغيل كهرباء' : '🔴 انقطاع كهرباء'}
          </Text>
          <Text style={hcStyles.reporter}>
            المُبلِّغ: <Text style={{ color: T.accent, fontWeight: '700' }}>{entry.reporter_username ?? 'مجهول'}</Text>
          </Text>
          {/* V2.2: Offset State */}
          {entry.offset_state && (
            <OffsetStateChip
              state={entry.offset_state}
              value={entry.offset_value}
            />
          )}
          {/* V2.2: Generated ON metadata */}
          {isGeneratedOn && (
            <View style={hcStyles.metaRow}>
              <View style={[hcStyles.metaChip, { backgroundColor: T.success + '15', borderColor: T.success + '44' }]}>
                <Text style={[hcStyles.metaChipText, { color: T.success }]}>
                  ⚡ مولّدة · مدة: {entry.generated_on_duration_min ?? '?'}د
                </Text>
              </View>
              {entry.generated_on_reference_kind === 'active' && (
                <View style={[hcStyles.metaChip, { backgroundColor: T.accent + '15', borderColor: T.accent + '44' }]}>
                  <Text style={[hcStyles.metaChipText, { color: T.accent }]}>
                    🔄 تتبّع دورة نشطة
                  </Text>
                </View>
              )}
            </View>
          )}
          <Text style={hcStyles.time}>وقت البلاغ: {timeLabel}</Text>
          <Text style={hcStyles.source}>المصدر: {entry.source}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={hcStyles.date}>{dateLabel}</Text>
        </View>
      </View>
    </View>
  );
}

const hcStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: T.border,
  },
  row: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12 },
  title: { color: T.textPrimary, fontSize: 14, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  reporter: { color: T.textSecondary, fontSize: 12, textAlign: 'right', marginBottom: 8 },
  metaRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' },
  metaChip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  metaChipText: { fontSize: 9, fontWeight: '700' },
  time: { color: T.textMuted, fontSize: 11, textAlign: 'right', marginBottom: 2 },
  source: { color: T.textMuted, fontSize: 10, textAlign: 'right' },
  date: { color: T.textMuted, fontSize: 11 },
});

// ════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ════════════════════════════════════════════════════════════════════════════
export default function CommunityScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    notifications, history, loading, pendingCount,
    respond, refresh,
  } = useResyncNotifications();
  const { applyResync } = useResync();
  const { capture } = useStateAnchor();

  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared response handler
  const handleRespond = useCallback(async (
    notif: ResyncNotification,
    resp: 'yes' | 'no' | 'ignore',
  ) => {
    setError(null);
    try {
      const { yesResult, error: respErr } = await respond(notif, resp);

      if (respErr) {
        setError(respErr);
        return;
      }

      if (resp === 'yes' && yesResult) {
        // V2.2: Use the complete YesResyncResult with all cloned fields
        const generatedOnStartIso = yesResult.generatedOnStartIso;
        const generatedOnDurationMin = yesResult.generatedOnDurationMin;
        const generatedOnReferenceIso = yesResult.generatedOnReferenceIso;
        const generatedOnReferenceKind = yesResult.generatedOnReferenceKind;

        const anchorStartIso = new Date().toISOString();

        // Apply the complete resync including V2.2 fields
        applyResync({
          syncedState: 'ON',
          syncedAtIso: generatedOnStartIso,
          appliedAtIso: anchorStartIso,
          reporterName: yesResult.reporterName,
          reporterReliability: null,
          // V2.2: Clone the reporter's offset snapshot verbatim
          offsetState: yesResult.offsetState,
          offsetValue: yesResult.offsetValue,
          timelineAlignment: yesResult.timelineAlignment,
          // V2.2: Clone Generated ON metadata
          generatedOnStartIso,
          generatedOnDurationMin,
          generatedOnReferenceIso,
          generatedOnReferenceKind,
          confirmationTime: anchorStartIso,
        });

        capture({ startIso: anchorStartIso });
      }
    } catch (e: any) {
      setError(e?.message ?? 'حدث خطأ أثناء الرد.');
    }
  }, [respond, applyResync, capture]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.title}>👥 المركز المجتمعي</Text>
        {pendingCount > 0 && (
          <View style={styles.pendingBadge}>
            <Text style={styles.pendingBadgeText}>{pendingCount} جديد</Text>
          </View>
        )}
      </View>
      <Text style={styles.subtitle}>تأكيد أو رفض بلاغات المستخدمين</Text>

      {/* Error */}
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </View>
      )}

      {/* Pending Notifications */}
      <Text style={styles.sectionTitle}>📬 بلاغات بانتظار ردّك ({notifications.length})</Text>
      {loading ? (
        <ActivityIndicator size="large" color={T.accent} style={{ marginVertical: 40 }} />
      ) : notifications.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyEmoji}>📭</Text>
          <Text style={styles.emptyTitle}>لا توجد بلاغات جديدة</Text>
          <Text style={styles.emptySub}>سيتم إشعارك فور وصول بلاغ جديد من المجتمع.</Text>
        </View>
      ) : (
        notifications.map(notif => (
          <NotifCard key={notif.id} notif={notif} onRespond={handleRespond} />
        ))
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>🕘 سجلّ المزامنات ({history.length})</Text>
          {history.map(entry => (
            <HistoryCard key={entry.id} entry={entry} />
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { padding: 16, paddingBottom: 32 },
  headerRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  title: { color: T.textPrimary, fontSize: 22, fontWeight: '900', flex: 1, textAlign: 'right' },
  pendingBadge: { backgroundColor: T.warning + '22', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.warning + '44' },
  pendingBadgeText: { color: T.warning, fontSize: 12, fontWeight: '700' },
  subtitle: { color: T.textMuted, fontSize: 12, marginBottom: 16, textAlign: 'right' },
  errorBox: { backgroundColor: '#1a0a0a', borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: T.danger + '55' },
  errorText: { color: T.danger, fontSize: 13, textAlign: 'right' },
  sectionTitle: { color: T.textPrimary, fontSize: 15, fontWeight: '800', marginTop: 8, marginBottom: 12, textAlign: 'right' },
  emptyBox: { alignItems: 'center', paddingVertical: 40 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { color: T.textPrimary, fontSize: 16, fontWeight: '800', marginBottom: 6 },
  emptySub: { color: T.textMuted, fontSize: 12, textAlign: 'center' },
});
