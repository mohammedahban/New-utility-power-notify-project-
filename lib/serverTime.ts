/**
 * serverTime — device-clock-independent "now".
 *
 * Root cause addressed: the app previously trusted Date.now() for report
 * timestamps, resync-window checks, and every elapsed/remaining display.
 * A phone with a wrong clock (e.g. set a day ahead) submitted reports with
 * FUTURE estimated_transition_at values — the generated ON landed "tomorrow",
 * the current state computed as OFF, and two devices on the SAME account
 * showed different data. All server-shared timestamps (power_events,
 * utility_predictions, resync windows) live on the SERVER clock, so every
 * comparison must use server time too.
 *
 * Usage:
 *   - Call syncServerTime() at app start and periodically (it self-throttles).
 *   - Use serverNowMs() / serverNowIso() anywhere a timestamp is sent to the
 *     server or compared against server data.
 *   Before the first successful sync, serverNowMs() falls back to Date.now().
 */

import { supabase } from './supabase';

let offsetMs = 0;             // serverNow − deviceNow (applied to Date.now())
let lastSyncOkAt = 0;         // device clock timestamp of the last good sync
let inflight: Promise<void> | null = null;

const RESYNC_AFTER_MS = 60_000;   // re-sync at most once a minute
const MIN_SKEW_MS = 5_000;        // ignore sub-5s jitter (RPC round-trip noise)

/** Sync the local clock offset with the Supabase server clock. */
export function syncServerTime(force = false): Promise<void> {
  const nowDev = Date.now();
  if (!force && nowDev - lastSyncOkAt < RESYNC_AFTER_MS) return Promise.resolve();
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const t0 = Date.now();
      const { data, error } = await supabase.rpc('server_time');
      const t1 = Date.now();
      if (error || !data) return;
      const serverMs = new Date(data as unknown as string).getTime();
      if (!Number.isFinite(serverMs)) return;
      // Assume symmetric latency: the server stamp corresponds to the
      // midpoint of the round trip.
      const estimated = serverMs + (t1 - t0) / 2;
      const skew = estimated - t1;
      offsetMs = Math.abs(skew) >= MIN_SKEW_MS ? Math.round(skew) : 0;
      lastSyncOkAt = t1;
      if (offsetMs !== 0) {
        console.log(`[serverTime] device clock skew corrected: ${Math.round(offsetMs / 1000)}s`);
      }
    } catch (_) {
      // Keep the previous offset — a wrong clock is still better handled by
      // the last known correction than by none.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Current time on the SERVER clock, in epoch milliseconds. */
export function serverNowMs(): number {
  return Date.now() + offsetMs;
}

/** Current time on the SERVER clock, as an ISO string. */
export function serverNowIso(): string {
  return new Date(serverNowMs()).toISOString();
}

/** The currently-applied skew correction (serverNow − deviceNow), in ms. */
export function getServerClockSkewMs(): number {
  return offsetMs;
}
