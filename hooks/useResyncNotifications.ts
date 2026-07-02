import { useEffect, useState, useCallback } from 'react';
import { getSupabaseClient } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export function useResyncNotifications() {
  const { session } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);

  const fetchPending = useCallback(async () => {
    if (!session?.user) return;
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    // Get all non-expired notifications for this user
    const { data: notifications, error } = await supabase
      .from('resync_notifications')
      .select('id')
      .eq('recipient_id', session.user.id)
      .gt('expires_at', now);

    if (error || !notifications?.length) {
      setPendingCount(0);
      return;
    }

    const notifIds = notifications.map((n: { id: number }) => n.id);

    // Find which ones already have a response
    const { data: responses } = await supabase
      .from('resync_responses')
      .select('notification_id')
      .in('notification_id', notifIds)
      .eq('responder_id', session.user.id);

    const respondedIds = new Set((responses ?? []).map((r: { notification_id: number }) => r.notification_id));
    const pending = notifIds.filter(id => !respondedIds.has(id)).length;
    setPendingCount(pending);
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user) {
      setPendingCount(0);
      return;
    }

    fetchPending();

    const supabase = getSupabaseClient();
    const channel = supabase
      .channel('resync-notif-count')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'resync_notifications',
          filter: `recipient_id=eq.${session.user.id}`,
        },
        () => fetchPending(),
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'resync_responses',
        },
        () => fetchPending(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id, fetchPending]);

  return { pendingCount };
}
