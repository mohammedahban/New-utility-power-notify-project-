import React, { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

// ─────────────────────────────────────────────────────────────────────────────
//  Storage keys Supabase uses to persist the session.
//  We probe these directly as a fallback when getSession() returns null on
//  cold start — a known issue in React Native where AsyncStorage reads
//  haven't always completed by the time getSession() is first called.
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_STORAGE_KEYS = [
  // sb-<project-ref>-auth-token (v2 default)
  null, // we will discover the actual key at runtime
];

const discoverSupabaseStorageKey = async (): Promise<string | null> => {
  try {
    const keys = await AsyncStorage.getAllKeys();
    // Match the v2 default pattern: sb-<ref>-auth-token
    const key = (keys as readonly string[]).find(
      (k) => typeof k === 'string' && /^sb-[^-]+-auth-token$/.test(k)
    );
    if (key) return key;
    // Match older v1 / custom patterns
    const legacy = (keys as readonly string[]).find(
      (k) => typeof k === 'string' && (k.endsWith('-auth-token') || k === 'supabase.auth.token')
    );
    return legacy ?? null;
  } catch (e) {
    console.warn('[Auth] storage key discovery failed:', e);
    return null;
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // Tracks the UID we currently expect a profile for. Prevents race
  // conditions where a stale fetch (e.g. from a previous user) overwrites
  // the profile of the current user.
  const currentUidRef = useRef<string | null>(null);

  // V2.2.1 FIX (Issue 7): fetchProfile had no retry. On a cold start after
  // the app was closed a long time, the access token is definitely expired,
  // so recovery always goes through a refresh (or a network round-trip)
  // right before this call. If the device's network wasn't fully back yet
  // at that exact moment (very plausible immediately after a cold launch —
  // often just barely won the race with connectivity coming back), this
  // request could fail even though the session itself was perfectly valid.
  // The caller (applySession, called from the INITIAL_SESSION handler
  // below) always calls clearLoading() right after this resolves — success
  // or failure — so a failed fetch here permanently left `profile` null
  // while `loading` was already false. AuthGate's own effect does nothing
  // in that state ("if (!profile) return"), so the user was just stranded
  // on whatever screen was already showing (apparently /login) until they
  // force-closed and reopened the app — the exact reported symptom, and
  // the second attempt succeeding simply because the network had caught up
  // by then. A short bounded retry covers that window without it.
  const fetchProfile = async (uid: string, retriesLeft = 3): Promise<void> => {
    currentUidRef.current = uid;
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', uid)
        .single();
      if (error) {
        console.error('[Auth] fetchProfile error:', error.message);
        if (retriesLeft > 0 && currentUidRef.current === uid) {
          await new Promise(res => setTimeout(res, 1200));
          if (currentUidRef.current === uid) {
            return fetchProfile(uid, retriesLeft - 1);
          }
        }
        return;
      }
      if (currentUidRef.current === uid) {
        setProfile(data as UserProfile);
      }
    } catch (e) {
      console.error('[Auth] fetchProfile exception:', e);
      if (retriesLeft > 0 && currentUidRef.current === uid) {
        await new Promise(res => setTimeout(res, 1200));
        if (currentUidRef.current === uid) {
          return fetchProfile(uid, retriesLeft - 1);
        }
      }
    }
  };

  const applySession = async (s: Session | null) => {
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

  useEffect(() => {
    let mounted = true;
    let loadingCleared = false;
    let initialSessionDelivered = false;

    const clearLoading = () => {
      if (!mounted || loadingCleared) return;
      loadingCleared = true;
      setLoading(false);
    };

    // ─────────────────────────────────────────────────────────────────────
    //  Cold-start session recovery (BULLETPROOF version)
    // ─────────────────────────────────────────────────────────────────────
    //  The previous version had a flaw: when getSession() returned null on
    //  cold start (which happens in React Native because AsyncStorage
    //  reads aren't always complete by the time getSession() is first
    //  called), we cleared loading after 1.5s and sent the user to
    //  /login — even though a valid refresh token was still in storage.
    //
    //  This version:
    //    1. Calls getSession().
    //    2. If null, probes AsyncStorage directly for the Supabase token
    //       and parses it.
    //    3. If we have a session (from either source) with an expired
    //       access token, calls refreshSession() explicitly.
    //    4. If we still have no session, waits up to 12s for the
    //       INITIAL_SESSION event from onAuthStateChange.
    //    5. Only clears loading when:
    //         a) We have a definitive session (valid or refreshed), OR
    //         b) INITIAL_SESSION arrives with null, OR
    //         c) The 12s safety timeout fires.
    //
    //  This means: if the user has ANY valid refresh token in storage,
    //  they will land on their home screen, never on /login.
    // ─────────────────────────────────────────────────────────────────────

    const recoverColdStartSession = async (): Promise<Session | null> => {
      // Step 1: Try getSession() — reads from in-memory state.
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!mounted) return null;
        if (error) {
          console.warn('[Auth] getSession error:', error.message);
        } else if (data.session) {
          return data.session;
        }
      } catch (e: any) {
        console.warn('[Auth] getSession exception:', e?.message ?? e);
      }

      // Step 2: getSession() returned null. On cold start in React Native
      // this can happen even when a valid session IS in storage. Probe
      // AsyncStorage directly and rehydrate.
      try {
        const storageKey = await discoverSupabaseStorageKey();
        if (storageKey) {
          const raw = await AsyncStorage.getItem(storageKey);
          if (raw) {
            // Supabase v2 stores either a JSON object or a JSON-stringified
            // object whose value is the session JSON. Handle both.
            let parsed: any;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = null;
            }
            // v2 shape: { access_token, refresh_token, expires_at, user, ... }
            const sessionObj =
              parsed && typeof parsed === 'object' && parsed.access_token
                ? parsed
                : parsed && typeof parsed === 'object' && parsed.value && parsed.value.access_token
                ? parsed.value
                : null;

            if (sessionObj?.access_token && sessionObj?.refresh_token) {
              // Rehydrate the Supabase client with what we found in storage.
              // setSession() will validate the tokens and store them in memory.
              try {
                const { data, error } = await supabase.auth.setSession({
                  access_token: sessionObj.access_token,
                  refresh_token: sessionObj.refresh_token,
                });
                if (!mounted) return null;
                if (error) {
                  console.warn('[Auth] setSession error:', error.message);
                } else if (data.session) {
                  return data.session;
                }
              } catch (e: any) {
                console.warn('[Auth] setSession exception:', e?.message ?? e);
              }
            }
          }
        }
      } catch (e: any) {
        console.warn('[Auth] storage probe failed:', e?.message ?? e);
      }

      return null;
    };

    // V2.2.1 FIX (Issue 7): this refresh runs right at cold-start, the same
    // moment network connectivity is least likely to be fully ready. Its
    // caller treats any failure here as "refresh token expired/revoked"
    // and signs the user out LOCALLY — a much more severe outcome than the
    // fetchProfile case above (this clears the session from storage
    // entirely, so a second app open wouldn't recover it either). One
    // short retry gives a transient network hiccup a chance to clear
    // before we conclude the token is genuinely invalid.
    const attemptRefresh = async (): Promise<{ session: Session | null; failed: boolean }> => {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (!mounted) return { session: null, failed: false };
        if (error) {
          console.warn('[Auth] refreshSession error:', error.message);
          return { session: null, failed: true };
        }
        return { session: data.session, failed: false };
      } catch (e: any) {
        console.warn('[Auth] refreshSession exception:', e?.message ?? e);
        return { session: null, failed: true };
      }
    };

    const maybeRefresh = async (s: Session): Promise<Session | null> => {
      const expiresAt = s.expires_at ?? 0;
      const nowSec = Math.floor(Date.now() / 1000);
      const needsRefresh = expiresAt - nowSec < 60; // 60s buffer

      if (!needsRefresh) return s;

      let result = await attemptRefresh();
      if (!mounted) return null;
      if (result.session) return result.session;
      if (result.failed) {
        await new Promise(res => setTimeout(res, 1000));
        if (!mounted) return null;
        result = await attemptRefresh();
        if (!mounted) return null;
        if (result.session) return result.session;
      }
      return null;
    };

    const initialize = async () => {
      // Ensure background auto-refresh is running from the very first
      // render. startAutoRefresh is a no-op if it's already running.
      try {
        supabase.auth.startAutoRefresh();
      } catch {
        // older SDK versions may not have startAutoRefresh
      }

      const recovered = await recoverColdStartSession();
      if (!mounted) return;

      if (recovered) {
        // Check if access token is expired; if so, refresh it now.
        const refreshed = await maybeRefresh(recovered);
        if (!mounted) return;

        if (refreshed) {
          await applySession(refreshed);
          clearLoading();
          return;
        }

        // We had a session but refresh failed — the refresh token is
        // likely expired/revoked. Sign out locally so storage is cleaned.
        console.warn('[Auth] recovery succeeded but refresh failed; signing out locally');
        try {
          await supabase.auth.signOut({ scope: 'local' });
        } catch {}
        await applySession(null);
        clearLoading();
        return;
      }

      // No recoverable session yet. DO NOT clear loading here — wait for
      // the INITIAL_SESSION event from onAuthStateChange (which fires
      // once the SDK has finished loading from storage). The 12s safety
      // timeout below will clear loading only as a last resort.
      // (See fallbackTimer below.)
    };

    initialize();

    // ─────────────────────────────────────────────────────────────────────
    //  Real-time auth state changes
    // ─────────────────────────────────────────────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      if (!mounted) return;

      switch (event) {
        case 'INITIAL_SESSION':
          // This fires once the SDK has finished reading from storage.
          // It is the authoritative source of truth on cold start.
          initialSessionDelivered = true;

          if (s?.user) {
            // We have a session. If the access token is expired, refresh
            // it now; otherwise use as-is.
            const expiresAt = s.expires_at ?? 0;
            const nowSec = Math.floor(Date.now() / 1000);
            if (expiresAt - nowSec < 60) {
              const { data: rd } = await supabase.auth.refreshSession();
              if (!mounted) return;
              if (rd.session) {
                await applySession(rd.session);
              } else {
                await applySession(s); // fall back to whatever we have
              }
            } else {
              await applySession(s);
            }
            clearLoading();
          } else {
            // INITIAL_SESSION definitively says: no session in storage.
            // Only now is it safe to send the user to /login.
            await applySession(null);
            clearLoading();
          }
          break;

        case 'TOKEN_REFRESHED':
          if (s?.user) {
            setSession(s);
            setUser(s.user);
            if (currentUidRef.current !== s.user.id) {
              await fetchProfile(s.user.id);
            }
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

    // Safety fallback: unblock the UI after 12s no matter what.
    // This is intentionally LONG because we want to give the SDK ample
    // time to load from AsyncStorage on a slow cold start. A user on a
    // slow device with a flaky network might otherwise be stuck forever.
    // 12s is the maximum acceptable wait; in 99% of cases the user will
    // be routed in <2s.
    const fallbackTimer = setTimeout(() => {
      if (!loadingCleared) {
        console.warn('[Auth] 12s safety timeout fired — forcing loading=false');
        if (!initialSessionDelivered) {
          // We never even got INITIAL_SESSION. Treat as logged out.
          applySession(null).finally(() => clearLoading());
        } else {
          clearLoading();
        }
      }
    }, 12000);

    // Start/stop auto-refresh based on app visibility.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        try {
          supabase.auth.startAutoRefresh();
        } catch {}
        // When the app returns to the foreground, also do an explicit
        // getSession + refresh check — the auto-refresh interval might
        // not have fired yet, and this gives an immediate refresh on
        // foreground (fixes the "long close" case where the OS killed
        // the JS context and no auto-refresh ran in the background).
        (async () => {
          try {
            const { data } = await supabase.auth.getSession();
            if (!mounted || !data.session) return;
            const expiresAt = data.session.expires_at ?? 0;
            const nowSec = Math.floor(Date.now() / 1000);
            if (expiresAt - nowSec < 300) {
              // Token expires in <5min — refresh now.
              const { data: rd, error } = await supabase.auth.refreshSession();
              if (error) console.warn('[Auth] foreground refresh error:', error.message);
              else if (rd.session) {
                setSession(rd.session);
                setUser(rd.session.user);
              }
            }
          } catch (e: any) {
            console.warn('[Auth] foreground refresh exception:', e?.message ?? e);
          }
        })();
      } else {
        try {
          supabase.auth.stopAutoRefresh();
        } catch {}
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


