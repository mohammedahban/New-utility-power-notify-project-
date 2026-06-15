/**
 * useUserPredictions — Layered Scheduling Engine
 *
 * Formula:
 *   Effective User Timeline
 *     = Master Pattern (from utility_predictions)
 *     + User Offset
 *     + Growatt Adjustments (auto-applied via master update)
 *     + Community Sync Adjustments
 *     + ATC Decision Layer
 *
 * ─────────────────────────────────────────────────────────────────────
 * THREE-USER MODEL (spec §OFFSET BEHAVIOR):
 *
 * User A (offset < 0 — AHEAD of Growatt):
 *   - Reaches predicted cycle end BEFORE Growatt.
 *   - Enters UNCERTAIN_ZONE at predicted end.
 *   - Stays there until: user report | community confirm | Growatt flip.
 *   - On Growatt flip: immediately exits, backdates start:
 *       UserCycleStart = GrowattTransitionTime + Offset   (< GrowattTime)
 *   - “منذ” shows elapsed since UserCycleStart, never “للتو”.
 *
 * User B (offset > 0 — BEHIND Growatt):
 *   - When Growatt flips, compute scheduledTransitionIso:
 *       scheduledTransitionIso = GrowattTransitionTime + positiveOffset
 *   - Show countdown banner: “سيتم تغيير حالتك تلقائياً عند الساعة [HH:MM]”
 *   - At scheduledTransitionIso: auto-transition, elapsed starts at that time.
 *   - WAITING_FOR_GROWATT only fires if scheduledTransitionIso has passed
 *     and the slot still hasn’t activated (should be very rare).
 *
 * User C (offset = 0 — NEUTRAL):
 *   - Transitions with Growatt.
 *   - Brief GRACE_MODE (15 min) before WAITING_FOR_GROWATT if late.
 * ─────────────────────────────────────────────────────────────────────
 */

Import { useEffect, useState, useRef } from ‘react’;
Import { supabase } from ‘../lib/supabase’;
Import { Prediction, ScheduleSlot } from ‘./usePredictions’;
Import { ResyncPoint } from ‘../contexts/ResyncContext’;

// ── Public types ──────────────────────────────────────────────────────────────

Export type ScheduleStateMode =
  | ‘NORMAL’
  | ‘PREDICTION_RANGE’
  | ‘UNCERTAIN_ZONE’
  | ‘COMMUNITY_SYNCED’
  | ‘WAITING_FOR_GROWATT’
  | ‘GRACE_MODE’
  | ‘POSITIVE_OFFSET_PENDING’; // User B: Growatt already changed, countdown to user’s scheduled time

/** TMMS transition authority modes (spec: TRANSITION MODES) */
Export type TransitionMode = ‘AUTO’ | ‘MANUAL’;

Export interface ATCState {
  Mode: ScheduleStateMode;
  overrunMinutes: number;
  communityElevated: boolean;
  statusLine: string | null;
  /** True when Growatt changed state but validation window is still active */
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  /** TMMS: active transition authority mode */
  transitionMode: TransitionMode;
  /**
   * User B (+offset): ISO of the exact scheduled auto-transition time.
   * = GrowattTransitionTime + positiveOffset
   * Shown as countdown banner on Home screen.
   * Null for all other modes / users.
   */
  scheduledAutoTransitionIso: string | null;
}

Export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string;
  syncedState: ‘ON’ | ‘OFF’;
}

Export interface ShiftedTransition {
  Type: ‘UTILITY_ON’ | ‘UTILITY_OFF’;
  /** Formatted range — e.g. “7:00 م → 8:03 م” */
  rangeLabel: string;
  /** ISO strings for the range start and end */
  rangeStartIso: string;
  rangeEndIso: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  waitLabel: string;
  /** True if current time has entered the prediction range window */
  inRangeWindow: boolean;
}

Export interface ShiftedScheduleSlot extends ScheduleSlot {
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  isResynced?: boolean;
}

Export interface UserPrediction {
  Atc: ATCState;
  nextTransition: ShiftedTransition | null;
  expectedOffDurationLabel: string | null;
  expectedOnDurationLabel: string | null;
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  currentState: ‘ON’ | ‘OFF’;
  currentStateDurationLabel: string;
  /** ISO of when the current state started (for elapsed timer) */
  currentStateStartIso: string | null;
  daySchedule: ShiftedScheduleSlot[];
  reasoning: string[];
  learningMode: string;
  computedAt: string | null;
  offsetMinutes: number;
  crisisMode: boolean;
  crisisReason: string | null;
  isResynced: boolean;
  resyncedAtIso: string | null;
  isHoldingState: boolean;
  communitySyncMeta: CommunitySyncMeta | null;
  /**
   * TMMS Lost-Time Reconciliation (spec §CYCLE CONTINUITY RULE):
   * When exiting UNCERTAIN_ZONE via Growatt confirmation, the next cycle
   * start is backdated to: GrowattTransitionTime + Offset.
   * This ISO is that backdated start so the elapsed timer shows the correct
   * time already elapsed, not “للتو”.
   */
  reconciledCycleStartIso: string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

Function shiftMs(iso: string, deltaMs: number): string {
  Return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

// Western numerals + Arabic AM/PM suffix, LTR (spec §20)
Function fmtYemenTime(iso: string): string {
  Const raw = new Date(iso).toLocaleString(‘en-US’, {
    timeZone: ‘Asia/Aden’, hour: ‘numeric’, minute: ‘2-digit’, hour12: true,
  });
  Return raw.replace(‘AM’, ‘ص’).replace(‘PM’, ‘م’);
}

Function getZoneFromIso(iso: string): string {
  Const h = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).getUTCHours();
  If (h < 6) return ‘Night’;
  If (h < 10) return ‘Morning’;
  If (h < 16) return ‘Midday’;
  If (h < 20) return ‘Evening’;
  Return ‘Late Night’;
}

Function fmtWait(min: number): string {
  If (min <= 0) return ‘قريباً’;
  Const h = Math.floor(min / 60);
  Const m = Math.round(min % 60);
  If (h === 0) return `~${m}د`;
  If (m === 0) return `~${h}س`;
  Return `~${h}س ${m}د`;
}

Function durationLabelFromMin(min: number): string {
  Const h = Math.floor(min / 60);
  Const m = Math.round(min % 60);
  If (h === 0) return `${m}د`;
  If (m === 0) return h === 1 ? ‘ساعة’ : `${h}س`;
  Return `${h}س ${m}د`;
}

Const EMPTY_ATC: ATCState = {
  Mode: ‘NORMAL’,
  overrunMinutes: 0,
  communityElevated: false,
  statusLine: null,
  inValidationWindow: false,
  validationWindowRemainingMin: 0,
  transitionMode: ‘AUTO’,
  scheduledAutoTransitionIso: null,
};

// ── Step 1: Extend master schedule to 48h ────────────────────────────────────
Function extendScheduleTo48h(masterSlots: ScheduleSlot[], prediction: Prediction): ScheduleSlot[] {
  If (masterSlots.length === 0) return [];

  Let realOnMin: number | null = null;
  Let realOffMin: number | null = null;

  For (let I = masterSlots.length – 1; I >= 0; i--) {
    Const s = masterSlots[i];
    If (!s.endIso) continue;
    Const durMin = (new Date(s.endIso).getTime() – new Date(s.startIso).getTime()) / 60_000;
    If (durMin < 5) continue;
    If (s.state === ‘ON’ && realOnMin === null) realOnMin = durMin;
    If (s.state === ‘OFF’ && realOffMin === null) realOffMin = durMin;
    If (realOnMin !== null && realOffMin !== null) break;
  }

  Const extOnMin  = realOnMin  ?? prediction.expectedOnRange?.minMin  ?? prediction.allPattern?.avgOnMin  ?? prediction.dayPattern?.avgOnMin  ?? 120;
  Const extOffMin = realOffMin ?? prediction.expectedOffRange?.minMin ?? prediction.allPattern?.avgOffMin ?? prediction.dayPattern?.avgOffMin ?? 360;

  Const horizonMs = Date.now() + 48 * 60 * 60 * 1000;
  Const slots: ScheduleSlot[] = […masterSlots];

  While (slots.length < 40) {
    Const last = slots[slots.length – 1];
    If (!last.endIso) break;
    Const lastEndMs = new Date(last.endIso).getTime();
    If (lastEndMs >= horizonMs) break;

    Const nextState: ‘ON’ | ‘OFF’ = last.state === ‘ON’ ? ‘OFF’ : ‘ON’;
    Const durationMin = nextState === ‘OFF’ ? extOffMin : extOnMin;
    Const nextStartIso = last.endIso;
    Const nextEndMs = lastEndMs + durationMin * 60_000;
    Const nextEndIso = new Date(nextEndMs).toISOString();

    Slots.push({
      State: nextState,
      startIso: nextStartIso,
      endIso: nextEndIso,
      startFormatted: fmtYemenTime(nextStartIso),
      endFormatted: fmtYemenTime(nextEndIso),
      durationLabel: durationLabelFromMin(Math.round(durationMin)),
      zone: getZoneFromIso(nextStartIso),
      isEstimated: true,
    });
  }

  Return slots;
}

// ── Step 2: Apply offset ──────────────────────────────────────────────────────
Function applyOffsetToSlots(slots: ScheduleSlot[], offsetMs: number): ShiftedScheduleSlot[] {
  Return slots.map((slot) => {
    Const startIso = shiftMs(slot.startIso, offsetMs);
    Const endIso = slot.endIso ? shiftMs(slot.endIso, offsetMs) : null;
    Return {
      …slot,
      startIso,
      endIso,
      startFormatted: fmtYemenTime(startIso),
      endFormatted: endIso ? fmtYemenTime(endIso) : null,
      shiftedStartFormatted: fmtYemenTime(startIso),
      shiftedEndFormatted: endIso ? fmtYemenTime(endIso) : null,
      isResynced: false,
    };
  });
}

// ── Step 3: Apply community delta ─────────────────────────────────────────────
Function applyCommunityDelta(offsetSlots: ShiftedScheduleSlot[], resync: ResyncPoint): ShiftedScheduleSlot[] {
  Const syncMs = new Date(resync.syncedAtIso).getTime();
  Const syncState = resync.syncedState;
  Const LOOKAHEAD_MS = 90 * 60_000;

  Let matchIdx = -1;

  For (let I = 0; I < offsetSlots.length; i++) {
    Const s = offsetSlots[i];
    If (s.state !== syncState) continue;
    Const sMs = new Date(s.startIso).getTime();
    Const eMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    If (syncMs >= sMs – LOOKAHEAD_MS && syncMs < eMs + LOOKAHEAD_MS) {
      matchIdx = I;
      break;
    }
  }

  If (matchIdx === -1) {
    Const nowMs = Date.now();
    For (let I = 0; I < offsetSlots.length; i++) {
      If (offsetSlots[i].state !== syncState) continue;
      Const sMs = new Date(offsetSlots[i].startIso).getTime();
      If (sMs >= nowMs – LOOKAHEAD_MS) {
        matchIdx = I;
        break;
      }
    }
  }

  If (matchIdx === -1) return offsetSlots;

  Const matchedSlotStartMs = new Date(offsetSlots[matchIdx].startIso).getTime();
  Const deltaMs = syncMs – matchedSlotStartMs;

  Return offsetSlots.map((slot, idx) => {
    If (idx < matchIdx) return slot;
    Const newStartIso = shiftMs(slot.startIso, deltaMs);
    Const newEndIso = slot.endIso ? shiftMs(slot.endIso, deltaMs) : null;
    Return {
      …slot,
      startIso: newStartIso,
      endIso: newEndIso,
      startFormatted: fmtYemenTime(newStartIso),
      endFormatted: newEndIso ? fmtYemenTime(newEndIso) : null,
      shiftedStartFormatted: fmtYemenTime(newStartIso),
      shiftedEndFormatted: newEndIso ? fmtYemenTime(newEndIso) : null,
      isResynced: idx === matchIdx,
    };
  });
}

// ── Validation Window (20 min) — Growatt changed while sync is active ─────────
Const VALIDATION_WINDOW_MS = 20 * 60_000;

// ── ATC Decision Engine ───────────────────────────────────────────────────────
//
// THREE-USER MODEL IMPLEMENTATION:
//
// User A (offsetMinutes < 0 — AHEAD of Growatt):
//   Scans for the most recently ended slot. If that slot’s end has passed
//   AND Growatt has NOT yet confirmed the matching transition → UNCERTAIN_ZONE.
//   If Growatt HAS confirmed → still return UNCERTAIN_ZONE so that the exit
//   block in applyOffsetToPrediction can compute the backdated start.
//
// User B (offsetMinutes > 0 — BEHIND Growatt):
//   When Growatt has already flipped and the user’s scheduled transition time
//   (= GrowattTransitionTime + positiveOffset) is still in the future:
//   → POSITIVE_OFFSET_PENDING with scheduledAutoTransitionIso set.
//   When scheduledTransitionIso has passed → NORMAL (schedule slot is now active).
//   If the slot somehow overruns past scheduledTransitionIso + 15min → WAITING_FOR_GROWATT.
//
// User C (offsetMinutes = 0 — NEUTRAL):
//   Transitions with Growatt. Brief GRACE_MODE (15 min) then WAITING_FOR_GROWATT.
//
Function computeATCState(
  effectiveSlots: ShiftedScheduleSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
  transitionMode: TransitionMode = ‘AUTO’,
): ATCState {
  Const nowMs = Date.now();

  // ── Community Sync path ────────────────────────────────────────────────────
  // Personal timeline branch is PERMANENT until explicit user revert.
  // Per spec §10: never auto-revert. Validation window = display warning only.
  If (resyncPoint) {
    Const syncedState = resyncPoint.syncedState;
    Const growattState = prediction.currentState;
    Const growattDiffers = (syncedState === ‘ON’) !== (growattState === ‘ON’);
    Const syncAgeMs = nowMs – new Date(resyncPoint.syncedAtIso).getTime();
    Const inValidationWindow = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
    Const validationRemainingMin = inValidationWindow ? (VALIDATION_WINDOW_MS – syncAgeMs) / 60_000 : 0;

    Return {
      Mode: ‘COMMUNITY_SYNCED’,
      overrunMinutes: 0,
      communityElevated: inValidationWindow,
      statusLine: inValidationWindow
        ? `نافذة التحقق نشطة — الحساس يُشير لتغيير · ${Math.ceil(validationRemainingMin)} د`
        : null,
      inValidationWindow,
      validationWindowRemainingMin: validationRemainingMin,
      transitionMode,
      scheduledAutoTransitionIso: null,
    };
  }

  Const halfSpreadMs = 15 * 60_000;
  Const GRACE_PERIOD_MS = 15 * 60_000;

  // ── USER A: NEGATIVE OFFSET ────────────────────────────────────────────────
  //
  // The user reaches the predicted cycle end BEFORE Growatt does.
  // After the predicted end, the user MUST enter UNCERTAIN_ZONE until:
  //   Priority 1: User report
  //   Priority 2: Community confirmation
  //   Priority 3: Growatt state change (AUTO mode only)
  //
  // CRITICAL: We cannot rely on the “currently active slot” check because
  // after the old slot ends, the schedule advances to the NEW slot (new state).
  // We must check the MOST RECENTLY ENDED slot instead.
  //
  If (offsetMinutes < 0) {
    // Find the most recently ended slot (endIso is in the past)
    Let justEndedSlot: ShiftedScheduleSlot | null = null;

    For (let I = 0; I < effectiveSlots.length; i++) {
      Const s = effectiveSlots[i];
      If (!s.endIso) continue;
      Const endMs = new Date(s.endIso).getTime();
      If (endMs <= nowMs) {
        justEndedSlot = s;
      } else {
        Break; // ordered slots — once future found, stop
      }
    }

    If (justEndedSlot && justEndedSlot.endIso) {
      Const slotEndMs = new Date(justEndedSlot.endIso).getTime();
      Const rangeStartMs = slotEndMs – halfSpreadMs;
      Const rangeEndMs   = slotEndMs + halfSpreadMs;
      Const overrunMs    = Math.max(0, nowMs – rangeEndMs);
      Const overrunMin   = overrunMs / 60_000;

      // Inside prediction range window of the just-ended slot
      If (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        Return {
          …EMPTY_ATC,
          Mode: ‘PREDICTION_RANGE’,
          statusLine: ‘نطاق التوقع نشط — التغيير محتمل’,
          transitionMode,
        };
      }

      // Past the range end — check if Growatt confirmed
      //
      // Growatt confirmed = prediction.currentState has already flipped to the
      // expected new state AND prediction.lastTransitionAt ≥ rangeStartMs.
      // (The check uses rangeStartMs so we don’t match stale unrelated events.)
      Const expectedNewState: ‘ON’ | ‘OFF’ = justEndedSlot.state === ‘ON’ ? ‘OFF’ : ‘ON’;
      Const growattAlreadyConfirmed =
        Prediction.currentState === expectedNewState &&
        !!prediction.lastTransitionAt &&
        New Date(prediction.lastTransitionAt).getTime() >= rangeStartMs;

      If (nowMs > rangeStartMs) {
        // Whether Growatt confirmed or not, return UNCERTAIN_ZONE so that:
        // - deriveCurrentStateATC holds the OLD (just-ended) slot’s state
        // - applyOffsetToPrediction’s exit block fires when growattAlreadyConfirmed
        Return {
          …EMPTY_ATC,
          Mode: ‘UNCERTAIN_ZONE’,
          overrunMinutes: overrunMin,
          communityElevated: !growattAlreadyConfirmed, // elevate community while waiting
          statusLine: growattAlreadyConfirmed
            ? null // reconciliation will handle this
            : overrunMin < 1
              ? ‘نطاق التوقع انتهى — بانتظار تأكيد تغير الحالة’
              : `تجاوزت المدة المتوقعة بـ ${Math.ceil(overrunMin)} دقيقة — بانتظار تأكيد`,
          transitionMode,
        };
      }
    }

    // No slot has ended yet — check currently active slot near its end
    Let activeSlotNeg: ShiftedScheduleSlot | null = null;
    For (const slot of effectiveSlots) {
      Const start = new Date(slot.startIso).getTime();
      Const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      If (nowMs >= start && nowMs < end) { activeSlotNeg = slot; break; }
    }
    If (activeSlotNeg?.endIso) {
      Const slotEndMs   = new Date(activeSlotNeg.endIso).getTime();
      Const rangeStartMs = slotEndMs – halfSpreadMs;
      Const rangeEndMs   = slotEndMs + halfSpreadMs;
      If (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        Return { …EMPTY_ATC, mode: ‘PREDICTION_RANGE’, statusLine: ‘نطاق التوقع نشط — التغيير محتمل’, transitionMode };
      }
    }

    Return { …EMPTY_ATC, transitionMode };
  }

  // ── USER B: POSITIVE OFFSET ────────────────────────────────────────────────
  //
  // The user is BEHIND Growatt. When Growatt flips, we know exactly when the
  // user will transition: scheduledTransitionIso = GrowattTransitionTime + offset.
  //
  // States:
  //   1. Growatt has NOT yet flipped for the next cycle → NORMAL (schedule-driven)
  //   2. Growatt has flipped AND scheduledTransitionIso is in the future →
  //      POSITIVE_OFFSET_PENDING — show countdown banner
  //   3. scheduledTransitionIso has passed → NORMAL (shifted schedule slot is active)
  //   4. Shifted schedule slot somehow overruns by >15 min → WAITING_FOR_GROWATT
  //
  If (offsetMinutes > 0) {
    // Check if Growatt has already transitioned for the UPCOMING user cycle.
    // We detect this by seeing if prediction.currentState differs from the
    // state of the currently-active shifted slot.
    //
    // Find current shifted-schedule state (what the schedule says should be now)
    Let activeSlotPos: ShiftedScheduleSlot | null = null;
    For (const slot of effectiveSlots) {
      Const start = new Date(slot.startIso).getTime();
      Const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      If (nowMs >= start && nowMs < end) { activeSlotPos = slot; break; }
    }

    // Find the slot that starts next (future)
    Let nextSlotPos: ShiftedScheduleSlot | null = null;
    For (const slot of effectiveSlots) {
      If (new Date(slot.startIso).getTime() > nowMs) { nextSlotPos = slot; break; }
    }

    // Determine what state the SCHEDULE says we are currently in
    Const scheduleCurrentState = activeSlotPos?.state ?? (nextSlotPos ? (nextSlotPos.state === ‘ON’ ? ‘OFF’ : ‘ON’) : null);

    // Has Growatt already flipped to the opposite of our schedule’s current state?
    Const growattFlippedAhead =
      scheduleCurrentState !== null &&
      prediction.currentState !== scheduleCurrentState &&
      !!prediction.lastTransitionAt;

        If (growattFlippedAhead && transitionMode === ‘AUTO’) {
      // Compute the exact time the user will transition
      Const offsetMs = offsetMinutes * 60_000;
      Const scheduledMs = new Date(prediction.lastTransitionAt!).getTime() + offsetMs;
      Const scheduledAutoTransitionIso = new Date(scheduledMs).toISOString();

      // Return POSITIVE_OFFSET_PENDING unconditionally so the exit block
      // in applyOffsetToPrediction can apply accurate reconciliation.
      Return {
        …EMPTY_ATC,
        Mode: ‘POSITIVE_OFFSET_PENDING’,
        statusLine: scheduledMs > nowMs 
          ? ` سيتم   تغيير   حالتك   تلقائياً   في  ${fmtYemenTime(scheduledAutoTransitionIso)} ·  بعد  ${Math.round((scheduledMs – nowMs) / 60_000)} د ` 
          : null,
        scheduledAutoTransitionIso,
        transitionMode,
      };
    }


    // Normal active-slot check for positive offset
    If (!activeSlotPos || !activeSlotPos.endIso) {
      Return { …EMPTY_ATC, transitionMode };
    }

    Const slotEndMs    = new Date(activeSlotPos.endIso).getTime();
    Const rangeStartMs = slotEndMs – halfSpreadMs;
    Const rangeEndMs   = slotEndMs + halfSpreadMs;
    Const overrunMs    = Math.max(0, nowMs – rangeEndMs);
    Const overrunMin   = overrunMs / 60_000;

    If (nowMs < rangeStartMs)                         return { …EMPTY_ATC, transitionMode };
    If (nowMs >= rangeStartMs && nowMs <= rangeEndMs) return { …EMPTY_ATC, mode: ‘PREDICTION_RANGE’, statusLine: ‘نطاق التوقع نشط — التغيير محتمل’, transitionMode };

    // Overrun beyond range → WAITING_FOR_GROWATT
    Return {
      …EMPTY_ATC,
      Mode: ‘WAITING_FOR_GROWATT’,
      overrunMinutes: overrunMin,
      communityElevated: transitionMode === ‘MANUAL’,
      statusLine: transitionMode === ‘MANUAL’
        ? ‘وضع يدوي — بانتظار بلاغك أو تأكيد مجتمعي’
        : ‘بانتظار تأكيد الحساس الرئيسي أو بلاغ مجتمعي’,
      transitionMode,
    };
  }

  // ── USER C: NEUTRAL OFFSET (= 0) ──────────────────────────────────────────
  //
  // Transitions align with Growatt. GRACE_MODE (15 min) before WAITING_FOR_GROWATT.
  //
  Let activeSlot: ShiftedScheduleSlot | null = null;
  For (const slot of effectiveSlots) {
    Const start = new Date(slot.startIso).getTime();
    Const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    If (nowMs >= start && nowMs < end) { activeSlot = slot; break; }
  }

  If (!activeSlot?.endIso) return { …EMPTY_ATC, transitionMode };

  Const slotEndMs    = new Date(activeSlot.endIso).getTime();
  Const rangeStartMs = slotEndMs – halfSpreadMs;
  Const rangeEndMs   = slotEndMs + halfSpreadMs;
  Const overrunMs    = Math.max(0, nowMs – rangeEndMs);
  Const overrunMin   = overrunMs / 60_000;

  If (nowMs < rangeStartMs)                         return { …EMPTY_ATC, transitionMode };
  If (nowMs >= rangeStartMs && nowMs <= rangeEndMs) return { …EMPTY_ATC, mode: ‘PREDICTION_RANGE’, statusLine: ‘نطاق التوقع نشط — التغيير محتمل’, transitionMode };

  If (overrunMs <= GRACE_PERIOD_MS) {
    Return {
      …EMPTY_ATC,
      Mode: ‘GRACE_MODE’,
      overrunMinutes: overrunMin,
      statusLine: ‘تأخر غير معتاد — لا يزال التشغيل مستمراً خارج النطاق المتوقع’,
      transitionMode,
    };
  }

  Return {
    …EMPTY_ATC,
    Mode: ‘WAITING_FOR_GROWATT’,
    overrunMinutes: overrunMin,
    communityElevated: true,
    statusLine: transitionMode === ‘MANUAL’
      ? ‘وضع يدوي — بانتظار بلاغك أو تأكيد مجتمعي لإنهاء الدورة’
      : ‘النمط الحالي ممتد بشكل غير معتاد — بانتظار تأكيد تغير الحالة’,
    transitionMode,
  };
}

Function atcShouldHold(mode: ScheduleStateMode): boolean {
  Return (
    Mode === ‘UNCERTAIN_ZONE’ ||
    Mode === ‘WAITING_FOR_GROWATT’ ||
    Mode === ‘PREDICTION_RANGE’ ||
    Mode === ‘GRACE_MODE’ ||
    Mode === ‘POSITIVE_OFFSET_PENDING’
  );
}

// ── Derive next transition ────────────────────────────────────────────────────
Function deriveNextTransition(
  effectiveSlots: ShiftedScheduleSlot[],
  currentState: ‘ON’ | ‘OFF’,
  prediction: Prediction,
): ShiftedTransition | null {
  Const nowMs = Date.now();
  Const oppositeState: ‘ON’ | ‘OFF’ = currentState === ‘ON’ ? ‘OFF’ : ‘ON’;

  For (const slot of effectiveSlots) {
    If (slot.state !== oppositeState) continue;
    Const slotMs = new Date(slot.startIso).getTime();
    If (slotMs <= nowMs) continue;

    Const minFromNow = (slotMs – nowMs) / 60_000;
    Let halfSpread = 15;
    If (prediction.nextTransition) {
      halfSpread = Math.max(10, (prediction.nextTransition.maxFromNowMin – prediction.nextTransition.minFromNowMin) / 2);
    }

    Const minMin      = Math.max(0, minFromNow – halfSpread);
    Const maxMin      = Math.max(0, minFromNow + halfSpread);
    Const earliestIso = shiftMs(slot.startIso, -halfSpread * 60_000);
    Const latestIso   = shiftMs(slot.startIso, halfSpread * 60_000);

    Const rangeStartMs = new Date(earliestIso).getTime();
    Const rangeEndMs   = new Date(latestIso).getTime();
    Const inRangeWindow = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

    Return {
      Type: oppositeState === ‘ON’ ? ‘UTILITY_ON’ : ‘UTILITY_OFF’,
      rangeLabel: `${fmtYemenTime(earliestIso)} → ${fmtYemenTime(latestIso)}`,
      rangeStartIso: earliestIso,
      rangeEndIso: latestIso,
      minFromNowMin: minMin,
      maxFromNowMin: maxMin,
      waitLabel: `${fmtWait(minMin)} → ${fmtWait(maxMin)}`,
      inRangeWindow,
    };
  }

  Return null;
}

// ── ATC-aware current state derivation ───────────────────────────────────────
//
// CRITICAL: For negative-offset users in UNCERTAIN_ZONE, the schedule may have
// advanced to the NEXT slot. We MUST hold the most-recently-ENDED slot’s state,
// not the currently-starting slot’s state.
//
// For User B in POSITIVE_OFFSET_PENDING: hold the current (pre-transition) state
// — the schedule’s shifted new slot hasn’t started yet (it starts at scheduledMs).
//
Function deriveCurrentStateATC(
  effectiveSlots: ShiftedScheduleSlot[],
  atcMode: ScheduleStateMode,
  masterCurrentState: ‘ON’ | ‘OFF’,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode = ‘AUTO’,
): { state: ‘ON’ | ‘OFF’; startIso: string | null } {
  If (resyncPoint) {
    Return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
  }

  Const nowMs = Date.now();

  Const derivePreScheduleState = (): { state: ‘ON’ | ‘OFF’; startIso: string | null } => {
    If (effectiveSlots.length > 0) {
      Const preState: ‘ON’ | ‘OFF’ = effectiveSlots[0].state === ‘ON’ ? ‘OFF’ : ‘ON’;
      Return { state: preState, startIso: null };
    }
    Return { state: masterCurrentState, startIso: null };
  };

  If (atcShouldHold(atcMode)) {
    If (atcMode === ‘UNCERTAIN_ZONE’) {
      // NEGATIVE OFFSET HOLD: find the most recently ENDED slot.
      // That is the slot whose predicted end triggered UNCERTAIN_ZONE.
      // The NEXT slot (new state) may have already started in the schedule —
      // we ignore it until a valid exit condition fires.
      Let heldSlot: ShiftedScheduleSlot | null = null;
      For (let I = 0; I < effectiveSlots.length; i++) {
        Const s = effectiveSlots[i];
        If (!s.endIso) continue;
        Const endMs = new Date(s.endIso).getTime();
        If (endMs <= nowMs) { heldSlot = s; }
        Else { break; }
      }
      If (heldSlot) return { state: heldSlot.state, startIso: heldSlot.startIso };
      Return derivePreScheduleState();
    }

    If (atcMode === ‘POSITIVE_OFFSET_PENDING’) {
      // User B: Growatt flipped ahead, but user’s scheduled time is still future.
      // Hold the current (pre-transition) schedule state.
      Let best: ShiftedScheduleSlot | null = null;
      For (const slot of effectiveSlots) {
        If (new Date(slot.startIso).getTime() <= nowMs) best = slot;
        Else break;
      }
      If (best) return { state: best.state, startIso: best.startIso };
      Return derivePreScheduleState();
    }

    // WAITING_FOR_GROWATT / GRACE_MODE / PREDICTION_RANGE:
    // hold the last slot that started before now
    Let best: ShiftedScheduleSlot | null = null;
    For (const slot of effectiveSlots) {
      If (new Date(slot.startIso).getTime() <= nowMs) best = slot;
      Else break;
    }
    If (best) return { state: best.state, startIso: best.startIso };
    Return derivePreScheduleState();
  }

  // Normal schedule-driven path
  Let best: ShiftedScheduleSlot | null = null;
  For (const slot of effectiveSlots) {
    If (new Date(slot.startIso).getTime() <= nowMs) best = slot;
    Else break;
  }
  If (best) return { state: best.state, startIso: best.startIso };
  Return derivePreScheduleState();
}

// ── Human-friendly Arabic duration range label (spec §23) ────────────────────
Function arabicDurationRange(minMin: number, maxMin: number): string {
  Const fmtSingle = (min: number): string => {
    Const h = Math.floor(min / 60);
    Const m = Math.round(min % 60);
    If (h === 0) return m === 1 ? ‘دقيقة’ : m === 2 ? ‘دقيقتان’ : `${m} دقيقة`;
    Const hoursAr = h === 1 ? ‘ساعة’ : h === 2 ? ‘ساعتان’ : `${h} ساعات`;
    If (m === 0) return hoursAr;
    Return `${hoursAr} و ${m} دقيقة`;
  };
  If (Math.round(minMin) === Math.round(maxMin)) return fmtSingle(minMin);
  Return `من ${fmtSingle(minMin)} إلى ${fmtSingle(maxMin)}`;
}

// ── Duration label from startIso ──────────────────────────────────────────────
Function elapsedLabel(startIso: string | null): string {
  If (!startIso) return ‘’;
  Const elapsedMin = Math.round((Date.now() – new Date(startIso).getTime()) / 60_000);
  If (elapsedMin < 1) return ‘للتو’;
  Const eH = Math.floor(elapsedMin / 60);
  Const eM = elapsedMin % 60;
  If (eH === 0) return `${elapsedMin}د`;
  If (eM === 0) return `${eH}س`;
  Return `${eH}س ${eM}د`;
}

// ── Lost-Time Reconciliation (spec §CYCLE CONTINUITY RULE) ──────────────────
//
// FORMULA:
//   UserCycleStartTime = GrowattTransitionTime + UserOffset
//
//   Negative offset (-60 min): GrowattTime=04:00 → UserStart=03:00 (in the past ✅)
//   Neutral offset (0):        GrowattTime=05:00 → UserStart=05:00 (in the past ✅)
//   Positive offset (+60 min): GrowattTime=05:00 → UserStart=06:00 (in the future ❌ → return null)
//     For positive offset the transition happens at scheduledMs via POSITIVE_OFFSET_PENDING
//     and then naturally via the shifted schedule slot becoming active.
//
Function computeReconciledCycleStart(
  growattLastTransitionAt: string | null,
  offsetMs: number,
  heldState: ‘ON’ | ‘OFF’,
  masterCurrentState: ‘ON’ | ‘OFF’,
): string | null {
  If (heldState === masterCurrentState) return null;
  If (!growattLastTransitionAt) return null;

  Const reconciledStartMs = new Date(growattLastTransitionAt).getTime() + offsetMs;
  // Only valid if the reconciled start is already in the past
  If (reconciledStartMs >= Date.now()) return null;

  Return new Date(reconciledStartMs).toISOString();
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

Export function applyOffsetToPrediction(
  Prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  communitySyncMeta?: CommunitySyncMeta | null,
  transitionMode: TransitionMode = ‘AUTO’,
  heldCycleStartIso?: string | null,
): UserPrediction {
  Const offsetMs = offsetMinutes * 60_000;

  // ── GLOBAL ANTI-CREEP: Anchor schedule to hardware reality ──
  // لحماية جميع الفترات الحالية والمستقبلية لجميع المستخدمين من زحف توقيت الخادم
  Let masterSlots = prediction.daySchedule ?? [];
  If (masterSlots.length > 0 && prediction.lastTransitionAt && masterSlots[0].state === prediction.currentState) {
    Const hardwareStartMs = new Date(prediction.lastTransitionAt).getTime();
    Const creepingStartMs = new Date(masterSlots[0].startIso).getTime();
    Const driftMs = hardwareStartMs – creepingStartMs; // حساب مقدار زحف الخادم
    masterSlots = masterSlots.map(slot => ({
      …slot,
      startIso: shiftMs(slot.startIso, driftMs),
      endIso: slot.endIso ? shiftMs(slot.endIso, driftMs) : null,
    }));
  }

  Const extended = extendScheduleTo48h(masterSlots, prediction);
  Let effectiveSlots = applyOffsetToSlots(extended, offsetMs);

  Const hasResync = !!resyncPoint;
  If (resyncPoint) {
    effectiveSlots = applyCommunityDelta(effectiveSlots, resyncPoint);
  }

  Const atcState = computeATCState(effectiveSlots, offsetMinutes, resyncPoint ?? null, prediction, transitionMode);

  Let { state: currentState, startIso: currentStateStartIso } =
    deriveCurrentStateATC(effectiveSlots, atcState.mode, prediction.currentState, resyncPoint ?? null, transitionMode);

  let isHolding = atcShouldHold(atcState.mode);
  let finalAtcState = atcState;
  let reconciledCycleStartIso: string | null = null;

  // ── USER A EXIT: UNCERTAIN_ZONE → Growatt confirmed (AUTO mode only) ──────
  //
  // When prediction.currentState has flipped relative to the HELD state,
  // Growatt has confirmed the transition. Immediately exit and backdate:
  //   UserCycleStartTime = GrowattTransitionTime + Offset
  //
  // Example: Growatt OFF at 12:00, offset -60 → UserStart = 11:00
  //   At 12:00: “طافية — منذ ساعة” ✅   NOT “منذ للتو” ❌
  //
  If (
    atcState.mode === ‘UNCERTAIN_ZONE’ &&
    transitionMode === ‘AUTO’ &&
    prediction.currentState !== currentState
  ) {
    Const backdatedStart = computeReconciledCycleStart(
      Prediction.lastTransitionAt,
      offsetMs,
      currentState,
      prediction.currentState,
    );

    If (backdatedStart) {
      reconciledCycleStartIso = backdatedStart;
      currentState            = prediction.currentState as ‘ON’ | ‘OFF’;
      currentStateStartIso    = backdatedStart;
      isHolding               = false;
      finalAtcState           = { …atcState, mode: ‘NORMAL’, overrunMinutes: 0, statusLine: null, communityElevated: false };
    } else if (prediction.lastTransitionAt) {
      // Safety fallback (should not reach here for negative offsets)
      currentState         = prediction.currentState as ‘ON’ | ‘OFF’;
      currentStateStartIso = prediction.lastTransitionAt;
      isHolding            = false;
      finalAtcState        = { …atcState, mode: ‘NORMAL’, overrunMinutes: 0, statusLine: null, communityElevated: false };
    }
  }

  // ── USER B EXIT: POSITIVE_OFFSET_PENDING → scheduled time has passed ──────
  //
  // If scheduledAutoTransitionIso has now passed, exit the hold.
  // UserCycleStartTime = scheduledAutoTransitionIso (which = GrowattTime + offset).
  // Since computeReconciledCycleStart returns null for future times, we use
  // scheduledAutoTransitionIso directly.
  //
  If (
    atcState.mode === ‘POSITIVE_OFFSET_PENDING’ &&
    transitionMode === ‘AUTO’ &&
    atcState.scheduledAutoTransitionIso
  ) {
    Const scheduledMs = new Date(atcState.scheduledAutoTransitionIso).getTime();
    If (scheduledMs <= Date.now()) {
      // Transition time has passed — user transitions to Growatt’s confirmed state
      Const newState = prediction.currentState as ‘ON’ | ‘OFF’;
      reconciledCycleStartIso = atcState.scheduledAutoTransitionIso;
      currentState            = newState;
      currentStateStartIso    = atcState.scheduledAutoTransitionIso;
      isHolding               = false;
      finalAtcState           = { …atcState, mode: ‘NORMAL’, overrunMinutes: 0, statusLine: null, scheduledAutoTransitionIso: null };
    }
  }

  // ── USER C / NEUTRAL EXIT: WAITING_FOR_GROWATT / GRACE_MODE ──────────────
  If (
    (atcState.mode === ‘WAITING_FOR_GROWATT’ || atcState.mode === ‘GRACE_MODE’) &&
    transitionMode === ‘AUTO’ &&
    prediction.currentState !== currentState
  ) {
    Const backdatedStart = computeReconciledCycleStart(
      Prediction.lastTransitionAt,
      offsetMs,
      currentState,
      prediction.currentState,
    );

    If (backdatedStart) {
      reconciledCycleStartIso = backdatedStart;
      currentState            = prediction.currentState as ‘ON’ | ‘OFF’;
      currentStateStartIso    = backdatedStart;
      isHolding               = false;
      finalAtcState           = { …atcState, mode: ‘NORMAL’, overrunMinutes: 0, statusLine: null, communityElevated: false };
    }
  }
  Const nextTransition = prediction.isUnstable
    ? null
    : deriveNextTransition(effectiveSlots, currentState, prediction);
    
  Const durLabel = elapsedLabel(reconciledCycleStartIso ?? currentStateStartIso);

    // ── POSITIVE OFFSET FIX: INJECT SYNTHETIC LINGERING SLOT ──
  // سد “فجوة الجدول” للمستخدم الموجب: إضافة الفترة الحالية المتبقية التي ينتظر انتهاءها
  Let finalDaySchedule = […effectiveSlots];
  If (finalAtcState.mode === ‘POSITIVE_OFFSET_PENDING’ && finalAtcState.scheduledAutoTransitionIso) {
    // نستخدم المرجع الثابت heldCycleStartIso لمنع الفترة من الزحف للأمام
    Const currentStart = reconciledCycleStartIso ?? currentStateStartIso ?? heldCycleStartIso ?? new Date().toISOString();
 
  
    finalDaySchedule.unshift({
      state: currentState,
      startIso: currentStart,
      endIso: finalAtcState.scheduledAutoTransitionIso,
      startFormatted: fmtYemenTime(currentStart),
      endFormatted: fmtYemenTime(finalAtcState.scheduledAutoTransitionIso),
      shiftedStartFormatted: fmtYemenTime(currentStart),
      shiftedEndFormatted: fmtYemenTime(finalAtcState.scheduledAutoTransitionIso),
      durationLabel: ‘’, 
      zone: getZoneFromIso(currentStart),
      isEstimated: true,
    });
  }

  Return {
    nextTransition,
    expectedOffDurationLabel: prediction.expectedOffRange
      ? arabicDurationRange(prediction.expectedOffRange.minMin, prediction.expectedOffRange.maxMin)
      : null,
    expectedOnDurationLabel: prediction.expectedOnRange
      ? arabicDurationRange(prediction.expectedOnRange.minMin, prediction.expectedOnRange.maxMin)
      : null,
    Confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    currentState,
    currentStateDurationLabel: durLabel,
    currentStateStartIso,
    daySchedule: finalDaySchedule, //  تم التعديل هنا فقط لربط الفترة الوهمية
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode ?? ‘prior_only’,
    computedAt: prediction.computedAt ?? null,
    offsetMinutes,
    crisisMode: prediction.apppe?.crisisMode ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    isResynced: hasResync,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    atc: finalAtcState,
    isHoldingState: isHolding,
    reconciledCycleStartIso,
    communitySyncMeta: communitySyncMeta
      ?? (resyncPoint ? {
          reporterName: resyncPoint.reporterName ?? null,
          reporterReliability: resyncPoint.reporterReliability ?? null,
          syncedAtIso: resyncPoint.syncedAtIso,
          syncedState: resyncPoint.syncedState,
        } : null),
  };

  
}

// ── Hook ──────────────────────────────────────────────────────────────────────
Export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  transitionMode: TransitionMode = ‘AUTO’,
  heldCycleStartIso?: string | null,
) {
  Const [rawPrediction, setRawPrediction] = useState<Prediction | null>(null);
  Const [loading, setLoading] = useState(true);

  Const stableStartRef = useRef<{ state: ‘ON’ | ‘OFF’; startIso: string | null } | null>(null);
  // Track the last reconciled start separately so re-renders don’t clobber it
  Const reconciledStartRef = useRef<{ state: ‘ON’ | ‘OFF’; startIso: string } | null>(null);
  Const prevOffsetRef = useRef<number>(offsetMinutes);

  Const fetchPrediction = () => {
    Supabase
      .from(‘utility_predictions’)
      .select(‘*’)
      .eq(‘id’, 1)
      .maybeSingle()
      .then(({ data, error }) => {
        If (error) console.error(‘[useUserPredictions] fetch error:’, error.message);
        If (data?.prediction) setRawPrediction(data.prediction as Prediction);
        setLoading(false);
      });
  };

  useEffect(() => {
    let cancelled = false;

    supabase
      .from(‘utility_predictions’)
      .select(‘*’)
      .eq(‘id’, 1)
      .maybeSingle()
      .then(({ data, error }) => {
        If (cancelled) return;
        If (error) console.error(‘[useUserPredictions] fetch error:’, error.message);
        If (data?.prediction) setRawPrediction(data.prediction as Prediction);
        setLoading(false);
      });

    Const timeout = setTimeout(() => {
      If (cancelled) return;
      setLoading(false);
    }, 8000);

    Const { AppState } = require(‘react-native’) as typeof import(‘react-native’);
    Const handleAppState = (nextState: string) => {
      If (nextState === ‘active’) fetchPrediction();
    };
    Const appStateSub = AppState.addEventListener(‘change’, handleAppState);

    Const channel = supabase
      .channel(`user_predictions_live_${Math.random().toString(36).slice(2)}`)
      .on(‘postgres_changes’, {
        Event: ‘*’,
        Schema: ‘public’,
        Table: ‘utility_predictions’,
      }, (payload) => {
        Const row = payload.new as any;
        If (row?.prediction) setRawPrediction(row.prediction as Prediction);
      })
      .subscribe();

    Return () => {
      Cancelled = true;
      clearTimeout(timeout);
      appStateSub.remove();
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (prevOffsetRef.current !== offsetMinutes) {
      prevOffsetRef.current       = offsetMinutes;
      stableStartRef.current      = null;
      reconciledStartRef.current  = null;
      fetchPrediction();
    }
  }, [offsetMinutes]);

  Const userPrediction: UserPrediction | null = rawPrediction
    ?
(() => {
        Const pred = applyOffsetToPrediction(
          rawPrediction, offsetMinutes, resyncPoint, null, transitionMode, stableStartRef.current?.startIso ?? heldCycleStartIso ?? null,
        );

        // ── Stabilize currentStateStartIso ────────────────────────────────────
        //
        // Priority order (highest first):
        //
        // 1. reconciledCycleStartIso just computed this render
        //    → Store in reconciledStartRef (keyed by new state) AND stableStartRef.
        //    → This is the backdated start (e.g. 11:00 for -60 offset) and MUST
        //      survive subsequent re-renders where reconciledCycleStartIso = null.
        //
        // 2. reconciledStartRef holds a reconciled start for the CURRENT state
        //    → Re-use it. This prevents re-renders from resetting to stale starts.
        //
        // 3. stableStartRef holds the same state → re-use (no-jitter on re-renders).
        //
        // 4. State flipped or first render → adopt computed startIso, clear refs.
        //
        If (pred.reconciledCycleStartIso) {
          // Fresh reconciliation this render — persist for subsequent renders
          reconciledStartRef.current = { state: pred.currentState, startIso: pred.reconciledCycleStartIso };
          stableStartRef.current     = { state: pred.currentState, startIso: pred.reconciledCycleStartIso };
          pred.currentStateStartIso  = pred.reconciledCycleStartIso;
        } else if (
          reconciledStartRef.current &&
          reconciledStartRef.current.state === pred.currentState
        ) {
          // Re-render after reconciliation — keep the backdated start alive
          Pred.currentStateStartIso  = reconciledStartRef.current.startIso;
          Pred.reconciledCycleStartIso = reconciledStartRef.current.startIso;
          stableStartRef.current     = reconciledStartRef.current;
        } else if (
          stableStartRef.current &&
          stableStartRef.current.state === pred.currentState
        ) {
          // Same state, no reconciliation — reuse stable anchor
          Pred.currentStateStartIso = stableStartRef.current.startIso;
        } else {
          // State changed or first render
          reconciledStartRef.current = null;
          stableStartRef.current     = { state: pred.currentState, startIso: pred.currentStateStartIso };
        }

        Pred.currentStateDurationLabel = elapsedLabel(pred.currentStateStartIso);

        Return pred;
      })()
    : null;

  Return { userPrediction, rawPrediction, loading };
}
