/**
 * phaseGroups — APPPE v6.2 phase-group model selection (client side).
 *
 * The server (supabase/functions/analyze-patterns) computes ONE base model
 * from the raw sensor event stream (offset 0.0 — completely unchanged) PLUS
 * dedicated per-phase models, each produced by running the FULL analysis
 * pipeline independently over the event stream shifted by the group's phase
 * offset. The groups are INTENTIONALLY ASYMMETRIC — do not normalize:
 *
 *   POSITIVE offsets: dedicated models exist for +5h … +9h only.
 *                     (+1h … +4h keep using the base model.)
 *   NEGATIVE offsets: dedicated models exist for −3h … −7h only.
 *                     (−1h … −2h keep using the base model.)
 *
 * Selection rule: round the user's offset to the NEAREST hour (sign-
 * preserving); if that hour group has a dedicated model, the engine runs on
 * it and only the REMAINING sub-hour residual is applied as the engine offset
 * (minute precision preserved — e.g. +5h18m → +5 model + 18 min residual).
 * Offsets whose rounded group has no model (±1…±2, +4, ±10+, NEUTRAL,
 * PENDING_NEGATIVE) fall back to the base model with the full offset —
 * exactly the pre-v6.2 behavior.
 *
 * NOTE: the same group list is declared server-side in
 * supabase/functions/analyze-patterns/index.ts (PHASE_GROUP_OFFSETS_HOURS).
 * Edge functions cannot import app code, so the constant is deliberately
 * duplicated — keep the two in sync.
 */

/** Offset-hour groups that have a dedicated server-side phase model. */
export const PHASE_GROUP_OFFSETS_HOURS: readonly number[] = [
  5, 6, 7, 8, 9,      // positive phases
  -3, -4, -5, -6, -7, // negative phases
];

export interface PhaseGroupSelection {
  /** JSON key of the model inside prediction.phaseModels ("+5", "-3", …). */
  key: string;
  /** The rounded hour group (e.g. 5, -3). */
  groupHours: number;
  /**
   * Sub-hour remainder still applied by the engine on top of the phase
   * model's schedule: residual = offsetMinutes − groupHours × 60.
   * Always within (−30, +30] minutes.
   */
  residualMinutes: number;
}

/**
 * Resolve the dedicated phase model for a user offset, or null when the
 * rounded hour group has none (→ caller keeps the base model + full offset).
 */
export function selectPhaseGroup(offsetMinutes: number): PhaseGroupSelection | null {
  if (!Number.isFinite(offsetMinutes)) return null;
  // Sign-preserving round-to-nearest-hour (JS Math.round(-2.5) → -2, which
  // would skew negative users toward zero — hence the sign×round(abs) form).
  const groupHours = Math.sign(offsetMinutes) * Math.round(Math.abs(offsetMinutes) / 60);
  if (!PHASE_GROUP_OFFSETS_HOURS.includes(groupHours)) return null;
  return {
    key: groupHours > 0 ? `+${groupHours}` : `${groupHours}`,
    groupHours,
    residualMinutes: offsetMinutes - groupHours * 60,
  };
}
