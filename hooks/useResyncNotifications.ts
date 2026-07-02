/**
 * useResyncNotifications — TMMS V2.2 Personal Timeline Replacement Model
 *
 * Fetches community resync notifications for the current user and handles
 * YES/NO/IGNORE responses.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.2 MIGRATION NOTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The V2.2 changes in this file:
 *
 *  1. ON-ONLY REPORTING (unchanged from V2.1)
 *     Users NEVER report OFF. Every OFF-report / OFF-confirmation branch has
 *     been removed. `reported_state` is type-narrowed to `'UTILITY_ON'`.
 *
 *  2. PENDING_NEGATIVE IS A REAL STATE (changed from V2.1)
 *     V2.1 incorrectly stated PENDING_NEGATIVE was "backwards compat only"
 *     and "never produced". V2.2 restores it as a first-class state:
 *     - Created when Generated ON is inside Period 2 (second half of OFF)
 *     - Offset Value = 'PENDING' (numeric value unknown)
 *     - Auto-resolves to NEGATIVE when Growatt ON begins:
 *       offsetValue = GeneratedONstart - ActualGrowattONstart
 *     - While pending, future ON predictions show "Estimated (Pending Offset)"
 *     - When resolved, UNCERTAIN_ZONE waiting time is deducted from next ON
 *
 *  3. APPROVER CLONES REPORTER (unchanged from V2.1)
 *     When a recipient presses YES, the system CLONES the reporter's:
 *         - OffsetState          (POSITIVE | PENDING_NEGATIVE | NEGATIVE | NEUTRAL)
 *         - OffsetValue          (number | 'PENDING')
 *         - TimelineAlignment    (iso string)
 *     These three values are persisted to resync_history.
 *
 *  4. PENDING_NEGATIVE AUTO-RESOLUTION (V2.2 corrected)
 *     `useGrowattOnWatcher` subscribes to power_events and calls
 *     `resolvePendingNegativeOffsets` when a UTILITY_ON arrives.
 *     For PENDING_NEGATIVE rows: resolves to NEGATIVE with computed value.
 *     For other rows: no change (state is already final).
 *
 *  5. COMMUNITY CONFIRMATION NEVER TOUCHES TIMELINE (unchanged)
 *     Confirmation only writes confidence/trust counters — it must NEVER
 *     modify OffsetState / OffsetValue / TimelineAlignment.
 *
 * Original (V2 / V2.1) responsibilities preserved unchanged:
 *   - Reliability bookkeeping (bumpReliabilityCounters)
 *   - Real-time Supabase subscription for new notifications
 *   - 15-row history fetch
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

// ── TMMS V2.2: Offset State ────────────────────────────────────────────────
// V2.2: Four possible states per the Personal Timeline Replacement Model:
//   POSITIVE         → Period 1 (during Growatt ON or first half of OFF)
//   PENDING_NEGATIVE → Period 2 (second half of OFF), auto-resolves
//   NEGATIVE         → after Pending Negative resolves
//   NEUTRAL          → Period 3 (exact ON start instant), offset = 0
export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';

// V2.2: the value is either a signed integer (minutes) or 'PENDING' meaning
// "waiting for next Growatt ON" (for Period 2 reports).
export type OffsetValue = number | 'PENDING';

// V2.2: a stable iso timestamp the reporter stores when their offset is
// first calculated. Approvers copy this verbatim.
export type TimelineAlignment = string;

export interface ResyncNotification {
  id: number;
  report_id: number;
  reporter_id: string;
  recipient_id: string;
  expires_at: string;
  created_at: string;
  reporter_username?: string | null;
  reported_state?: 'UTILITY_ON' | null;
  time_option?: string | null;
  estimated_transition_at?: string | null;
  // ── V2.2: Reporter's offset snapshot, cloned by Approver on YES ──
  reporter_offset_state?: OffsetState | null;
  reporter_offset_value?: OffsetValue | null;
  reporter_timeline_alignment?: TimelineAlignment | null;
  // response state
  response?: 'yes' | 'no' | 'ignore' | null;
}

export interface ResyncHistoryEntry {
  id: number;
  user_id: string;
  report_id: number | null;
  reporter_id: string | null;
  reporter_username: string | null;
  reported_state: 'UTILITY_ON';
  effective_transition_at: string;
  confirmed_at: string;
  source: string;
  // ── V2.2: cloned offset data ──
  offset_state?: OffsetState | null;
  offset_value?: OffsetValue | null;
  timeline_alignment?: TimelineAlignment | null;
  // ── V2.2: Generated ON metadata ──
  generated_on_start_iso?: string | null;
  generated_on_duration_min?: number | null;
  generated_on_reference_iso?: string | null;
  generated_on_reference_kind?: 'completed' | 'active' | null;
}

/** Returned when a YES response is confirmed */
export interface YesResyncResult {
  effectiveTransitionAt: string;
  reportedState: 'UTILITY_ON';
  reporterName: string | null;
  // ── V2.2: cloned offset data ──
  offsetState: OffsetState;
  offsetValue: OffsetValue;
  timelineAlignment: TimelineAlignment;
  // ── V2.2: Generated ON metadata ──
  generatedOnStartIso: string;
  generatedOnDurationMin: number | null;
  generatedOnReferenceIso: string | null;
  generatedOnReferenceKind: 'completed' | 'active' | null;
}

/**
 * Increment one or more numeric counters on a user's reliability row.
 */
async function bumpReliabilityCounters(
  userId: string,
  counters: Partial<Record<
    'total_reports' | 'accepted_reports' | 'rejected_reports' |
    'total_responses' | 'yes_responses' | 'no_responses' | 'ignored_notifications',
    number
  >>,
  extra: Record<string, any> = {},
): Promise<void> {
  try {
    const fields = Object.keys(counters);
    if (fields.length === 0) return;
    const { data: current, error: readErr } = await supabase
      .from('user_reliability')
      .select(fields.join(','))
      .eq('user_id', userId)
      .maybeSingle();
    if (readErr) {
      console.warn('[useResyncNotifications] reliability read error:', readErr.message);
      return;
    }

    const patch: Record<string, any> = { user_id: userId, updated_at: new Date().toISOString(), ...extra };
    for (const field of fields) {
      const inc = (counters as Record<string, number>)[field] ?? 0;
      patch[field] = ((current as any)?.[field] ?? 0) + inc;
    }

    const { error: writeErr } = await supabase
      .from('user_reliability')
      .upsert(patch, { onConflict: 'user_id' });
    if (writeErr) console.warn('[useResyncNotifications] reliability write error:', writeErr.message);
  } catch (e) {
    console.warn('[useResyncNotifications] reliability update failed (non-fatal):', e);
  }
}

// ── V2.2: PENDING_NEGATIVE auto-resolution watcher ─────────────────────────
//
// When Growatt turns ON, PENDING_NEGATIVE rows must auto-resolve to NEGATIVE
// with the actual numeric offset value computed as:
//   offsetValue = GeneratedONstart - ActualGrowattONstart
//
// This function is called when a new UTILITY_ON event arrives in power_events.
// It updates ALL pending rows (not just PENDING_NEGATIVE — any row with a
// null pending_resolved_at gets resolved).
async function resolvePendingNegativeOffsets(growattOnIso: string): Promise<void> {
  const growattOnMs = new Date(growattOnIso).getTime();
  if (!Number.isFinite(growattOnMs)) return;

  // Find all rows that haven't been resolved yet
  const { data: unresolvedRows, error } = await supabase
    .from('resync_history')
    .select('id, user_id, effective_transition_at, offset_state, generated_on_start_iso')
    .is('pending_resolved_at', null);

  if (error || !unresolvedRows || unresolvedRows.length === 0) return;

  for (const row of unresolvedRows) {
    const reportMs = new Date(row.generated_on_start_iso ?? row.effective_transition_at).getTime();
    if (!Number.isFinite(reportMs)) continue;

    // V2.2: offsetValue = T - G (Generated ON start - Actual Growatt ON start)
    const offsetMin = Math.round((reportMs - growattOnMs) / 60_000);

    // Determine the final state:
    // - PENDING_NEGATIVE → NEGATIVE (this is the resolution)
    // - Other states stay as-is (already final)
    const finalState: OffsetState =
      row.offset_state === 'PENDING_NEGATIVE' ? 'NEGATIVE' : (row.offset_state as OffsetState) ?? 'NEUTRAL';

    await supabase
      .from('resync_history')
      .update({
        offset_state: finalState,
        offset_value: offsetMin,
        pending_resolved_at: new Date().toISOString(),
      })
      .eq('id', row.id);
  }

  // Also update user_offsets for each affected user
  const userIds = [...new Set(unresolvedRows.map(r => r.user_id))];
  for (const userId of userIds) {
    const userRows = unresolvedRows.filter(r => r.user_id === userId);
    if (userRows.length === 0) continue;
    const latest = userRows.sort((a, b) =>
      new Date(b.effective_transition_at).getTime() - new Date(a.effective_transition_at).getTime(),
    )[0];
    const reportMs = new Date(latest.generated_on_start_iso ?? latest.effective_transition_at).getTime();
    const offsetMin = Math.round((reportMs - growattOnMs) / 60_000);
    const finalState: OffsetState =
      latest.offset_state === 'PENDING_NEGATIVE' ? 'NEGATIVE' : (latest.offset_state as OffsetState) ?? 'NEUTRAL';

    await supabase
      .from('user_offsets')
      .upsert({
        user_id: userId,
        offset_minutes: offsetMin,
        offset_state: finalState,
        offset_value: offsetMin,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
  }
}

// ── V2.2: Growatt ON watcher ───────────────────────────────────────────────
// Listens for new UTILITY_ON rows in power_events. When one arrives,
// resolves any PENDING_NEGATIVE offsets.
function useGrowattOnWatcher() {
  useEffect(() => {
    const channel = supabase
      .channel(`growatt_on_watcher_${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'power_events' },
        async (payload: any) => {
          const newRow = payload.new as { event_type?: string; occurred_at?: string };
          if (newRow.event_type !== 'UTILITY_ON' || !newRow.occurred_at) return;
          try {
            await resolvePendingNegativeOffsets(newRow.occurred_at);
          } catch (e) {
            console.warn('[useResyncNotifications] PENDING_NEGATIVE resolution failed:', e);
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);
}

export function useResyncNotifications() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<ResyncNotification[]>([]);
  const [history, setHistory] = useState<ResyncHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // V2.2: arm the Growatt ON watcher to resolve PENDING_NEGATIVE offsets
  useGrowattOnWatcher();

  const fetchNotifications = useCallback(async () => {
    if (!user) { setLoading(false); return; }

    const { data: notifs, error } = await supabase
      .from('resync_notifications')
      .select('*')
      .eq('recipient_id', user.id)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('[useResyncNotifications] fetch error:', error.message);
      setLoading(false);
      return;
    }

    if (!notifs || notifs.length === 0) {
      setNotifications([]);
      setLoading(false);
      return;
    }

    const reportIds = [...new Set(notifs.map(n => n.report_id))];
    const reporterIds = [...new Set(notifs.map(n => n.reporter_id))];

    const [{ data: reports }, { data: profiles }, { data: responses }] = await Promise.all([
      supabase
        .from('utility_reports')
        .select(`
          id, reported_state, time_option, estimated_transition_at,
          reporter_offset_state, reporter_offset_value,
          reporter_timeline_alignment,
          generated_on_start_iso, generated_on_duration_min,
          generated_on_reference_iso, generated_on_reference_kind
        `)
        .in('id', reportIds),
      supabase
        .from('user_profiles')
        .select('id, username')
        .in('id', reporterIds),
      supabase
        .from('resync_responses')
        .select('notification_id, response')
        .eq('responder_id', user.id)
        .in('notification_id', notifs.map(n => n.id)),
    ]);

    const reportMap: Record<number, any> = {};
    for (const r of reports ?? []) reportMap[r.id] = r;

    const profileMap: Record<string, string | null> = {};
    for (const p of profiles ?? []) {
      profileMap[p.id] = p.username ?? (p as any).email?.split('@')[0] ?? null;
    }

    const responseMap: Record<number, 'yes' | 'no' | 'ignore'> = {};
    for (const r of responses ?? []) responseMap[r.notification_id] = r.response;

    const enriched: ResyncNotification[] = notifs
      .map(n => {
        const report = reportMap[n.report_id];
        if (report && report.reported_state === 'UTILITY_OFF') return null;
        return {
          ...n,
          reporter_username: profileMap[n.reporter_id] ?? `User_${n.reporter_id.slice(0, 6)}`,
          reported_state: 'UTILITY_ON' as const,
          time_option: report?.time_option ?? null,
          estimated_transition_at: report?.estimated_transition_at ?? null,
          reporter_offset_state: report?.reporter_offset_state ?? null,
          reporter_offset_value: report?.reporter_offset_value ?? null,
          reporter_timeline_alignment: report?.reporter_timeline_alignment ?? null,
          response: responseMap[n.id] ?? null,
        } as ResyncNotification;
      })
      .filter((n): n is ResyncNotification => n !== null);

    setNotifications(enriched);
    setLoading(false);
  }, [user]);

  const fetchHistory = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('resync_history')
      .select('*')
      .eq('user_id', user.id)
      .order('confirmed_at', { ascending: false })
      .limit(15);
    if (error) console.error('[useResyncNotifications] history error:', error.message);
    const v22Entries = (data ?? []).filter(
      (row: any) => row.reported_state !== 'UTILITY_OFF',
    ) as ResyncHistoryEntry[];
    setHistory(v22Entries);
  }, [user]);

  useEffect(() => {
    fetchNotifications();
    fetchHistory();
  }, [fetchNotifications, fetchHistory]);

  // Real-time: new notifications arrive
  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel(`resync_notif_${user.id}_${Math.random()}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'resync_notifications',
        filter: `recipient_id=eq.${user.id}`,
      }, () => { fetchNotifications(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, fetchNotifications]);

  /**
   * Respond to a community resync notification.
   *
   * TMMS V2.2: the YES branch clones the reporter's full synchronization
   * state including PENDING_NEGATIVE if applicable.
   */
  const respond = useCallback(async (
    notif: ResyncNotification,
    response: 'yes' | 'no' | 'ignore',
  ): Promise<{ yesResult: YesResyncResult | null; error: string | null }> => {
    if (!user) return { yesResult: null, error: 'Not authenticated' };

    const delaySec = Math.max(
      0,
      Math.round((Date.now() - new Date(notif.created_at).getTime()) / 1000),
    );

    const { error: respError } = await supabase
      .from('resync_responses')
      .upsert({
        notification_id: notif.id,
        report_id: notif.report_id,
        responder_id: user.id,
        response,
        response_delay_sec: delaySec,
      }, { onConflict: 'notification_id,responder_id' });

    if (respError) return { yesResult: null, error: respError.message };

    // Reliability bookkeeping
    const responderPatch: Partial<Record<'total_responses' | 'yes_responses' | 'no_responses' | 'ignored_notifications', number>> = { total_responses: 1 };
    if (response === 'yes') responderPatch.yes_responses = 1;
    else if (response === 'no') responderPatch.no_responses = 1;
    else if (response === 'ignore') responderPatch.ignored_notifications = 1;
    await bumpReliabilityCounters(user.id, responderPatch, { last_response_at: new Date().toISOString() });

    if (response === 'yes') {
      await bumpReliabilityCounters(notif.reporter_id, { accepted_reports: 1 });
    } else if (response === 'no') {
      await bumpReliabilityCounters(notif.reporter_id, { rejected_reports: 1 });
    }

    let yesResult: YesResyncResult | null = null;

    if (response === 'yes') {
      const effectiveTransitionAt = notif.estimated_transition_at ?? new Date().toISOString();

      // V2.2: Clone the reporter's offset snapshot verbatim
      const clonedOffsetState: OffsetState =
        notif.reporter_offset_state ?? 'NEUTRAL';
      const clonedOffsetValue: OffsetValue =
        notif.reporter_offset_value ?? 0;
      const clonedTimelineAlignment: TimelineAlignment =
        notif.reporter_timeline_alignment ?? effectiveTransitionAt;

      // V2.2: Clone the Generated ON metadata
      const generatedOnStartIso = effectiveTransitionAt;
      const generatedOnDurationMin: number | null =
        (notif as any).generated_on_duration_min ?? null;
      const generatedOnReferenceIso: string | null =
        (notif as any).generated_on_reference_iso ?? null;
      const generatedOnReferenceKind: 'completed' | 'active' | null =
        (notif as any).generated_on_reference_kind ?? null;

      // Persist to resync_history — V2.2: include cloned offset data
      await supabase.from('resync_history').insert({
        user_id: user.id,
        report_id: notif.report_id,
        reporter_id: notif.reporter_id,
        reporter_username: notif.reporter_username,
        reported_state: 'UTILITY_ON',
        effective_transition_at: effectiveTransitionAt,
        confirmed_at: new Date().toISOString(),
        source: 'community_resync',
        // V2.2 cloned offset data:
        offset_state: clonedOffsetState,
        offset_value: clonedOffsetValue,
        timeline_alignment: clonedTimelineAlignment,
        // V2.2 Generated ON metadata:
        generated_on_start_iso: generatedOnStartIso,
        generated_on_duration_min: generatedOnDurationMin,
        generated_on_reference_iso: generatedOnReferenceIso,
        generated_on_reference_kind: generatedOnReferenceKind,
      });

      // V2.2: upsert user_offsets
      const numericOffsetForUserRow = typeof clonedOffsetValue === 'number'
        ? clonedOffsetValue
        : 0; // PENDING → 0 placeholder, replaced on resolution
      await supabase
        .from('user_offsets')
        .upsert({
          user_id: user.id,
          offset_minutes: numericOffsetForUserRow,
          offset_state: clonedOffsetState,
          offset_value: clonedOffsetValue,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });

      yesResult = {
        effectiveTransitionAt,
        reportedState: 'UTILITY_ON',
        reporterName: notif.reporter_username ?? null,
        offsetState: clonedOffsetState,
        offsetValue: clonedOffsetValue,
        timelineAlignment: clonedTimelineAlignment,
        generatedOnStartIso,
        generatedOnDurationMin,
        generatedOnReferenceIso,
        generatedOnReferenceKind,
      };

      await fetchHistory();
    }

    await fetchNotifications();
    return { yesResult, error: null };
  }, [user, fetchNotifications, fetchHistory]);

  // V2.2: expose helpers for current offset state
  const currentOffsetState = history.length > 0
    ? (history[0].offset_state ?? null)
    : null;
  const currentOffsetValue = history.length > 0
    ? (history[0].offset_value ?? null)
    : null;
  const currentTimelineAlignment = history.length > 0
    ? (history[0].timeline_alignment ?? null)
    : null;
  const currentGeneratedOn = history.length > 0
    ? {
        startIso: history[0].generated_on_start_iso ?? null,
        durationMin: history[0].generated_on_duration_min ?? null,
        referenceIso: history[0].generated_on_reference_iso ?? null,
        referenceKind: history[0].generated_on_reference_kind ?? null,
      }
    : null;

  const pendingCount = notifications.filter(n => !n.response).length;

  return {
    notifications,
    history,
    loading,
    pendingCount,
    respond,
    refresh: () => { fetchNotifications(); fetchHistory(); },
    currentOffsetState,
    currentOffsetValue,
    currentTimelineAlignment,
    currentGeneratedOn,
  };
}
