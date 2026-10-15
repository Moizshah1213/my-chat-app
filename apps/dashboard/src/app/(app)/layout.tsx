'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';

const NAV = [
  { href: '/conversations', label: 'Conversations' },
  { href: '/visitors', label: 'Visitors' },
  { href: '/settings/api-keys', label: 'API Keys' },
  { href: '/settings/widget', label: 'Widget Settings' },
  { href: '/settings/members', label: 'Team' },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/activity', label: 'Activity' },
];

/** Authenticated shell: guards the route, renders sidebar + user box. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, role, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) return <div className="loading">Loading…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">LiveChat</div>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={pathname.startsWith(n.href) ? 'active' : ''}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        <div className="userbox">
          <div className="email">{user.email}</div>
          <div className="role">{role}</div>
          <button
            className="btn secondary small"
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => {
              void signOut().then(() => router.replace('/login'));
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="main">{children}</div>
    </div>
  );
}
