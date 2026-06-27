/**
 * app/(admin)/simulator.web.tsx
 * ════════════════════════════════════════════════════════════════════════════
 * WEB-ONLY Expo Router admin page — Expo picks this file on web builds and
 * simulator.tsx on iOS/Android.
 *
 * Route URL:  /simulator
 *
 * Wiring (full chain):
 *   simulator.web.tsx
 *     → TMMSDebugSimulator   (UI — 15 sections + scenario runner)
 *         → tmmsSimulation   (SimWorld, scenarios, runEngine)
 *             → tmmsEngine   (applyOffsetToPrediction — same call as production)
 *
 * The simulator runs the EXACT same engine function that index.tsx /
 * schedule.tsx / community.tsx use via useUserPredictions.ts — so a passing
 * scenario here guarantees correct behaviour in the real app.
 * ════════════════════════════════════════════════════════════════════════════
 */

// Re-export TMMSDebugSimulator's default export as this route's page.
// Expo Router uses the default export of every file in app/ as the page
// component — no wrapper needed since TMMSDebugSimulator already has one.
export { default } from '../../components/TMMSDebugSimulator';
