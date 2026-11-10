import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type User } from './api';

interface AuthCtx { authMode: string | null; user: User | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; isAdmin: boolean }
const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const s = await api<{ user: User | null; authMode?: string }>('GET', '/api/session');
      setUser(s.user); setAuthMode(s.authMode ?? null);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const logout = useCallback(async () => { await api('POST', '/api/logout'); setUser(null); }, []);
  return <Ctx.Provider value={{ authMode, user, loading, refresh, logout, isAdmin: !!user?.roles.includes('CampaignAdmin') }}>{children}</Ctx.Provider>;
}
