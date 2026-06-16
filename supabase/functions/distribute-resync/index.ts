import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

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

    console.log(
      `[auto-resolve] Conflict #${conflicts[0].id} for report ${reportId} ` +
      `auto-confirmed with ${yesCount} YES responses.`,
    );
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}

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

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // 1. Get reporter's username
    const { data: reporterProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('username')
      .eq('id', reporterId)
      .single();
    const reporterName = reporterProfile?.username ?? 'شخص ما';

    // 2. Get all accepted followers of the reporter
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
      console.log('No followers to notify for reporter:', reporterId);
      return new Response(
        JSON.stringify({ notified: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 3. Create resync_notifications (expires in 30 min)
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const notifRows = followerIds.map((recipientId) => ({
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
      return new Response(
        JSON.stringify({ error: notifError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 4. Check current Growatt state for conflict detection
    // Guard: only flag a conflict if the inverter reading is fresh (< 10 min old)
    // to avoid false positives caused by stale sensor data.
    const { data: currentState } = await supabaseAdmin
      .from('inverter_state')
      .select('utility_on, inverter_offline, last_polled')
      .eq('id', 1)
      .single();

    if (currentState && !currentState.inverter_offline) {
      const lastPolledMs = currentState.last_polled
        ? Date.now() - new Date(currentState.last_polled).getTime()
        : Infinity;
      const isStale = lastPolledMs > 10 * 60 * 1000; // older than 10 minutes

      if (!isStale) {
        const growattState = currentState.utility_on ? 'UTILITY_ON' : 'UTILITY_OFF';
        if (growattState !== reportedState) {
          // Deduplicate: avoid inserting a conflict for the same report twice
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
            console.log(
              `Conflict recorded: Growatt=${growattState}, Reported=${reportedState}, ` +
              `staleness=${Math.round(lastPolledMs / 1000)}s`,
            );
          } else {
            console.log(`Conflict for report ${reportId} already exists — skipping duplicate`);
          }
        }
      } else {
        console.log(
          `Skipping conflict check: Growatt data is stale ` +
          `(${Math.round(lastPolledMs / 60_000)} min old)`,
        );
      }
    }

    // 5. Send push notifications to followers
    // Only fetch tokens where user_id is non-null and belongs to a recipient
    const recipientIds = (insertedNotifs ?? []).map((n: any) => n.recipient_id).filter(Boolean);
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
    };
    const timeAr = timeLabelAr[timeOption] ?? timeOption;

    const pushMessages = (tokens ?? []).map((t: any) => ({
      to: t.token,
      title: `${stateEmoji} بلاغ من ${reporterName}`,
      body: `أفاد ${reporterName} أن ${stateAr} (${timeAr}) — هل هذا صحيح في موقعك؟`,
      // Highest delivery priority so the 30-minute window is never missed
      priority: "high",
      _displayInForeground: true,
      sound: "default",
      channelId: "community-alerts",
      // Keep alive for 20 minutes (validation window duration)
      ttl: 1200,
      badge: 1,
      data: { type: "community_resync", reportId },
    }));

    if (pushMessages.length > 0) {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pushMessages),
      });
    }

    // 6. Update reporter's reliability: increment total_reports
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
      `Distributed ${followerIds.length} resync notifications for report ${reportId}`,
    );

    // 7. Auto-resolve conflict if 3+ YES responses already exist
    await autoResolveConflictIfNeeded(supabaseAdmin, reportId, reportedState);

    return new Response(
      JSON.stringify({ notified: followerIds.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('distribute-resync error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
