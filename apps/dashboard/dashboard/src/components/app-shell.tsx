'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import {
  ActivityIcon,
  BellIcon,
  ChatIcon,
  GearIcon,
  GridIcon,
  KeyIcon,
  LogOutIcon,
  MoonIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  SunIcon,
  TeamIcon,
  VisitorsIcon,
} from '@/components/icons';
import { PillNav, type PillItem } from '@/components/pill-nav';
import { cn } from '@/components/ui';
import { BRAND } from '@/config/brand';
import { getSavedTheme, setTheme, type Theme } from '@/lib/theme';

interface Meta {
  title: string;
  sub: string;
  action?: { href: string; label: string };
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function metaFor(pathname: string, firstName: string): Meta {
  if (pathname.startsWith('/overview')) {
    return {
      title: `${greeting()}, ${firstName}`,
      sub: 'Stay on top of your conversations, visitors and team activity.',
      action: { href: '/conversations', label: 'Open inbox' },
    };
  }
  if (pathname.startsWith('/conversations')) {
    return { title: 'Conversations', sub: 'Reply to visitors in real time from one inbox.' };
  }
  if (pathname.startsWith('/visitors/')) {
    return { title: 'Visitor', sub: 'Profile, attributes and every conversation with this visitor.' };
  }
  if (pathname.startsWith('/visitors')) {
    return { title: 'Visitors', sub: 'Everyone who has chatted with your team, with their attributes.' };
  }
  if (pathname.startsWith('/settings/api-keys')) {
    return { title: 'API keys', sub: 'Mint keys that connect the widget to your sites.' };
  }
  if (pathname.startsWith('/settings/widget')) {
    return { title: 'Widget', sub: 'Match the chat bubble to your brand and control where it loads.' };
  }
  if (pathname.startsWith('/settings/members')) {
    return { title: 'Team', sub: 'Invite teammates and manage their roles.' };
  }
  if (pathname.startsWith('/settings/security')) {
    return { title: 'Security', sub: 'Protect your account with 2FA and manage signed-in devices.' };
  }
  if (pathname.startsWith('/settings/activity')) {
    return { title: 'Activity', sub: 'Recent privileged actions in your workspace.' };
  }
  return { title: 'Settings', sub: 'Manage your workspace.' };
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [openCount, setOpenCount] = useState(0);
  const [theme, setThemeState] = useState<Theme>('light');
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');

  // Auth guard: bounce to /login once we know there is no session.
  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    setThemeState(getSavedTheme() === 'dark' ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .listConversations({ status: 'open', limit: 100 })
      .then((page) => {
        if (!cancelled) setOpenCount(page.items.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user, pathname]);

  // Close the profile menu on outside click / route change.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.me-wrap')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);
  useEffect(() => setMenuOpen(false), [pathname]);

  const firstName = (user?.name || user?.email || 'there').trim().split(/\s+/)[0] ?? 'there';
  const initials = (user?.name || user?.email || '?')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const inSettings = pathname.startsWith('/settings') && !pathname.startsWith('/settings/members');

  const top: PillItem[] = useMemo(
    () => [
      { href: '/overview', label: 'Overview', active: pathname.startsWith('/overview') },
      { href: '/conversations', label: 'Conversations', active: pathname.startsWith('/conversations') },
      { href: '/visitors', label: 'Visitors', active: pathname.startsWith('/visitors') },
      { href: '/settings/members', label: 'Team', active: pathname.startsWith('/settings/members') },
      { href: '/settings/widget', label: 'Settings', active: inSettings },
    ],
    [pathname, inSettings],
  );

  const rail: PillItem[] = useMemo(
    () => [
      { href: '/overview', label: 'Overview', Icon: GridIcon, active: pathname.startsWith('/overview') },
      { href: '/conversations', label: 'Conversations', Icon: ChatIcon, active: pathname.startsWith('/conversations') },
      { href: '/visitors', label: 'Visitors', Icon: VisitorsIcon, active: pathname.startsWith('/visitors') },
      { href: '/settings/widget', label: 'Widget', Icon: SlidersIcon, active: pathname.startsWith('/settings/widget') },
      { href: '/settings/api-keys', label: 'API keys', Icon: KeyIcon, active: pathname.startsWith('/settings/api-keys') },
      { href: '/settings/members', label: 'Team', Icon: TeamIcon, active: pathname.startsWith('/settings/members') },
      { href: '/settings/security', label: 'Security', Icon: ShieldIcon, active: pathname.startsWith('/settings/security') },
      { href: '/settings/activity', label: 'Activity', Icon: ActivityIcon, active: pathname.startsWith('/settings/activity') },
    ],
    [pathname],
  );

  const sub: PillItem[] = useMemo(
    () => [
      { href: '/settings/widget', label: 'Widget', active: pathname.startsWith('/settings/widget') },
      { href: '/settings/api-keys', label: 'API keys', active: pathname.startsWith('/settings/api-keys') },
      { href: '/settings/security', label: 'Security', active: pathname.startsWith('/settings/security') },
      { href: '/settings/activity', label: 'Activity', active: pathname.startsWith('/settings/activity') },
    ],
    [pathname],
  );

  function onGlobalSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    window.dispatchEvent(new CustomEvent<string>('lc-search', { detail: query }));
    if (!pathname.startsWith('/conversations')) {
      router.push(query ? `/conversations?q=${encodeURIComponent(query)}` : '/conversations');
    }
  }

  function doSignOut() {
    setMenuOpen(false);
    void signOut().then(() => router.replace('/login'));
  }

  function onThemeToggle(t: Theme, e: React.MouseEvent) {
    setThemeState(t);
    setTheme(t, e.nativeEvent);
  }

  if (loading || !user) {
    return (
      <div className="boot" aria-busy="true">
        <div className="lg">{BRAND.product.charAt(0)}</div>
      </div>
    );
  }

  const meta = metaFor(pathname, firstName);

  return (
    <div className="shell">
      <header className="top">
        <div className="lt">
          <Link href="/overview" className="pill logo" aria-label={BRAND.product}>
            <div className="lg">{BRAND.product.charAt(0)}</div>
            {BRAND.product}
          </Link>
        </div>

        <PillNav items={top} label="Main" className="pill tabs" />

        <div className="rt">
          <div className="pill">
            <form className={cn('sform', searchOpen && 'open')} onSubmit={onGlobalSearch} role="search">
              <input
                aria-label="Search conversations"
                placeholder="Search conversations…"
                value={q}
                tabIndex={searchOpen ? 0 : -1}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setSearchOpen(false)}
                ref={(el) => {
                  if (el && searchOpen) el.focus();
                }}
              />
            </form>
            <button
              className="ib"
              aria-label="Search"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen((o) => !o)}
            >
              <SearchIcon size={18} />
            </button>
            <button
              className="ib"
              aria-label={`Notifications — ${openCount} open conversations`}
              onClick={() => router.push('/conversations')}
            >
              <BellIcon size={18} />
              {openCount > 0 && <span className="dot" />}
            </button>
          </div>

          <div className="me-wrap" style={{ position: 'relative' }}>
            <button
              className="pill me"
              aria-label="User menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <div className="av">{initials}</div>
              <div>
                {user.name || 'Agent'}
                <small>{user.email}</small>
              </div>
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <div className="who-am">
                  {user.name || 'Agent'}
                  <small>{user.email}</small>
                </div>
                <Link href="/settings/security" role="menuitem">
                  <ShieldIcon size={16} /> Security
                </Link>
                <Link href="/settings/widget" role="menuitem">
                  <GearIcon size={16} /> Settings
                </Link>
                <button role="menuitem" onClick={doSignOut}>
                  <LogOutIcon size={16} /> Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="frame">
        <aside className="rail" aria-label="Navigation">
          <div className="pill th">
            <button
              className={cn('ib', theme === 'light' && 'on')}
              aria-label="Light theme"
              aria-pressed={theme === 'light'}
              onClick={(e) => onThemeToggle('light', e)}
            >
              <SunIcon size={18} />
            </button>
            <button
              className={cn('ib', theme === 'dark' && 'on')}
              aria-label="Dark theme"
              aria-pressed={theme === 'dark'}
              onClick={(e) => onThemeToggle('dark', e)}
            >
              <MoonIcon size={18} />
            </button>
          </div>

          <PillNav items={rail} label="Sections" className="pill" iconOnly />

          <div className="pill">
            <Link href="/settings/widget" className="ib" aria-label="Settings">
              <GearIcon size={18} />
            </Link>
            <button className="ib" aria-label="Log out" onClick={doSignOut}>
              <LogOutIcon size={18} />
            </button>
          </div>
        </aside>

        <main id="main" className="stage">
          <div className="hd">
            <div>
              <h1>{meta.title}</h1>
              <p className="sub">{meta.sub}</p>
            </div>
            {meta.action && (
              <Link href={meta.action.href} className="btn s">
                {meta.action.label}
              </Link>
            )}
          </div>
          {inSettings && <PillNav items={sub} label="Settings sections" className="pill tabs subnav" />}
          {children}
        </main>
      </div>
    </div>
  );
}
