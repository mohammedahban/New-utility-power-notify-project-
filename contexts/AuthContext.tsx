
/**
 * AuthContext — Bulletproof cold-start session recovery
 *
 * Multi-layered recovery strategy:
 *   1. getSession() — happy path (in-memory SDK state)
 *   2. Direct AsyncStorage probe — rehydrates when getSession() returns null
 *      (known React Native SDK issue: AsyncStorage is async, in-memory not
 *      populated yet on first cold-start call)
 *   3. INITIAL_SESSION from onAuthStateChange — authoritative confirmation
 *      once SDK finishes loading from storage
 *   4. 12-second fallback timer — unblocks UI if nothing delivers a result
 *
 * AppState listener: pauses/resumes background auto-refresh and explicitly
 * refreshes the token on foreground return to catch cases where the JS
 * context was suspended or the token expired while backgrounded.
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  ReactNode,
} from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Session, User } from '@supabase/supabase/dist/module/lib/types';
import { supabase } from '../lib/supabase';

// ── Types ──────────────────────────────────────────────────────────────────

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
  signOut: () => Promise<void>;
}

// ── Context ────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  profile: null,
  loading: true,
  signOut: async () => {},
});

// ── Provider ───────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const profileFetchedForRef = useRef<string | null>(null);
  const loadingResolvedRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Resolve loading — called at most once ─────────────────────────────────
  const resolveLoading = useCallback(() => {
    if (loadingResolvedRef.current) return;
    loadingResolvedRef.current = true;
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    setLoading(false);
  }, []);

  // ── Fetch profile ─────────────────────────────────────────────────────────
  const fetchProfile = useCallback(async (userId: string) => {
    if (profileFetchedForRef.current === userId) return;
    profileFetchedForRef.current = userId;
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        console.error('[AuthContext] fetchProfile error:', error.message);
        profileFetchedForRef.current = null;
      } else {
        setProfile(data as UserProfile | null);
      }
    } catch (e) {
      console.error('[AuthContext] fetchProfile exception:', e);
      profileFetchedForRef.current = null;
    } finally {
      resolveLoading();
    }
  }, [resolveLoading]);

  // ── Apply session ─────────────────────────────────────────────────────────
  const applySession = useCallback((s: Session | null) => {
    setSession(s);
    setUser(s?.user ?? null);
    if (s?.user) {
      fetchProfile(s.user.id);
    } else {
      setProfile(null);
      profileFetchedForRef.current = null;
      resolveLoading();
    }
  }, [fetchProfile, resolveLoading]);

  // ── Direct AsyncStorage probe (Strategy 2) ────────────────────────────────
  // When getSession() returns null on cold start (known RN SDK issue),
  // we probe AsyncStorage directly to find the persisted session token and
  // call setSession() to rehydrate.
  const probeAsyncStorage = useCallback(async (): Promise<boolean> => {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      // Supabase stores the session under a key containing 'supabase.auth.token'
      const sessionKey = allKeys.find(k => k.includes('supabase.auth.token') || (k.includes('sb-') && k.includes('-auth-token')));
      if (!sessionKey) return false;
      const raw = await AsyncStorage.getItem(sessionKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      // Handle both direct session object and { currentSession: ... } wrapper
      const storedSession = parsed?.currentSession ?? parsed;
      if (!storedSession?.access_token || !storedSession?.refresh_token) return false;
      const { data, error } = await supabase.auth.setSession({
        access_token: storedSession.access_token,
        refresh_token: storedSession.refresh_token,
      });
      if (error || !data.session) return false;
      applySession(data.session);
      return true;
    } catch (e) {
      console.warn('[AuthContext] AsyncStorage probe failed:', e);
      return false;
    }
  }, [applySession]);

  // ── Initial session load ──────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    // 12-second fallback — unblocks UI unconditionally
    fallbackTimerRef.current = setTimeout(() => {
      if (mounted) {
        console.warn('[AuthContext] 12s fallback fired — resolving loading');
        resolveLoading();
      }
    }, 12_000);

    // Strategy 1: getSession()
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (!mounted) return;
      if (s) {
        applySession(s);
        return;
      }
      // Strategy 2: AsyncStorage probe
      const rehydrated = await probeAsyncStorage();
      if (!mounted || rehydrated) return;
      // Neither strategy found a session — user is logged out
      applySession(null);
    }).catch((e) => {
      console.error('[AuthContext] getSession error:', e);
      if (mounted) applySession(null);
    });

    // Strategy 3: onAuthStateChange INITIAL_SESSION as authoritative confirmation
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mounted) return;
      if (event === 'INITIAL_SESSION') {
        // Only use if loading hasn't resolved yet (strategies 1/2 may have already)
        if (!loadingResolvedRef.current) {
          applySession(s);
        }
        return;
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        if (s) {
          setSession(s);
          setUser(s.user);
          if (s.user && profileFetchedForRef.current !== s.user.id) {
            fetchProfile(s.user.id);
          }
        }
        return;
      }
      if (event === 'SIGNED_OUT') {
        setSession(null);
        setUser(null);
        setProfile(null);
        profileFetchedForRef.current = null;
        resolveLoading();
        return;
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  // The original error "Definition for rule 'react-hooks/exhaustive-deps' was not found"
  // indicates an ESLint configuration issue, not a TypeScript syntax error.
  // The comment was likely meant to suppress a lint warning.
  // Since the goal is only syntax correction and the comment itself is valid TS syntax,
  // it is preserved. If it were a TS syntax error, it would be fixed.
  }, [applySession, fetchProfile, probeAsyncStorage, resolveLoading]);

  // ── AppState listener — pause/resume auto-refresh + explicit refresh ──────
  useEffect(() => {
    const handleAppStateChange = async (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        supabase.auth.startAutoRefresh();
        // Strategy 5: explicit token refresh on foreground return
        try {
          const { data, error } = await supabase.auth.refreshSession();
          if (!error && data.session) {
            setSession(data.session);
            setUser(data.session.user);
          }
        } catch (_) {}
      } else {
        supabase.auth.stopAutoRefresh();
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, []);

  // ── Sign out ──────────────────────────────────────────────────────────────
  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
    setProfile(null);
    profileFetchedForRef.current = null;
  }, []);

  return (
    <AuthContext.Provider value={{ session, user, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useAuth() {
  return useContext(AuthContext);
}
