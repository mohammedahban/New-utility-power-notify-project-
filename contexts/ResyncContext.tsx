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
import { supabase } from '../lib/supabase';
import { serverNowMs } from '../lib/serverTime';

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

/**
 * Reconstruct a ResyncPoint from a resync_history row (the server-side record
 * written by every self-report / community clone). Used for multi-device
 * hydration: a second device on the same account rebuilds the exact personal
 * timeline the first device computed.
 */
function resyncPointFromHistoryRow(row: any): ResyncPoint | null {
  if (!row || row.reverted_at) return null;
  const rawState: string | null = row.offset_state ?? null;
  const rawVal = row.offset_value ?? null;
  const isPending = rawState === 'PENDING_NEGATIVE' || rawVal === 'PENDING';
  let offsetValue: OffsetValue = 0;
  if (isPending) {
    offsetValue = 'PENDING';
  } else {
    const n = Number(rawVal);
    offsetValue = Number.isFinite(n) ? n : 0;
  }
  const offsetState: OffsetState = isPending
    ? 'PENDING_NEGATIVE'
    : (rawState as OffsetState) ?? (typeof offsetValue === 'number'
        ? (offsetValue > 0 ? 'POSITIVE' : offsetValue < 0 ? 'NEGATIVE' : 'NEUTRAL')
        : 'NEUTRAL');
  return {
    syncedState: row.reported_state === 'UTILITY_ON' ? 'ON' : 'OFF',
    syncedAtIso: row.effective_transition_at,
    appliedAtIso: row.confirmed_at,
    reporterName: row.reporter_username ?? null,
    reporterReliability: null,
    offsetState,
    offsetValue,
    timelineAlignment: row.timeline_alignment ?? row.effective_transition_at,
    generatedOnStartIso: row.generated_on_start_iso ?? undefined,
    generatedOnDurationMin: row.generated_on_duration_min ?? null,
    generatedOnReferenceIso: row.generated_on_reference_iso ?? null,
    generatedOnReferenceKind: row.generated_on_reference_kind ?? null,
    confirmationTime: row.confirmed_at,
    source: row.source === 'self_report' ? 'self_report' : 'community_resync',
  };
}

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
  // MULTI-DEVICE FIX: the resync point was previously hydrated ONLY from
  // AsyncStorage, so two devices on the SAME account diverged (the device
  // where the sync was applied had the personal timeline; every other device
  // showed the plain Growatt one). Now we also consult resync_history — the
  // server-side record every sync writes — and adopt the newest live point.
  useEffect(() => {
    if (!storageKey) { setResyncPoint(null); return; }
    (async () => {
      let local: ResyncPoint | null = null;
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (raw) {
          const parsed: ResyncPoint = JSON.parse(raw);
          const ageMs = serverNowMs() - new Date(parsed.appliedAtIso).getTime();
          if (ageMs < MAX_AGE_MS) {
            local = parsed;
          } else {
            await AsyncStorage.removeItem(storageKey);
          }
        }
      } catch (_) {}

      // Server hydration: latest non-reverted history row for this user that
      // is still inside the 3-hour window (spec §F-04 validity cap).
      let server: ResyncPoint | null = null;
      try {
        const uid = storageKey.slice(STORAGE_KEY_PREFIX.length);
        const sinceIso = new Date(serverNowMs() - MAX_AGE_MS).toISOString();
        const { data: rows } = await supabase
          .from('resync_history')
          .select('*')
          .eq('user_id', uid)
          .is('reverted_at', null)
          .gte('confirmed_at', sinceIso)
          .order('confirmed_at', { ascending: false })
          .limit(1);
        const row = rows?.[0];
        if (row) server = resyncPointFromHistoryRow(row);
      } catch (_) {}

      // Adopt the NEWER of the two (server wins ties — it is the record every
      // device agrees on).
      const localMs = local ? new Date(local.appliedAtIso).getTime() : 0;
      const serverMs = server ? new Date(server.appliedAtIso).getTime() : 0;
      const winner = server && serverMs >= localMs ? server : local;
      if (winner) {
        setResyncPoint(winner);
        if (winner === server) {
          try { await AsyncStorage.setItem(storageKey, JSON.stringify(winner)); } catch (_) {}
        }
      }
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
      const ageMs = serverNowMs() - new Date(resyncPoint.appliedAtIso).getTime();
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

  // ── MULTI-DEVICE SYNC: same account on a second device ─────────────────────
  // When THIS account applies a resync on another device, a resync_history row
  // appears on the server. Applying it here (through the normal guards) keeps
  // every device of the same account on the same personal timeline. UPDATE
  // events carry pending-offset resolutions (PENDING → NEGATIVE) across too.
  const applyResyncRef = useRef(applyResync);
  applyResyncRef.current = applyResync;
  const resyncPointRef = useRef(resyncPoint);
  resyncPointRef.current = resyncPoint;

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`resync-history-xdev-${user.id}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'resync_history', filter: `user_id=eq.${user.id}` },
        (payload) => {
          const point = resyncPointFromHistoryRow(payload.new);
          if (!point) return;
          // Skip echoes of what this device already applied. Timestamps arrive
          // in Postgres format ("+00:00"), while the locally-applied point
          // carries the JS ISO string ("Z") — compare parsed instants with a
          // small tolerance, never raw strings. (An unnoticed echo would
          // re-apply the same point and overwrite the revert snapshot with
          // the post-sync state.)
          const cur = resyncPointRef.current;
          if (cur && cur.source === point.source) {
            const curMs = new Date(cur.syncedAtIso).getTime();
            const incMs = new Date(point.syncedAtIso).getTime();
            if (Number.isFinite(curMs) && Number.isFinite(incMs) && Math.abs(curMs - incMs) < 5_000) return;
          }
          applyResyncRef.current(point).catch(() => {});
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'resync_history', filter: `user_id=eq.${user.id}` },
        (payload) => {
          const row: any = payload.new;
          const cur = resyncPointRef.current;
          if (!cur) return;
          // Only interested in updates to the row that produced our current
          // point (pending resolution, or a revert triggered elsewhere).
          // Compare parsed instants (Postgres "+00:00" vs local "Z" strings
          // never match literally).
          const rowMs = new Date(row?.effective_transition_at ?? '').getTime();
          const curMs = new Date(cur.syncedAtIso).getTime();
          if (!Number.isFinite(rowMs) || !Number.isFinite(curMs) || Math.abs(rowMs - curMs) >= 5_000) return;
          if (row.reverted_at) {
            // Reverted on another device → drop the local point too.
            clearResync().catch(() => {});
            return;
          }
          const isPendingNow = row.offset_state === 'PENDING_NEGATIVE' || row.offset_value === 'PENDING';
          const curPending = cur.offsetState === 'PENDING_NEGATIVE' || cur.offsetValue === 'PENDING';
          if (curPending && !isPendingNow) {
            const point = resyncPointFromHistoryRow(row);
            if (point) applyResyncRef.current(point).catch(() => {});
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, clearResync]);

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
