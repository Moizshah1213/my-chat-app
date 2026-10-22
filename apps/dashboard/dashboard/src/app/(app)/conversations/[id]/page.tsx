'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  api,
  getAccessToken,
  type Conversation,
  type ConversationStatus,
  type Message,
  type VisitorDetail,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { connectAgentSocket, joinConversation, type Socket } from '@/lib/socket';
import InboxList, { timeAgo } from '../../components/inbox-list';
import {
  ArrowLeftIcon,
  ChatIcon,
  ChevronDownIcon,
  EditIcon,
  SendIcon,
  SmileIcon,
  UserIcon,
} from '@/components/icons';

const TIME = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' });
const EMOJIS = ['\uD83D\uDC4D', '\uD83C\uDF89', '\uD83D\uDE04', '\uD83D\uDE4F', '\u2705', '\uD83D\uDD25', '\u2764\uFE0F', '\uD83D\uDE05'];

function whenLabel(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const day = sameDay
    ? 'Today'
    : d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  return `${day} ${TIME.format(d)}`;
}

/** Conversation detail: inbox list + thread (channel tabs, bubbles, composer)
 *  + right-hand contact panel (status, visitor details, sections, actions). */
export default function ConversationDetailPage() {
  const params = useParams<{ id: string }>();
  const conversationId = params.id;
  const { user } = useAuth();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [visitor, setVisitor] = useState<VisitorDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState('');
  const [typing, setTyping] = useState(false);
  const [online, setOnline] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  const seenIds = useRef(new Set<string>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appendMessage = useCallback((msg: Message) => {
    if (seenIds.current.has(msg.id)) return;
    seenIds.current.add(msg.id);
    setMessages((prev) => [...prev, msg]);
  }, []);

  // Load conversation + first page of history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [conv, page] = await Promise.all([
          api.getConversation(conversationId),
          api.listMessages(conversationId),
        ]);
        if (cancelled) return;
        setConversation(conv);
        setSubject(conv.subject ?? '');
        for (const m of page.items) seenIds.current.add(m.id);
        setMessages(page.items);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Contact panel: resolve the visitor behind this conversation.
  useEffect(() => {
    const id = conversation?.visitorId;
    if (!id) return;
    let cancelled = false;
    api
      .getVisitor(id)
      .then((v) => {
        if (!cancelled) setVisitor(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversation?.visitorId]);

  // Realtime: visitor messages, typing, presence, conversation updates.
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const socket = connectAgentSocket(token, {
      onMessage: (payload) => {
        const msg = payload as Message & { conversationId: string };
        if (msg.conversationId === conversationId) appendMessage(msg);
      },
      onTyping: (payload) => {
        const p = payload as { conversationId: string; typing: boolean };
        if (p.conversationId !== conversationId) return;
        setTyping(p.typing);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTyping(false), 3000);
      },
      onVisitorPresence: (payload) => {
        const p = payload as { visitorId: string; online: boolean };
        if (p.visitorId === conversation?.visitorId) setOnline(p.online);
      },
      onConversationUpdated: (payload) => {
        const p = payload as { conversationId?: string };
        if (p.conversationId === conversationId) {
          void api
            .getConversation(conversationId)
            .then(setConversation)
            .catch(() => undefined);
        }
      },
    });
    socketRef.current = socket;
    if (conversation) joinConversation(socket, conversationId);
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [conversationId, conversation, appendMessage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, typing]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    try {
      appendMessage(await api.sendMessage(conversationId, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    }
  }

  async function assignToMe() {
    if (!user) return;
    try {
      setConversation(await api.updateConversation(conversationId, { assignedTo: user.id }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assign failed');
    }
  }

  async function setStatus(status: ConversationStatus) {
    try {
      setConversation(await api.updateConversation(conversationId, { status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  /** Subject is editable here (PATCH /conversations/:id). */
  async function saveSubject() {
    if (!conversation) return;
    const next = subject.trim();
    if (next === (conversation.subject ?? '')) return;
    try {
      setConversation(await api.updateConversation(conversationId, { subject: next || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Subject update failed');
      setSubject(conversation.subject ?? '');
    }
  }

  function insertEmoji(e: string) {
    setEmojiOpen(false);
    setDraft((d) => d + e);
    composerRef.current?.focus();
  }

  const displayName =
    visitor?.name ??
    (conversation?.visitorId ? `Visitor ${conversation.visitorId.slice(0, 8)}` : 'Visitor');
  const [first = '', ...restParts] = displayName.split(' ');
  const last = restParts.join(' ') || '—';
  const metaEntries = Object.entries(visitor?.meta ?? {});

  return (
    <div className="inbox with-contact">
      <InboxList selectedId={conversationId} />

      <div className="inbox-detail thread">
        <div className="thread-head">
          <Link
            href="/conversations"
            className="icon-btn"
            aria-label="Back to inbox"
            data-tip="Back to inbox"
          >
            <ArrowLeftIcon size={17} />
          </Link>
          <span
            className={`status-dot${online ? ' online' : ''}`}
            title={online ? 'Visitor online' : 'Visitor offline'}
          />
          <span className="title">{conversation?.subject ?? displayName}</span>
          {conversation && (
            <span className={`badge ${conversation.status}`}>{conversation.status}</span>
          )}
        </div>

        <div className="tabs" role="tablist" aria-label="Channels">
          <button className="tab active" type="button" role="tab" aria-selected="true">
            All
          </button>
          <button
            className="tab"
            type="button"
            role="tab"
            aria-selected="false"
            disabled
            title="Channel not connected"
          >
            SMS
          </button>
          <button
            className="tab"
            type="button"
            role="tab"
            aria-selected="false"
            disabled
            title="Channel not connected"
          >
            Email
          </button>
          <button
            className="tab"
            type="button"
            role="tab"
            aria-selected="false"
            disabled
            title="Channel not connected"
          >
            Messenger
          </button>
        </div>

        {error && (
          <div className="alert error" style={{ margin: 12 }}>
            {error}
          </div>
        )}

        <div className="chat-messages">
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.senderType}`}>
              <span className="msg-meta">
                <span className="sender">
                  {m.senderType === 'agent' ? user?.name || 'You' : displayName}
                </span>
                <ChatIcon size={12} />
                <span className="when">{whenLabel(m.createdAt)}</span>
              </span>
              <span className="body">{m.body}</span>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="typing-line">{typing ? 'Visitor is typing…' : ''}</div>

        <form className="chat-composer" onSubmit={onSend}>
          <input
            className="subject-input"
            placeholder="Subject"
            aria-label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={() => void saveSubject()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void saveSubject();
              }
            }}
          />
          <div className="composer-row">
            <div className="emoji-wrap">
              <button
                className="icon-btn"
                type="button"
                aria-label="Insert emoji"
                aria-expanded={emojiOpen}
                onClick={() => setEmojiOpen((o) => !o)}
              >
                <SmileIcon size={17} />
              </button>
              {emojiOpen && (
                <div className="emoji-pop">
                  {EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      aria-label="Insert emoji"
                      onClick={() => insertEmoji(e)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <textarea
              ref={composerRef}
              rows={1}
              placeholder={
                conversation?.status === 'closed' ? 'Conversation is closed' : 'Enter text'
              }
              aria-label="Reply"
              value={draft}
              disabled={conversation?.status === 'closed'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              className="btn"
              type="submit"
              disabled={conversation?.status === 'closed' || !draft.trim()}
            >
              <SendIcon size={15} />
              Send
            </button>
          </div>
        </form>
      </div>

      <aside className="contact" aria-label="Contact details">
        <div className="contact-head">
          <label className="contact-status">
            <UserIcon size={14} />
            <select
              aria-label="Conversation status"
              value={conversation?.status ?? 'open'}
              disabled={!conversation}
              onChange={(e) => void setStatus(e.target.value as ConversationStatus)}
            >
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="closed">Closed</option>
            </select>
            <ChevronDownIcon size={13} />
          </label>
        </div>

        <div className="contact-body">
          <div className="contact-title">
            <h3>Contact Details</h3>
            <Link
              className="link-edit"
              href={
                conversation?.visitorId ? `/visitors/${conversation.visitorId}` : '/visitors'
              }
            >
              <EditIcon size={13} />
              EDIT
            </Link>
          </div>
          <dl className="detail-rows">
            <div className="detail-row">
              <dt>First Name</dt>
              <dd>{first || '—'}</dd>
            </div>
            <div className="detail-row">
              <dt>Last Name</dt>
              <dd>{last}</dd>
            </div>
            <div className="detail-row">
              <dt>Email</dt>
              <dd>{visitor?.email ?? '—'}</dd>
            </div>
            <div className="detail-row">
              <dt>Visitor ID</dt>
              <dd className="mono">{conversation?.visitorId?.slice(0, 12) ?? '—'}</dd>
            </div>
            <div className="detail-row">
              <dt>Status</dt>
              <dd>
                {conversation && (
                  <span className={`badge ${conversation.status}`}>{conversation.status}</span>
                )}
              </dd>
            </div>
          </dl>

          <details className="collapse">
            <summary>
              Attributes <span className="count-pill">{metaEntries.length}</span>
              <ChevronDownIcon size={14} />
            </summary>
            {metaEntries.length === 0 ? (
              <div className="muted small">No attributes captured.</div>
            ) : (
              <dl className="detail-rows">
                {metaEntries.map(([k, v]) => (
                  <div className="detail-row" key={k}>
                    <dt>{k}</dt>
                    <dd>{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—')}</dd>
                  </div>
                ))}
              </dl>
            )}
          </details>

          <details className="collapse">
            <summary>
              Conversations <span className="count-pill">{visitor?.conversations.length ?? 0}</span>
              <ChevronDownIcon size={14} />
            </summary>
            {!visitor && <div className="muted small">Loading…</div>}
            {visitor && visitor.conversations.length === 0 && (
              <div className="muted small">No other conversations.</div>
            )}
            {(visitor?.conversations ?? []).map((c) => (
              <Link
                key={c.id}
                className={`conv-mini${c.id === conversationId ? ' current' : ''}`}
                href={`/conversations/${c.id}`}
              >
                <span className="who">{c.subject ?? 'Conversation'}</span>
                <span className={`badge ${c.status}`}>{c.status}</span>
                <span className="when">{timeAgo(c.lastMessageAt)}</span>
              </Link>
            ))}
          </details>

          <details className="collapse">
            <summary>
              Session
              <ChevronDownIcon size={14} />
            </summary>
            <dl className="detail-rows">
              <div className="detail-row">
                <dt>First seen</dt>
                <dd>{visitor ? new Date(visitor.firstSeen).toLocaleString() : '—'}</dd>
              </div>
              <div className="detail-row">
                <dt>Last seen</dt>
                <dd>{visitor ? timeAgo(visitor.lastSeen) : '—'}</dd>
              </div>
              <div className="detail-row">
                <dt>Socket</dt>
                <dd>{online ? 'online' : 'offline'}</dd>
              </div>
            </dl>
          </details>
        </div>

        <div className="contact-actions">
          {conversation && conversation.status !== 'closed' && !conversation.assignedTo && (
            <button className="btn" onClick={() => void assignToMe()}>
              Assign to me
            </button>
          )}
          {conversation && conversation.status !== 'closed' && (
            <button className="btn danger" onClick={() => void setStatus('closed')}>
              Close conversation
            </button>
          )}
          {conversation?.status === 'closed' && (
            <button className="btn" onClick={() => void setStatus('open')}>
              Reopen conversation
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
