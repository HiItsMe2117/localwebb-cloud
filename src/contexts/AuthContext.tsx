import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import type { Session, User } from '@supabase/supabase-js';

interface AuthContextType {
  isAdmin: boolean;
  isPro: boolean;
  isElite: boolean;
  isStandard: boolean;
  hasAIPrivileges: boolean;
  isLoading: boolean;
  user: User | null;
  role: string | null;
  isRecovering: boolean;
  setIsRecovering: (v: boolean) => void;
  logout: () => Promise<void>;
  refreshSession: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType>({
  isAdmin: false,
  isPro: false,
  isElite: false,
  isStandard: true,
  hasAIPrivileges: false,
  isLoading: true,
  user: null,
  role: null,
  isRecovering: false,
  setIsRecovering: () => {},
  logout: async () => {},
  refreshSession: async () => null,
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRecovering, setIsRecovering] = useState(false);

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
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, currentSession) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsRecovering(true);
      }
      handleSession(currentSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  const refreshSession = async (): Promise<string | null> => {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    await handleSession(currentSession);
    if (currentSession?.user) {
      return await fetchRole(currentSession.user.id);
    }
    return null;
  };

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const isAdmin = role === 'admin';
  const isPro = role === 'pro';
  const isElite = role === 'elite';
  const isStandard = role === 'standard';
  const hasAIPrivileges = ['admin', 'pro', 'elite', 'basic'].includes(role || '');

  return (
    <AuthContext.Provider value={{ isAdmin, isPro, isElite, isStandard, hasAIPrivileges, isLoading, user, role, isRecovering, setIsRecovering, logout, refreshSession }}>
      {children}
    </AuthContext.Provider>
  );
}
