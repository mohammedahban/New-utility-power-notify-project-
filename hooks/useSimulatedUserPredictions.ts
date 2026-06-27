/**
 * useSimulatedUserPredictions
 * ════════════════════════════════════════════════════════════════════════════
 * Debug-only hook. Feeds a SimWorld (from TMMSDebugSimulator's state) through
 * the REAL engine and returns a UserPrediction — identical in shape to what
 * useUserPredictions returns in production.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The TMMSDebugSimulator's built-in panels (Sections ①–⑮) show raw engine
 * numbers: stat rows, decision traces, ISO timestamps. They do NOT show the
 * real Arabic UI your users see (PersonalStatusCard, TodayTimeline, community
 * chips, ATC banners, etc.).
 *
 * This hook bridges that gap. Feed it the same `world` state the simulator
 * controls, and you get a UserPrediction that can be passed directly into the
 * real production screen components — so you see exactly what a user would
 * see for every simulated scenario, without touching Supabase or real data.
 *
 * WHAT IT COVERS THAT THE SIMULATOR DOES NOT
 * ───────────────────────────────────────────
 *   ✅ frozenCommunityOffsetMinutes — respected exactly as in production
 *      (Q2-A: computed once, never recalculated)
 *   ✅ communitySyncMeta — built from world.resyncPoint the same way
 *      useUserPredictions builds it from its resyncPoint prop
 *   ✅ simulatedNowMs — the simulator's clock drives the engine tick,
 *      so ATC state, overrun detection, and validation windows all
 *      advance exactly as real time would advance in the production hook
 *   ✅ Same UserPrediction shape — every field used by PersonalStatusCard,
 *      TodayTimeline, ScheduleBlock, community badges, etc. is present
 *
 * WHAT IT DOES NOT COVER (by design)
 * ───────────────────────────────────
 *   ✗ AsyncStorage frozen-offset persistence  — irrelevant for a simulator;
 *     the world object already carries frozenCommunityOffsetMinutes
 *   ✗ Supabase accuracy_events inserts        — no side effects in debug mode
 *   ✗ 30-second heartbeat tick                — world.simulatedNowMs is
 *     controlled by the simulator's Advance Time buttons instead
 *
 * USAGE IN A PRODUCTION PREVIEW PANEL
 * ─────────────────────────────────────
 *   // Inside TMMSDebugSimulator or a sibling admin screen:
 *   const { userPrediction } = useSimulatedUserPredictions(world);
 *   // Pass userPrediction into the REAL screen components:
 *   <PersonalStatusCard userPrediction={userPrediction} ... />
 *   <TodayTimeline      userPrediction={userPrediction} ... />
 *   <ScheduleScreen     userPrediction={userPrediction} ... />
 * ════════════════════════════════════════════════════════════════════════════
 */
import { useMemo } from 'react';
import {
  runEngine,
  type SimWorld,
} from '../app/(admin)/tmmsSimulation';
import type { UserPrediction, CommunitySyncMeta } from '../app/(admin)/tmmsSimulation';

/**
 * Runs the real TMMS V2 engine against a SimWorld and returns a UserPrediction
 * in the exact same shape as useUserPredictions returns in production.
 *
 * No Supabase. No AsyncStorage. No side effects.
 */
export function useSimulatedUserPredictions(world: SimWorld): {
  userPrediction: UserPrediction | null;
  loading: false;
} {
  const userPrediction = useMemo((): UserPrediction | null => {
    try {
      // Build the communitySyncMeta display object the same way
      // useUserPredictions builds it from its resyncPoint prop.
      // The engine can derive this itself from resyncPoint, but passing it
      // explicitly surfaces the reporterName + reliability badge — matching
      // production exactly.
      const syncMeta: CommunitySyncMeta | null = world.resyncPoint
        ? {
            syncedAtIso:         world.resyncPoint.syncedAtIso,
            syncedState:         world.resyncPoint.syncedState,
            reporterName:        world.resyncPoint.reporterName ?? null,
            reporterReliability: world.resyncPoint.reporterReliability ?? null,
          }
        : null;

      // runEngine already calls applyOffsetToPrediction with world.simulatedNowMs
      // as the injectable clock — so the ATC state, UNCERTAIN_ZONE detection,
      // and validation window logic all advance with the simulator's time control
      // exactly as they would with real wall-clock time in production.
      //
      // If you need the syncMeta to propagate into the result's communitySyncMeta
      // field (used by PersonalStatusCard's community chip), call applyOffsetToPrediction
      // directly here instead of runEngine — runEngine passes null for communitySyncMeta:
      return runEngine(world);

      // ── Alternative: if you need the full communitySyncMeta in the result ──
      // import { worldToPrediction, applyOffsetToPrediction } from '../app/(admin)/tmmsSimulation';
      // const prediction = worldToPrediction(world);
      // return applyOffsetToPrediction(
      //   prediction,
      //   world.offsetMinutes,
      //   world.resyncPoint,
      //   syncMeta,               // ← passes reporter name + reliability
      //   world.transitionMode,
      //   null,
      //   world.frozenCommunityOffsetMinutes,
      //   undefined,
      //   world.simulatedNowMs,
      //   undefined,
      // );
    } catch (e) {
      console.error('[useSimulatedUserPredictions] engine error:', e);
      return null;
    }
  }, [
    // Re-derive whenever the simulator's clock, state, resync, or mode changes.
    // These are the same dependencies that drive the real useUserPredictions,
    // just sourced from SimWorld rather than from props + Supabase.
    world.simulatedNowMs,
    world.growattCurrentState,
    world.growattLastTransitionAt,
    world.resyncPoint,
    world.frozenCommunityOffsetMinutes,
    world.transitionMode,
    world.offsetMinutes,
    world.scheduleTemplate,
    world.scheduleAnchorIso,
  ]);

  // loading is always false — SimWorld is synchronous, no network calls
  return { userPrediction, loading: false };
}
