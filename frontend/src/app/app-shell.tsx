'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

type IconName = 'live' | 'home' | 'leads' | 'inbox' | 'deals' | 'chart' | 'gauge' | 'globe' | 'brain' | 'bell' | 'phone' | 'shield' | 'gear' | 'more' | 'logout';
type NavItem = { href: string; label: string; icon: IconName; badge?: 'to_review' | 'pending_replies'; owner?: boolean };
type Account = { email: string; role: string };
type Counts = { to_review: number; pending_replies: number; overdue_replies: number };

const GROUPS: Array<{ title: string; items: NavItem[] }> = [
  { title: 'Workspace', items: [
    { href: '/', label: 'Overview', icon: 'home', badge: 'to_review' },
    { href: '/live', label: 'Live', icon: 'live' },
    { href: '/inbox', label: 'Replies', icon: 'inbox', badge: 'pending_replies' },
    { href: '/leads', label: 'Leads', icon: 'leads' },
    { href: '/pipeline', label: 'Deals', icon: 'deals' },
  ] },
  { title: 'Insights', items: [
    { href: '/analytics', label: 'Analytics', icon: 'chart' },
    { href: '/usage', label: 'Usage & Health', icon: 'gauge' },
  ] },
  { title: 'Agent', items: [
    { href: '/brain', label: 'Brain', icon: 'brain', owner: true },
    { href: '/markets', label: 'Markets', icon: 'globe' },
  ] },
  { title: 'Settings', items: [
    { href: '/settings', label: 'Settings', icon: 'gear', owner: true },
    { href: '/notifications', label: 'Notifications', icon: 'bell' },
    { href: '/devices', label: 'Devices', icon: 'phone' },
    { href: '/admin', label: 'Admin & Security', icon: 'shield', owner: true },
  ] },
];
const TABS = ['/', '/live', '/inbox', '/leads'];
// Pages that render without the workspace chrome.
const BARE = ['/login', '/privacy', '/offline'];

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    live: <><path d="M2 12h4l2.5-6 4 13 3-9 1.5 2H22" /></>,
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></>,
    inbox: <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Z" /></>,
    leads: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" /></>,
    deals: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" /></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    gauge: <><path d="M4.5 18a9 9 0 1 1 15 0" /><path d="m12 13 4-5" /><circle cx="12" cy="13" r="1.2" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
    brain: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2Z" /></>,
    bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
    phone: <><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>,
    shield: <><path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6Z" /><path d="m9 12 2 2 4-4" /></>,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
    more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
    logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l5-5-5-5M15 12H3" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const bare = BARE.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const [account, setAccount] = useState<Account | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (bare) return;
    let active = true;
    void (async () => {
      try {
        const [me, stats] = await Promise.all([fetch('/api/proxy/auth/me'), fetch('/api/proxy/stats')]);
        if (!active) return;
        if (me.ok) setAccount(await me.json() as Account);
        if (stats.ok) setCounts(await stats.json() as Counts);
      } catch {
        // Navigation still works without counts; each page reports its own load errors.
      }
    })();
    return () => { active = false; };
  }, [bare, pathname]);

  useEffect(() => { setSheetOpen(false); }, [pathname]);
  // iOS-style: the compact top-bar title appears once the large page title scrolls away.
  useEffect(() => {
    if (bare) return;
    const onScroll = () => setScrolled(window.scrollY > 48);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [bare, pathname]);
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSheetOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  if (bare) return <>{children}</>;

  const isOwner = account?.role === 'owner';
  const groups = GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => !item.owner || isOwner) })).filter((group) => group.items.length);
  const allItems = groups.flatMap((group) => group.items);
  const current = allItems.find((item) => isActive(pathname, item.href));
  const tabs = TABS.map((href) => allItems.find((item) => item.href === href)).filter((item): item is NavItem => !!item);
  const moreActive = !!current && !TABS.includes(current.href);
  const badgeOf = (item: NavItem) => (item.badge && counts ? counts[item.badge] : 0) || 0;

  const logout = async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } finally { location.href = '/login'; }
  };

  const navList = (onNavigate?: () => void) => groups.map((group) => (
    <div className="nav-group" key={group.title}>
      <div className="nav-group-title">{group.title}</div>
      <div className="nav-group-items">
        {group.items.map((item) => {
          const badge = badgeOf(item);
          return (
            <a key={item.href} href={item.href} className={`nav-row${isActive(pathname, item.href) ? ' active' : ''}`} aria-current={isActive(pathname, item.href) ? 'page' : undefined} onClick={onNavigate}>
              <span className={`nav-icon tint-${item.icon}`}><Icon name={item.icon} /></span>
              <span className="nav-label">{item.label}</span>
              {badge > 0 && <span className="nav-badge">{badge}</span>}
            </a>
          );
        })}
      </div>
    </div>
  ));

  const accountRow = (
    <div className="account-card">
      <span className="account-avatar">{(account?.email ?? '?').slice(0, 1).toUpperCase()}</span>
      <span className="account-meta"><strong>{account?.email ?? 'Signed in'}</strong><small>{isOwner ? 'Owner' : account ? 'Admin' : ''}</small></span>
      <button className="icon-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
    </div>
  );

  return (
    <div className={`app${scrolled ? ' scrolled' : ''}`}>
      <aside className="app-sidebar" aria-label="Main navigation">
        <a className="sidebar-brand" href="/"><span className="brand-mark">E</span><span>Email Auto</span></a>
        <nav className="sidebar-nav">{navList()}</nav>
        {accountRow}
      </aside>

      <header className="mobile-bar">
        <a className="mobile-brand" href="/" aria-label="Overview"><span className="brand-mark">E</span></a>
        <span className="mobile-title">{current?.label ?? 'Email Auto'}</span>
        <button className="icon-button" onClick={() => setSheetOpen(true)} aria-label="Open menu"><Icon name="more" /></button>
      </header>

      <div className="app-main">{children}</div>

      <nav className="tab-bar" aria-label="Primary">
        {tabs.map((item) => {
          const badge = badgeOf(item);
          return (
            <a key={item.href} href={item.href} className={`tab${isActive(pathname, item.href) ? ' active' : ''}`} aria-current={isActive(pathname, item.href) ? 'page' : undefined}>
              <span className="tab-icon"><Icon name={item.icon} />{badge > 0 && <span className="tab-badge">{badge > 99 ? '99+' : badge}</span>}</span>
              <span>{item.label}</span>
            </a>
          );
        })}
        <button className={`tab${moreActive || sheetOpen ? ' active' : ''}`} onClick={() => setSheetOpen(true)} aria-haspopup="dialog" aria-expanded={sheetOpen}>
          <span className="tab-icon"><Icon name="more" /></span>
          <span>More</span>
        </button>
      </nav>

      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="All sections" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-grabber" />
            <div className="sheet-header"><strong>All Sections</strong><button className="sheet-done" onClick={() => setSheetOpen(false)}>Done</button></div>
            <div className="sheet-body">
              {navList(() => setSheetOpen(false))}
              {accountRow}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
