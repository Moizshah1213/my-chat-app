'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, getAccessToken, type Conversation, type ConversationStatus } from '@/lib/api';
import { connectAgentSocket, type Socket } from '@/lib/socket';

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

/** Agent inbox: filterable conversation list with live workspace updates. */
export default function ConversationsPage() {
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<ConversationStatus | ''>('');
  const [assignee, setAssignee] = useState<'me' | 'unassigned' | 'any'>('any');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const socketRef = useRef<Socket | null>(null);

  const load = useCallback(
    async (nextCursor?: string) => {
      setError('');
      try {
        const page = await api.listConversations({
          ...(status ? { status } : {}),
          assignee,
          ...(nextCursor ? { cursor: nextCursor } : {}),
          limit: 50,
        });
        setItems((prev) => (nextCursor ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load conversations');
      } finally {
        setLoading(false);
      }
    },
    [status, assignee],
  );

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Live inbox updates: workspace room events (assign/close/new) → refetch.
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const socket = connectAgentSocket(token, {
      onConversationUpdated: () => void load(),
    });
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [load]);

  return (
    <>
      <div className="topbar">
        <h1>Conversations</h1>
      </div>
      <div className="inbox">
        <div className="inbox-list">
          <div className="filters">
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ConversationStatus | '')}
            >
              <option value="">All statuses</option>
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="closed">Closed</option>
            </select>
            <select
              aria-label="Assignee"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value as typeof assignee)}
            >
              <option value="any">Anyone</option>
              <option value="me">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </div>
          {error && <div className="alert error" style={{ margin: 12 }}>{error}</div>}
          {loading && items.length === 0 && <div className="loading">Loading…</div>}
          {!loading && items.length === 0 && !error && (
            <div className="empty-state" style={{ padding: 40 }}>
              No conversations yet.
            </div>
          )}
          {items.map((c) => (
            <Link key={c.id} className="conv-item" href={`/conversations/${c.id}`}>
              <div className="top">
                <span className="who">{c.subject ?? `Visitor ${c.visitorId?.slice(0, 8) ?? '—'}`}</span>
                <span className={`badge ${c.status}`}>{c.status}</span>
              </div>
              <div className="top" style={{ marginTop: 4 }}>
                <span className="when">{timeAgo(c.lastMessageAt)}</span>
                {c.assignedTo && <span className="when">assigned</span>}
              </div>
            </Link>
          ))}
          {cursor && (
            <div className="pager">
              <button className="btn secondary small" onClick={() => void load(cursor)}>
                Load more
              </button>
            </div>
          )}
        </div>
        <div className="inbox-detail">
          <div className="empty-state">Select a conversation to start replying.</div>
        </div>
      </div>
    </>
  );
}
