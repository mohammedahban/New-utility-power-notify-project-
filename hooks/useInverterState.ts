import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface InverterState {
  vac: number | null;
  pac_to_user: number | null;
  status_text: string | null;
  utility_on: boolean | null;
  last_polled: string | null;
  inverter_offline: boolean;
}

export function useInverterState() {
  const [state, setState] = useState<InverterState | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchState = useCallback(async () => {
    // Safety timeout — never hang indefinitely
    const timeout = setTimeout(() => { setLoading(false); }, 8000);
    try {
      const { data, error } = await supabase
        .from('inverter_state')
        .select('*')
        .eq('id', 1)
        .maybeSingle();
      if (error) {
        console.error('[useInverterState] fetch error:', error.message, error.code);
      } else {
        setState(data as InverterState | null);
      }
    } catch (err) {
      console.error('[useInverterState] unexpected error:', err);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchState();

    const channelName = `inverter_state_live_${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inverter_state' },
        (payload) => {
          console.log('[useInverterState] realtime update');
          setState(payload.new as InverterState);
        }
      )
      .subscribe((status) => {
        console.log('[useInverterState] channel status:', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchState]);

  return { state, loading, refetch: fetchState };
}
