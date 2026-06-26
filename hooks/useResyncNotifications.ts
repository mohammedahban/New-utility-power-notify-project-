/**
 * useResyncNotifications
 *
 * Fetches community resync notifications for the current user and handles
 * YES/NO/IGNORE responses.
 *
 * Confirmation Timestamp Rule: when a recipient responds YES, the resync's
 * syncedAtIso is the ORIGINAL report's estimated_transition_at, unmodified.
 * The recipient's response delay is recorded (response_delay_sec, for
 * reliability/latency metrics) but must NEVER be subtracted from the
 * transition timestamp — the transition happened at that fixed point in
 * time regardless of how long any individual recipient took to confirm it.
 *
 *   effective_transition_at = estimated_transition_at   (no adjustment)
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
  /** Reporter display name for community sync meta */
  reporterName: string | null;
}

/**
 * Increment one or more numeric counters on a user's reliability row.
 *
 * This is the real-world counterpart of tmmsEngine.ts's Group K
 * confidence-ledger logic (createReportRecord / applyConfirmationToReport /
 * trustLevelForScore): tmmsEngine.ts tracks confidence per-report in an
 * in-memory ledger for the simulator; this app tracks it per-USER in the
 * `user_reliability` table (useReliability.ts already reads total_responses,
 * yes_responses, no_responses, ignored_notifications, accepted_reports,
 * rejected_reports — but until now nothing ever WROTE to them).
 *
 * Mirrors the exact read-then-upsert pattern the distribute-resync edge
 * function already uses for total_reports, for consistency.
 *
 * Deliberately does NOT touch reliability_score / community_trust_score —
 * those read as DERIVED/aggregate scores (the same way analytics_daily_snapshots
 * is a derived rollup computed by the compute-analytics scheduled job, not
 * written incrementally). This only maintains the raw counters such a score
 * would be computed FROM. If no such job exists yet for reliability, that's
 * a separate piece — ask rather than guess at an undocumented formula.
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

    // ── Reliability bookkeeping (Group K confidence-ledger equivalent) ──────
    // Responder's own counters — always updated, regardless of response type.
    const responderPatch: Partial<Record<'total_responses' | 'yes_responses' | 'no_responses' | 'ignored_notifications', number>> = { total_responses: 1 };
    if (response === 'yes') responderPatch.yes_responses = 1;
    else if (response === 'no') responderPatch.no_responses = 1;
    else if (response === 'ignore') responderPatch.ignored_notifications = 1;
    await bumpReliabilityCounters(user.id, responderPatch, { last_response_at: new Date().toISOString() });

    // Reporter's counters — how THEIR report was judged by this responder.
    // ('ignore' is not a judgment on accuracy, so it doesn't count either way.)
    if (response === 'yes') {
      await bumpReliabilityCounters(notif.reporter_id, { accepted_reports: 1 });
    } else if (response === 'no') {
      await bumpReliabilityCounters(notif.reporter_id, { rejected_reports: 1 });
    }

    let yesResult: YesResyncResult | null = null;

    if (response === 'yes' && notif.reported_state) {
      /**
       * Effective transition time — Confirmation Timestamp Rule.
       *
       * estimated_transition_at is ALREADY the correct, complete, absolute
       * timestamp: the reporter computed it as
       *   report_created_at - selectedOffsetMinutes
       * at the moment they submitted the report. It does not drift and must
       * NEVER be adjusted again based on how long a recipient takes to
       * respond — the utility transition happened at that fixed point in
       * time regardless of when any individual recipient gets around to
       * confirming it.
       *
       * The previous implementation subtracted response_delay_sec from
       * estimated_transition_at, which double-counts the delay: this
       * exact cancellation is also why ResyncContext's own documented
       * recipient formula — now - (selectedOffsetMinutes + responseDelay) —
       * reduces algebraically to plain estimated_transition_at:
       *   now - offset - delay
       *     = (report_created_at + delay) - offset - delay
       *     = report_created_at - offset
       *     = estimated_transition_at
       * i.e. the delay term is only meant to *cancel out* the fact that
       * "now" has moved forward since the report was created — never to be
       * subtracted a second time from a value that's already offset-adjusted.
       *
       * response_delay_sec is still recorded above (for reliability/latency
       * metrics) — it just must never feed into the transition timestamp.
       */
      const effectiveTransitionAt = notif.estimated_transition_at ?? new Date().toISOString();

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
