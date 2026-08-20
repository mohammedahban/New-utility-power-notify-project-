import React, { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { serverNowMs } from '../lib/serverTime';

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

// ─────────────────────────────────────────────────────────────────────────────
//  Transient-network vs definitive-auth error discrimination.
//  A failed token refresh has two VERY different meanings:
//    • AuthRetryableFetchError / AuthUnknownError / no HTTP status / 5xx →
//      the network (or server) is unreachable — the stored session is still
//      legitimate and must be KEPT so an offline cold start never kicks the
//      user to /login.
//    • AuthApiError 400/401 ("Invalid Refresh Token") → the session is truly
//      dead — only then do we sign out locally.
// ─────────────────────────────────────────────────────────────────────────────
const isTransientNetworkError = (e: any): boolean => {
  if (!e) return false;
  const name = typeof e?.name === 'string' ? e.name : '';
  const msg = String(e?.message ?? e ?? '');
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (name === 'AuthRetryableFetchError' || name === 'AuthUnknownError') return true;
  if (status !== undefined && status >= 500) return true;
  if (status === 0 || status === undefined) {
    return /fetch|network|timeout|timed?\s?out|abort|unreachable/i.test(msg);
  }
  return false;
};

// Profile cache — lets role-based routing work on an offline cold start.
const PROFILE_CACHE_PREFIX = 'tmms_profile_cache_';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // Tracks the UID we currently expect a profile for. Prevents race
  // conditions where a stale fetch (e.g. from a previous user) overwrites
  // the profile of the current user.
  const currentUidRef = useRef<string | null>(null);

  // Retry loop for sessions that were applied OFFLINE (stored session whose
  // access token could not be refreshed because there was no connectivity).
  // Ticks until the refresh succeeds (internet back) or definitively fails
  // (refresh token revoked → real sign-out).
  const refreshRetryRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchProfile = async (uid: string) => {
    currentUidRef.current = uid;
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', uid)
        .single();
      if (error) throw error;
      if (currentUidRef.current === uid) {
        setProfile(data as UserProfile);
        try { await AsyncStorage.setItem(PROFILE_CACHE_PREFIX + uid, JSON.stringify(data)); } catch {}
      }
    } catch (e: any) {
      // Offline / transient failure — fall back to the cached profile so the
      // user is routed to their home screen even with no connectivity.
      console.warn('[Auth] fetchProfile failed, trying cache:', e?.message ?? e);
      try {
        const cached = await AsyncStorage.getItem(PROFILE_CACHE_PREFIX + uid);
        if (cached && currentUidRef.current === uid) {
          setProfile(JSON.parse(cached) as UserProfile);
        }
      } catch {}
    }
  };

  const applySession = async (s: Session | null) => {
    if (s?.user) {
      setSession(s);
      setUser(s.user);
      await fetchProfile(s.user.id);
    } else {
      const prevUid = currentUidRef.current;
      currentUidRef.current = null;
      setSession(null);
      setUser(null);
      setProfile(null);
      if (prevUid) {
        try { await AsyncStorage.removeItem(PROFILE_CACHE_PREFIX + prevUid); } catch {}
      }
    }
  };

  useEffect(() => {
    let mounted = true;
    let loadingCleared = false;
    let initialSessionDelivered = false;
    // Offline-cold-start state: a stored session JSON that could NOT be
    // rehydrated because the network is down (transient), plus a flag marking
    // that the failure was indeed transient (not a revoked refresh token).
    let storedSessionCandidate: Session | null = null;
    let sawTransientFailure = false;

    const clearLoading = () => {
      if (!mounted || loadingCleared) return;
      loadingCleared = true;
      setLoading(false);
    };

    const stopRefreshRetry = () => {
      if (refreshRetryRef.current) {
        clearInterval(refreshRetryRef.current);
        refreshRetryRef.current = null;
      }
    };

    // While a session is applied from storage WITHOUT a successful refresh
    // (offline), keep retrying every 30s. Success → the app is fully online
    // again with zero user action; definitive 400/401 → the session is truly
    // dead → sign out locally (same as before).
    const startRefreshRetry = () => {
      if (refreshRetryRef.current) return;
      refreshRetryRef.current = setInterval(async () => {
        if (!mounted) return;
        try {
          const { data, error } = await supabase.auth.refreshSession();
          if (!mounted) return;
          if (data.session) {
            stopRefreshRetry();
            await applySession(data.session);
          } else if (error && !isTransientNetworkError(error)) {
            stopRefreshRetry();
            try { await supabase.auth.signOut({ scope: 'local' }); } catch {}
            await applySession(null);
          }
          // transient error → keep the stored session, retry on next tick
        } catch { /* transient throw — keep retrying */ }
      }, 30000);
    };

    const isNearExpiry = (s: Session): boolean => {
      const expiresAt = s.expires_at ?? 0;
      const nowSec = Math.floor(serverNowMs() / 1000);
      return expiresAt - nowSec < 60;
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
                  // Offline? Keep the stored JSON as a candidate so the
                  // caller can apply it as-is instead of dropping to /login.
                  if (isTransientNetworkError(error)) {
                    storedSessionCandidate = sessionObj as Session;
                    sawTransientFailure = true;
                  }
                } else if (data.session) {
                  return data.session;
                }
              } catch (e: any) {
                console.warn('[Auth] setSession exception:', e?.message ?? e);
                if (isTransientNetworkError(e)) {
                  storedSessionCandidate = sessionObj as Session;
                  sawTransientFailure = true;
                }
              }
            }
          }
        }
      } catch (e: any) {
        console.warn('[Auth] storage probe failed:', e?.message ?? e);
      }

      return null;
    };

    const maybeRefresh = async (s: Session): Promise<Session | null> => {
      if (!isNearExpiry(s)) return s;

      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (!mounted) return null;
        if (error) {
          console.warn('[Auth] refreshSession error:', error.message);
          // Transient network failure → KEEP the stored session (offline
          // cold start). Only a definitive 400/401 means "truly signed out".
          if (isTransientNetworkError(error)) return s;
          return null;
        }
        return data.session;
      } catch (e: any) {
        console.warn('[Auth] refreshSession exception:', e?.message ?? e);
        if (isTransientNetworkError(e)) return s;
        return null;
      }
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
          // Session applied but still (near-)expired = the refresh was blocked
          // by the network — keep retrying until connectivity returns.
          if (isNearExpiry(refreshed)) startRefreshRetry();
          clearLoading();
          return;
        }

        // We had a session but refresh failed DEFINITIVELY (400/401) — the
        // refresh token is expired/revoked. Sign out locally so storage is
        // cleaned. (Network failures never reach this branch anymore.)
        console.warn('[Auth] recovery succeeded but refresh failed definitively; signing out locally');
        try {
          await supabase.auth.signOut({ scope: 'local' });
        } catch {}
        await applySession(null);
        clearLoading();
        return;
      }

      // OFFLINE COLD START: a stored session exists but every rehydration
      // attempt failed on the network. Apply the stored session as-is so the
      // user lands on their home screen — never on /login — and start the
      // retry loop so the session recovers by itself once internet returns.
      if (storedSessionCandidate && sawTransientFailure) {
        console.warn('[Auth] offline cold start — applying stored session without refresh');
        await applySession(storedSessionCandidate);
        startRefreshRetry();
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
            if (isNearExpiry(s)) {
              const { data: rd, error: refreshErr } = await supabase.auth.refreshSession();
              if (!mounted) return;
              if (rd.session) {
                stopRefreshRetry();
                await applySession(rd.session);
              } else {
                // Refresh blocked — if it's the network (offline), keep the
                // stored session and retry in the background instead of
                // sending the user to /login.
                await applySession(s); // fall back to whatever we have
                if (isTransientNetworkError(refreshErr)) startRefreshRetry();
              }
            } else {
              await applySession(s);
            }
            clearLoading();
          } else {
            // INITIAL_SESSION says: no session. Before concluding "logged
            // out", honor a stored session whose only failure was the
            // network (offline cold start) — apply it and keep retrying.
            if (storedSessionCandidate && sawTransientFailure) {
              console.warn('[Auth] INITIAL_SESSION null but stored session exists (offline) — keeping user signed in');
              await applySession(storedSessionCandidate);
              startRefreshRetry();
            } else {
              // Definitively no session — only now is it safe to send the
              // user to /login.
              await applySession(null);
            }
            clearLoading();
          }
          break;

        case 'TOKEN_REFRESHED':
          if (s?.user) {
            stopRefreshRetry();
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
            stopRefreshRetry();
            await applySession(s);
          }
          clearLoading();
          break;

        case 'SIGNED_OUT':
          stopRefreshRetry();
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
          // We never even got INITIAL_SESSION. If a stored session exists and
          // the only failure was the network, keep the user signed in;
          // otherwise treat as logged out.
          if (storedSessionCandidate && sawTransientFailure) {
            applySession(storedSessionCandidate).finally(() => { startRefreshRetry(); clearLoading(); });
          } else {
            applySession(null).finally(() => clearLoading());
          }
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
            const nowSec = Math.floor(serverNowMs() / 1000);
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
      stopRefreshRetry();
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
    if (refreshRetryRef.current) {
      clearInterval(refreshRetryRef.current);
      refreshRetryRef.current = null;
    }
    const prevUid = currentUidRef.current;
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('[Auth] signOut error:', e);
    }
    currentUidRef.current = null;
    setProfile(null);
    setUser(null);
    setSession(null);
    if (prevUid) {
      try { await AsyncStorage.removeItem(PROFILE_CACHE_PREFIX + prevUid); } catch {}
    }
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
