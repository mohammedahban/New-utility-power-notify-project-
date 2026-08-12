/**
 * useUserOffset — TMMS V2.2 Personal Timeline Replacement Model
 *
 * Manages the user's personal offset (offset_minutes) in local state and
 * syncs it to Supabase user_offsets.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.2 NOTES
 * ───────────────────────────────────────────────────────────────────────────
 *
 * V2.2 offset_minutes semantics:
 *   - offset_minutes > 0  → POSITIVE offset (Period 1: during ON or first half of OFF)
 *                           User's Personal Timeline is LATER than Growatt.
 *                           Future ON/OFF shifted forward by offset value.
 *   - offset_minutes < 0  → NEGATIVE offset (Period 2 resolved)
 *                           User's Personal Timeline is EARLIER than Growatt.
 *                           Future ON/OFF shifted backward by offset value.
 *   - offset_minutes === 0 → NEUTRAL (Period 3: exact ON start instant)
 *                            Personal Timeline = exact clone of Growatt.
 *   - PENDING_NEGATIVE state is tracked separately via offset_state
 *     column in user_offsets and via the ResyncPoint.offsetState field.
 *
 * The V2.2 engine (tmmsEngine.ts computeATCMode) treats these offsets as:
 *   POSITIVE → Short Verification Window after Growatt turns ON.
 *              Home Page remains OFF with countdown until scheduled time.
 *   NEGATIVE → UNCERTAIN_ZONE when predicted OFF ends before Growatt ON.
 *              Waiting time is deducted from next ON duration.
 *   NEUTRAL  → No special behavior. Standard verification window applies.
 *
 * Pending DSD flow (unchanged from V2.1):
 *   When a report is submitted, a PendingDSDCandidate is stored in memory.
 *   It is confirmed (offset_minutes updated) on the next Growatt transition,
 *   or cancelled by the user.
 *
 * Original V2 / V2.1 responsibilities preserved:
 *   1. Load offset_minutes from Supabase user_offsets on mount
 *   2. Persist new offsets to Supabase
 *   3. Clear offset (delete row) on demand
 *   4. Manage pending DSD state
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export interface OffsetRow {
  id?: number;
  user_id: string;
  offset_minutes: number;
  created_at?: string;
}

export interface PendingDSDCandidate {
  eventType: 'UTILITY_ON' | 'UTILITY_OFF';
  tentativeDSD: number;
  createdAtIso: string;
}

/**
 * Effective offset semantics of a user_offsets row.
 *
 * The numeric `offset_minutes` column alone is NOT authoritative in V2.1+:
 * PENDING_NEGATIVE rows store a 0 placeholder there while the real value
 * lives in `offset_value`, and `offset_value` comes back from PostgREST as
 * text. Snapshots and reverts must use THIS derivation — mixing the raw
 * numeric column with the semantic state/value columns is what made
 * "revert" restore NEUTRAL/0 instead of the true previous offset.
 */
export function effectiveOffsetFromRow(row: any): {
  minutes: number;
  state: string | null;
  value: number | string | null;
} {
  if (!row) return { minutes: 0, state: null, value: null };
  const state: string | null = row.offset_state ?? null;
  const raw = row.offset_value ?? null;
  const isPending = state === 'PENDING_NEGATIVE' || raw === 'PENDING';
  if (isPending) return { minutes: 0, state: 'PENDING_NEGATIVE', value: 'PENDING' };
  const parsed = raw != null ? Number(raw) : NaN;
  const value = Number.isFinite(parsed) ? parsed : (row.offset_minutes ?? 0);
  return {
    minutes: Number.isFinite(Number(value)) ? Number(value) : 0,
    state: state ?? (Number(value) > 0 ? 'POSITIVE' : Number(value) < 0 ? 'NEGATIVE' : 'NEUTRAL'),
    value,
  };
}

export function useUserOffset() {
  const { user } = useAuth();
  const [offset, setOffset] = useState<OffsetRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingDSD, setPendingDSD] = useState<PendingDSDCandidate | null>(null);

  const fetchOffset = useCallback(async () => {
    if (!user) { setOffset(null); return; }
    setLoading(true);
    const { data } = await supabase
      .from('user_offsets')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    if (data) setOffset(data);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchOffset();
  }, [fetchOffset]);

  // AUDIT-FIX F-05 (session-stale offset): user_offsets is written directly by
  // the report/YES paths, and this hook previously never re-read it — the
  // engine kept running on the pre-report offset until app restart. The table
  // is now in the realtime publication, so subscribe to our own row and update
  // the engine's offset immediately when it changes (report, YES-confirm,
  // backend pending-resolution, revert).
  useEffect(() => {
    if (!user) return;
    // Unique topic per hook INSTANCE: useUserOffset is mounted by several
    // components at once (layout, prediction provider, screens). A shared
    // topic makes supabase-js return the existing (already-subscribed)
    // channel and .on() then throws "cannot add callbacks after subscribe()".
    const channel = supabase
      .channel(`user_offsets_live_${user.id}_${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_offsets', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setOffset(null);
          } else if (payload.new) {
            setOffset(payload.new as OffsetRow);
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  /**
   * V2.2: The offset value is derived from Period 1/2/3 rules at report time.
   * For Period 1: positive value (T - ReplacedONstart).
   * For Period 2: stored as PENDING_NEGATIVE state; numeric value resolves
   *               when Growatt ON begins.
   * For Period 3: 0 (NEUTRAL).
   *
   * AUDIT-FIX F-18: callers that know the exact state/value semantics (e.g.
   * revert restoring a PENDING_NEGATIVE) may pass them explicitly; otherwise
   * the state is derived from the numeric sign (legacy behaviour).
   */
  const updateOffset = useCallback(async (
    offsetMinutes: number,
    explicit?: { state?: string; value?: string | number },
  ) => {
    if (!user) return;
    const upsertData: any = {
      user_id: user.id,
      offset_minutes: offsetMinutes,
      updated_at: new Date().toISOString(),
    };
    // V2.2: derive and store offset_state alongside the numeric value
    const offsetState: string =
      explicit?.state ??
      (offsetMinutes > 0 ? 'POSITIVE'
      : offsetMinutes < 0 ? 'NEGATIVE'
      : 'NEUTRAL');
    upsertData.offset_state = offsetState;
    upsertData.offset_value = explicit?.value ?? offsetMinutes;

    const { data } = await supabase
      .from('user_offsets')
      .upsert(upsertData, { onConflict: 'user_id' })
      .select()
      .single();
    if (data) setOffset(data);
  }, [user]);

  const clearOffset = useCallback(async () => {
    if (!user) return;
    await supabase.from('user_offsets').delete().eq('user_id', user.id);
    setOffset(null);
  }, [user]);

  // Pending DSD (unchanged from V2.1)
  const setPendingDSDCandidate = useCallback((candidate: PendingDSDCandidate) => {
    setPendingDSD(candidate);
  }, []);

  const clearPendingDSD = useCallback(() => {
    setPendingDSD(null);
  }, []);

  const confirmPendingDSD = useCallback(async () => {
    if (!pendingDSD) return;
    await updateOffset(pendingDSD.tentativeDSD);
    setPendingDSD(null);
  }, [pendingDSD, updateOffset]);

  // V2.2: saveOffset is an alias for updateOffset — used by index.tsx
  const saveOffset = updateOffset;

  return {
    offset,
    updateOffset,
    saveOffset,
    clearOffset,
    loading,
    pendingDSD,
    setPendingDSD: setPendingDSDCandidate,
    clearPendingDSD,
    confirmPendingDSD,
  };
}
