import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export interface PinnedTiming {
  id: number;
  user_id: string;
  pin_type: 'self' | 'user';
  pinned_user_id: string | null;
  updated_at: string;
}

export function usePinnedTiming() {
  const { user } = useAuth();
  const [pinned, setPinned] = useState<PinnedTiming | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    const { data, error } = await supabase
      .from('pinned_timings')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) console.error('[usePinnedTiming] error:', error.message);
    setPinned(data as PinnedTiming | null);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetch(); }, [fetch]);

  const pinSelf = useCallback(async () => {
    if (!user) return;
    await supabase
      .from('pinned_timings')
      .upsert({ user_id: user.id, pin_type: 'self', pinned_user_id: null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    await fetch();
  }, [user, fetch]);

  const pinUser = useCallback(async (pinnedUserId: string) => {
    if (!user) return;
    await supabase
      .from('pinned_timings')
      .upsert({ user_id: user.id, pin_type: 'user', pinned_user_id: pinnedUserId, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    await fetch();
  }, [user, fetch]);

  return { pinned, loading, pinSelf, pinUser, refresh: fetch };
}
