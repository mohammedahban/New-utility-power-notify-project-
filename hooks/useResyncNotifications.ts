/**
 * useResyncNotifications
 *
 * Fetches community resync notifications for the current user and handles
 * YES/NO/IGNORE responses.
 *
 * When a recipient responds YES:
 *   effective_transition_time = estimated_transition_at - response_delay_sec
 *   (i.e. how long ago did the transition actually happen, accounting for
 *    both the reporter's reported lag AND the recipient's response delay)
 *
 * The effective_transition_at is saved to resync_history and returned so
 * the caller can apply it to the ResyncContext.
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
  /** The effective transition time to apply as a resync point */
  effectiveTransitionAt: string;
  /** The utility state that became active */
  reportedState: 'UTILITY_ON' | 'UTILITY_OFF';
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
   */
  const respond = useCallback(async (
    notif: ResyncNotification,
    response: 'yes' | 'no' | 'ignore',
  ): Promise<{ yesResult: YesResyncResult | null; error: string | null }> => {
    if (!user) return { yesResult: null, error: 'Not authenticated' };

    // Response delay = time since the notification was created
    const delaySec = Math.max(
      0,
      Math.round((Date.now() - new Date(notif.created_at).getTime()) / 1000),
    );

    // Record the response
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
      /**
       * Effective transition time calculation:
       *
       * The reporter said "it happened X minutes ago" at report creation time.
       * estimated_transition_at = report_created_at - selectedOffsetMinutes
       *
       * The recipient clicked YES after delaySec seconds.
       * In that time the transition has moved further into the past.
       *
       * effective_transition_at = estimated_transition_at
       * (the absolute timestamp is already correct — it was computed
       *  relative to wall-clock time, not relative to "now")
       *
       * We also factor in the response delay to correct for the recipient's
       * perception gap: if the notification was created 4 minutes ago the
       * event is 4 minutes more stale than the reporter's estimate.
       *
       * effective = estimated_transition_at - response_delay_sec
       */
      const estimatedMs = notif.estimated_transition_at
        ? new Date(notif.estimated_transition_at).getTime()
        : Date.now();
      const effectiveMs = estimatedMs - delaySec * 1000;
      const effectiveTransitionAt = new Date(effectiveMs).toISOString();

      // Persist to resync_history
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
