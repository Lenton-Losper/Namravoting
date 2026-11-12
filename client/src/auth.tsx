import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, onSessionExpired, resetCsrf, type User } from './api';

export interface AdminNotice { kind: 'admin_by_email' | 'secret_expiry'; daysLeft?: number; expired?: boolean }
interface AuthCtx { authMode: string | null; notices: AdminNotice[]; user: User | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; isAdmin: boolean }
const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [notices, setNotices] = useState<AdminNotice[]>([]);
  const refresh = useCallback(async () => {
    try {
      const s = await api<{ user: User | null; authMode?: string; notices?: AdminNotice[] }>('GET', '/api/session');
      setUser(s.user); setAuthMode(s.authMode ?? null); setNotices(s.notices ?? []);
    } catch { setUser(null); }   // 401 already started the re-sign-in (api.ts); other failures leave the visitor signed out
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => onSessionExpired(() => setUser(null)), []);   // any 401 clears the signed-in user
  const logout = useCallback(async () => {
    // Demo: identity is the Cloudflare Access session, so signing out means ending that session.
    if (authMode === 'demo') { window.location.assign('/cdn-cgi/access/logout'); return; }
    // Entra: the server revokes the app session, then we send the browser through Microsoft's sign-out, back to the site root.
    if (authMode === 'entra') { const r = await api<{ redirect?: string }>('POST', '/api/logout'); resetCsrf(); window.location.assign(r?.redirect ?? '/'); return; }
    await api('POST', '/api/logout'); resetCsrf(); setUser(null);
  }, [authMode]);
  return <Ctx.Provider value={{ authMode, notices, user, loading, refresh, logout, isAdmin: !!user?.roles.includes('CampaignAdmin') }}>{children}</Ctx.Provider>;
}
