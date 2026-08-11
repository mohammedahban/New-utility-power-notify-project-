/**
 * ResyncContext — TMMS V2.1 (Final Corrected Logic)
 *
 * Stores a single "personal sync point" (personal timeline branch) per user.
 * When a community resync is applied (either by submitting a report or
 * confirming YES on a notification) the sync point is saved here AND in
 * AsyncStorage so it survives app restarts.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.1 FINAL CHANGES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  The ResyncPoint type is extended to carry V2.1 fields:
 *    - offsetState: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
 *    - offsetValue: number (signed minutes)
 *    - timelineAlignment: string (ISO timestamp anchor)
 *    - generatedOnStartIso / generatedOnDurationMin / generatedOnReferenceIso / generatedOnReferenceKind
 *    - confirmationTime: string (for approvers — the time they confirmed)
 *
 *  These fields are set when:
 *    1. A reporter submits a report (computed by useUtilityReports using
 *       Period 1/Period 2 rules)
 *    2. An approver confirms (cloned from the reporter's values by
 *       useResyncNotifications, plus confirmationTime = report time + delay)
 *
 *  The offset is FINAL at report time — it never changes after being set.
 *  No recomputation, no flipping, no pending state.
 *
 * Original (V2) responsibilities preserved unchanged:
 *   - AsyncStorage persistence (per-user key)
 *   - 3-hour safety-net auto-clear (spec three-hour rule, F-04)
 *   - Snapshot callback for revert
 *   - Permanent personal timeline branch (does NOT auto-revert)
 */

import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';

// ── V2.1: Offset State types (mirrored from useResyncNotifications) ────────
export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
export type OffsetValue = number | 'PENDING';

export interface ResyncPoint {
  /** The utility state that was confirmed as active */
  syncedState: 'ON' | 'OFF';
  /**
   * The ISO timestamp at which this state effectively became active.
   * For reporter: transition time (now - selectedTimeOffsetMinutes)
   * For recipient: same as reporter (Confirmation Timestamp Rule — never adjusted by delay)
   */
  syncedAtIso: string;
  /** When the resync was applied locally (for display / expiry) */
  appliedAtIso: string;
  /** Reporter display name — shown in PersonalStatusCard community banner */
  reporterName?: string | null;
  /** Reporter reliability score (0–100) */
  reporterReliability?: number | null;

  // ── V2.1 FINAL additions ──────────────────────────────────────────────────
  /** V2.1: Offset state (POSITIVE for Period 1, NEGATIVE for Period 2) */
  offsetState?: OffsetState;
  /** V2.1: Offset value in signed minutes (e.g. +270, −40) */
  offsetValue?: OffsetValue;
  /** V2.1: Timeline alignment anchor (ISO timestamp of the reference ON start) */
  timelineAlignment?: string;
  /** V2.1: Generated ON start time (ISO) */
  generatedOnStartIso?: string;
  /** V2.1: Generated ON duration in minutes */
  generatedOnDurationMin?: number | null;
  /** V2.1: Reference ON start time (ISO) — the Growatt ON that was replaced */
  generatedOnReferenceIso?: string | null;
  /** V2.1: Reference kind ('completed' in V2.1 Final — always final at report time) */
  generatedOnReferenceKind?: 'completed' | 'active' | null;
  /**
   * V2.1: For approvers only — the time they confirmed (report time + delay).
   * The approver's current state is evaluated at this time, not the report time.
   * For reporters, this is the same as syncedAtIso.
   */
  confirmationTime?: string;
  /**
   * AUDIT-FIX (F-01/F-06): origin of this resync point. Required by the
   * applyResync guards: a user's OWN manual report has priority over
   * community clones, and within the one-hour window the earliest community
   * event wins. Legacy persisted points have no source — they are treated
   * as 'community_resync' (the less privileged origin).
   */
  source?: 'self_report' | 'community_resync';
}

interface ResyncContextType {
  resyncPoint: ResyncPoint | null;
  /**
   * Apply a resync point. AUDIT-FIX (F-01/F-06): returns true when the
   * point was applied, false when a guard rejected it (manual-state
   * priority or the one-hour earliest-wins rule).
   */
  applyResync: (point: ResyncPoint) => Promise<boolean>;
  clearResync: () => Promise<void>;
  /**
   * Callback registered by the Home screen's useStatusSnapshot instance.
   * ResyncContext calls this BEFORE applying a new resync so the snapshot
   * captures the pre-sync state.  Set via registerSnapshotCallback().
   */
  registerSnapshotCallback: (
    cb: ((point: ResyncPoint) => Promise<void>) | null,
  ) => void;
}

const ResyncContext = createContext<ResyncContextType | undefined>(undefined);

const STORAGE_KEY_PREFIX = 'community_resync_point_v2_';
const VALIDATION_WINDOW_MS = 20 * 60 * 1000;   // 20 minutes
// AUDIT-FIX (F-04): the spec caps community-clone validity at 3 hours
// ("three-hour rule"). The client safety-net was 6 h — double the spec —
// so a stale clone could drive the timeline for hours after it became
// invalid. Now aligned with the 3 h expiry the server stamps on
// resync_notifications.
const MAX_AGE_MS          = 3 * 60 * 60 * 1000; // 3 hours
// AUDIT-FIX (F-01): one-hour community window — within one hour of the
// currently-applied community event, later community events must NOT
// replace it (earliest wins).
const ONE_HOUR_MS         = 60 * 60 * 1000;

export function ResyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [resyncPoint, setResyncPoint] = useState<ResyncPoint | null>(null);
  // External snapshot callback — set by Home screen (avoids circular imports)
  const snapshotCbRef = React.useRef<((point: ResyncPoint) => Promise<void>) | null>(null);
  const registerSnapshotCallback = useCallback(
    (cb: ((point: ResyncPoint) => Promise<void>) | null) => {
      snapshotCbRef.current = cb;
    },
    [],
  );

  // Key is per-user so switching accounts doesn't bleed state
  const storageKey = user ? `${STORAGE_KEY_PREFIX}${user.id}` : null;

  // ── Load persisted resync on user/mount ─────────────────────────────────────
  useEffect(() => {
    if (!storageKey) { setResyncPoint(null); return; }
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (raw) {
          const parsed: ResyncPoint = JSON.parse(raw);
          const ageMs = Date.now() - new Date(parsed.appliedAtIso).getTime();
          if (ageMs < MAX_AGE_MS) {
            setResyncPoint(parsed);
          } else {
            await AsyncStorage.removeItem(storageKey);
          }
        }
      } catch (_) {}
    })();
  }, [storageKey]);

  // ── Max-age watchdog ────────────────────────────────────────────────────────
  // Per spec §10: community sync is a PERMANENT personal timeline branch.
  // It must NOT be cleared because Growatt disagrees or the validation window
  // expired. The ONLY programmatic clear allowed is the 3-hour safety-net to
  // prevent forever-stale data. The user must explicitly press a revert button
  // to leave the community-synced branch at any other time.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!resyncPoint || !storageKey) return;

    const check = async () => {
      if (!resyncPoint) return;
      const ageMs = Date.now() - new Date(resyncPoint.appliedAtIso).getTime();
      // Safety-net only: clear after 3-hour max age (F-04)
      if (ageMs >= MAX_AGE_MS) {
        console.log('[ResyncContext] 3-hour safety-net reached — clearing resync');
        await AsyncStorage.removeItem(storageKey!);
        setResyncPoint(null);
      }
      // NOTE: validation window expiry and Growatt mismatch do NOT clear the
      // resync here. The ATC layer shows a warning badge in the UI instead.
    };

    check();
    intervalRef.current = setInterval(check, 60_000); // check every minute

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [resyncPoint, storageKey]);

  // ── applyResync ──────────────────────────────────────────────────────────────
  // V2.1: Now accepts and stores all V2.1 fields (offsetState, offsetValue,
  // timelineAlignment, generatedOn metadata, confirmationTime).
  // No UI changes — just passes through the extended ResyncPoint.
  const applyResync = useCallback(async (point: ResyncPoint): Promise<boolean> => {
    const incomingSource = point.source ?? 'community_resync';
    const existing = resyncPoint;

    if (existing) {
      const existingSource = existing.source ?? 'community_resync';

      // AUDIT-FIX (F-06 — manual-state priority): the user's OWN report is
      // first-hand information and outranks community clones. A community
      // resync must never overwrite a self-report; only another (newer)
      // self-report may.
      if (existingSource === 'self_report' && incomingSource !== 'self_report') {
        console.log('[ResyncContext] applyResync rejected — manual self-report has priority over community clone');
        return false;
      }

      // AUDIT-FIX (F-01 — one-hour rule, earliest wins): within one hour of
      // the currently-applied community event, a LATER community event must
      // not replace it. The window is anchored on the EVENT time
      // (syncedAtIso), not the application time. An earlier event, or any
      // event more than one hour away, starts a new window and applies.
      if (incomingSource === 'community_resync' && existingSource === 'community_resync') {
        const existingMs = new Date(existing.syncedAtIso).getTime();
        const incomingMs = new Date(point.syncedAtIso).getTime();
        if (
          Number.isFinite(existingMs) && Number.isFinite(incomingMs) &&
          incomingMs > existingMs && incomingMs - existingMs < ONE_HOUR_MS
        ) {
          console.log('[ResyncContext] applyResync rejected — one-hour rule: later community event inside the window of the applied one');
          return false;
        }
      }
    }

    // Capture snapshot BEFORE applying so the revert button can restore fully.
    // The callback is registered by the Home screen's useStatusSnapshot hook.
    try {
      if (snapshotCbRef.current) {
        await snapshotCbRef.current(point);
      }
    } catch (_) {}

    setResyncPoint(point);
    if (!storageKey) return true;
    try {
      await AsyncStorage.setItem(storageKey, JSON.stringify(point));
    } catch (_) {}
    return true;
  }, [storageKey, resyncPoint]);

  // ── clearResync ──────────────────────────────────────────────────────────────
  const clearResync = useCallback(async () => {
    setResyncPoint(null);
    if (!storageKey) return;
    try {
      await AsyncStorage.removeItem(storageKey);
    } catch (_) {}
  }, [storageKey]);

  return (
    <ResyncContext.Provider value={{ resyncPoint, applyResync, clearResync, registerSnapshotCallback }}>
      {children}
    </ResyncContext.Provider>
  );
}

export function useResync() {
  const ctx = useContext(ResyncContext);
  if (!ctx) throw new Error('useResync must be used within ResyncProvider');
  return ctx;
}
