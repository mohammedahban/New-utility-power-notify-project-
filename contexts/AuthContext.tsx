import React, { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { AppState } from 'react-native';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface UserProfile {
  id: string;
  email: string;
  username: string | null;
  role: 'admin' | 'user';
  created_at: string;
  updated_at: string;
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, username: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const getSessionReturnedUser = useRef(false);

  const fetchProfile = async (uid: string) => {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', uid)
      .single();
    if (error) {
      console.error('[Auth] fetchProfile error:', error.message);
    } else {
      setProfile(data as UserProfile);
    }
  };

    useEffect(() => {
    let loadingCleared = false;
    const clearLoading = () => {
      if (!loadingCleared) {
        loadingCleared = true;
        setLoading(false);
      }
    };

    // Step 1: get the persisted (and auto-refreshed) session on startup.
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (s?.user) {
        getSessionReturnedUser.current = true;
        setSession(s);
        setUser(s.user);
        await fetchProfile(s.user.id);
        clearLoading();
      } else {
        getSessionReturnedUser.current = false;
        setSession(null);
        setUser(null);
        setProfile(null);
        // Give onAuthStateChange a short window to deliver a refreshed
        // session before we tell the router "user is logged out".
        setTimeout(clearLoading, 2000);
      }
    }).catch(() => {
      getSessionReturnedUser.current = false;
      setTimeout(clearLoading, 2000);
    });

    // Step 2: listen for real-time auth changes after startup.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      if (event === 'INITIAL_SESSION') {
        // If getSession() found nothing, INITIAL_SESSION may be the
        // late-arriving recovered session. Accept it.
        if (!getSessionReturnedUser.current && s?.user) {
          setSession(s);
          setUser(s.user);
          await fetchProfile(s.user.id);
        }
        clearLoading();
        return;
      }

      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        await fetchProfile(s.user.id);
      } else {
        setProfile(null);
      }

      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        clearLoading();
      }
    });

    // Safety fallback: unblock UI after 8 s in case both getSession() and
    // onAuthStateChange are delayed by network issues on cold start.
    const fallbackTimer = setTimeout(clearLoading, 8000);

    // App state for token refresh
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    });

    return () => {
      subscription.unsubscribe();
      appStateSub.remove();
      clearTimeout(fallbackTimer);
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? error.message : null };
  };

  const signUp = async (email: string, password: string, username: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { username } },
    });
    return { error: error ? error.message : null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setUser(null);
    setSession(null);
  };

  const refreshProfile = async () => {
    if (user) await fetchProfile(user.id);
  };

  return (
    <AuthContext.Provider value={{ session, user, profile, loading, signIn, signUp, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
