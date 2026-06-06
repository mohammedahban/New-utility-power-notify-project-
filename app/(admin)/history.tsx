import React, { useMemo, useState, useCallback } from 'react';
import {
  View, Text, FlatList, ScrollView, TouchableOpacity, StyleSheet,
  Modal, TextInput, Alert, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePowerEvents } from '../../hooks/usePowerEvents';
import EventItem from '../../components/EventItem';
import { PowerEvent } from '../../hooks/usePowerEvents';
import { supabase } from '../../lib/supabase';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtH(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function yemenDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'Asia/Aden', year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

interface DayStat {
  date: string; dateKey: string;
  gridHours: number; outageHours: number;
  eventCount: number; onCount: number; offCount: number;
  avgOnMin: number | null; avgOffMin: number | null;
  events: PowerEvent[];
}

function computeDailyStats(events: PowerEvent[]): DayStat[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  const byDate = new Map<string, PowerEvent[]>();
  for (const ev of sorted) {
    const d = yemenDate(ev.occurred_at);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(ev);
  }
  const stats: DayStat[] = [];
  for (const [dateStr, dayEvents] of byDate.entries()) {
    const [m, d, y] = dateStr.split('/');
    const dateKey = `${y}-${m}-${d}`;
    const dateLabel = new Date(`${y}-${m}-${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const dayEnd = new Date(`${y}-${m}-${d}T00:00:00+03:00`).getTime() + 24 * 3600000;
    let outageMs = 0, offTime: number | null = null;
    const offDurations: number[] = [], onDurations: number[] = [];
    let lastOnTime: number | null = null;
    for (const ev of dayEvents) {
      const t = new Date(ev.occurred_at).getTime();
      if (ev.event_type === 'UTILITY_OFF') {
        if (lastOnTime !== null) { onDurations.push((t - lastOnTime) / 60000); lastOnTime = null; }
        offTime = t;
      } else {
        lastOnTime = t;
        if (offTime !== null) { const d = t - offTime; outageMs += d; offDurations.push(d / 60000); offTime = null; }
      }
    }
    if (offTime !== null) { const d = Math.min(dayEnd, Date.now()) - offTime; outageMs += d; offDurations.push(d / 60000); }
    if (lastOnTime !== null) onDurations.push((Math.min(dayEnd, Date.now()) - lastOnTime) / 60000);
    const outageHours = Math.min(24, outageMs / 3600000);
    stats.push({
      date: dateLabel, dateKey,
      gridHours: Math.max(0, 24 - outageHours), outageHours,
      eventCount: dayEvents.length,
      onCount: dayEvents.filter(e => e.event_type === 'UTILITY_ON').length,
      offCount: dayEvents.filter(e => e.event_type === 'UTILITY_OFF').length,
      avgOnMin: onDurations.length ? onDurations.reduce((s, v) => s + v, 0) / onDurations.length : null,
      avgOffMin: offDurations.length ? offDurations.reduce((s, v) => s + v, 0) / offDurations.length : null,
      events: dayEvents,
    });
  }
  return stats.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

// ── Bar Chart ─────────────────────────────────────────────────────────────────
type ChartRange = '24h' | 'week' | 'month';

function HourBar({ label, gridH, outageH, maxH, isToday }: { label: string; gridH: number; outageH: number; maxH: number; isToday: boolean }) {
  const BAR_MAX = 80;
  const totalH = gridH + outageH;
  const barH = maxH > 0 ? Math.round((totalH / maxH) * BAR_MAX) : 0;
  const gridPx = totalH > 0 ? Math.round((gridH / totalH) * barH) : 0;
  const outagePx = Math.max(0, barH - gridPx);
  return (
    <View style={barStyles.col}>
      <View style={[barStyles.barWrap, { height: BAR_MAX }]}>
        <View style={barStyles.track} />
        <View style={[barStyles.stackWrap, { height: barH }]}>
          <View style={[barStyles.segment, { height: outagePx, backgroundColor: '#ef4444' }]} />
          <View style={[barStyles.segment, { height: gridPx, backgroundColor: '#22c55e' }]} />
        </View>
      </View>
      <Text style={[barStyles.label, isToday && { color: '#38bdf8' }]}>{label}</Text>
    </View>
  );
}
const barStyles = StyleSheet.create({
  col: { alignItems: 'center', flex: 1 },
  barWrap: { justifyContent: 'flex-end', alignItems: 'center', width: '100%' },
  track: { position: 'absolute', bottom: 0, left: '15%', right: '15%', top: 0, backgroundColor: '#1e293b', borderRadius: 4 },
  stackWrap: { width: '60%', justifyContent: 'flex-end', borderRadius: 4, overflow: 'hidden', flexDirection: 'column' },
  segment: { width: '100%' },
  label: { color: '#64748b', fontSize: 9, marginTop: 4, textAlign: 'center' },
});

function ChartSection({ allStats }: { allStats: DayStat[] }) {
  const [range, setRange] = useState<ChartRange>('week');
  const chartData = useMemo(() => {
    const today = new Date();
    const mk = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (range === 'week') {
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today); d.setDate(d.getDate() - (6 - i));
        const key = mk(d);
        const stat = allStats.find(s => s.dateKey === key);
        return { label: i === 6 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }), gridH: stat?.gridHours ?? 0, outageH: stat?.outageHours ?? 0, isToday: i === 6 };
      });
    }
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() - (29 - i));
      const key = mk(d);
      const stat = allStats.find(s => s.dateKey === key);
      return { label: i === 29 ? 'T' : i % 5 === 0 ? String(d.getDate()) : '', gridH: stat?.gridHours ?? 0, outageH: stat?.outageHours ?? 0, isToday: i === 29 };
    });
  }, [range, allStats]);
  const maxH = useMemo(() => Math.max(1, ...chartData.map(d => d.gridH + d.outageH)), [chartData]);
  const summary = useMemo(() => {
    const today = new Date(); const days = range === 'week' ? 7 : 30;
    let tg = 0, to = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const s = allStats.find(s => s.dateKey === key);
      if (s) { tg += s.gridHours; to += s.outageHours; }
    }
    return { totalGrid: tg, totalOutage: to, pct: tg + to > 0 ? Math.round((tg / (tg + to)) * 100) : 0 };
  }, [range, allStats]);
  return (
    <View style={chartStyles.container}>
      <View style={chartStyles.rangeRow}>
        {(['week', 'month'] as ChartRange[]).map(r => (
          <TouchableOpacity key={r} style={[chartStyles.rangeBtn, range === r && chartStyles.rangeBtnActive]} onPress={() => setRange(r)}>
            <Text style={[chartStyles.rangeTxt, range === r && chartStyles.rangeTxtActive]}>{r === 'week' ? '7 Days' : '30 Days'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={chartStyles.summaryRow}>
        <View style={chartStyles.badge}><View style={[chartStyles.dot, { backgroundColor: '#22c55e' }]} /><Text style={chartStyles.badgeTxt}>Grid {fmtH(summary.totalGrid)}</Text></View>
        <View style={chartStyles.badge}><View style={[chartStyles.dot, { backgroundColor: '#ef4444' }]} /><Text style={chartStyles.badgeTxt}>Outage {fmtH(summary.totalOutage)}</Text></View>
        <View style={[chartStyles.badge]}><Text style={[chartStyles.badgeTxt, { color: summary.pct >= 50 ? '#22c55e' : '#ef4444', fontWeight: '700' }]}>{summary.pct}% uptime</Text></View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={chartStyles.barsWrap}>
        {chartData.map((d, i) => <HourBar key={i} label={d.label} gridH={d.gridH} outageH={d.outageH} maxH={maxH} isToday={d.isToday} />)}
      </ScrollView>
    </View>
  );
}
const chartStyles = StyleSheet.create({
  container: { backgroundColor: '#1e293b', borderRadius: 16, padding: 16, marginBottom: 16 },
  rangeRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  rangeBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center', backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#334155' },
  rangeBtnActive: { backgroundColor: '#1d4ed8', borderColor: '#3b82f6' },
  rangeTxt: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  rangeTxtActive: { color: '#fff' },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  badge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0f172a', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  badgeTxt: { color: '#94a3b8', fontSize: 12 },
  barsWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingBottom: 4, minWidth: '100%' },
});

// ── Edit Event Modal ──────────────────────────────────────────────────────────
interface EditModalProps {
  event: PowerEvent | null;
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function EditEventModal({ event, visible, onClose, onSaved }: EditModalProps) {
  const [dateStr, setDateStr] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  React.useEffect(() => {
    if (event) {
      // Show in Yemen time as ISO-like for editing
      const d = new Date(event.occurred_at);
      const yemenOffset = 3 * 60 * 60000;
      const local = new Date(d.getTime() + yemenOffset);
      // Format: YYYY-MM-DD HH:MM
      const iso = local.toISOString().slice(0, 16).replace('T', ' ');
      setDateStr(iso);
      setError('');
    }
  }, [event]);

  const handleSave = async () => {
    if (!event) return;
    setError('');
    // Parse as Yemen time → UTC
    const parts = dateStr.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    if (!parts) { setError('Format must be YYYY-MM-DD HH:MM (Yemen time)'); return; }
    const yemenMs = new Date(`${parts[1]}T${parts[2]}:00+03:00`).getTime();
    if (isNaN(yemenMs)) { setError('Invalid date/time'); return; }
    setSaving(true);
    const { error: dbErr } = await supabase
      .from('power_events')
      .update({ occurred_at: new Date(yemenMs).toISOString() })
      .eq('id', event.id);
    setSaving(false);
    if (dbErr) { setError(dbErr.message); return; }
    onSaved();
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.sheet}>
          <Text style={modalStyles.title}>Edit Event Timestamp</Text>
          <Text style={modalStyles.sub}>Event: {event?.event_type}</Text>
          <Text style={modalStyles.fieldLabel}>Date & Time (Yemen time, UTC+3)</Text>
          <Text style={modalStyles.hint}>Format: YYYY-MM-DD HH:MM</Text>
          <TextInput
            style={modalStyles.input}
            value={dateStr}
            onChangeText={setDateStr}
            placeholder="2026-05-28 14:30"
            placeholderTextColor="#475569"
            autoCapitalize="none"
          />
          {error ? <Text style={modalStyles.error}>{error}</Text> : null}
          <View style={modalStyles.btnRow}>
            <TouchableOpacity style={modalStyles.cancelBtn} onPress={onClose}>
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[modalStyles.saveBtn, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
              <Text style={modalStyles.saveText}>{saving ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  sheet: { backgroundColor: '#1e293b', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400 },
  title: { color: '#f1f5f9', fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sub: { color: '#64748b', fontSize: 13, marginBottom: 20 },
  fieldLabel: { color: '#94a3b8', fontSize: 12, fontWeight: '600', marginBottom: 4 },
  hint: { color: '#475569', fontSize: 11, marginBottom: 8 },
  input: { backgroundColor: '#0f172a', borderRadius: 10, borderWidth: 1, borderColor: '#334155', paddingHorizontal: 14, paddingVertical: 12, color: '#f1f5f9', fontSize: 15, marginBottom: 8 },
  error: { color: '#f87171', fontSize: 12, marginBottom: 8 },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  cancelBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#334155' },
  cancelText: { color: '#94a3b8', fontWeight: '600', fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: '#1d4ed8' },
  saveText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

// ── Admin Event Item with Edit/Delete ─────────────────────────────────────────
function AdminEventItem({ event, onEdit, onDelete }: { event: PowerEvent; onEdit: (e: PowerEvent) => void; onDelete: (e: PowerEvent) => void }) {
  const [expanded, setExpanded] = useState(false);
  const isOn = event.event_type === 'UTILITY_ON';
  const time = new Date(event.occurred_at).toLocaleString('en-US', { timeZone: 'Asia/Aden', dateStyle: 'medium', timeStyle: 'short' });
  return (
    <TouchableOpacity onPress={() => setExpanded(v => !v)} activeOpacity={0.85}>
      <View style={[aeiStyles.row, { borderLeftColor: isOn ? '#22c55e' : '#ef4444' }]}>
        <Text style={aeiStyles.icon}>{isOn ? '⚡' : '🔴'}</Text>
        <View style={aeiStyles.info}>
          <Text style={[aeiStyles.type, { color: isOn ? '#22c55e' : '#ef4444' }]}>Utility {isOn ? 'CAME ON' : 'WENT OFF'}</Text>
          <Text style={aeiStyles.time}>{time} (Yemen)</Text>
          {event.status_text ? <Text style={aeiStyles.status}>{event.status_text}</Text> : null}
        </View>
        <Text style={aeiStyles.expand}>{expanded ? '▲' : '▼'}</Text>
      </View>
      {expanded ? (
        <View style={aeiStyles.actions}>
          <TouchableOpacity style={aeiStyles.editBtn} onPress={() => onEdit(event)}>
            <Text style={aeiStyles.editText}>✏️ Edit Timestamp</Text>
          </TouchableOpacity>
          <TouchableOpacity style={aeiStyles.deleteBtn} onPress={() => onDelete(event)}>
            <Text style={aeiStyles.deleteText}>🗑️ Delete</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}
const aeiStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1e293b', borderRadius: 12, padding: 14, marginBottom: 2, borderLeftWidth: 3 },
  icon: { fontSize: 20, marginRight: 12 },
  info: { flex: 1 },
  type: { fontWeight: '700', fontSize: 14, marginBottom: 2 },
  time: { color: '#64748b', fontSize: 12 },
  status: { color: '#475569', fontSize: 11, marginTop: 2 },
  expand: { color: '#475569', fontSize: 11, marginLeft: 8 },
  actions: { flexDirection: 'row', gap: 8, paddingHorizontal: 8, paddingBottom: 8, paddingTop: 4, backgroundColor: '#1e293b', borderBottomLeftRadius: 12, borderBottomRightRadius: 12, marginBottom: 6 },
  editBtn: { flex: 1, backgroundColor: '#1d4ed8', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  editText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  deleteBtn: { flex: 1, backgroundColor: '#450a0a', borderRadius: 8, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: '#7f1d1d' },
  deleteText: { color: '#f87171', fontWeight: '600', fontSize: 13 },
});

// ── Day Stat Card ─────────────────────────────────────────────────────────────
function DayStatCard({ stat }: { stat: DayStat }) {
  const gridPct = Math.round((stat.gridHours / 24) * 100);
  const outagePct = 100 - gridPct;
  return (
    <View style={dsStyles.card}>
      <View style={dsStyles.header}>
        <Text style={dsStyles.date}>{stat.date}</Text>
        <Text style={dsStyles.eventCount}>{stat.eventCount} events</Text>
      </View>
      <View style={dsStyles.barTrack}>
        <View style={[dsStyles.barFill, { flex: gridPct || 0.5, backgroundColor: '#22c55e' }]} />
        <View style={[dsStyles.barFill, { flex: outagePct || 0.5, backgroundColor: '#ef4444' }]} />
      </View>
      <View style={dsStyles.statsRow}>
        <View style={dsStyles.statsItem}>
          <View style={[dsStyles.dot, { backgroundColor: '#22c55e' }]} />
          <Text style={dsStyles.statsLabel}>Grid</Text>
          <Text style={[dsStyles.statsValue, { color: '#22c55e' }]}>{fmtH(stat.gridHours)}</Text>
          <Text style={dsStyles.statsPct}>{gridPct}%</Text>
        </View>
        <View style={dsStyles.divider} />
        <View style={dsStyles.statsItem}>
          <View style={[dsStyles.dot, { backgroundColor: '#ef4444' }]} />
          <Text style={dsStyles.statsLabel}>Outage</Text>
          <Text style={[dsStyles.statsValue, { color: '#ef4444' }]}>{fmtH(stat.outageHours)}</Text>
          <Text style={dsStyles.statsPct}>{outagePct}%</Text>
        </View>
      </View>
      {(stat.avgOnMin !== null || stat.avgOffMin !== null) && (
        <View style={dsStyles.durRow}>
          {stat.avgOnMin !== null && <View style={dsStyles.durItem}><Text style={dsStyles.durLabel}>Avg ON</Text><Text style={[dsStyles.durValue, { color: '#4ade80' }]}>{fmtH(stat.avgOnMin / 60)}</Text></View>}
          {stat.avgOffMin !== null && <View style={dsStyles.durItem}><Text style={dsStyles.durLabel}>Avg OFF</Text><Text style={[dsStyles.durValue, { color: '#f87171' }]}>{fmtH(stat.avgOffMin / 60)}</Text></View>}
          <View style={dsStyles.durItem}><Text style={dsStyles.durLabel}>Outages</Text><Text style={dsStyles.durValue}>{stat.offCount}</Text></View>
        </View>
      )}
    </View>
  );
}
const dsStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 14, padding: 16, marginBottom: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  date: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  eventCount: { color: '#64748b', fontSize: 12 },
  barTrack: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: '#0f172a', marginBottom: 12, gap: 1 },
  barFill: { borderRadius: 4 },
  statsRow: { flexDirection: 'row', alignItems: 'center' },
  statsItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statsLabel: { color: '#64748b', fontSize: 11, flex: 1 },
  statsValue: { fontSize: 13, fontWeight: '700' },
  statsPct: { color: '#475569', fontSize: 11, marginLeft: 2 },
  divider: { width: 1, height: 28, backgroundColor: '#334155', marginHorizontal: 12 },
  durRow: { flexDirection: 'row', marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#0f172a', gap: 8 },
  durItem: { flex: 1, alignItems: 'center' },
  durLabel: { color: '#475569', fontSize: 10, marginBottom: 2 },
  durValue: { color: '#94a3b8', fontSize: 13, fontWeight: '700' },
});

// ── History Screen ─────────────────────────────────────────────────────────────
type Tab = 'events' | 'stats' | 'chart';

export default function AdminHistory() {
  const { events, loading } = usePowerEvents(500);
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('chart');
  const [editEvent, setEditEvent] = useState<PowerEvent | null>(null);
  const [editVisible, setEditVisible] = useState(false);

  const onCount = events.filter(e => e.event_type === 'UTILITY_ON').length;
  const offCount = events.filter(e => e.event_type === 'UTILITY_OFF').length;
  const dailyStats = useMemo(() => computeDailyStats(events), [events]);

  const handleEdit = useCallback((ev: PowerEvent) => {
    setEditEvent(ev);
    setEditVisible(true);
  }, []);

  const handleDelete = useCallback((ev: PowerEvent) => {
    const doDelete = async () => {
      const { error } = await supabase.from('power_events').delete().eq('id', ev.id);
      if (error) Alert.alert('Error', error.message);
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Delete this event?')) doDelete();
    } else {
      Alert.alert('Delete Event', 'Are you sure you want to delete this event?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  }, []);

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {events.length > 0 && (
        <View style={styles.summary}>
          <View style={styles.summaryItem}><Text style={styles.summaryValue}>{events.length}</Text><Text style={styles.summaryLabel}>Total</Text></View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}><Text style={[styles.summaryValue, { color: '#22c55e' }]}>{onCount}</Text><Text style={styles.summaryLabel}>Grid ON</Text></View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}><Text style={[styles.summaryValue, { color: '#ef4444' }]}>{offCount}</Text><Text style={styles.summaryLabel}>Grid OFF</Text></View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}><Text style={styles.summaryValue}>{dailyStats.length}</Text><Text style={styles.summaryLabel}>Days</Text></View>
        </View>
      )}

      <View style={styles.tabBar}>
        {([['chart', '📊 Chart'], ['stats', '📅 Daily'], ['events', '📋 Events']] as [Tab, string][]).map(([t, label]) => (
          <TouchableOpacity key={t} style={[styles.tabBtn, tab === t && styles.tabBtnActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabBtnText, tab === t && styles.tabBtnTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'chart' && (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {dailyStats.length === 0 ? (
            <View style={styles.emptyBox}><Text style={styles.emptyIcon}>📊</Text><Text style={styles.emptyTitle}>No Chart Data Yet</Text></View>
          ) : (
            <>
              <Text style={styles.sectionLabel}>ON / OFF Hours by Period</Text>
              <ChartSection allStats={dailyStats} />
              <Text style={styles.sectionLabel}>Recent Days</Text>
              {dailyStats.slice(0, 7).map(s => <DayStatCard key={s.dateKey} stat={s} />)}
            </>
          )}
        </ScrollView>
      )}

      {tab === 'stats' && (
        <FlatList
          data={dailyStats}
          keyExtractor={s => s.dateKey}
          renderItem={({ item }) => <DayStatCard stat={item} />}
          contentContainerStyle={[styles.list, dailyStats.length === 0 && styles.emptyList]}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={<View style={styles.emptyBox}><Text style={styles.emptyIcon}>📅</Text><Text style={styles.emptyTitle}>No Stats Yet</Text></View>}
        />
      )}

      {tab === 'events' && (
        <>
          <View style={styles.adminHint}>
            <Text style={styles.adminHintText}>Tap any event to edit or delete it</Text>
          </View>
          <FlatList
            data={events}
            keyExtractor={e => String(e.id)}
            renderItem={({ item }) => <AdminEventItem event={item} onEdit={handleEdit} onDelete={handleDelete} />}
            contentContainerStyle={[styles.list, events.length === 0 && styles.emptyList]}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              loading ? <View style={styles.emptyBox}><Text style={styles.emptyText}>Loading…</Text></View>
                : <View style={styles.emptyBox}><Text style={styles.emptyIcon}>📋</Text><Text style={styles.emptyTitle}>No Events</Text></View>
            }
          />
        </>
      )}

      <EditEventModal
        event={editEvent}
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        onSaved={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  sectionLabel: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10 },
  summary: { flexDirection: 'row', backgroundColor: '#1e293b', marginHorizontal: 16, marginTop: 12, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'space-evenly' },
  summaryItem: { alignItems: 'center', flex: 1 },
  summaryValue: { color: '#e2e8f0', fontSize: 22, fontWeight: '800' },
  summaryLabel: { color: '#64748b', fontSize: 10, marginTop: 2 },
  summaryDivider: { width: 1, height: 36, backgroundColor: '#334155' },
  tabBar: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, marginBottom: 4, backgroundColor: '#1e293b', borderRadius: 12, padding: 4, gap: 4 },
  tabBtn: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  tabBtnActive: { backgroundColor: '#0f172a' },
  tabBtnText: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  tabBtnTextActive: { color: '#38bdf8' },
  adminHint: { marginHorizontal: 16, marginBottom: 4, paddingVertical: 6 },
  adminHintText: { color: '#475569', fontSize: 11, textAlign: 'center' },
  list: { padding: 16, paddingTop: 12 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  emptyBox: { alignItems: 'center', padding: 32 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: '#94a3b8', fontSize: 18, fontWeight: '700', marginBottom: 10 },
  emptyText: { color: '#475569', fontSize: 13, textAlign: 'center' },
});
