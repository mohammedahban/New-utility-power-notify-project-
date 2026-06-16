/**
 * compute-analytics — Daily analytics snapshot computation
 * Intended to run at 06:00 Yemen time (03:00 UTC) via external cron trigger.
 * Can also be invoked manually from the admin panel.
 *
 * Computes and upserts into analytics_daily_snapshots:
 *   total_users, new_users_24h,
 *   active_users_24h/7d/30d, sessions_24h/7d/30d,
 *   total_seconds_24h/7d/30d, avg_session_seconds
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const now = new Date();
    const snapshotDate = now.toISOString().slice(0, 10); // YYYY-MM-DD

    const ago = (days: number) =>
      new Date(now.getTime() - days * 86400 * 1000).toISOString();

    // ── Total users ─────────────────────────────────────────────────────────
    const { count: totalUsers } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true });

    // ── New users in last 24 h ────────────────────────────────────────────
    const { count: newUsers24h } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', ago(1));

    // ── Sessions helper ───────────────────────────────────────────────────
    const fetchSessions = async (since: string) => {
      const { data } = await supabase
        .from('user_activity_logs')
        .select('user_id, duration_seconds')
        .gte('started_at', since)
        .not('ended_at', 'is', null);
      return data ?? [];
    };

    const sessions24h = await fetchSessions(ago(1));
    const sessions7d  = await fetchSessions(ago(7));
    const sessions30d = await fetchSessions(ago(30));

    const distinctUsers = (rows: { user_id: string }[]) =>
      new Set(rows.map((r) => r.user_id)).size;

    const totalSecs = (rows: { duration_seconds: number | null }[]) =>
      rows.reduce((s, r) => s + (r.duration_seconds ?? 0), 0);

    const secs24h = totalSecs(sessions24h);
    const secs7d  = totalSecs(sessions7d);
    const secs30d = totalSecs(sessions30d);

    const avgSec = sessions30d.length > 0
      ? Math.round(secs30d / sessions30d.length)
      : 0;

    const snapshot = {
      snapshot_date:       snapshotDate,
      total_users:         totalUsers ?? 0,
      new_users_24h:       newUsers24h ?? 0,
      active_users_24h:    distinctUsers(sessions24h),
      active_users_7d:     distinctUsers(sessions7d),
      active_users_30d:    distinctUsers(sessions30d),
      sessions_24h:        sessions24h.length,
      sessions_7d:         sessions7d.length,
      sessions_30d:        sessions30d.length,
      total_seconds_24h:   secs24h,
      total_seconds_7d:    secs7d,
      total_seconds_30d:   secs30d,
      avg_session_seconds: avgSec,
      computed_at:         now.toISOString(),
    };

    const { error } = await supabase
      .from('analytics_daily_snapshots')
      .upsert(snapshot, { onConflict: 'snapshot_date' });

    if (error) {
      console.error('[compute-analytics] upsert error:', error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[compute-analytics] snapshot saved for ${snapshotDate}`);
    return new Response(JSON.stringify({ ok: true, snapshot }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[compute-analytics] unexpected error:', err?.message ?? err);
    return new Response(JSON.stringify({ error: err?.message ?? 'unknown' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
