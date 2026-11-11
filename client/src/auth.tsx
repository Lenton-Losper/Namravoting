import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type User } from './api';

interface AuthCtx { authMode: string | null; demoBanner: boolean; user: User | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; isAdmin: boolean }
const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [demoBanner, setDemoBanner] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const s = await api<{ user: User | null; authMode?: string; demoBanner?: boolean }>('GET', '/api/session');
      setUser(s.user); setAuthMode(s.authMode ?? null); setDemoBanner(!!s.demoBanner);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const logout = useCallback(async () => {
    // Demo: identity is the Cloudflare Access session, so signing out means ending that session.
    if (authMode === 'demo') { window.location.assign('/cdn-cgi/access/logout'); return; }
    // Entra: the server clears the app session and sends the browser through Microsoft's sign-out, back to the site root.
    if (authMode === 'entra') { window.location.assign('/auth/logout'); return; }
    await api('POST', '/api/logout'); setUser(null);
  }, [authMode]);
  return <Ctx.Provider value={{ authMode, demoBanner, user, loading, refresh, logout, isAdmin: !!user?.roles.includes('CampaignAdmin') }}>{children}</Ctx.Provider>;
}
