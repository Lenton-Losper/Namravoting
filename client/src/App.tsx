import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Icon, Wordmark } from './icons';
import { initials, Spinner } from './ui';
import { LoginPage } from './pages/Login';
import { VotePage } from './pages/Vote';
import { MyVotes } from './pages/MyVotes';
import { ObserveCampaign, ObserveList } from './pages/Observe';
import { Dashboard } from './pages/admin/Dashboard';
import { ResultsArchive } from './pages/admin/ResultsArchive';
import { NewCampaign } from './pages/admin/NewCampaign';
import { EditCampaign } from './pages/admin/EditCampaign';
import { CampaignPage } from './pages/admin/CampaignPage';

function RequireUser({ admin = false }: { admin?: boolean }) {
  const { user, loading, isAdmin } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (admin && !isAdmin) return <div className="card card-pad center"><h1>Not allowed</h1><p className="muted">This area is for campaign administrators.</p><Link to="/votes">Go to My votes</Link></div>;
  return <Outlet />;
}

const ADMIN_NAV = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/new', label: 'Create campaign', end: true },
  { to: '/admin/results', label: 'Results', end: false },
];
const VOTER_NAV = [{ to: '/votes', label: 'My votes', end: false }];

/** Navy 64px top bar: wordmark left; nav, user and sign-out right. Collapses to a hamburger under 768px. */
function TopBar() {
  const { user, logout, isAdmin, observing } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  const nav = [...(isAdmin ? ADMIN_NAV : VOTER_NAV), ...(observing > 0 ? [{ to: '/observe', label: 'Observing', end: false }] : [])];
  const linkClass = (to: string) => ({ isActive }: { isActive: boolean }) =>
    `topnav-link${isActive || (to === '/votes' && loc.pathname.startsWith('/v/')) ? ' active' : ''}`;
  return (
    <header className="topbar">
      <div className="topbar-in">
        <Link to="/" className="brand" aria-label="NamRA Voting home"><Wordmark /></Link>
        {user && (
          <>
            <nav className="topnav" aria-label="Main">
              {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={linkClass(n.to)}>{n.label}</NavLink>)}
            </nav>
            <div className="userbox">
              <span className="user-name">{user.displayName}</span>
              <span className="avatar-round" aria-hidden="true">{initials(user.displayName).slice(0, 1)}</span>
              <button className="signout-btn" onClick={() => void logout()}>Sign out →</button>
            </div>
            <button className="hamburger" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen((o) => !o)}>
              <Icon name={open ? 'close' : 'menu'} size={22} />
            </button>
          </>
        )}
      </div>
      {user && open && (
        <div id="mobile-menu" className="dropdown">
          <div className="dropdown-user"><span className="avatar-round avatar-round-dark" aria-hidden="true">{initials(user.displayName).slice(0, 1)}</span><strong>{user.displayName}</strong></div>
          <nav aria-label="Mobile">
            {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `dropdown-link${isActive ? ' active' : ''}`}>{n.label}</NavLink>)}
          </nav>
          <button className="dropdown-link dropdown-signout" onClick={() => void logout()}>Sign out →</button>
        </div>
      )}
    </header>
  );
}

/** Operator banners for campaign admins: admins matched by email, Entra secret about to expire. */
function AdminBanners() {
  const { notices, isAdmin } = useAuth();
  if (!isAdmin || notices.length === 0) return null;
  return (
    <div className="admin-banners">
      {notices.map((n) => {
        if (n.kind === 'secret_expiry') {
          return <div key={n.kind} className="admin-banner admin-banner-danger" role="alert">{n.expired ? 'The Entra client secret has EXPIRED: nobody can sign in. ' : `The Entra client secret expires in ${n.daysLeft} day${n.daysLeft === 1 ? '' : 's'}. `}Create a new one in the Entra app registration and update ENTRA_CLIENT_SECRET and ENTRA_SECRET_EXPIRES_AT.</div>;
        }
        return <div key={n.kind} className="admin-banner" role="status">Admins are matched by email. Set ADMIN_OIDS so that admin rights follow the Entra account, not an email address.</div>;
      })}
    </div>
  );
}

function Shell() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      <TopBar />
      <AdminBanners />
      <main id="main" tabIndex={-1} className="container"><Outlet /></main>
    </>
  );
}

function Home() {
  const { user, loading, isAdmin } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={isAdmin ? '/admin' : '/votes'} replace />;
}

export function App() {
  return (
    <>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Home />} />
      <Route element={<Shell />}>
        <Route element={<RequireUser admin />}>
          <Route path="/admin" element={<Dashboard />} />
          <Route path="/admin/new" element={<NewCampaign />} />
          <Route path="/admin/results" element={<ResultsArchive />} />
          <Route path="/admin/c/:id" element={<CampaignPage />} />
          <Route path="/admin/c/:id/edit" element={<EditCampaign />} />
        </Route>
        <Route element={<RequireUser />}>
          <Route path="/votes" element={<MyVotes />} />
          <Route path="/v/:shareToken" element={<VotePage />} />
          <Route path="/observe" element={<ObserveList />} />
          <Route path="/observe/:id" element={<ObserveCampaign />} />
        </Route>
        <Route path="*" element={<div className="card card-pad center"><h1>Page not found</h1><Link to="/">Go home</Link></div>} />
      </Route>
    </Routes>
    </>
  );
}
