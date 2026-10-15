'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, type VisitorDetail } from '@/lib/api';

const WHEN = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Visitor detail (blueprint §12): profile, attributes, their conversations. */
export default function VisitorDetailPage() {
  const params = useParams<{ id: string }>();
  const visitorId = params.id;
  const [visitor, setVisitor] = useState<VisitorDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await api.getVisitor(visitorId);
        if (!cancelled) setVisitor(v);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load visitor');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visitorId]);

  const attrs = Object.entries(visitor?.meta ?? {});

  return (
    <>
      <div className="topbar" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Link href="/visitors" className="btn secondary small">
          ← Visitors
        </Link>
        <h1>{visitor?.name ?? `Visitor ${visitorId.slice(0, 8)}`}</h1>
      </div>
      <div className="content">
        {error && <div className="alert error">{error}</div>}
        {visitor && (
          <>
            <div className="card">
              <h2>Profile</h2>
              <table className="list">
                <tbody>
                  <tr>
                    <td className="muted">Email</td>
                    <td>{visitor.email ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="muted">First seen</td>
                    <td>{WHEN.format(new Date(visitor.firstSeen))}</td>
                  </tr>
                  <tr>
                    <td className="muted">Last seen</td>
                    <td>{WHEN.format(new Date(visitor.lastSeen))}</td>
                  </tr>
                </tbody>
              </table>
              <h2 style={{ marginTop: 16 }}>Attributes</h2>
              {attrs.length === 0 ? (
                <p className="muted" style={{ marginBottom: 0 }}>
                  No attributes — set them from your site with{' '}
                  <code>{'LiveChat.setAttributes({...})'}</code>.
                </p>
              ) : (
                <table className="list">
                  <tbody>
                    {attrs.map(([k, v]) => (
                      <tr key={k}>
                        <td className="muted">{k}</td>
                        <td className="mono">{String(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h2>Conversations</h2>
              {visitor.conversations.length === 0 ? (
                <p className="muted" style={{ marginBottom: 0 }}>
                  No conversations yet.
                </p>
              ) : (
                <table className="list">
                  <thead>
                    <tr>
                      <th>Subject</th>
                      <th>Status</th>
                      <th>Last message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visitor.conversations.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link href={`/conversations/${c.id}`}>
                            {c.subject ?? `Conversation ${c.id.slice(0, 8)}`}
                          </Link>
                        </td>
                        <td>
                          <span className={`badge ${c.status}`}>{c.status}</span>
                        </td>
                        <td className="muted">{WHEN.format(new Date(c.lastMessageAt))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
