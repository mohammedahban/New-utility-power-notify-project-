// poll-growatt Edge Function
// Polls Growatt storage API.
// IMPORTANT: Set cron schedule to "*/5 * * * *" (every 5 minutes) in Supabase dashboard.
// Sends push notifications ONLY to admin tokens (is_admin = true).
// Auto-triggers analyze-patterns IMMEDIATELY after detecting a state change.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const GROWATT_TOKEN = Deno.env.get("GROWATT_TOKEN")!;
const INVERTER_SN   = Deno.env.get("GROWATT_INVERTER_SN")!;
const PAC_INPUT_THRESHOLD = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── 1. Poll Growatt ────────────────────────────────────────────────────────
  let json: any;
  try {
    const apiUrl = `http://openapi.growatt.com/v1/device/storage/storage_last_data?storage_sn=${INVERTER_SN}`;
    console.log(`[poll-growatt] POST ${apiUrl}`);

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { token: GROWATT_TOKEN, "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      console.error(`[poll-growatt] HTTP ${res.status}`);
      return new Response(JSON.stringify({ ok: false, error: `HTTP ${res.status}` }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    json = await res.json();
    console.log("[poll-growatt] Response:", JSON.stringify(json).slice(0, 400));
  } catch (err) {
    console.error("[poll-growatt] Fetch failed:", err);
    return new Response(JSON.stringify({ ok: false, error: "Growatt fetch failed" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (json.error_code !== 0) {
    console.error("[poll-growatt] API error:", json.error_code, json.error_msg);
    return new Response(JSON.stringify({ ok: false, error: json.error_msg }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const d = json.data;

  // ── 2. Handle inverter offline ─────────────────────────────────────────────
  if (!d || typeof d !== "object") {
    console.warn("[poll-growatt] Inverter offline — empty data");
    await supabase.from("inverter_state").upsert({
      id: 1, last_polled: new Date().toISOString(), inverter_offline: true,
    });
    return new Response(JSON.stringify({ ok: true, note: "inverter_offline" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── 3. Extract fields ──────────────────────────────────────────────────────
  const pAcInput: number = parseFloat(String(d.pAcInPut ?? d.pacInPut ?? d.pac_input ?? "0")) || 0;
  const sysOut: number   = parseFloat(String(d.sysOut ?? d.pac ?? d.outPutPower1 ?? "0")) || 0;
  const ppvTotal: number = (parseFloat(String(d.ppv ?? "0")) || 0) + (parseFloat(String(d.ppv2 ?? "0")) || 0);

  let statusText = "";
  if (d.statusText) {
    statusText = d.statusText;
  } else if (pAcInput > PAC_INPUT_THRESHOLD) {
    statusText = "AC charge and Bypass";
  } else if (ppvTotal > 50) {
    statusText = "PV charge and Bypass";
  } else {
    statusText = "Discharge";
  }

  const utilityIsOn: boolean = pAcInput > PAC_INPUT_THRESHOLD;
  const now = new Date().toISOString();

  console.log(`[poll-growatt] pAcInput=${pAcInput}W sysOut=${sysOut}W utilityOn=${utilityIsOn}`);

  // ── 4. Read previous state ─────────────────────────────────────────────────
  const { data: prevState, error: prevErr } = await supabase
    .from("inverter_state")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (prevErr) console.error("[poll-growatt] Prev state error:", prevErr.message);

  const previouslyOn: boolean = prevState?.utility_on ?? utilityIsOn;
  const stateChanged = prevState !== null && !prevState.inverter_offline && utilityIsOn !== previouslyOn;

  // ── 5. Handle state change ─────────────────────────────────────────────────
  if (stateChanged) {
    const eventType = utilityIsOn ? "UTILITY_ON" : "UTILITY_OFF";
    const isOn = utilityIsOn;
    console.log(`[poll-growatt] Transition: ${eventType}`);

    // Insert power event
    await supabase.from("power_events").insert({
      event_type: eventType,
      occurred_at: now,
      vac: pAcInput,
      pac_to_user: sysOut,
      status_text: statusText,
    });

    // ── Send push to admin tokens ───────────────────────────────────────────
    // Primary: tokens flagged is_admin=true
    // Fallback: look up all user_ids with role='admin' in user_profiles,
    //           then fetch their tokens (covers tokens registered before
    //           the admin flag was set on the push_tokens row).
    const { data: directAdminTokens } = await supabase
      .from("push_tokens")
      .select("token")
      .eq("is_admin", true);

    const { data: adminProfiles } = await supabase
      .from("user_profiles")
      .select("id")
      .eq("role", "admin");

    const adminUserIds = (adminProfiles ?? []).map((p: any) => p.id);
    const { data: profileAdminTokens } = adminUserIds.length > 0
      ? await supabase.from("push_tokens").select("token").in("user_id", adminUserIds)
      : { data: [] };

    // Merge and deduplicate by token string
    const allAdminTokenSet = new Set<string>();
    for (const row of [...(directAdminTokens ?? []), ...(profileAdminTokens ?? [])]) {
      if (row.token) allAdminTokenSet.add(row.token);
    }
    const adminTokens = Array.from(allAdminTokenSet).map(token => ({ token }));

    // Also back-fill is_admin=true on any token belonging to an admin user
    // so future queries are instant (fire-and-forget, non-blocking)
    if (adminUserIds.length > 0) {
      supabase.from("push_tokens").update({ is_admin: true }).in("user_id", adminUserIds)
        .then(() => console.log("[poll-growatt] Backfilled is_admin on admin tokens"))
        .catch(() => {});
    }

    if (adminTokens.length > 0) {
      const localTimeAr = new Date(now).toLocaleString("ar-SA", {
        timeZone: "Asia/Aden",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });

      const messages = adminTokens.map(({ token }: { token: string }) => ({
        to: token,
        title: isOn ? "⚡ الكهرباء اشتغلت" : "🔴 الكهرباء طفت",
        body: isOn
          ? `عادت الكهرباء الساعة ${localTimeAr} — قدرة الشبكة: ${pAcInput.toFixed(0)}W`
          : `انقطعت الكهرباء الساعة ${localTimeAr} — يعمل على الطاقة الشمسية/البطارية`,
        sound: "alarm.wav",
        channelId: "grid-monitor",
        // Highest delivery priority on both Android (FCM high) and iOS (APNs priority 10)
        priority: "high",
        _displayInForeground: true,
        // Keep notification alive for 10 minutes in case device is briefly offline
        ttl: 600,
        badge: 1,
        data: {
          eventType,
          occurred_at: now,
          pac_input: pAcInput,
          pac_to_user: sysOut,
          play_sound: true,
          is_on: isOn,
          is_admin_alert: true,
        },
      }));

      try {
        const pushRes = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
          },
          body: JSON.stringify(messages),
        });
        const pushJson = await pushRes.json();
        console.log("[poll-growatt] Push sent to", adminTokens.length, "admin token(s):", JSON.stringify(pushJson).slice(0, 200));
      } catch (err) {
        console.error("[poll-growatt] Push failed:", err);
      }
    } else {
      console.log("[poll-growatt] No admin push tokens registered — skipping admin notification");
    }

    // ── Auto-trigger analyze-patterns immediately ───────────────────────────
    console.log("[poll-growatt] Triggering analyze-patterns after state change...");
    {
      const analyzeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/analyze-patterns`;
      let triggered = false;
      for (let attempt = 1; attempt <= 3 && !triggered; attempt++) {
        try {
          const res = await fetch(analyzeUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            },
            body: JSON.stringify({ trigger: "poll-growatt", eventType, occurredAt: now }),
            signal: AbortSignal.timeout(60000),
          });
          if (res.ok) {
            triggered = true;
            console.log(`[poll-growatt] analyze-patterns triggered successfully (attempt ${attempt})`);
          } else {
            const bodyText = await res.text().catch(() => "");
            console.error(`[poll-growatt] analyze-patterns HTTP ${res.status} (attempt ${attempt}):`, bodyText.slice(0, 200));
          }
        } catch (err) {
          console.error(`[poll-growatt] analyze-patterns trigger failed (attempt ${attempt}):`, err);
        }
      }
      if (!triggered) {
        console.error("[poll-growatt] analyze-patterns could NOT be triggered after 3 attempts — APPPE will refresh on next manual/cron run");
      }
    }

    // NOTE: prediction_accuracy_logs is now written by analyze-patterns (step 22)
    // after the day schedule is generated, giving it access to bias-corrected
    // slot durations. No accuracy logging here.
  }

  // ── 6. Upsert live state ───────────────────────────────────────────────────
  await supabase.from("inverter_state").upsert({
    id: 1,
    vac: pAcInput,
    pac_to_user: sysOut,
    status_text: statusText,
    utility_on: utilityIsOn,
    last_polled: now,
    inverter_offline: false,
  });

  return new Response(
    JSON.stringify({ ok: true, utilityIsOn, pAcInput, sysOut, ppvTotal, status: statusText, stateChanged }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
