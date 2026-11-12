import logo from './assets/namra-logo.jpg';
import type { ReactNode } from 'react';

/** Small inline outline icons (no dependency). All are decorative; the parent control carries the accessible name. */
const paths: Record<string, ReactNode> = {
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>,
  alert: <path d="M12 3l10 18H2L12 3zM12 10v4M12 17.5v.5" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" /></>,
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  share: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.2 10.9l7.6-3.8M8.2 13.1l7.6 3.8" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>,
  inbox: <><path d="M3 13l3-8h12l3 8v6H3v-6z" /><path d="M3 13h5l1 3h6l1-3h5" /></>,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

/**
 * Wordmark: "NamRA | Voting".
 * The official NamRA mark (client/src/assets/namra-logo.jpg, used as supplied) sits on a small white rounded backing, so it stays visible on the navy bar.
 */
export function Wordmark({ dark = false }: { dark?: boolean }) {
  return (
    <span className={`wordmark${dark ? ' wordmark-dark' : ''}`}>
      <span className="wordmark-logo"><img src={logo} alt="NamRA" width={32} height={32} decoding="async" /></span>
      <span className="wordmark-sep" aria-hidden="true" />
      <span className="wordmark-sub">Voting</span>
    </span>
  );
}
