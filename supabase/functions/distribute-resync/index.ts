import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });

/**
 * If a report has a conflict record AND has received 3+ YES responses,
 * automatically mark the conflict as 'community-confirmed' (low-priority).
 */
async function autoResolveConflictIfNeeded(
  admin: ReturnType<typeof createClient>,
  reportId: number,
  reportedState: string,
) {
  try {
    // Check if a conflict exists for this report that hasn't been reviewed
    const { data: conflicts } = await admin
      .from('community_conflicts')
      .select('id, reviewed_at')
      .eq('report_id', reportId)
      .is('reviewed_at', null)
      .limit(1);

    if (!conflicts || conflicts.length === 0) return; // no unreviewed conflict

    const conflict = conflicts[0];

    // Count YES responses for this report
    const { count: yesCount } = await admin
      .from('resync_responses')
      .select('*', { count: 'exact', head: true })
      .eq('report_id', reportId)
      .eq('response', 'yes');

    if ((yesCount ?? 0) < 3) return; // not enough confirmations yet

    // Auto-mark as community-confirmed
    const note = `Auto-resolved: ${yesCount} community YES confirmations received for ${reportedState} report. ` +
      `Community consensus overrides sensor reading. Low-priority review.`;

    await admin
      .from('community_conflicts')
      .update({
        reviewed_at: new Date().toISOString(),
        notes: note,
      })
      .eq('id', conflict.id);

    console.log(
      `[auto-resolve] Conflict #${conflict.id} for report ${reportId} auto-confirmed ` +
      `with ${yesCount} YES responses.`,
    );
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}
  }

  try {
    const { reportId, reporterId, reportedState, estimatedTransitionAt, timeOption } = await req.json();

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
    const reporterName = reporterProfile?.username ?? 'Someone';

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
      return new Response(JSON.stringify({ notified: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

/**
 * If a report has a conflict record AND has received 3+ YES responses,
 * automatically mark the conflict as 'community-confirmed' (low-priority).
 */
async function autoResolveConflictIfNeeded(
  admin: ReturnType<typeof createClient>,
  reportId: number,
  reportedState: string,
) {
  try {
    // Check if a conflict exists for this report that hasn't been reviewed
    const { data: conflicts } = await admin
      .from('community_conflicts')
      .select('id, reviewed_at')
      .eq('report_id', reportId)
      .is('reviewed_at', null)
      .limit(1);

    if (!conflicts || conflicts.length === 0) return; // no unreviewed conflict

    const conflict = conflicts[0];

    // Count YES responses for this report
    const { count: yesCount } = await admin
      .from('resync_responses')
      .select('*', { count: 'exact', head: true })
      .eq('report_id', reportId)
      .eq('response', 'yes');

    if ((yesCount ?? 0) < 3) return; // not enough confirmations yet

    // Auto-mark as community-confirmed
    const note = `Auto-resolved: ${yesCount} community YES confirmations received for ${reportedState} report. ` +
      `Community consensus overrides sensor reading. Low-priority review.`;

    await admin
      .from('community_conflicts')
      .update({
        reviewed_at: new Date().toISOString(),
        notes: note,
      })
      .eq('id', conflict.id);

    console.log(
      `[auto-resolve] Conflict #${conflict.id} for report ${reportId} auto-confirmed ` +
      `with ${yesCount} YES responses.`,
    );
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}
    }

    // 3. Create resync_notifications (expires in 30 min)
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const notifRows = followerIds.map(recipientId => ({
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
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

/**
 * If a report has a conflict record AND has received 3+ YES responses,
 * automatically mark the conflict as 'community-confirmed' (low-priority).
 */
async function autoResolveConflictIfNeeded(
  admin: ReturnType<typeof createClient>,
  reportId: number,
  reportedState: string,
) {
  try {
    // Check if a conflict exists for this report that hasn't been reviewed
    const { data: conflicts } = await admin
      .from('community_conflicts')
      .select('id, reviewed_at')
      .eq('report_id', reportId)
      .is('reviewed_at', null)
      .limit(1);

    if (!conflicts || conflicts.length === 0) return; // no unreviewed conflict

    const conflict = conflicts[0];

    // Count YES responses for this report
    const { count: yesCount } = await admin
      .from('resync_responses')
      .select('*', { count: 'exact', head: true })
      .eq('report_id', reportId)
      .eq('response', 'yes');

    if ((yesCount ?? 0) < 3) return; // not enough confirmations yet

    // Auto-mark as community-confirmed
    const note = `Auto-resolved: ${yesCount} community YES confirmations received for ${reportedState} report. ` +
      `Community consensus overrides sensor reading. Low-priority review.`;

    await admin
      .from('community_conflicts')
      .update({
        reviewed_at: new Date().toISOString(),
        notes: note,
      })
      .eq('id', conflict.id);

    console.log(
      `[auto-resolve] Conflict #${conflict.id} for report ${reportId} auto-confirmed ` +
      `with ${yesCount} YES responses.`,
    );
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}
    }

    // 4. Check current Growatt state for conflict detection
    const { data: currentState } = await supabaseAdmin
      .from('inverter_state')
      .select('utility_on, inverter_offline')
      .eq('id', 1)
      .single();

    if (currentState && !currentState.inverter_offline) {
      const growattState = currentState.utility_on ? 'UTILITY_ON' : 'UTILITY_OFF';
      if (growattState !== reportedState) {
        // Conflict: community report disagrees with Growatt
        await supabaseAdmin.from('community_conflicts').insert({
          report_id: reportId,
          growatt_state: growattState,
          reported_state: reportedState,
        });

/**
 * If a report has a conflict record AND has received 3+ YES responses,
 * automatically mark the conflict as 'community-confirmed' (low-priority).
 */
async function autoResolveConflictIfNeeded(
  admin: ReturnType<typeof createClient>,
  reportId: number,
  reportedState: string,
) {
  try {
    // Check if a conflict exists for this report that hasn't been reviewed
    const { data: conflicts } = await admin
      .from('community_conflicts')
      .select('id, reviewed_at')
      .eq('report_id', reportId)
      .is('reviewed_at', null)
      .limit(1);

    if (!conflicts || conflicts.length === 0) return; // no unreviewed conflict

    const conflict = conflicts[0];

    // Count YES responses for this report
    const { count: yesCount } = await admin
      .from('resync_responses')
      .select('*', { count: 'exact', head: true })
      .eq('report_id', reportId)
      .eq('response', 'yes');

    if ((yesCount ?? 0) < 3) return; // not enough confirmations yet

    // Auto-mark as community-confirmed
    const note = `Auto-resolved: ${yesCount} community YES confirmations received for ${reportedState} report. ` +
      `Community consensus overrides sensor reading. Low-priority review.`;

    await admin
      .from('community_conflicts')
      .update({
        reviewed_at: new Date().toISOString(),
        notes: note,
      })
      .eq('id', conflict.id);

    console.log(
      `[auto-resolve] Conflict #${conflict.id} for report ${reportId} auto-confirmed ` +
      `with ${yesCount} YES responses.`,
    );
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}
        console.log(`Conflict recorded: Growatt=${growattState}, Reported=${reportedState}`);
      }
    }

    // 5. Send push notifications to followers
    const recipientIds = (insertedNotifs ?? []).map((n: any) => n.recipient_id);
    const { data: tokens } = await supabaseAdmin
      .from('push_tokens')
      .select('token')
      .in('user_id', recipientIds);

    const stateEmoji = reportedState === 'UTILITY_ON' ? '⚡' : '🔴';
    const stateLabel = reportedState === 'UTILITY_ON' ? 'came ON' : 'went OFF';
    const timeLabel: Record<string, string> = {
      now: 'just now',
      '5min': 'about 5 minutes ago',
      '10min': 'about 10 minutes ago',
      '15min': 'about 15 minutes ago',
      '20min': 'about 20 minutes ago',
    };

    const pushMessages = (tokens ?? []).map((t: any) => ({
      to: t.token,
      title: `${stateEmoji} Grid Update from ${reporterName}`,
      body: `${reporterName} reports electricity ${stateLabel} (${timeLabel[timeOption] ?? timeOption}). Is this correct for your location?`,
      data: { type: 'community_resync', reportId },
      priority: 'high',
      sound: 'default',
      channelId: 'community-alerts',
    }));

    if (pushMessages.length > 0) {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pushMessages),
      });

/**
 * If a report has a conflict record AND has received 3+ YES responses,
 * automatically mark the conflict as 'community-confirmed' (low-priority).
 */
async function autoResolveConflictIfNeeded(
  admin: ReturnType<typeof createClient>,
  reportId: number,
  reportedState: string,
) {
  try {
    // Check if a conflict exists for this report that hasn't been reviewed
    const { data: conflicts } = await admin
      .from('community_conflicts')
      .select('id, reviewed_at')
      .eq('report_id', reportId)
      .is('reviewed_at', null)
      .limit(1);

    if (!conflicts || conflicts.length === 0) return; // no unreviewed conflict

    const conflict = conflicts[0];

    // Count YES responses for this report
    const { count: yesCount } = await admin
      .from('resync_responses')
      .select('*', { count: 'exact', head: true })
      .eq('report_id', reportId)
      .eq('response', 'yes');

    if ((yesCount ?? 0) < 3) return; // not enough confirmations yet

    // Auto-mark as community-confirmed
    const note = `Auto-resolved: ${yesCount} community YES confirmations received for ${reportedState} report. ` +
      `Community consensus overrides sensor reading. Low-priority review.`;

    await admin
      .from('community_conflicts')
      .update({
        reviewed_at: new Date().toISOString(),
        notes: note,
      })
      .eq('id', conflict.id);

    console.log(
      `[auto-resolve] Conflict #${conflict.id} for report ${reportId} auto-confirmed ` +
      `with ${yesCount} YES responses.`,
    );
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}
    }

    // 6. Update reporter's reliability: increment total_reports
    const { data: relRow } = await supabaseAdmin
      .from('user_reliability')
      .select('total_reports')
      .eq('user_id', reporterId)
      .single();
    await supabaseAdmin
      .from('user_reliability')
      .upsert({
        user_id: reporterId,
        total_reports: (relRow?.total_reports ?? 0) + 1,
        last_report_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

/**
 * If a report has a conflict record AND has received 3+ YES responses,
 * automatically mark the conflict as 'community-confirmed' (low-priority).
 */
async function autoResolveConflictIfNeeded(
  admin: ReturnType<typeof createClient>,
  reportId: number,
  reportedState: string,
) {
  try {
    // Check if a conflict exists for this report that hasn't been reviewed
    const { data: conflicts } = await admin
      .from('community_conflicts')
      .select('id, reviewed_at')
      .eq('report_id', reportId)
      .is('reviewed_at', null)
      .limit(1);

    if (!conflicts || conflicts.length === 0) return; // no unreviewed conflict

    const conflict = conflicts[0];

    // Count YES responses for this report
    const { count: yesCount } = await admin
      .from('resync_responses')
      .select('*', { count: 'exact', head: true })
      .eq('report_id', reportId)
      .eq('response', 'yes');

    if ((yesCount ?? 0) < 3) return; // not enough confirmations yet

    // Auto-mark as community-confirmed
    const note = `Auto-resolved: ${yesCount} community YES confirmations received for ${reportedState} report. ` +
      `Community consensus overrides sensor reading. Low-priority review.`;

    await admin
      .from('community_conflicts')
      .update({
        reviewed_at: new Date().toISOString(),
        notes: note,
      })
      .eq('id', conflict.id);

    console.log(
      `[auto-resolve] Conflict #${conflict.id} for report ${reportId} auto-confirmed ` +
      `with ${yesCount} YES responses.`,
    );
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}

    console.log(`Distributed ${followerIds.length} resync notifications for report ${reportId}`);

    // 7. Check if 3+ YES responses exist for a conflict — auto-mark as community-confirmed
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

/**
 * If a report has a conflict record AND has received 3+ YES responses,
 * automatically mark the conflict as 'community-confirmed' (low-priority).
 */
async function autoResolveConflictIfNeeded(
  admin: ReturnType<typeof createClient>,
  reportId: number,
  reportedState: string,
) {
  try {
    // Check if a conflict exists for this report that hasn't been reviewed
    const { data: conflicts } = await admin
      .from('community_conflicts')
      .select('id, reviewed_at')
      .eq('report_id', reportId)
      .is('reviewed_at', null)
      .limit(1);

    if (!conflicts || conflicts.length === 0) return; // no unreviewed conflict

    const conflict = conflicts[0];

    // Count YES responses for this report
    const { count: yesCount } = await admin
      .from('resync_responses')
      .select('*', { count: 'exact', head: true })
      .eq('report_id', reportId)
      .eq('response', 'yes');

    if ((yesCount ?? 0) < 3) return; // not enough confirmations yet

    // Auto-mark as community-confirmed
    const note = `Auto-resolved: ${yesCount} community YES confirmations received for ${reportedState} report. ` +
      `Community consensus overrides sensor reading. Low-priority review.`;

    await admin
      .from('community_conflicts')
      .update({
        reviewed_at: new Date().toISOString(),
        notes: note,
      })
      .eq('id', conflict.id);

    console.log(
      `[auto-resolve] Conflict #${conflict.id} for report ${reportId} auto-confirmed ` +
      `with ${yesCount} YES responses.`,
    );
  } catch (err) {
    console.error('[auto-resolve] error:', err);
  }
}
