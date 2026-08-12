import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

/**
 * distribute-resync — fan out a reporter's ON report to accepted followers.
 *
 * Audit-fix version (see audit report F-01/F-04/F-10/F-12/F-14/F-24):
 *  F-10  Caller authentication: the caller's JWT must belong to `reporterId`,
 *        and the referenced report must exist, belong to the reporter, match
 *        `reportedState`, and be recent. Prevents anonymous forged fan-out.
 *  F-24  Idempotency: a second invocation for an (almost) identical report
 *        (same reporter, transition within ±60 s) distributes nothing.
 *  F-01  One-hour community window (spec §25–§27): per recipient, if their
 *        latest applicable event (own report or accepted clone) is within one
 *        hour BEFORE the new event, the earliest event wins and the new
 *        notification is suppressed. Events >1h apart replace (delivered).
 *  F-14  One-hour sound throttle (spec §33): a delivered push carries an
 *        audible sound only if no community notification reached this
 *        recipient in the last hour; otherwise it is sent to the quiet
 *        Android channel / without sound on iOS. Backend processing is
 *        never suppressed — only the audible part.
 *  F-04  Three-hour propagation (spec §32): notifications expire after
 *        3 hours and pushes use a 3-hour TTL.
 *  F-12  Conflict detection: ON reports while Growatt shows OFF are the
 *        designed Period-2 case (user power precedes the sensor) and are no
 *        longer flagged as conflicts.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const DEDUP_WINDOW_MS = 60 * 1000;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const {
      reportId,
      reporterId,
      reportedState,
      estimatedTransitionAt,
      timeOption,
    } = await req.json();

    // ── F-10: authenticate the caller ────────────────────────────────────────
    // The caller must be a signed-in user AND must be the reporter. This stops
    // anonymous abuse of the (public) anon key for forged follower fan-out.
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user: caller }, error: authErr } = await supabaseUser.auth.getUser();
    if (authErr || !caller || caller.id !== reporterId) {
      return new Response(JSON.stringify({ error: 'Caller is not the reporter' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // ── F-10: validate the referenced report ─────────────────────────────────
    const { data: reportRow } = await supabaseAdmin
      .from('utility_reports')
      .select('id, reporter_id, reported_state, created_at')
      .eq('id', reportId)
      .maybeSingle();
    const reportAgeMs = reportRow ? Date.now() - new Date(reportRow.created_at).getTime() : Infinity;
    if (
      !reportRow ||
      reportRow.reporter_id !== reporterId ||
      reportRow.reported_state !== reportedState ||
      reportAgeMs > 10 * 60 * 1000
    ) {
      return new Response(JSON.stringify({ error: 'Invalid report reference' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const reportMs = new Date(estimatedTransitionAt).getTime();

    // ── F-24: idempotency — same reporter, same transition (±60 s) already
    // distributed → do nothing. Compare against the reports table (transition
    // time), then check whether that twin report already fanned out.
    const { data: twinReports } = await supabaseAdmin
      .from('utility_reports')
      .select('id')
      .eq('reporter_id', reporterId)
      .neq('id', reportId)
      .gte('estimated_transition_at', new Date(reportMs - DEDUP_WINDOW_MS).toISOString())
      .lte('estimated_transition_at', new Date(reportMs + DEDUP_WINDOW_MS).toISOString());
    const twinIds = (twinReports ?? []).map((r: any) => r.id);
    let alreadyDistributed = false;
    if (twinIds.length > 0) {
      const { count: twinNotifs } = await supabaseAdmin
        .from('resync_notifications')
        .select('id', { count: 'exact', head: true })
        .in('report_id', twinIds);
      alreadyDistributed = (twinNotifs ?? 0) > 0;
    }
    if (alreadyDistributed) {
      return new Response(JSON.stringify({ notified: 0, deduplicated: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Reporter's username
    const { data: reporterProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('username')
      .eq('id', reporterId)
      .single();
    const reporterName = reporterProfile?.username ?? 'شخص ما';

    // 2. Accepted followers of the reporter
    const { data: follows, error: followsError } = await supabaseAdmin
      .from('follows')
      .select('requester_id')
      .eq('target_id', reporterId)
      .eq('status', 'accepted');

    if (followsError) {
      console.error('follows error:', followsError.message);
    }

    const followerIds: string[] = (follows ?? []).map((f: any) => f.requester_id);

    if (followerIds.length === 0) {
      return new Response(JSON.stringify({ notified: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── F-01: one-hour community window (spec §25–§27) ──────────────────────
    // For each follower, find their latest applicable event (own report OR
    // accepted community clone). If that event is within one hour before the
    // new event, the EARLIEST event wins → suppress this notification for
    // that follower. If more than one hour has passed, the new event
    // legitimately replaces the previous clone (spec §26).
    // Spec §29: a REVERT does NOT erase the historical event for window
    // purposes — reverted rows still anchor the one-hour window, so no
    // reverted_at filter is applied here.
    const { data: recentEvents } = await supabaseAdmin
      .from('resync_history')
      .select('user_id, effective_transition_at, source, confirmed_at')
      .in('user_id', followerIds)
      .gte('effective_transition_at', new Date(reportMs - ONE_HOUR_MS).toISOString())
      .lte('effective_transition_at', new Date(reportMs).toISOString());

    const suppressed = new Set<string>();
    for (const ev of recentEvents ?? []) {
      const evMs = new Date(ev.effective_transition_at).getTime();
      // An event strictly inside (reportMs − 1h, reportMs] blocks the new one.
      if (evMs > reportMs - ONE_HOUR_MS && evMs <= reportMs) {
        suppressed.add(ev.user_id);
      }
    }

    const eligibleIds = followerIds.filter((id) => !suppressed.has(id));

    if (eligibleIds.length === 0) {
      console.log(`All ${followerIds.length} followers suppressed by the one-hour window`);
      return new Response(JSON.stringify({ notified: 0, suppressed: followerIds.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Create resync_notifications — F-04: 3-hour expiry (spec §32).
    const expiresAt = new Date(Date.now() + THREE_HOURS_MS).toISOString();
    const notifRows = eligibleIds.map((recipientId) => ({
      report_id: reportId,
      reporter_id: reporterId,
      recipient_id: recipientId,
      expires_at: expiresAt,
    }));

    const { data: insertedNotifs, error: notifError } = await supabaseAdmin
      .from('resync_notifications')
      .insert(notifRows)
      .select('id, recipient_id');

    if (notifError) {
      console.error('notif insert error:', notifError.message);
      return new Response(JSON.stringify({ error: notifError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 4. Conflict detection — F-12: with ON-only reporting, "reported ON while
    // Growatt shows OFF" is the DESIGNED Period-2 case (user power precedes the
    // sensor), not a conflict. Conflicts are only meaningful for OFF reports.
    if (reportedState !== 'UTILITY_ON') {
      const { data: currentState } = await supabaseAdmin
        .from('inverter_state')
        .select('utility_on, inverter_offline, last_polled')
        .eq('id', 1)
        .single();

      if (currentState && !currentState.inverter_offline) {
        const lastPolledMs = currentState.last_polled
          ? Date.now() - new Date(currentState.last_polled).getTime()
          : Infinity;
        const isStale = lastPolledMs > 10 * 60 * 1000;

        if (!isStale) {
          const growattState = currentState.utility_on ? 'UTILITY_ON' : 'UTILITY_OFF';
          if (growattState !== reportedState) {
            const { count: existingCount } = await supabaseAdmin
              .from('community_conflicts')
              .select('id', { count: 'exact', head: true })
              .eq('report_id', reportId);

            if ((existingCount ?? 0) === 0) {
              await supabaseAdmin.from('community_conflicts').insert({
                report_id: reportId,
                growatt_state: growattState,
                reported_state: reportedState,
              });
            }
          }
        }
      }
    }

    // 5. Push notifications — F-14: audible sound only if this recipient has
    // not received any community notification in the last hour (spec §33).
    const recipientIds = (insertedNotifs ?? []).map((n: any) => n.recipient_id).filter(Boolean);

    const { data: recentNotifs } = recipientIds.length > 0
      ? await supabaseAdmin
          .from('resync_notifications')
          .select('recipient_id')
          .in('recipient_id', recipientIds)
          .lt('report_id', reportId)
          .gte('created_at', new Date(Date.now() - ONE_HOUR_MS).toISOString())
      : { data: [] as any[] };
    const recentNotifSet = new Set((recentNotifs ?? []).map((r: any) => r.recipient_id));

    const { data: tokens } = recipientIds.length > 0
      ? await supabaseAdmin
          .from('push_tokens')
          .select('token, user_id')
          .in('user_id', recipientIds)
          .not('user_id', 'is', null)
      : { data: [] };

    const stateEmoji = reportedState === 'UTILITY_ON' ? '⚡' : '🔴';
    const stateAr = reportedState === 'UTILITY_ON' ? 'اشتغلت الكهرباء' : 'طفت الكهرباء';
    const timeLabelAr: Record<string, string> = {
      now: 'الآن',
      '5min': 'منذ ~5 دقائق',
      '10min': 'منذ ~10 دقائق',
      '15min': 'منذ ~15 دقيقة',
      '20min': 'منذ ~20 دقيقة',
      '30min': 'منذ ~30 دقيقة',
    };
    const timeAr = timeLabelAr[timeOption] ?? timeOption;

    const pushMessages = (tokens ?? []).map((t: any) => {
      const audible = !recentNotifSet.has(t.user_id);
      return {
        to: t.token,
        title: `${stateEmoji} بلاغ من ${reporterName}`,
        body: `أفاد ${reporterName} أن ${stateAr} (${timeAr}) — هل هذا صحيح في موقعك؟`,
        priority: 'high',
        _displayInForeground: true,
        // F-14: quiet notifications go to the silent Android channel and carry
        // no sound key (iOS silent). Audible ones use the default sound.
        ...(audible ? { sound: 'default' } : {}),
        channelId: audible ? 'community-alerts' : 'community-alerts-quiet',
        ttl: Math.floor(THREE_HOURS_MS / 1000), // F-04: 3-hour push TTL
        badge: 1,
        data: { type: 'community_resync', reportId, audible },
      };
    });

    if (pushMessages.length > 0) {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pushMessages),
      });
    }

    // 6. Reporter reliability: increment total_reports
    const { data: relRow } = await supabaseAdmin
      .from('user_reliability')
      .select('total_reports')
      .eq('user_id', reporterId)
      .single();

    await supabaseAdmin
      .from('user_reliability')
      .upsert(
        {
          user_id: reporterId,
          total_reports: (relRow?.total_reports ?? 0) + 1,
          last_report_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );

    console.log(
      `Distributed ${recipientIds.length} notifications for report ${reportId} ` +
      `(${suppressed.size} suppressed by one-hour window)`,
    );

    // 7. Auto-resolve conflict if 3+ YES responses already exist
    await autoResolveConflictIfNeeded(supabaseAdmin, reportId, reportedState);

    return new Response(
      JSON.stringify({ notified: recipientIds.length, suppressed: suppressed.size }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('distribute-resync error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

/**
 * If a report has an unreviewed conflict AND has received 3+ YES responses,
 * automatically mark the conflict as 'community-confirmed' (low-priority).
 */
async function autoResolveConflictIfNeeded(
  admin: ReturnType<typeof createClient>,
  reportId: number,
  reportedState: string,
) {
  try {
    const { data: conflicts } = await admin
      .from('community_conflicts')
      .select('id, reviewed_at')
      .eq('report_id', reportId)
      .is('reviewed_at', null)
      .limit(1);

    if (!conflicts || conflicts.length === 0) return;

    const { count: yesCount } = await admin
      .from('resync_responses')
      .select('*', { count: 'exact', head: true })
      .eq('report_id', reportId)
      .eq('response', 'yes');

    if ((yesCount ?? 0) < 3) return;

    const note =
      `Auto-resolved: ${yesCount} community YES confirmations received for ` +
      `${reportedState} report. Community consensus overrides sensor reading.`;

    await admin
      .from('community_conflicts')
      .update({ reviewed_at: new Date().toISOString(), notes: note })
      .eq('id', conflicts[0].id);
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}
