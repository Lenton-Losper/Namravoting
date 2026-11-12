import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, resetCsrf, type User } from './api';

export interface AdminNotice { kind: 'demo_override' | 'admin_by_email' | 'secret_expiry'; daysLeft?: number; expired?: boolean }
interface AuthCtx { authMode: string | null; demoBanner: boolean; notices: AdminNotice[]; user: User | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; isAdmin: boolean }
const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [demoBanner, setDemoBanner] = useState(false);
  const [notices, setNotices] = useState<AdminNotice[]>([]);
  const refresh = useCallback(async () => {
    try {
      const s = await api<{ user: User | null; authMode?: string; demoBanner?: boolean; notices?: AdminNotice[] }>('GET', '/api/session');
      setUser(s.user); setAuthMode(s.authMode ?? null); setDemoBanner(!!s.demoBanner); setNotices(s.notices ?? []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const logout = useCallback(async () => {
    // Demo: identity is the Cloudflare Access session, so signing out means ending that session.
    if (authMode === 'demo') { window.location.assign('/cdn-cgi/access/logout'); return; }
    // Entra: the server revokes the app session, then we send the browser through Microsoft's sign-out, back to the site root.
    if (authMode === 'entra') { const r = await api<{ redirect?: string }>('POST', '/api/logout'); resetCsrf(); window.location.assign(r?.redirect ?? '/'); return; }
    await api('POST', '/api/logout'); resetCsrf(); setUser(null);
  }, [authMode]);
  return <Ctx.Provider value={{ authMode, demoBanner, notices, user, loading, refresh, logout, isAdmin: !!user?.roles.includes('CampaignAdmin') }}>{children}</Ctx.Provider>;
}
