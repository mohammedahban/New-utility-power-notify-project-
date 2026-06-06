import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export interface Follow {
  id: number;
  requester_id: string;
  target_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  updated_at: string;
  // joined profile fields
  requester_username?: string | null;
  target_username?: string | null;
}

export function useFollows() {
  const { user } = useAuth();
  const [following, setFollowing] = useState<Follow[]>([]);   // users I follow (accepted)
  const [followers, setFollowers] = useState<Follow[]>([]);   // users following me (accepted)
  const [pending, setPending] = useState<Follow[]>([]);       // incoming requests to me
  const [outgoing, setOutgoing] = useState<Follow[]>([]);     // requests I sent (pending)
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true);

    const { data, error } = await supabase
      .from('follows')
      .select('*')
      .or(`requester_id.eq.${user.id},target_id.eq.${user.id}`);

    if (error) { console.error('[useFollows] fetch error:', error.message); setLoading(false); return; }

    const rows = (data ?? []) as Follow[];

    // Enrich with usernames
    const ids = [...new Set(rows.flatMap(r => [r.requester_id, r.target_id]).filter(id => id !== user.id))];
    let usernameMap: Record<string, string | null> = {};
    if (ids.length > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, username')
        .in('id', ids);
      for (const p of profiles ?? []) usernameMap[p.id] = p.username;
    }

    const enriched = rows.map(r => ({
      ...r,
      requester_username: usernameMap[r.requester_id] ?? null,
      target_username: usernameMap[r.target_id] ?? null,
    }));

    // Apply email-prefix fallback for any remaining nulls
    for (const row of enriched) {
      if (!row.requester_username) {
        row.requester_username = `User_${row.requester_id.slice(0, 6)}`;
      }
      if (!row.target_username) {
        row.target_username = `User_${row.target_id.slice(0, 6)}`;
      }
    }

    setFollowing(enriched.filter(r => r.requester_id === user.id && r.status === 'accepted'));
    setFollowers(enriched.filter(r => r.target_id === user.id && r.status === 'accepted'));
    setPending(enriched.filter(r => r.target_id === user.id && r.status === 'pending'));
    setOutgoing(enriched.filter(r => r.requester_id === user.id && r.status === 'pending'));

    setLoading(false);
  }, [user]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Real-time listener
  useEffect(() => {
    if (!user) return;
    const ch = supabase.channel(`follows_user_${user.id}_${Math.random()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'follows' }, () => { fetchAll(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user, fetchAll]);

  const sendRequest = useCallback(async (targetId: string): Promise<{ error: string | null }> => {
    if (!user) return { error: 'Not authenticated' };
    const { error } = await supabase
      .from('follows')
      .insert({ requester_id: user.id, target_id: targetId });
    if (error) return { error: error.message };
    await fetchAll();
    return { error: null };
  }, [user, fetchAll]);

  const respondToRequest = useCallback(async (followId: number, accept: boolean): Promise<{ error: string | null }> => {
    if (!user) return { error: 'Not authenticated' };
    const { error } = await supabase
      .from('follows')
      .update({ status: accept ? 'accepted' : 'rejected', updated_at: new Date().toISOString() })
      .eq('id', followId)
      .eq('target_id', user.id);
    if (error) return { error: error.message };
    await fetchAll();
    return { error: null };
  }, [user, fetchAll]);

  const cancelOrUnfollow = useCallback(async (followId: number): Promise<{ error: string | null }> => {
    if (!user) return { error: 'Not authenticated' };
    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('id', followId)
      .or(`requester_id.eq.${user.id},target_id.eq.${user.id}`);
    if (error) return { error: error.message };
    await fetchAll();
    return { error: null };
  }, [user, fetchAll]);

  // Check follow status with a specific user
  const getStatusWith = useCallback((targetId: string): 'none' | 'pending' | 'accepted' | 'incoming' => {
    const sent = outgoing.find(r => r.target_id === targetId);
    if (sent) return 'pending';
    const accepted = following.find(r => r.target_id === targetId);
    if (accepted) return 'accepted';
    const inc = pending.find(r => r.requester_id === targetId);
    if (inc) return 'incoming';
    return 'none';
  }, [following, outgoing, pending]);

  return {
    following, followers, pending, outgoing, loading,
    sendRequest, respondToRequest, cancelOrUnfollow, getStatusWith,
    refresh: fetchAll,
  };
}
