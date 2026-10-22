'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, getAccessToken, type Conversation, type ConversationStatus } from '@/lib/api';
import { connectAgentSocket, type Socket } from '@/lib/socket';
import { useAuth } from '@/lib/auth';
import { RefreshIcon, SearchIcon, UserIcon } from '@/components/icons';

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return RELATIVE.format(-mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 24) return RELATIVE.format(-hours, 'hour');
  return RELATIVE.format(-Math.round(hours / 24), 'day');
}

/** Avatar initials from a label ("Mary Smith" → "MS", fallback "VI"). */
function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'VI';
  return parts
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

interface Props {
  /** Conversation highlighted as active (detail view). */
  selectedId?: string;
}

/** Shared inbox conversation list: search, status/assignee filters, live updates. */
export default function InboxList({ selectedId }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<ConversationStatus | ''>('');
  const [assignee, setAssignee] = useState<'me' | 'unassigned' | 'any'>('any');
  const [query, setQuery] = useState('');
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

  // Global search: initial ?q= from the topbar jump + live "lc-search" events.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('q');
    if (initial) setQuery(initial);
    const onSearch = (e: Event) => setQuery(String((e as CustomEvent<string>).detail ?? ''));
    window.addEventListener('lc-search', onSearch);
    return () => window.removeEventListener('lc-search', onSearch);
  }, []);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? items.filter((c) =>
        `${c.subject ?? ''} ${c.visitor?.name ?? ''} ${c.visitor?.email ?? ''} ${c.visitorId ?? ''}`.toLowerCase().includes(needle),
      )
    : items;

  return (
    <div className="inbox-list">
      <div className="list-tools">
        <label className="search-pill">
          <SearchIcon size={15} />
          <input
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          className="pill-select"
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as ConversationStatus | '')}
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      <div className="list-tools sub">
        <select
          className="pill-select"
          aria-label="Assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value as typeof assignee)}
        >
          <option value="any">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <span className="list-count">
          {visible.length} {visible.length === 1 ? 'conversation' : 'conversations'}
        </span>
        <button
          className="icon-btn"
          onClick={() => void load()}
          aria-label="Refresh conversations"
          data-tip="Refresh"
        >
          <RefreshIcon size={15} />
        </button>
      </div>

      {error && <div className="alert error" style={{ margin: 12 }}>{error}</div>}
      {loading && items.length === 0 && <div className="loading">Loading…</div>}
      {!loading && visible.length === 0 && !error && (
        <div className="empty-state" style={{ padding: 40 }}>
          {needle ? 'No conversations match your search.' : 'No conversations yet.'}
        </div>
      )}
      {visible.map((c) => {
        const label =
          c.subject ??
          c.visitor?.name ??
          c.visitor?.email ??
          `Visitor ${c.visitorId?.slice(0, 8) ?? '—'}`;
        const assigned = Boolean(c.assignedTo);
        const mine = Boolean(c.assignedTo) && c.assignedTo === user?.id;
        return (
          <Link
            key={c.id}
            className={`conv-item${selectedId === c.id ? ' active' : ''}`}
            href={`/conversations/${c.id}`}
            aria-current={selectedId === c.id ? 'page' : undefined}
          >
            <span className="conv-avatar" aria-hidden="true">
              {initialsOf(label)}
            </span>
            <span className="conv-main">
              <span className="conv-row">
                <span className="who">{label}</span>
                <span className={`badge ${c.status}`}>{c.status}</span>
              </span>
              <span className="conv-row sub">
                <span className="when">{timeAgo(c.lastMessageAt)}</span>
                <span className={`assignee-chip${assigned ? '' : ' none'}`}>
                  <UserIcon size={11} />
                  {mine ? 'You' : assigned ? 'Teammate' : 'Unassigned'}
                </span>
              </span>
            </span>
          </Link>
        );
      })}
      {cursor && (
        <div className="pager">
          <button className="btn s" onClick={() => void load(cursor)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
