import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import type { Session, User } from '@supabase/supabase-js';

interface AuthContextType {
  isAdmin: boolean;
  isStandard: boolean;
  isLoading: boolean;
  user: User | null;
  role: string | null;
  logout: () => Promise<void>;
  // login is no longer a simple function here, as Supabase Auth UI or standard Supabase calls will handle it.
  // We provide a refresh helper instead
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  isAdmin: false,
  isStandard: true,
  isLoading: true,
  user: null,
  role: null,
  logout: async () => {},
  refreshSession: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchRole = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();
      
      if (error) {
        console.error('Error fetching role:', error);
        return null;
      }
      return data?.role || 'standard';
    } catch (e) {
      console.error(e);
      return null;
    }
  };

  const handleSession = async (currentSession: Session | null) => {
    setSession(currentSession);
    setUser(currentSession?.user || null);
    
    if (currentSession?.user) {
      const currentRole = await fetchRole(currentSession.user.id);
      setRole(currentRole);
      // Attach token to axios requests for the Python backend
      axios.defaults.headers.common['Authorization'] = `Bearer ${currentSession.access_token}`;
    } else {
      setRole(null);
      delete axios.defaults.headers.common['Authorization'];
    }
    setIsLoading(false);
  };

  useEffect(() => {
    // Initial session fetch
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      handleSession(currentSession);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      handleSession(currentSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  const refreshSession = async () => {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    await handleSession(currentSession);
  };

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const isAdmin = role === 'admin';
  const isStandard = role === 'standard';

  return (
    <AuthContext.Provider value={{ isAdmin, isStandard, isLoading, user, role, logout, refreshSession }}>
      {children}
    </AuthContext.Provider>
  );
}
