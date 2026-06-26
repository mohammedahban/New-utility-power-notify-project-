import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

interface UserProfile {
  id: string;
  email: string;
  username: string | null;
  role: 'admin' | 'user';
  created_at: string;
  updated_at: string;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    username: string,
  ) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // Prevent stale-closure issues in the AppState listener.
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  // ── Fetch profile ──────────────────────────────────────────────────────────

  const fetchProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (!error && data) {
        setProfile(data as UserProfile);
      }
    } catch (err) {
      console.error('[AuthContext] fetchProfile error:', err);
    }
  };

  const refreshProfile = async () => {
    if (user) await fetchProfile(user.id);
  };

  // ── Startup: getSession() as authoritative source ─────────────────────────
  //
  // We use getSession() directly instead of relying on onAuthStateChange's
  // INITIAL_SESSION event. The INITIAL_SESSION event fires BEFORE Supabase
  // has had a chance to refresh an expired token, causing a cold-start race
  // where `session` is null for a moment even though the user is actually
  // logged in. getSession() is atomic — it refreshes the token internally
  // before returning.
  //
  // An 8-second fallback timer ensures we never block the UI indefinitely
  // if the network is slow or unavailable on startup.

  useEffect(() => {
    let mounted = true;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const init = async () => {
      fallbackTimer = setTimeout(() => {
        if (mounted && loading) {
          console.warn('[AuthContext] 8s fallback: clearing loading state');
          setLoading(false);
        }
      }, 8000);

      try {
        const { data: { session: existingSession } } = await supabase.auth.getSession();
        if (!mounted) return;

        if (existingSession?.user) {
          setSession(existingSession);
          setUser(existingSession.user);
          await fetchProfile(existingSession.user.id);
        } else {
          setSession(null);
          setUser(null);
          setProfile(null);
        }
      } catch (err) {
        console.error('[AuthContext] getSession error:', err);
      } finally {
        if (mounted) {
          if (fallbackTimer) clearTimeout(fallbackTimer);
          setLoading(false);
        }
      }
    };

    init();

    // ── Real-time auth state changes ────────────────────────────────────────
    //
    // We intentionally SKIP INITIAL_SESSION here to avoid the race described
    // above. We only handle subsequent real-time events.

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (event === 'INITIAL_SESSION') return; // Handled by getSession() above

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (newSession?.user) {
            setSession(newSession);
            setUser(newSession.user);
            await fetchProfile(newSession.user.id);
          }
        } else if (event === 'SIGNED_OUT') {
          setSession(null);
          setUser(null);
          setProfile(null);
        }
      },
    );

    return () => {
      mounted = false;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      subscription.unsubscribe();
    };
  }, []);

  // ── AppState: pause/resume token auto-refresh ──────────────────────────────

  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppState);
    return () => subscription.remove();
  }, []);

  // ── Auth actions ───────────────────────────────────────────────────────────

  const signIn = async (
    email: string,
    password: string,
  ): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  };

  const signUp = async (
    email: string,
    password: string,
    username: string,
  ): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { username } },
    });
    if (error) return { error: error.message };
    return { error: null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
    setProfile(null);
  };

  // ── Value ──────────────────────────────────────────────────────────────────

  const value: AuthContextValue = {
    session,
    user,
    profile,
    loading,
    signIn,
    signUp,
    signOut,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
