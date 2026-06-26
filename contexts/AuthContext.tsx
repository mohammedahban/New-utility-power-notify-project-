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

  // Tracks the UID we currently expect a profile for. Prevents race
  // conditions where a stale fetch (e.g. from a previous user) overwrites
  // the profile of the current user.
  const currentUidRef = useRef<string | null>(null);

  const fetchProfile = async (uid: string) => {
    currentUidRef.current = uid;
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', uid)
        .single();
      if (error) {
        console.error('[Auth] fetchProfile error:', error.message);
        return;
      }
      // Only commit the profile if this user is still the current one.
      if (currentUidRef.current === uid) {
        setProfile(data as UserProfile);
      }
    } catch (e) {
      console.error('[Auth] fetchProfile exception:', e);
    }
  };

  useEffect(() => {
    let mounted = true;
    let loadingCleared = false;

    const clearLoading = () => {
      if (!mounted || loadingCleared) return;
      loadingCleared = true;
      setLoading(false);
    };

    // Apply a session (or null) to React state and fetch the profile.
    const applySession = async (s: Session | null) => {
      if (!mounted) return;
      if (s?.user) {
        setSession(s);
        setUser(s.user);
        await fetchProfile(s.user.id);
      } else {
        currentUidRef.current = null;
        setSession(null);
        setUser(null);
        setProfile(null);
      }
    };

    // ─────────────────────────────────────────────────────────────────────
    //  Cold-start session recovery
    // ─────────────────────────────────────────────────────────────────────
    //  This is the fix for the "redirected to login after long close" bug.
    //
    //  Old behaviour: getSession() → if no user, wait 2 s then give up and
    //  show /login. If the refresh token was still valid but the access
    //  token had expired, the user was wrongly sent to /login and had to
    //  kill & reopen the app.
    //
    //  New behaviour:
    //    1. Call getSession().
    //    2. If we have a session whose access token is expired (or about to
    //       expire), explicitly call refreshSession() to recover via the
    //       refresh token.
    //    3. Only clear `loading` (which unlocks navigation to /login) once
    //       we are certain there is no recoverable session.
    // ─────────────────────────────────────────────────────────────────────
    const initialize = async () => {
      try {
        // Ensure background auto-refresh is running from the very first
        // render (the original code only started it on AppState changes,
        // so on a true cold start it was never started until the user
        // backgrounded & foregrounded the app).
        supabase.auth.startAutoRefresh();

        const { data: { session: s }, error } = await supabase.auth.getSession();
        if (!mounted) return;
        if (error) throw error;

        if (s?.user) {
          // Check whether the access token is expired (or about to expire).
          // expires_at is a Unix timestamp in seconds.
          const expiresAt = s.expires_at ?? 0;
          const nowSec = Math.floor(Date.now() / 1000);
          const needsRefresh = expiresAt - nowSec < 60; // 60-second buffer

          if (needsRefresh) {
            const { data: rd, error: re } = await supabase.auth.refreshSession();
            if (!mounted) return;
            if (re || !rd.session) {
              // The refresh token is also invalid → user is truly logged out.
              console.warn('[Auth] refreshSession failed on init:', re?.message);
              await supabase.auth.signOut({ scope: 'local' });
              await applySession(null);
              clearLoading();
              return;
            }
            await applySession(rd.session);
            clearLoading();
            return;
          }

          // Access token is still valid — use the session as-is.
          await applySession(s);
          clearLoading();
          return;
        }

        // No session in storage. Give onAuthStateChange's INITIAL_SESSION
        // event a short window to deliver a recovered session before we
        // conclude the user is logged out.
        setTimeout(clearLoading, 1500);
      } catch (e: any) {
        console.warn('[Auth] init error:', e?.message ?? e);
        setTimeout(clearLoading, 1500);
      }
    };

    initialize();

    // ─────────────────────────────────────────────────────────────────────
    //  Real-time auth state changes
    // ─────────────────────────────────────────────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      if (!mounted) return;

      switch (event) {
        case 'INITIAL_SESSION':
          // Fires once on subscription with whatever is in storage.
          // If initialize() hasn't finished yet and we get a session here,
          // accept it immediately so the user doesn't get sent to /login.
          if (s?.user) {
            setSession(prev => prev ?? s);
            setUser(prev => prev ?? s.user);
            if (currentUidRef.current !== s.user.id) {
              await fetchProfile(s.user.id);
            }
            clearLoading();
          }
          // If s is null, let initialize()'s timeout handle clearing.
          break;

        case 'TOKEN_REFRESHED':
          // Token was refreshed (by auto-refresh or manually). Update the
          // session and re-fetch the profile (role may have changed).
          if (s?.user) {
            setSession(s);
            setUser(s.user);
            await fetchProfile(s.user.id);
          }
          clearLoading();
          break;

        case 'SIGNED_IN':
          if (s?.user) {
            await applySession(s);
          }
          clearLoading();
          break;

        case 'SIGNED_OUT':
          await applySession(null);
          clearLoading();
          break;
      }
    });

    // Safety fallback: unblock the UI after 8 s no matter what, so the
    // user is never stuck on the loading splash forever (e.g. if the
    // network is completely unreachable on cold start).
    const fallbackTimer = setTimeout(clearLoading, 8000);

    // Start/stop auto-refresh based on app visibility.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    });

    return () => {
      mounted = false;
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
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('[Auth] signOut error:', e);
    }
    currentUidRef.current = null;
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
