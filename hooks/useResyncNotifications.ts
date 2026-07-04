/**
 * useResyncNotifications
 *
 * Loads resync notifications sent to the current user, their responses,
 * and the user's resync history. Provides a `respond()` function for
 * YES / NO / IGNORE actions.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { ResyncPoint } from '../contexts/ResyncContext';

export interface ResyncNotification {
  id: number;
  report_id: number;
  reporter_id: string;
  reporter_username: string | null;
  recipient_id: string;
  expires_at: string;
  created_at: string;
  // From joined utility_reports
  reported_state: string;
  time_option: string;
  estimated_transition_at: string;
  // V2.2 fields from utility_reports
  reporter_offset_state?: string | null;
  reporter_offset_value?: any;
  reporter_timeline_alignment?: string | null;
  generated_on_start_iso?: string | null;
  generated_on_duration_min?: number | null;
  generated_on_reference_iso?: string | null;
  generated_on_reference_kind?: string | null;
  // From joined resync_responses (null if not yet responded)
  response?: 'yes' | 'no' | 'ignore' | null;
}

export interface ResyncHistoryEntry {
  id: number;
  user_id: string;
  report_id: number | null;
  reporter_id: string | null;
  reporter_username: string | null;
  reported_state: string;
  effective_transition_at: string;
  confirmed_at: string;
  source: string;
  offset_state?: string | null;
  offset_value?: any;
  timeline_alignment?: string | null;
}

interface RespondYesResult {
  reportedState: string;
  effectiveTransitionAt: string;
  reporterName: string | null;
}

export function useResyncNotifications() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<ResyncNotification[]>([]);
  const [history, setHistory] = useState<ResyncHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      // ── Fetch notifications sent to this user ────────────────────────────
      const { data: notifData, error: notifErr } = await supabase
        .from('resync_notifications')
        .select(`
          id,
          report_id,
          reporter_id,
          recipient_id,
          expires_at,
          created_at,
          utility_reports (
            reported_state,
            time_option,
            estimated_transition_at,
            reporter_offset_state,
            reporter_offset_value,
            reporter_timeline_alignment,
            generated_on_start_iso,
            generated_on_duration_min,
            generated_on_reference_iso,
            generated_on_reference_kind
          )
        `)
        .eq('recipient_id', user.id)
        .order('created_at', { ascending: false })
        .limit(30);

      if (notifErr) {
        console.error('[useResyncNotifications] fetch notifs error:', notifErr.message);
        if (!mountedRef.current) return;
        setLoading(false);
        return;
      }

      const notifIds = (notifData ?? []).map(n => n.id);
      const reporterIds = [...new Set((notifData ?? []).map(n => n.reporter_id).filter(Boolean))];

      // ── Fetch responses for these notifications ──────────────────────────
      let responseMap: Record<number, 'yes' | 'no' | 'ignore'> = {};
      if (notifIds.length > 0) {
        const { data: respData } = await supabase
          .from('resync_responses')
          .select('notification_id, response')
          .in('notification_id', notifIds)
          .eq('responder_id', user.id);
        for (const r of respData ?? []) {
          responseMap[r.notification_id] = r.response as 'yes' | 'no' | 'ignore';
        }
      }

      // ── Fetch reporter usernames ─────────────────────────────────────────
      let reporterNames: Record<string, string | null> = {};
      if (reporterIds.length > 0) {
        const { data: profileData } = await supabase
          .from('user_profiles')
          .select('id, username')
          .in('id', reporterIds);
        for (const p of profileData ?? []) {
          reporterNames[p.id] = p.username ?? null;
        }
      }

      // ── Merge into notification objects ──────────────────────────────────
      const merged: ResyncNotification[] = (notifData ?? []).map(n => {
        const report = Array.isArray(n.utility_reports)
          ? n.utility_reports[0]
          : n.utility_reports;
        return {
          id: n.id,
          report_id: n.report_id,
          reporter_id: n.reporter_id,
          reporter_username: reporterNames[n.reporter_id] ?? null,
          recipient_id: n.recipient_id,
          expires_at: n.expires_at,
          created_at: n.created_at,
          reported_state: report?.reported_state ?? 'UTILITY_ON',
          time_option: report?.time_option ?? 'now',
          estimated_transition_at: report?.estimated_transition_at ?? n.created_at,
          reporter_offset_state: report?.reporter_offset_state ?? null,
          reporter_offset_value: report?.reporter_offset_value ?? null,
          reporter_timeline_alignment: report?.reporter_timeline_alignment ?? null,
          generated_on_start_iso: report?.generated_on_start_iso ?? null,
          generated_on_duration_min: report?.generated_on_duration_min ?? null,
          generated_on_reference_iso: report?.generated_on_reference_iso ?? null,
          generated_on_reference_kind: report?.generated_on_reference_kind ?? null,
          response: responseMap[n.id] ?? null,
        };
      });

      // ── Fetch resync history for this user ───────────────────────────────
      const { data: histData } = await supabase
        .from('resync_history')
        .select('*')
        .eq('user_id', user.id)
        .order('confirmed_at', { ascending: false })
        .limit(20);

      if (!mountedRef.current) return;
      setNotifications(merged);
      setHistory((histData ?? []) as ResyncHistoryEntry[]);
    } catch (err) {
      console.error('[useResyncNotifications] unexpected error:', err);
    }
    if (mountedRef.current) setLoading(false);
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Real-time subscription ───────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`resync_notifs_${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'resync_notifications',
        filter: `recipient_id=eq.${user.id}`,
      }, () => { refresh(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, refresh]);

  // ── Computed pending count (non-expired, no response) ───────────────────
  const pendingCount = notifications.filter(n => {
    if (n.response) return false;
    if (new Date(n.expires_at) < new Date()) return false;
    return true;
  }).length;

  /**
   * Respond to a notification.
   *
   * Returns:
   *   yesResult — populated when response === 'yes', contains fields needed
   *               by the caller to apply a community resync.
   *   error     — error message string, or null on success.
   */
  const respond = useCallback(async (
    notif: ResyncNotification,
    response: 'yes' | 'no' | 'ignore',
  ): Promise<{ yesResult: RespondYesResult | null; error: string | null }> => {
    if (!user) return { yesResult: null, error: 'Not authenticated' };

    // Optimistic update
    setNotifications(prev =>
      prev.map(n => n.id === notif.id ? { ...n, response } : n)
    );

    // Compute response_delay_sec
    const delaySeconds = Math.round(
      (Date.now() - new Date(notif.created_at).getTime()) / 1000
    );

    const { error } = await supabase.from('resync_responses').upsert({
      notification_id: notif.id,
      report_id: notif.report_id,
      responder_id: user.id,
      response,
      response_delay_sec: delaySeconds,
    }, { onConflict: 'notification_id,responder_id' });

    if (error) {
      // Revert optimistic update
      setNotifications(prev =>
        prev.map(n => n.id === notif.id ? { ...n, response: null } : n)
      );
      return { yesResult: null, error: error.message };
    }

    if (response !== 'yes') {
      return { yesResult: null, error: null };
    }

    // ── YES path: build yesResult ────────────────────────────────────────
    const yesResult: RespondYesResult = {
      reportedState: notif.reported_state,
      effectiveTransitionAt: notif.estimated_transition_at,
      reporterName: notif.reporter_username ?? null,
    };

    // Refresh after a short delay so response is reflected in list
    setTimeout(() => refresh(), 500);

    return { yesResult, error: null };
  }, [user, refresh]);

  return {
    notifications,
    history,
    loading,
    pendingCount,
    respond,
    refresh,
  };
}
