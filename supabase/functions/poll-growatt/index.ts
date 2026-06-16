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
    try {
      const analyzeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/analyze-patterns`;
      await fetch(analyzeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30000),
      });
      console.log("[poll-growatt] analyze-patterns triggered successfully");
    } catch (err) {
      console.error("[poll-growatt] analyze-patterns trigger failed:", err);
    }

    // ── Log prediction accuracy (read-only analytics — never affects predictions) ──
    try {
      const MAX_ALLOWED_ERROR_MIN = 150; // 100% error at 150 min
      const { data: latestPred } = await supabase
        .from("utility_predictions")
        .select("prediction, computed_at")
        .eq("id", 1)
        .maybeSingle();

      if (latestPred?.prediction) {
        const pred = latestPred.prediction as any;
        // The schedule is stored under `daySchedule` by analyze-patterns (APPPE v3).
        // Fallback to legacy field names for forward-compatibility.
        const slots: any[] = pred.daySchedule ?? pred.slots ?? pred.schedule ?? [];
        const eventType = utilityIsOn ? "UTILITY_ON" : "UTILITY_OFF";
        const targetState = utilityIsOn ? "ON" : "OFF";

        // Find the slot that was predicted to start closest to the actual event time.
        // We look for the upcoming transition slot (state === targetState) whose
        // startIso is nearest to `now` — this is the slot that was "about to become
        // the current state" from the prediction's point of view.
        const nowMs = new Date(now).getTime();
        let matchingSlot: any = null;
        let minDist = Infinity;
        for (const s of slots) {
          if (s.state !== targetState) continue;
          const predictedMs = new Date(s.startIso ?? s.start_iso ?? "").getTime();
          if (!predictedMs) continue;
          const dist = Math.abs(predictedMs - nowMs);
          if (dist < minDist) { minDist = dist; matchingSlot = s; }
        }

        if (matchingSlot) {
          const predictedIso: string = matchingSlot.startIso ?? matchingSlot.start_iso ?? matchingSlot.shiftedStartIso;
          if (predictedIso) {
            const predictedMs = new Date(predictedIso).getTime();
            const actualMs = new Date(now).getTime();
            const errorMin = Math.abs((actualMs - predictedMs) / 60_000);
            const accuracyScore = Math.max(0, 100 - (errorMin / MAX_ALLOWED_ERROR_MIN) * 100);
            const confidence = typeof matchingSlot.confidence === "number" ? matchingSlot.confidence : null;

            await supabase.from("prediction_accuracy_logs").insert({
              predicted_event_time: predictedIso,
              actual_event_time: now,
              predicted_state: eventType,
              actual_state: eventType,
              error_minutes: Math.round(errorMin * 100) / 100,
              accuracy_score: Math.round(accuracyScore * 100) / 100,
              confidence_score: confidence,
              prediction_generated_at: latestPred.computed_at ?? null,
              slot_id: matchingSlot.slotId ?? matchingSlot.slot_id ?? null,
            });
            console.log(`[poll-growatt] Accuracy logged: error=${errorMin.toFixed(1)}min score=${accuracyScore.toFixed(1)}% slot=${targetState}`);
          }
        } else {
          console.log(`[poll-growatt] No matching slot found for ${targetState} in ${slots.length} daySchedule slots — skipping accuracy log`);
        }
      }
    } catch (accErr) {
      // Analytics failure must never break the main polling loop
      console.error("[poll-growatt] Accuracy log failed (non-fatal):", accErr);
    }
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
