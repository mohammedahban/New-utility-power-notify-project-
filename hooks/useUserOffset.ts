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

export function useUserOffset() {
  const { user } = useAuth();
  const [offset, setOffset] = useState<OffsetRow | null>(null);
  const [pendingDSD, setPendingDSD] = useState<PendingDSDCandidate | null>(null);

  useEffect(() => {
    if (!user) { setOffset(null); return; }
    (async () => {
      const { data } = await supabase
        .from('user_offsets')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (data) setOffset(data);
    })();
  }, [user]);

  /**
   * V2.2: The offset value is derived from Period 1/2/3 rules at report time.
   * For Period 1: positive value (T - ReplacedONstart).
   * For Period 2: stored as PENDING_NEGATIVE state; numeric value resolves
   *               when Growatt ON begins.
   * For Period 3: 0 (NEUTRAL).
   */
  const updateOffset = useCallback(async (offsetMinutes: number) => {
    if (!user) return;
    const upsertData: any = {
      user_id: user.id,
      offset_minutes: offsetMinutes,
      updated_at: new Date().toISOString(),
    };
    // V2.2: derive and store offset_state alongside the numeric value
    const offsetState: string =
      offsetMinutes > 0 ? 'POSITIVE'
      : offsetMinutes < 0 ? 'NEGATIVE'
      : 'NEUTRAL';
    upsertData.offset_state = offsetState;
    upsertData.offset_value = offsetMinutes;

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

  return {
    offset,
    updateOffset,
    clearOffset,
    pendingDSD,
    setPendingDSD: setPendingDSDCandidate,
    clearPendingDSD,
    confirmPendingDSD,
  };
}
