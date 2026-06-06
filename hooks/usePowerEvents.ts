import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface PowerEvent {
  id: number;
  event_type: 'UTILITY_ON' | 'UTILITY_OFF';
  occurred_at: string;
  vac: number | null;
  pac_to_user: number | null;
  status_text: string | null;
  created_at: string;
}

export function usePowerEvents(limit = 50) {
  const [events, setEvents] = useState<PowerEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    // Safety timeout — never hang indefinitely
    const timeout = setTimeout(() => { setLoading(false); }, 8000);
    try {
      const { data, error } = await supabase
        .from('power_events')
        .select('*')
        .order('occurred_at', { ascending: false })
        .limit(limit);
      if (error) {
        console.error('[usePowerEvents] fetch error:', error.message, error.code);
      } else {
        setEvents((data as PowerEvent[]) ?? []);
      }
    } catch (err) {
      console.error('[usePowerEvents] unexpected error:', err);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchEvents();

    const channel = supabase
      .channel(`power_events_live_${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'power_events' },
        (payload) => {
          console.log('[usePowerEvents] new event:', payload.new);
          setEvents((prev) => [payload.new as PowerEvent, ...prev]);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'power_events' },
        (payload) => {
          console.log('[usePowerEvents] updated event:', payload.new);
          setEvents((prev) => prev.map(e => e.id === (payload.new as PowerEvent).id ? payload.new as PowerEvent : e));
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'power_events' },
        (payload) => {
          console.log('[usePowerEvents] deleted event:', payload.old);
          setEvents((prev) => prev.filter(e => e.id !== (payload.old as any).id));
        }
      )
      .subscribe((status) => {
        console.log('[usePowerEvents] channel status:', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [limit, fetchEvents]);

  return { events, loading, refetch: fetchEvents };
}
