'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type VisitorSummary } from '@/lib/api';

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return RELATIVE.format(-mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 24) return RELATIVE.format(-hours, 'hour');
  return RELATIVE.format(-Math.round(hours / 24), 'day');
}

/** Visitors list (blueprint §12): who has chatted, with their attributes. */
export default function VisitorsPage() {
  const [items, setItems] = useState<VisitorSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setItems(await api.listVisitors());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load visitors');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="topbar">
        <h1>Visitors</h1>
      </div>
      <div className="content">
        {error && <div className="alert error">{error}</div>}
        {loading && items.length === 0 && <div className="loading">Loading…</div>}
        {!loading && items.length === 0 && !error && (
          <div className="empty-state">No visitors yet — they appear after first widget chat.</div>
        )}
        {items.length > 0 && (
          <div className="card">
            <table className="list">
              <thead>
                <tr>
                  <th>Visitor</th>
                  <th>Email</th>
                  <th>Attributes</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {items.map((v) => {
                  const attrCount = Object.keys(v.meta ?? {}).length;
                  return (
                    <tr key={v.id}>
                      <td>
                        <Link href={`/visitors/${v.id}`}>
                          {v.name ?? `Visitor ${v.id.slice(0, 8)}`}
                        </Link>
                      </td>
                      <td className="muted">{v.email ?? '—'}</td>
                      <td className="muted">{attrCount > 0 ? `${attrCount} set` : '—'}</td>
                      <td className="muted">{timeAgo(v.lastSeen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
