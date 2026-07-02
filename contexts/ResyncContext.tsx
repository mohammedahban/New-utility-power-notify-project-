/**
 * ResyncContext — TMMS V2.2 Personal Timeline Replacement Model
 *
 * Provides the community resync state (ResyncPoint) that is shared between
 * the TMMS engine (useUserPredictions) and the Home Screen (index.tsx).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.2 CHANGES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  1. V2.2 Offset State added to ResyncPoint
 *     The ResyncPoint now carries the V2.2 OffsetState field:
 *       - 'POSITIVE'         — user's Personal Timeline is later than Growatt
 *       - 'NEGATIVE'         — user's Personal Timeline is earlier than Growatt
 *       - 'NEUTRAL'          — exact sync (Period 3, offset = 0)
 *       - 'PENDING_NEGATIVE' — Period 2 report; numeric offset value unknown
 *                              until Growatt ON begins
 *     Plus OffsetValue (number | 'PENDING') and TimelineAlignment fields.
 *
 *  2. Approver Cloning (unchanged from V2.1)
 *     When a YES response is processed, the approver's offset/state/alignment
 *     are CLONED from the reporter (who computed them via Period 1/2/3 rules).
 *     These three values are passed through ResyncPoint so the engine can
 *     apply them correctly.
 *
 *  3. PENDING_NEGATIVE is a real first-class state (corrected from V2.1)
 *     V2.1 incorrectly stated PENDING_NEGATIVE was deprecated. V2.2 restores
 *     it as a legitimate state created by Period 2 reports. When the context
 *     receives a ResyncPoint with offsetState === 'PENDING_NEGATIVE', it is
 *     passed through to the engine unchanged — no normalization or coercion.
 *
 *  4. All fields are optional / backwards-compatible.
 *     If the caller does not supply offsetState/offsetValue/timelineAlignment,
 *     the engine falls back to deriving them from offset_minutes as before.
 *
 * V2.2: this file now also imports and re-exports the OffsetState type for
 * convenience, ensuring consumers (community.tsx, useUtilityReports.ts,
 * useUserPredictions.ts) can import it from a single source of truth.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

// ─── TMMS V2.2: Offset State types ──────────────────────────────────────────
// V2.2: Four possible states per the Personal Timeline Replacement Model:
//   POSITIVE         → Period 1 (during Growatt ON or first half of OFF)
//                      User's timeline is later than Growatt
//   PENDING_NEGATIVE → Period 2 (second half of OFF)
//                      Numeric offset value unknown; auto-resolves to NEGATIVE
//                      when Growatt ON begins
//   NEGATIVE         → after Pending Negative resolves
//                      User's timeline is earlier than Growatt
//   NEUTRAL          → Period 3 (exact ON start instant)
//                      Offset = 0, exact clone of Growatt
export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';

// V2.2: the value is either a signed integer (minutes) or 'PENDING' meaning
// "waiting for next Growatt ON" (for Period 2 reports).
export type OffsetValue = number | 'PENDING';

// V2.2: a stable iso timestamp the reporter stores when their offset is
// first calculated. Approvers copy this verbatim.
export type TimelineAlignment = string;

// ─── Community resync point ─────────────────────────────────────────────────
export interface ResyncPoint {
  /** The utility state that was confirmed as active */
  syncedState: 'ON' | 'OFF';

  /**
   * The ISO timestamp at which this state effectively became active.
   * For reporter: transition time (now - selectedTimeOffsetMinutes)
   * For recipient: same as reporter (Confirmation Timestamp Rule)
   */
  syncedAtIso: string;

  /** When the resync was applied locally */
  appliedAtIso: string;

  /** Reporter display name */
  reporterName?: string | null;

  /** Reporter reliability score (0–100) */
  reporterReliability?: number | null;

  // ── V2.2 additions ────────────────────────────────────────────────────────
  /** V2.2: Offset state (POSITIVE for Period 1, PENDING_NEGATIVE for Period 2,
   *  NEUTRAL for Period 3, NEGATIVE after Pending Negative resolves) */
  offsetState?: OffsetState;
  /** V2.2: Offset value in signed minutes, or 'PENDING' when waiting for
   *  Growatt ON to resolve Period 2 */
  offsetValue?: OffsetValue;
  /** V2.2: Timeline alignment anchor (ISO timestamp of the reference ON start) */
  timelineAlignment?: TimelineAlignment;
  /** V2.2: Generated ON start time (ISO) */
  generatedOnStartIso?: string;
  /** V2.2: Generated ON duration in minutes */
  generatedOnDurationMin?: number | null;
  /** V2.2: Reference ON start time (ISO) — the Growatt ON that was replaced */
  generatedOnReferenceIso?: string | null;
  /** V2.2: Reference kind */
  generatedOnReferenceKind?: 'completed' | 'active' | null;
  /** V2.2: For approvers — the time they confirmed */
  confirmationTime?: string;
}

// ─── Context type ───────────────────────────────────────────────────────────
interface ResyncContextType {
  resyncPoint: ResyncPoint | null;
  applyResync: (point: ResyncPoint) => void;
  clearResync: () => void;
}

const ResyncContext = createContext<ResyncContextType>({
  resyncPoint: null,
  applyResync: () => {},
  clearResync: () => {},
});

export function ResyncProvider({ children }: { children: React.ReactNode }) {
  const [resyncPoint, setResyncPoint] = useState<ResyncPoint | null>(null);

  const applyResync = useCallback((point: ResyncPoint) => {
    setResyncPoint(point);
  }, []);

  const clearResync = useCallback(() => {
    setResyncPoint(null);
  }, []);

  return (
    <ResyncContext.Provider value={{ resyncPoint, applyResync, clearResync }}>
      {children}
    </ResyncContext.Provider>
  );
}

export function useResync(): ResyncContextType {
  return useContext(ResyncContext);
}
