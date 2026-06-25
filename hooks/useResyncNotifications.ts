/**
 * useResyncNotifications
 *
 * Fetches community resync notifications for the current user and handles
 * YES/NO/IGNORE responses.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2 MIGRATION NOTES
 * ───────────────────────────────────────────────────────────────────────────
 * CRITICAL FIX: Community Confirmation Timestamp Rule
 *
 * The previous version computed:
 *   effective_transition_at = estimated_transition_at - response_delay_sec
 *
 * This VIOLATED the TMMS V2 spec:
 *   "Community Confirmations must never create new transitions using
 *    confirmation timestamps. All calculations must use the Original Report
 *    Timestamp. Confirmation timestamps may only affect Confidence, Trust,
 *    Reliability. Nothing else."
 *
 * The `response_delay_sec` is derived from the confirmation timestamp
 * (Date.now() when the recipient clicks YES). Subtracting it from the
 * report's original `estimated_transition_at` modified the transition time
 * using confirmation-derived data — a spec violation.
 *
 * MIGRATED BEHAVIOR:
 *   effective_transition_at = estimated_transition_at
 *     (the original report timestamp — unmodified)
 *
 * The `response_delay_sec` is still recorded in `resync_responses` for
 * trust/reliability analytics (which is spec-compliant: confirmation data
 * may affect Confidence/Trust/Reliability), but it no longer affects the
 * transition time itself.
 *
 * When a recipient responds YES:
 *   effective_transition_at = notif.estimated_transition_at
 *     (the absolute timestamp from the original report — already correct)
 */
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export interface ResyncNotification {
  id: number;
  report_id: number;
  reporter_id: string;
  recipient_id: string;
  expires_at: string;
  created_at: string;
  // joined
  reporter_username?: string | null;
  reported_state?: 'UTILITY_ON' | 'UTILITY_OFF' | null;
  time_option?: string | null;
  estimated_transition_at?: string | null;
  // response state
  response?: 'yes' | 'no' | 'ignore' | null;
}

export interface ResyncHistoryEntry {
  id: number;
  user_id: string;
  report_id: number | null;
  reporter_id: string | null;
  reporter_username: string | null;
  reported_state: 'UTILITY_ON' | 'UTILITY_OFF';
  effective_transition_at: string;
  confirmed_at: string;
  source: string;
}

/** Returned when a YES response is confirmed */
export interface YesResyncResult {
  /**
   * The effective transition time to apply as a resync point.
   *
   * TMMS V2: This is the ORIGINAL REPORT TIMESTAMP
   * (notif.estimated_transition_at), unmodified by the confirmation delay.
   * The confirmation timestamp may only affect Confidence/Trust/Reliability,
   * never the transition time itself.
   */
  effectiveTransitionAt: string;
  /** The utility state that became active */
  reportedState: 'UTILITY_ON' | 'UTILITY_OFF';
  /** Reporter display name for community sync meta */
  reporterName: string | null;
}

export function useResyncNotifications() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<ResyncNotification[]>([]);
  const [history, setHistory] = useState<ResyncHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

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
        .select('id, reported_state, time_option, estimated_transition_at')
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
      profileMap[p.id] = p.username
        ?? (p as any).email?.split('@')[0]
        ?? null;
    }

    const responseMap: Record<number, 'yes' | 'no' | 'ignore'> = {};
    for (const r of responses ?? []) responseMap[r.notification_id] = r.response;

    const enriched: ResyncNotification[] = notifs.map(n => ({
      ...n,
      reporter_username: profileMap[n.reporter_id] ?? `User_${n.reporter_id.slice(0, 6)}`,
      reported_state: reportMap[n.report_id]?.reported_state ?? null,
      time_option: reportMap[n.report_id]?.time_option ?? null,
      estimated_transition_at: reportMap[n.report_id]?.estimated_transition_at ?? null,
      response: responseMap[n.id] ?? null,
    }));

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
    setHistory((data ?? []) as ResyncHistoryEntry[]);
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
   * Returns a YesResyncResult when the response is 'yes' so the caller
   * can immediately update the ResyncContext.
   *
   * TMMS V2 COMMUNITY CONFIRMATION TIMESTAMP RULE:
   *   The effective transition time is the ORIGINAL REPORT TIMESTAMP
   *   (notif.estimated_transition_at).  The confirmation delay
   *   (response_delay_sec) is recorded for trust/reliability analytics
   *   but does NOT modify the transition time.
   */
  const respond = useCallback(async (
    notif: ResyncNotification,
    response: 'yes' | 'no' | 'ignore',
  ): Promise<{ yesResult: YesResyncResult | null; error: string | null }> => {
    if (!user) return { yesResult: null, error: 'Not authenticated' };

    // Response delay = time since the notification was created.
    // This is recorded in resync_responses for trust/reliability analytics
    // (spec-compliant: confirmation data may affect Confidence/Trust/Reliability).
    // It does NOT affect the transition time.
    const delaySec = Math.max(
      0,
      Math.round((Date.now() - new Date(notif.created_at).getTime()) / 1000),
    );

    // Record the response (includes delay for analytics — NOT for transition time)
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

    let yesResult: YesResyncResult | null = null;

    if (response === 'yes' && notif.reported_state) {
      // ── TMMS V2: Community Confirmation Timestamp Rule ──────────────────
      //
      // The effective transition time is the ORIGINAL REPORT TIMESTAMP.
      // Per spec:
      //   "Community Confirmations must never create new transitions using
      //    confirmation timestamps. All calculations must use the Original
      //    Report Timestamp."
      //
      // `notif.estimated_transition_at` is already the correct absolute
      // timestamp — it was set when the reporter submitted the report and
      // represents when the transition actually occurred.  The confirmation
      // delay does NOT modify it.
      //
      // The previous version incorrectly subtracted `delaySec` here, which
      // violated the spec by letting confirmation-derived data affect the
      // transition time.
      const effectiveTransitionAt = notif.estimated_transition_at
        ?? new Date().toISOString();

      // Persist to resync_history.
      // `effective_transition_at` = original report timestamp (spec-compliant).
      // `confirmed_at` = confirmation timestamp (for record-keeping only).
      await supabase.from('resync_history').insert({
        user_id: user.id,
        report_id: notif.report_id,
        reporter_id: notif.reporter_id,
        reporter_username: notif.reporter_username,
        reported_state: notif.reported_state,
        effective_transition_at: effectiveTransitionAt,
        confirmed_at: new Date().toISOString(),
        source: 'community_resync',
      });

      yesResult = {
        effectiveTransitionAt,
        reportedState: notif.reported_state,
        reporterName: notif.reporter_username ?? null,
      };

      await fetchHistory();
    }

    await fetchNotifications();
    return { yesResult, error: null };
  }, [user, fetchNotifications, fetchHistory]);

  const pendingCount = notifications.filter(n => !n.response).length;

  return {
    notifications,
    history,
    loading,
    pendingCount,
    respond,
    refresh: () => { fetchNotifications(); fetchHistory(); },
  };
}
