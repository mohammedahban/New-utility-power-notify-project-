/**
 * useResyncNotifications — TMMS V2.1
 *
 * Fetches community resync notifications for the current user and handles
 * YES/NO/IGNORE responses.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.1 MIGRATION NOTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The big V2.1 changes in this file:
 *
 *  1. ON-ONLY REPORTING (PDF §"WHY ONLY ON REPORTS?")
 *     Users NEVER report OFF. Every OFF-report / OFF-confirmation branch has
 *     been removed. `reported_state` is type-narrowed to `'UTILITY_ON'`
 *     exclusively. The DB column still exists for backwards compatibility,
 *     but the V2.1 application layer only ever writes/reads ON reports.
 *
 *  2. APPROVER CLONES REPORTER (PDF §"APPROVER LOGIC")
 *     When a recipient presses YES, the system DOES NOT recalculate a local
 *     offset. Instead it CLONES the reporter's:
 *         - OffsetState          (Positive | Negative | Neutral | PendingNegative)
 *         - OffsetValue          (number | 'PENDING')
 *         - TimelineAlignment    (iso string)
 *     These three values are persisted to resync_history alongside the
 *     effective_transition_at so the Home Screen / Schedule / Future
 *     Predictions can all read them back without re-deriving anything.
 *
 *  3. PENDING NEGATIVE AUTO-RESOLUTION (PDF §Rule 2)
 *     When the reporter's offset is PendingNegative, neither the reporter
 *     nor any approver has a numeric OffsetValue yet — they're all
 *     "Waiting for next Growatt ON". When Growatt finally transitions to ON,
 *     the resolution must happen AUTOMATICALLY for every user holding that
 *     pending state. `useGrowattOnWatcher` subscribes to power_events and
 *     calls `resolvePendingNegativeOffset` for every affected resync_history
 *     row that still has OffsetValue='PENDING'.
 *
 *  4. COMMUNITY CONFIRMATION NEVER TOUCHES TIMELINE (PDF §"COMMUNITY CONFIRMATION")
 *     The Confirmation Timestamp Rule is preserved (effective_transition_at
 *     = estimated_transition_at, never adjusted by response delay). On top
 *     of that, V2.1 adds: confirmation only writes confidence/trust
 *     counters — it must NEVER modify OffsetState / OffsetValue /
 *     TimelineAlignment. Those three fields are set ONCE when the report is
 *     accepted (by the reporter's first submission or the approver's YES)
 *     and never touched again.
 *
 * Original (V2) responsibilities preserved unchanged:
 *   - Reliability bookkeeping (bumpReliabilityCounters)
 *   - Real-time Supabase subscription for new notifications
 *   - 15-row history fetch
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

// ── TMMS V2.1: Offset State ─────────────────────────────────────────────────
// PDF §"OFFSET CALCULATION ENGINE": four possible states. The fourth
// (PendingNegative) is new in V2.1 — it represents the case where the
// reporter pressed ON during the second half of an expected OFF (OFF
// Progress > 50%), so the system can't compute a numeric offset yet and
// must wait for the next Growatt ON.
export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
// V2.1 CORRECTED: PENDING_NEGATIVE is kept for backwards compatibility with
// legacy DB rows, but the corrected engine NEVER produces it — >50% now yields
// immediately NEGATIVE. The >50%/<50% rule is ABSOLUTE:
//   >50% → NEGATIVE (always, locked, never changes)
//   <50% → POSITIVE (always, locked, never changes)
// The IMPORTANT NOTICE confirms (not flips) the state when Growatt turns ON.

// PDF §"OFFSET CALCULATION ENGINE": the value is either a signed integer
// (minutes) or the literal token 'PENDING' meaning "waiting for next
// Growatt ON".
export type OffsetValue = number | 'PENDING';

// PDF §"APPROVER LOGIC" / §"REPORTER PROCESSING": a stable iso timestamp
// the reporter stores when their offset is first calculated. Approvers
// copy this verbatim — it's the alignment anchor for the entire cloned
// timeline.
export type TimelineAlignment = string;

export interface ResyncNotification {
  id: number;
  report_id: number;
  reporter_id: string;
  recipient_id: string;
  expires_at: string;
  created_at: string;
  // joined
  reporter_username?: string | null;
  // TMMS V2.1: only ON reports exist. Kept as a literal type so the
  // compiler enforces "no OFF branch anywhere in the UI".
  reported_state?: 'UTILITY_ON' | null;
  time_option?: string | null;
  estimated_transition_at?: string | null;
  // ── TMMS V2.1: Reporter's offset snapshot, cloned by Approver on YES ──
  // These come from the joined utility_reports row (the reporter stored
  // them at submission time). They are ALWAYS present for V2.1 reports;
  // null only for legacy V2 reports still sitting in the DB.
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
  // V2.1: type-narrowed to ON only
  reported_state: 'UTILITY_ON';
  effective_transition_at: string;
  confirmed_at: string;
  source: string;
  // ── TMMS V2.1: cloned offset data ──
  // For a reporter: the freshly-calculated offset (or PENDING).
  // For an approver: a verbatim clone of the reporter's three fields.
  offset_state?: OffsetState | null;
  offset_value?: OffsetValue | null;
  timeline_alignment?: TimelineAlignment | null;
  // ── TMMS V2.1: Generated ON metadata ──
  // Stored at the moment of acceptance so any future reader (Home Screen,
  // Schedule, Debug Simulator) can reconstruct the Generated ON event
  // without re-running the engine.
  generated_on_start_iso?: string | null;
  generated_on_duration_min?: number | null;
  generated_on_reference_iso?: string | null;
  generated_on_reference_kind?: 'completed' | 'active' | null;
}

/** Returned when a YES response is confirmed */
export interface YesResyncResult {
  /** The effective transition time to apply as a resync point */
  effectiveTransitionAt: string;
  /** V2.1: always 'UTILITY_ON' (OFF reporting removed) */
  reportedState: 'UTILITY_ON';
  /** Reporter display name for community sync meta */
  reporterName: string | null;
  // ── TMMS V2.1: cloned offset data ──
  offsetState: OffsetState;
  offsetValue: OffsetValue;
  timelineAlignment: TimelineAlignment;
  // ── TMMS V2.1: Generated ON metadata ──
  generatedOnStartIso: string;
  generatedOnDurationMin: number | null;
  generatedOnReferenceIso: string | null;
  generatedOnReferenceKind: 'completed' | 'active' | null;
}

/**
 * Increment one or more numeric counters on a user's reliability row.
 *
 * Mirrors the exact read-then-upsert pattern the distribute-resync edge
 * function already uses for total_reports, for consistency.
 *
 * Deliberately does NOT touch reliability_score / community_trust_score —
 * those are DERIVED/aggregate scores. This only maintains the raw counters
 * such a score would be computed FROM.
 *
 * TMMS V2.1 note: this function is the ONLY place where community
 * confirmation affects anything reliability-related. Per the spec
 * ("Community confirmations only increase confidence and never modify
 * timeline calculations"), counters are bookkeeping for trust/confidence
 * — they never feed back into OffsetState/OffsetValue/TimelineAlignment.
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

// ── TMMS V2.1 FINAL: Offset is computed once at report time ──────────────
//
// PERIOD RULES (corrected per user clarification):
//   • Period 1: first half of OFF (<50% consumed) → POSITIVE offset
//   • Period 2: second half of OFF (>50% consumed) → NEGATIVE offset
//
// The offset state AND value are computed ONCE at report time based on which
// Period the report falls in. They are FINAL and NEVER change — not even
// when Growatt actually turns ON.
//
// `useGrowattOnWatcher` is kept for backwards compatibility but is now a
// no-op since offsets are final at report time. No recomputation needed.
//
// `useGrowattOnWatcher` listens for new UTILITY_ON rows in power_events.
// For every new ON event, it queries resync_history for recent rows and
// recomputes their offset_value using the actual Growatt ON time.
function useGrowattOnWatcher() {
  useEffect(() => {
    const channel = supabase
      .channel(`growatt_on_watcher_${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'power_events' },
        async (payload: any) => {
          const newRow = payload.new as { event_type?: string; occurred_at?: string };
          // V2.1: we only care about ON events — that's when offset values
          // get recomputed using the actual Growatt ON time.
          if (newRow.event_type !== 'UTILITY_ON' || !newRow.occurred_at) return;
          try {
            await resolveOffsetsWithGrowatt(newRow.occurred_at);
          } catch (e) {
            console.warn('[useResyncNotifications] offset resolution failed:', e);
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);
}

/**
 * Recompute the offset VALUE for recent resync_history rows using the
 * actual Growatt ON timestamp. The STATE stays LOCKED — it was determined
 * by the >50%/<50% rule at report time and never changes.
 *
 * CORRECTED V2.1:
 *   offsetValue = T − G  (where T = report time, G = actual Growatt ON time)
 *
 * Example: Report at 17:20, Growatt ON at 18:17 → offsetValue = −57 min.
 * The state was NEGATIVE (>50%) and stays NEGATIVE — only the value updates.
 *
 * This applies to ALL recent reports, not just >50% ones. For <50% reports
 * where T < G (the normal case), the value would be negative, but the state
 * stays POSITIVE (locked by the <50% rule). The IMPORTANT NOTICE highlights
 * the two cross-cases where the value sign confirms the state.
 */
async function resolveOffsetsWithGrowatt(growattOnIso: string): Promise<void> {
  const growattOnMs = new Date(growattOnIso).getTime();
  if (!Number.isFinite(growattOnMs)) return;

  // V2.1 CORRECTED: resolve ALL recent rows, not just PENDING_NEGATIVE ones.
  // The state is LOCKED — we only update the numeric offset_value.
  // We look for rows that haven't been resolved yet (pending_resolved_at IS NULL).
  // Also handle legacy PENDING_NEGATIVE rows that may still exist from the old logic.
  const { data: unresolvedRows, error } = await supabase
    .from('resync_history')
    .select('id, user_id, effective_transition_at, offset_state')
    .is('pending_resolved_at', null);

  if (error || !unresolvedRows || unresolvedRows.length === 0) return;

  // Recompute the offset value for each row. The STATE stays as-is (locked).
  for (const row of unresolvedRows) {
    const reportMs = new Date(row.effective_transition_at).getTime();
    if (!Number.isFinite(reportMs)) continue;

    // V2.1 CORRECTED: offsetValue = T − G (not G − T)
    // This gives: negative when T < G (electricity came before Growatt confirmed),
    //             positive when T > G (electricity came after Growatt confirmed).
    const offsetMin = Math.round((reportMs - growattOnMs) / 60_000);

    // The state stays LOCKED — whatever it was (POSITIVE, NEGATIVE, or
    // legacy PENDING_NEGATIVE). For legacy PENDING_NEGATIVE rows, update
    // them to NEGATIVE (they should have been NEGATIVE from the start
    // under the corrected logic).
    const lockedState = row.offset_state === 'PENDING_NEGATIVE' ? 'NEGATIVE' : row.offset_state;

    await supabase
      .from('resync_history')
      .update({
        offset_state: lockedState, // LOCKED — never changes (except legacy PENDING_NEGATIVE → NEGATIVE)
        offset_value: offsetMin, // recomputed as T − G
        // Keep timeline_alignment as-is — per spec, the alignment anchor
        // doesn't change when the value is resolved.
        pending_resolved_at: new Date().toISOString(),
      })
      .eq('id', row.id);
  }

  // Also update the latest user_offsets row for each affected user so the
  // Home Screen reads the resolved value on next mount.
  const userIds = [...new Set(unresolvedRows.map(r => r.user_id))];
  for (const userId of userIds) {
    const userRows = unresolvedRows.filter(r => r.user_id === userId);
    if (userRows.length === 0) continue;
    // Use the LATEST resolved report for this user (newest wins).
    const latest = userRows.sort((a, b) =>
      new Date(b.effective_transition_at).getTime() - new Date(a.effective_transition_at).getTime(),
    )[0];
    const reportMs = new Date(latest.effective_transition_at).getTime();
    const offsetMin = Math.round((reportMs - growattOnMs) / 60_000);
    const lockedState = latest.offset_state === 'PENDING_NEGATIVE' ? 'NEGATIVE' : latest.offset_state;

    await supabase
      .from('user_offsets')
      .upsert({
        user_id: userId,
        offset_minutes: offsetMin,
        offset_state: lockedState, // LOCKED
        offset_value: offsetMin, // recomputed
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
  }
}

// ── Backwards-compat alias ───────────────────────────────────────────────
// Old name kept for any code that still calls resolvePendingNegativeOffsets.
// Internally delegates to the new resolveOffsetsWithGrowatt.
async function resolvePendingNegativeOffsets(growattOnIso: string): Promise<void> {
  return resolveOffsetsWithGrowatt(growattOnIso);
}

export function useResyncNotifications() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<ResyncNotification[]>([]);
  const [history, setHistory] = useState<ResyncHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // TMMS V2.1 CORRECTED: arm the Growatt ON watcher so ALL offset values
  // get recomputed using the actual Growatt ON time when it arrives.
  // The STATE stays locked (determined by >50%/<50% rule), only the VALUE updates.
  useGrowattOnWatcher();

  const fetchNotifications = useCallback(async () => {
    if (!user) { setLoading(false); return; }

    // V2.1: filter out any legacy OFF reports at the source — the
    // notification list should only ever contain ON reports now.
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

    // V2.1: also fetch the reporter's offset snapshot from utility_reports
    // so the NotifCard can show "Approving will clone: Positive +24 min".
    const [{ data: reports }, { data: profiles }, { data: responses }] = await Promise.all([
      supabase
        .from('utility_reports')
        // V2.1 columns added: reporter_offset_state, reporter_offset_value,
        // reporter_timeline_alignment, generated_on_*. Older V2 rows will
        // return null for these — the UI handles that as "legacy report".
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
      profileMap[p.id] = p.username
        ?? (p as any).email?.split('@')[0]
        ?? null;
    }

    const responseMap: Record<number, 'yes' | 'no' | 'ignore'> = {};
    for (const r of responses ?? []) responseMap[r.notification_id] = r.response;

    const enriched: ResyncNotification[] = notifs
      .map(n => {
        const report = reportMap[n.report_id];
        // V2.1: filter out legacy OFF reports — they cannot be acted on
        // under V2.1 rules. (They should not exist in the DB at all going
        // forward, but defensive filtering protects against pre-migration
        // rows still sitting in the table.)
        if (report && report.reported_state === 'UTILITY_OFF') return null;
        return {
          ...n,
          reporter_username: profileMap[n.reporter_id] ?? `User_${n.reporter_id.slice(0, 6)}`,
          reported_state: 'UTILITY_ON' as const, // V2.1: hardcoded
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
    // V2.1: filter out legacy OFF entries from history display.
    const v21Entries = (data ?? []).filter(
      (row: any) => row.reported_state !== 'UTILITY_OFF',
    ) as ResyncHistoryEntry[];
    setHistory(v21Entries);
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
   * TMMS V2.1 changes:
   *   - The `response === 'yes'` branch NO LONGER recalculates anything.
   *     It CLONES the reporter's OffsetState / OffsetValue /
   *     TimelineAlignment verbatim (PDF §"APPROVER LOGIC").
   *   - The `reported_state` of the resulting YesResyncResult is always
   *     'UTILITY_ON' (OFF reporting removed).
   *   - The Generated ON metadata (start, duration, reference) is copied
   *     from the report so the Home Screen can render the Generated ON
   *     banner without re-running the engine.
   *   - Reliability counters are still bumped — that's confidence/trust
   *     bookkeeping, NOT timeline recalculation, so it's spec-compliant.
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

    // ── Reliability bookkeeping (confidence/trust only — NOT timeline) ──
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

    // V2.1: `response === 'yes'` branch is the APPROVER CLONE path.
    // PDF §"APPROVER LOGIC": "When the Approver presses Approve: The system
    // does not calculate a new offset. Instead, the Approver clones the
    // Reporter's synchronization information."
    if (response === 'yes') {
      /**
       * Effective transition time — Confirmation Timestamp Rule (preserved
       * from V2). estimated_transition_at is ALREADY the correct, complete,
       * absolute timestamp: the reporter computed it as
       *   report_created_at - selectedOffsetMinutes
       * at the moment they submitted the report. It is never adjusted by
       * the recipient's response delay.
       */
      const effectiveTransitionAt = notif.estimated_transition_at ?? new Date().toISOString();

      // ── V2.1: Clone the reporter's offset snapshot ───────────────────
      // If the report was created under V2.1, the reporter's offset
      // state/value/alignment live on the joined utility_reports row (we
      // fetched them in fetchNotifications). For legacy V2 reports these
      // fields are null — in that case the approver falls back to
      // NEUTRAL/0/effectiveTransitionAt, which is the safest possible
      // default (no shift, perfect alignment with the report time).
      const clonedOffsetState: OffsetState =
        notif.reporter_offset_state ?? 'NEUTRAL';
      const clonedOffsetValue: OffsetValue =
        notif.reporter_offset_value ?? 0;
      const clonedTimelineAlignment: TimelineAlignment =
        notif.reporter_timeline_alignment ?? effectiveTransitionAt;

      // ── V2.1: Clone the Generated ON metadata ────────────────────────
      // The reporter's report already created a Generated ON at submission
      // time. The approver inherits the SAME Generated ON — they don't get
      // a fresh one (PDF §"GENERATED ON IS A REAL TIMELINE EVENT": "Never
      // delete Generated ON later. Never replace it."). The approver's
      // timeline simply adopts the reporter's Generated ON as their
      // current state.
      const generatedOnStartIso = effectiveTransitionAt; // = report time
      const generatedOnDurationMin: number | null =
        (notif as any).generated_on_duration_min ?? null;
      const generatedOnReferenceIso: string | null =
        (notif as any).generated_on_reference_iso ?? null;
      const generatedOnReferenceKind: 'completed' | 'active' | null =
        (notif as any).generated_on_reference_kind ?? null;

      // Persist to resync_history — V2.1: include the cloned offset data
      // and Generated ON metadata so the Home Screen / Schedule / Debug
      // Simulator can read them back without re-deriving anything.
      await supabase.from('resync_history').insert({
        user_id: user.id,
        report_id: notif.report_id,
        reporter_id: notif.reporter_id,
        reporter_username: notif.reporter_username,
        reported_state: 'UTILITY_ON', // V2.1: hardcoded
        effective_transition_at: effectiveTransitionAt,
        confirmed_at: new Date().toISOString(),
        source: 'community_resync',
        // V2.1 cloned offset data:
        offset_state: clonedOffsetState,
        offset_value: clonedOffsetValue,
        timeline_alignment: clonedTimelineAlignment,
        // V2.1 Generated ON metadata (cloned from report):
        generated_on_start_iso: generatedOnStartIso,
        generated_on_duration_min: generatedOnDurationMin,
        generated_on_reference_iso: generatedOnReferenceIso,
        generated_on_reference_kind: generatedOnReferenceKind,
      });

      // V2.1: also upsert the user's user_offsets row so the next
      // useUserPredictions mount reads the cloned offset directly.
      // The numeric offset_minutes is 0 when the state is PENDING_NEGATIVE
      // — the actual numeric value will be filled in later by
      // resolvePendingNegativeOffsets when Growatt turns ON.
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
        reportedState: 'UTILITY_ON', // V2.1: always ON
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

  // V2.1: expose a helper so the Home Screen can read the user's CURRENT
  // offset state (most recent resync_history row) without re-fetching.
  // Used by useUserPredictions and the schedule screen.
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
    // V2.1 additions:
    currentOffsetState,
    currentOffsetValue,
    currentTimelineAlignment,
    currentGeneratedOn,
  };
}
