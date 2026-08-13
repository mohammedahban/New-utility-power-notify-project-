import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { sendExpoPush } from '../_shared/push.ts';

/**
 * test-push — REAL remote push self-test.
 *
 * The in-app "test notification" buttons fire a LOCAL notification, which
 * proves nothing about remote delivery (Expo push service → FCM → device).
 * This function sends an actual push through the Expo push service to every
 * token registered for the CALLING user and returns the per-token ticket
 * results, so the app can show exactly what happened:
 *   ok / DeviceNotRegistered / InvalidCredentials / ...
 *
 * Auth: the caller's JWT (verify_jwt). A user can only test their OWN tokens.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Identify the caller from the JWT.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: tokens } = await admin
      .from('push_tokens')
      .select('token')
      .eq('user_id', user.id);

    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({
        ok: false,
        reason: 'no_tokens',
        message: 'لا يوجد رمز إشعارات مسجّل لهذا الحساب على هذا الجهاز. أعد فتح التطبيق واسمح بالإشعارات ثم حاول مجدداً.',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const now = new Date().toLocaleString('ar-SA', {
      timeZone: 'Asia/Aden', hour: '2-digit', minute: '2-digit', hour12: true,
    });

    const messages = tokens.map(({ token }: { token: string }) => ({
      to: token,
      title: '✅ اختبار إشعار فعلي',
      body: `إشعار حقيقي عبر الخادم — ${now}. إذا وصلك هذا فالتسليم البعيد يعمل.`,
      sound: 'default',
      channelId: 'community-alerts',
      priority: 'high',
      _displayInForeground: true,
      ttl: 600,
      data: { type: 'remote_self_test' },
    }));

    const result = await sendExpoPush(
      admin,
      messages as Array<Record<string, unknown> & { to: string }>,
      'test-push',
    );

    return new Response(JSON.stringify({
      ok: result.ok > 0,
      sent: result.sent,
      deliveredToExpo: result.ok,
      deadTokensRemoved: result.deadTokens.length,
      errors: result.errors.map(e => ({ tokenSuffix: e.token.slice(-8), error: e.error, message: e.message })),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('test-push error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
