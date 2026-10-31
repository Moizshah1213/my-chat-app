'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useAuth } from '@/lib/auth';
import {
  clearNotifications as storeClearNotifications,
  getNotifications,
  markAllRead as storeMarkAllRead,
  markRead as storeMarkRead,
  notifyConversationChange,
  notifyVisitorOnline,
  resetNotificationPreferences,
  setPausedConversations,
  subscribe,
  type Notification,
} from '@/lib/notifications';
import { api, API_URL, getAccessToken } from '@/lib/api';
import { connectAgentSocket } from '@/lib/socket';
import {
  BellIcon,
  ChatIcon,
  HelpIcon,
  LogOutIcon,
  SearchIcon,
  VisitorsIcon,
} from '@/components/icons';
import { BRAND } from '@/config/brand';
import { cn } from '@/components/ui';
import { setTheme } from '@/lib/theme';
import TwoFactorSetupModal from '@/components/two-factor-setup-modal';

import {
  Activity,
  Bot,
  ChevronDown,
  KeyRound,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
  UserRound,
} from 'lucide-react';

function Link(props: ComponentProps<'a'>) {
  return <a {...props} />;
}

function useCurrentPathname() {
  const [pathname, setPathname] = useState('');

  useEffect(() => {
    const updatePathname = () => setPathname(window.location.pathname);
    updatePathname();
    window.addEventListener('popstate', updatePathname);
    return () => window.removeEventListener('popstate', updatePathname);
  }, []);

  return pathname;
}

function useBrowserRouter() {
  return {
    push: (href: string) => window.location.assign(href),
    replace: (href: string) => window.location.replace(href),
  };
}

const NAV = [
  { href: '/overview', label: 'Overview', Icon: LayoutDashboard },
  { href: '/conversations', label: 'Conversations', Icon: MessageSquare },
  { href: '/visitors', label: 'Visitors', Icon: VisitorsIcon },
  { href: '/settings/widget', label: 'Widget', Icon: SlidersHorizontal },
  { href: '/settings/ai', label: 'AI', Icon: Bot },
  { href: '/settings/email', label: 'Email', Icon: Mail },
  { href: '/settings/api-keys', label: 'API keys', Icon: KeyRound },
  { href: '/settings/members', label: 'Settings', Icon: Settings },
];

const SETTINGS_NAV = [
  { href: '/settings/profile', label: 'My profile', Icon: UserRound },
  { href: '/settings/members', label: 'Team', Icon: UsersRound },
  { href: '/settings/security', label: 'Security', Icon: ShieldCheck },
  { href: '/settings/activity', label: 'Activity', Icon: Activity },
  { href: '/settings/widget', label: 'Widget', Icon: SlidersHorizontal },
  { href: '/settings/ai', label: 'AI Assistant', Icon: Bot },
  { href: '/settings/email', label: 'Email Settings', Icon: Mail },
  { href: '/settings/api-keys', label: 'API keys', Icon: KeyRound },
];

const SEARCH_NAV = Array.from(
  new Map([...NAV, ...SETTINGS_NAV].map((item) => [item.href, item])).values(),
);

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function titleFor(pathname: string): string {
  if (pathname === '/overview') return 'Overview';
  if (pathname === '/conversations') return 'Conversations';
  if (pathname.startsWith('/visitors/')) return 'Visitor';
  if (pathname === '/visitors') return 'Visitors';
  if (pathname.startsWith('/settings/widget')) return 'Widget';
  if (pathname.startsWith('/settings/profile')) return 'My profile';
  if (pathname.startsWith('/settings/ai')) return 'AI Assistant';
  if (pathname.startsWith('/settings/email')) return 'Email Settings';
  if (pathname.startsWith('/settings/api-keys')) return 'API keys';
  if (pathname.startsWith('/settings/security')) return 'Security';
  if (pathname.startsWith('/settings/activity')) return 'Activity';
  if (pathname.startsWith('/settings/members')) return 'Team';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/conversations/')) return 'Conversation';
  return BRAND.product;
}

function subtitleFor(pathname: string): string {
  if (pathname === '/overview') return 'Stay on top of your conversations, visitors and team activity.';
  if (pathname === '/conversations') return 'Reply to visitors in real time from one inbox.';
  if (pathname === '/visitors') return 'See who has visited your site and review their activity.';
  if (pathname.startsWith('/settings/widget')) return 'Match the chat widget to your brand and configure how it behaves.';
  if (pathname.startsWith('/settings/profile')) return 'Update your personal details, email address and password.';
  if (pathname.startsWith('/settings/ai')) return 'Connect your LLM, set auto-reply rules, and manage the knowledge base.';
  if (pathname.startsWith('/settings/email')) return 'Configure email provider for chat transcripts and system emails.';
  if (pathname.startsWith('/settings/api-keys')) return 'Manage the keys that connect your widget and apps.';
  if (pathname.startsWith('/settings/security')) return 'Protect your account and manage active sessions.';
  if (pathname.startsWith('/settings/activity')) return 'Review recent activity across your workspace.';
  if (pathname.startsWith('/settings/members')) return 'Invite teammates and manage their roles.';
  if (pathname.startsWith('/settings')) return 'Manage your workspace, security and team.';
  return '';
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut, twoFactorSkipped } = useAuth();
  const twoFactorSetupNeeded = Boolean(!loading && user && !user.totpEnabled && !twoFactorSkipped);
  const router = useBrowserRouter();
  const pathname = useCurrentPathname();
  const [theme, setThemeState] = useState<'light' | 'dark'>('light');
  const [q, setQ] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>(() => getNotifications());
  const [unreadCount, setUnreadCount] = useState(() =>
    getNotifications().filter((n) => !n.read).length,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const authRedirectingRef = useRef(false);

  useEffect(() => {
    setThemeState(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    if (!loading && !user && pathname && !authRedirectingRef.current) {
      authRedirectingRef.current = true;
      window.location.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [loading, user, pathname]);

  useEffect(() => {
    setNotifications(getNotifications());
    setUnreadCount(getNotifications().filter((n) => !n.read).length);
    const unsub = subscribe(() => {
      const current = getNotifications();
      setNotifications(current);
      setUnreadCount(current.filter((n) => !n.read).length);
    });
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    resetNotificationPreferences();
    if (!user?.id) return;
    let cancelled = false;
    void api
      .listNotificationPreferences()
      .then(({ conversationIds }) => {
        if (!cancelled) setPausedConversations(conversationIds);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('[notifications] Could not load paused conversations:', error);
        setPausedConversations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    const token = getAccessToken();
    if (!token || !user?.id || (!user.totpEnabled && !twoFactorSkipped) || pathname.startsWith('/conversations')) return;
    const socket = connectAgentSocket(token, {
      onVisitorPresence: notifyVisitorOnline,
      onConversationUpdated: notifyConversationChange,
    });
    return () => {
      socket.close();
    };
  }, [user?.id, user?.totpEnabled, twoFactorSkipped, pathname]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    setSearchActiveIndex(0);
  }, [searchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setNotifOpen(false);
        setProfileOpen(false);
        setSearchOpen(true);
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setNotifOpen(false);
        setProfileOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!notificationRef.current?.contains(target)) setNotifOpen(false);
      if (!profileRef.current?.contains(target)) setProfileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  const searchItems = SEARCH_NAV.filter(({ label }) =>
    label.toLowerCase().includes(q.trim().toLowerCase()),
  );

  function navigateToSearchResult(href: string) {
    setSearchOpen(false);
    setQ('');
    router.push(href);
  }

  function onGlobalSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    navigateToSearchResult(query ? `/conversations?q=${encodeURIComponent(query)}` : '/conversations');
  }

  function doSignOut() {
    void signOut().then(() => router.replace('/login'));
  }

  function markAllRead() {
    storeMarkAllRead();
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  function markNotificationRead(notification: Notification) {
    storeMarkRead(notification.id);
    setNotifications(getNotifications());
    setUnreadCount(getNotifications().filter((n) => !n.read).length);
    if (notification.href) {
      setNotifOpen(false);
      router.push(notification.href);
    }
  }

  function clearAllNotifications() {
    storeClearNotifications();
    setNotifications([]);
    setUnreadCount(0);
  }

  function onThemeToggle(t: 'light' | 'dark', event: React.MouseEvent<HTMLButtonElement>) {
    setThemeState(t);
    setTheme(t, event.nativeEvent);
  }

  function isActive(href: string): boolean {
    if (href === '/settings/members') {
      return ['/settings/members', '/settings/security', '/settings/activity'].some(
        (settingsPath) => pathname === settingsPath || pathname.startsWith(`${settingsPath}/`),
      );
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  const initials = (user?.name || user?.email || '?')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <>
    <div className="shell" inert={twoFactorSetupNeeded} aria-hidden={twoFactorSetupNeeded}>
      <header className="top">
        <div className="lt">
          <Link className="pill logo brand-lockup" href="/overview" aria-label={`${BRAND.product} dashboard`}>
            <img className="brand-logo brand-logo-light" src={BRAND.logoOnLight} alt={BRAND.product} />
            <img className="brand-logo brand-logo-dark" src={BRAND.logoOnDark} alt="" aria-hidden="true" />
          </Link>
        </div>

        <nav className="pill tabs" aria-label="Main">
          {NAV.map(({ href, label }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                className={cn('pi', active && 'on')}
                href={href}
                aria-current={active ? 'page' : undefined}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="rt">
          <div className="top-tools">
            <div className="pill tool-pill">
              <button
                className="ib header-icon-button"
                aria-label="Search"
                title="Search (Ctrl+K)"
                onClick={() => {
                  setNotifOpen(false);
                  setProfileOpen(false);
                  setSearchOpen(true);
                }}
              >
                <SearchIcon size={18} />
              </button>
              <div className="header-popover" ref={notificationRef}>
                <button
                  className="ib header-icon-button"
                  aria-label="Notifications"
                  aria-expanded={notifOpen}
                  aria-haspopup="dialog"
                  onClick={() => {
                    setProfileOpen(false);
                    setNotifOpen((v) => !v);
                  }}
                >
                  <BellIcon size={18} />
                  {unreadCount > 0 && <span className="dot" />}
                </button>
                {notifOpen && (
                  <div className="notif-panel" role="dialog" aria-label="Notifications">
                    <div className="notif-head">
                      <div>
                        <strong>Notifications</strong>
                        <span>{unreadCount ? `${unreadCount} unread` : 'You’re all caught up'}</span>
                      </div>
                      <div className="notif-actions">
                        {unreadCount > 0 && (
                          <button type="button" onClick={markAllRead}>Mark all read</button>
                        )}
                        {notifications.length > 0 && (
                          <button type="button" onClick={clearAllNotifications}>Clear</button>
                        )}
                      </div>
                    </div>
                    {notifications.length === 0 ? (
                      <div className="notif-empty">
                        <BellIcon size={22} />
                        <strong>No notifications yet</strong>
                        <span>Visitor activity and conversation updates will appear here.</span>
                      </div>
                    ) : (
                      <ul className="notif-list">
                        {notifications.map((n) => (
                          <li key={n.id}>
                            <button
                              className={`notif${n.read ? '' : ' unread'}`}
                              type="button"
                              onClick={() => markNotificationRead(n)}
                            >
                              {!n.read && <span className="notif-unread-dot" aria-hidden="true" />}
                              <span className="notif-body">
                                <span className="notif-title">{n.title}</span>
                                <span className="notif-text">{n.body}</span>
                                <time dateTime={n.createdAt}>
                                  {new Intl.DateTimeFormat(undefined, {
                                    hour: 'numeric',
                                    minute: '2-digit',
                                  }).format(new Date(n.createdAt))}
                                </time>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
              <button className="ib header-icon-button" aria-label="Help">
                <HelpIcon size={18} />
              </button>
            </div>
          </div>
          <div className="profile-wrap" ref={profileRef}>
            <button
              className="pill profile-card profile-trigger"
              type="button"
              onClick={() => {
                setNotifOpen(false);
                setProfileOpen((v) => !v);
              }}
              aria-label="Open profile menu"
              aria-expanded={profileOpen}
              aria-haspopup="menu"
            >
              <span className="av">{user?.avatarUrl ? <img src={user.avatarUrl.startsWith('/') ? `${API_URL}${user.avatarUrl}` : user.avatarUrl} alt="" /> : initials}</span>
              <span className="profile-trigger-copy">
                <strong>{user?.name || 'Agent'}</strong>
                <small>{user?.email || ''}</small>
              </span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {profileOpen && (
              <div className="profile-panel" role="menu" aria-label="Profile menu">
                <div className="profile-summary">
                  <span className="av">{user?.avatarUrl ? <img src={user.avatarUrl.startsWith('/') ? `${API_URL}${user.avatarUrl}` : user.avatarUrl} alt="" /> : initials}</span>
                  <span>
                    <strong>{user?.name || 'Agent'}</strong>
                    <small>{user?.email || ''}</small>
                  </span>
                </div>
                <Link
                  className="profile-menu-link"
                  href="/settings/profile"
                  role="menuitem"
                  onClick={() => setProfileOpen(false)}
                >
                  <UserRound size={16} />
                  My profile
                </Link>
                <Link
                  className="profile-menu-link"
                  href="/settings/members"
                  role="menuitem"
                  onClick={() => setProfileOpen(false)}
                >
                  <Settings size={16} />
                  Workspace settings
                </Link>
                <button className="profile-signout" role="menuitem" onClick={doSignOut}>
                  <LogOutIcon size={16} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {searchOpen && (
        <div
          className="search-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSearchOpen(false);
          }}
        >
          <section className="search-dialog" role="dialog" aria-modal="true" aria-label="Search">
            <form className="search-form" onSubmit={onGlobalSearch}>
              <SearchIcon size={19} aria-hidden="true" />
              <input
                ref={searchInputRef}
                aria-label="Search conversations or pages"
                placeholder="Search conversations or jump to..."
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSearchActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  const count = searchItems.length + 1;
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSearchActiveIndex((index) => (index + 1) % count);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSearchActiveIndex((index) => (index - 1 + count) % count);
                  } else if (
                    event.key === 'Enter' &&
                    searchActiveIndex > 0 &&
                    searchItems[searchActiveIndex - 1]
                  ) {
                    event.preventDefault();
                    navigateToSearchResult(searchItems[searchActiveIndex - 1].href);
                  }
                }}
              />
              {q && (
                <button className="search-clear" type="button" onClick={() => setQ('')} aria-label="Clear search">
                  Clear
                </button>
              )}
              <kbd>ESC</kbd>
            </form>
            <div className="search-results">
              <button
                className={`search-result${searchActiveIndex === 0 ? ' active' : ''}`}
                type="button"
                onMouseEnter={() => setSearchActiveIndex(0)}
                onClick={() => navigateToSearchResult(q.trim() ? `/conversations?q=${encodeURIComponent(q.trim())}` : '/conversations')}
              >
                <span className="search-result-icon"><MessageSquare size={16} /></span>
                <span>
                  <strong>{q.trim() ? `Search conversations for “${q.trim()}”` : 'Search conversations'}</strong>
                  <small>Find visitors, messages and conversation subjects</small>
                </span>
                <span className="search-enter">↵</span>
              </button>
              {searchItems.map(({ href, label, Icon }, index) => (
                <button
                  className={`search-result${searchActiveIndex === index + 1 ? ' active' : ''}`}
                  key={href}
                  type="button"
                  onMouseEnter={() => setSearchActiveIndex(index + 1)}
                  onClick={() => navigateToSearchResult(href)}
                >
                  <span className="search-result-icon"><Icon size={16} /></span>
                  <span><strong>{label}</strong><small>Go to {label.toLowerCase()}</small></span>
                  <span className="search-enter">↵</span>
                </button>
              ))}
              {searchItems.length === 0 && q.trim() && (
                <p className="search-hint">No matching pages. Press Enter to search conversations.</p>
              )}
            </div>
            <footer className="search-footer">
              <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
              <span><kbd>↵</kbd> to select</span>
              <span>Conversation search checks loaded results</span>
            </footer>
          </section>
        </div>
      )}

      <div className="body">
        <aside className="rail" aria-label="Navigation">
          <div className="pill th">
            <button
              className={cn('ib', theme === 'light' && 'on')}
              id="tl"
              aria-label="Light theme"
              aria-pressed={theme === 'light'}
              onClick={(event) => onThemeToggle('light', event)}
            >
              <svg viewBox="0 0 24 24" width={18} height={18}>
                <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth={1.7} />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
              </svg>
            </button>
            <button
              className={cn('ib', theme === 'dark' && 'on')}
              id="td"
              aria-label="Dark theme"
              aria-pressed={theme === 'dark'}
              onClick={(event) => onThemeToggle('dark', event)}
            >
              <svg viewBox="0 0 24 24">
                <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div className="pill" id="rail">
          {NAV.map(({ href, Icon, label }) => {
            const active = isActive(href);
            return (
            <Link
              key={href}
              className={cn('pi ib', active && 'on')}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              href={href}
            >
              <Icon size={19} />
            </Link>
          );
          })}
        </div>
        <div className="pill">
          <button className="ib" aria-label="Help">
            <HelpIcon size={18} />
            </button>
          <button className="ib" aria-label="Log out" onClick={doSignOut}>
            <LogOutIcon size={18} />
          </button>
        </div>
      </aside>

      <section className="stage">
        {!pathname.startsWith('/conversations/') && (
          <div className="hd page-heading">
            <div>
              <h1>
                {pathname === '/overview' && user?.name
                  ? `${greeting()}, ${user.name.split(/\s+/)[0]}`
                  : titleFor(pathname)}
              </h1>
              <p className="sub">{subtitleFor(pathname)}</p>
            </div>
            {pathname === '/overview' && (
              <Link className="btn s" href="/conversations">Open inbox</Link>
            )}
          </div>
        )}
        {pathname.startsWith('/settings') && (
          <nav className="settings-nav" aria-label="Workspace settings">
            {SETTINGS_NAV.map(({ href, label, Icon }) => {
              const active = pathname.startsWith(href);
              return (
                <Link key={href} href={href} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
                  <Icon size={16} />
                  {label}
                </Link>
              );
            })}
          </nav>
        )}
        <main id="main" aria-live="polite">
          {children}
        </main>
      </section>
      </div>
    </div>
    {twoFactorSetupNeeded && <TwoFactorSetupModal />}
    </>
  );
}
