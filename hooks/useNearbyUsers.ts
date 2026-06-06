import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Prediction } from './usePredictions';
import { applyOffsetToPrediction, UserPrediction } from './useUserPredictions';

export interface NearbyUser {
  user_id: string;
  username: string | null;
  offsetMinutes: number;
  distanceKm: number;
  prediction: UserPrediction | null;
  reliabilityScore: number;
  communityTrustScore: number;
  totalReports: number;
  lastReportAt: string | null;
}

// Haversine formula — returns distance in km
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function useNearbyUsers(myLatitude: number | null, myLongitude: number | null, radiusKm = 0.5) {
  const { user } = useAuth();
  const [nearbyUsers, setNearbyUsers] = useState<NearbyUser[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchNearby = useCallback(async () => {
    if (!myLatitude || !myLongitude || !user) return;
    setLoading(true);

    try {
      // Fetch all user locations
      const { data: locations, error: locErr } = await supabase
        .from('user_locations')
        .select('user_id, latitude, longitude');

      if (locErr || !locations) { setLoading(false); return; }

      // Filter within radius (exclude self)
      const nearbyIds = locations
        .filter((loc) =>
          loc.user_id !== user.id &&
          haversineKm(myLatitude, myLongitude, loc.latitude, loc.longitude) <= radiusKm
        )
        .map((loc) => ({
          user_id: loc.user_id,
          distanceKm: haversineKm(myLatitude, myLongitude, loc.latitude, loc.longitude),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 20);

      if (nearbyIds.length === 0) { setNearbyUsers([]); setLoading(false); return; }

      const ids = nearbyIds.map((n) => n.user_id);

      // Fetch profiles, offsets, admin prediction, reliability scores in parallel
      const [
        { data: profiles },
        { data: offsets },
        { data: predRow },
        { data: reliability },
      ] = await Promise.all([
        supabase.from('user_profiles').select('id, username, email').in('id', ids),
        supabase.from('user_offsets').select('user_id, offset_minutes').in('user_id', ids),
        supabase.from('utility_predictions').select('prediction').eq('id', 1).maybeSingle(),
        supabase.from('user_reliability').select('user_id, reliability_score, community_trust_score, total_reports, last_report_at').in('user_id', ids),
      ]);

      const adminPred = predRow?.prediction as Prediction | null;

      const reliabilityMap: Record<string, any> = {};
      for (const r of reliability ?? []) reliabilityMap[r.user_id] = r;

      const result: NearbyUser[] = nearbyIds.map(({ user_id, distanceKm }) => {
        const profile = profiles?.find((p) => p.id === user_id);
        const offsetRow = offsets?.find((o) => o.user_id === user_id);
        const offsetMinutes = offsetRow?.offset_minutes ?? 0;
        const prediction = adminPred ? applyOffsetToPrediction(adminPred, offsetMinutes) : null;
        const rel = reliabilityMap[user_id];

        // Resolve display name: stored username → email prefix → short ID fallback
        const resolvedUsername =
          profile?.username && profile.username.trim() !== ''
            ? profile.username
            : profile?.email
              ? profile.email.split('@')[0]
              : `User_${user_id.slice(0, 6)}`;

        return {
          user_id,
          username: resolvedUsername,
          offsetMinutes,
          distanceKm,
          prediction,
          reliabilityScore: rel?.reliability_score ?? 50,
          communityTrustScore: rel?.community_trust_score ?? 50,
          totalReports: rel?.total_reports ?? 0,
          lastReportAt: rel?.last_report_at ?? null,
        };
      });

      // Sort: reliability score DESC, then distance ASC
      result.sort((a, b) => {
        const relDiff = b.reliabilityScore - a.reliabilityScore;
        if (Math.abs(relDiff) > 5) return relDiff;
        return a.distanceKm - b.distanceKm;
      });

      setNearbyUsers(result);
    } catch (err) {
      console.error('[useNearbyUsers] error:', err);
    } finally {
      setLoading(false);
    }
  }, [myLatitude, myLongitude, user, radiusKm]);

  useEffect(() => { fetchNearby(); }, [fetchNearby]);

  return { nearbyUsers, loading, refresh: fetchNearby };
}
