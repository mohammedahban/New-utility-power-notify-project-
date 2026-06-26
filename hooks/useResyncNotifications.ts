import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

/**
 * Subscribes to resync_notifications for the current user and exposes
 * a live count of un-responded (pending) notifications.
 *
 * Used by the community tab badge in app/(user)/_layout.tsx.
 */
export function useResyncNotifications() {
  const { user } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const mountedRef = useRef(true);

  const fetchPending = async (uid: string) => {
    try {
      // A notification is "pending" if:
      //   • recipient_id = current user
      //   • no matching row in resync_responses (responder_id = current user, notification_id = id)
      //   • not yet expired
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('resync_notifications')
        .select('id')
        .eq('recipient_id', uid)
        .gt('expires_at', now);

      if (error || !data) return;
      if (!mountedRef.current) return;

      // Filter out those the user has already responded to.
      if (data.length === 0) {
        setPendingCount(0);
        return;
      }

      const notifIds = data.map((r) => r.id);
      const { data: responses } = await supabase
        .from('resync_responses')
        .select('notification_id')
        .eq('responder_id', uid)
        .in('notification_id', notifIds);

      if (!mountedRef.current) return;

      const respondedIds = new Set((responses ?? []).map((r: any) => r.notification_id));
      const unresponded = notifIds.filter((id) => !respondedIds.has(id));
      setPendingCount(unresponded.length);
    } catch (e) {
      console.warn('[useResyncNotifications] fetch error:', e);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    if (!user?.id) {
      setPendingCount(0);
      return;
    }

    const uid = user.id;
    fetchPending(uid);

    // Real-time subscription on resync_notifications for this user.
    const channel = supabase
      .channel(`resync_notifs_${uid}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'resync_notifications',
          filter: `recipient_id=eq.${uid}`,
        },
        () => {
          if (mountedRef.current) fetchPending(uid);
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'resync_responses',
          filter: `responder_id=eq.${uid}`,
        },
        () => {
          if (mountedRef.current) fetchPending(uid);
        }
      )
      .subscribe();

    return () => {
      mountedRef.current = false;
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  return { pendingCount };
}
