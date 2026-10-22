'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import {
  ActivityIcon,
  BellIcon,
  ChatIcon,
  GearIcon,
  ListIcon,
  KeyIcon,
  LogOutIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  UsersIcon,
  VisitorsIcon,
} from '@/components/icons';
import { cn } from '@/components/ui';
import { setTheme } from '@/lib/theme';

const NAV = [
  { href: '/conversations', label: 'Conversations', Icon: ChatIcon },
  { href: '/visitors', label: 'Visitors', Icon: VisitorsIcon },
  { href: '/settings/api-keys', label: 'API Keys', Icon: KeyIcon },
  { href: '/settings/widget', label: 'Widget Settings', Icon: SlidersIcon },
  { href: '/settings/members', label: 'Team', Icon: UsersIcon },
  { href: '/settings/security', label: 'Security', Icon: ShieldIcon },
  { href: '/settings/activity', label: 'Activity', Icon: ActivityIcon },
];

function titleFor(pathname: string): string {
  if (pathname.startsWith('/conversations/')) return 'Conversation';
  if (pathname.startsWith('/visitors/')) return 'Visitor';
  if (pathname.startsWith('/settings/api-keys')) return 'API Keys';
  if (pathname.startsWith('/settings/widget')) return 'Widget Settings';
  if (pathname.startsWith('/settings/members')) return 'Team';
  if (pathname.startsWith('/settings/security')) return 'Security';
  if (pathname.startsWith('/settings/activity')) return 'Activity';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/visitors')) return 'Visitors';
  return 'Conversations';
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, role, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [openCount, setOpenCount] = useState(0);
  const [theme, setThemeState] = useState<'light' | 'dark'>('light');
  const [menuOpen, setMenuOpen] = useState(false);
  const [q, setQ] = useState('');

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

  function onThemeToggle(t: 'light' | 'dark') {
    setThemeState(t);
    setTheme(t);
    document.documentElement.dataset.theme = t;
  }

  function isActive(href: string): boolean {
    if (href === '/conversations') {
      return pathname === '/conversations' || pathname.startsWith('/conversations/');
    }
    return pathname.startsWith(href);
  }
  const initials = (user?.name || user?.email || '?')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="shell">
      <header className="top">
        <div className="pill logo">
          <div className="lg">C</div>
          Chatly
        </div>

        <nav className="pill tabs" aria-label="Main">
          
          {NAV.map(({ href, label }) => (
            <button key={href} className={cn(isActive(href) ? 'on' : '')} data-p={href}>
              {label}
            </button>
          ))}
        </nav>

        <div className="pill">
          <button className="ib" aria-label="Search" onClick={() => setMenuOpen(!menuOpen)}>
            <SearchIcon size={18} />
          </button>
          <button className="ib" aria-label="Notifications">
            <BellIcon size={18} />
            <span className="dot" />
          </button>
          <button className="ib" aria-label="Help">
            <ListIcon size={18} />
          </button>
        </div>
        <button className="pill me" aria-label="User profile">
          <div className="av">{initials}</div>
          <div>
            {user?.name || 'Agent'}
            <small>{user?.email || ''}</small>
          </div>
        </button>
      </header>
    
      <aside className="rail" aria-label="Navigation">
          <div className="pill th">
            <button
              className={cn(theme === 'light' ? 'on' : '')}
              id="tl"
              aria-label="Light theme"
              onClick={() => onThemeToggle('light')}
            >
              <svg viewBox="0 0 24 24" width={18} height={18}>
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            </button>
            <button
              className={cn(theme === 'dark' ? 'on' : '')}
              id="td"
              aria-label="Dark theme"
              onClick={() => onThemeToggle('dark')}
            >
              <svg viewBox="0 0 24 24">
                <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />
              </svg>
            </button>
          </div>
          <div className="pill" id="rail">
            {NAV.map(({ href, Icon }) => (
              <button
                key={href}
                className={cn(isActive(href) ? 'on' : '')}
                aria-label={titleFor(href)}
                data-p={href}
                onClick={() => router.push(href)}
              >
                <Icon size={19} />
              </button>
            ))}
          </div>
          <div className="pill">
            <button className="ib" aria-label="Help">
              <ListIcon size={18} />
            </button>
            <button className="ib" aria-label="Log out" onClick={doSignOut}>
              <LogOutIcon size={18} />
            </button>
          </div>
        </aside>

      <main id="main" aria-live="polite">
        {children}
      </main>
    </div>
  );
}
