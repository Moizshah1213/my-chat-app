'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
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
import { setConversationNotificationsPaused } from '@/lib/notifications';
import InboxList from '@/app/(app)/components/inbox-list';
import { ArrowLeftIcon, Bell, BellOff, MoreVertical, Pencil, SendIcon, SmileIcon, Trash2, UserIcon, X } from 'lucide-react';

const TIME = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' });
const EMOJIS = ['👍', '🎉', '😄', '🙏', '✅', '🔥', '❤️', '😅'];
const GROUP_GAP_MS = 5 * 60 * 1000;

type Live = 'connecting' | 'live' | 'offline';
type TypingSender = 'visitor' | 'ai' | null;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'V';
}

function timeLabel(iso?: string): string {
  const d = new Date(iso ?? '');
  return isNaN(d.getTime()) ? '' : TIME.format(d);
}

function timeAgo(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (isNaN(timestamp)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function dayKey(m: Message): string {
  const d = new Date(m.createdAt ?? '');
  return isNaN(d.getTime()) ? '' : d.toDateString();
}

function dayLabel(m: Message): string {
  const d = new Date(m.createdAt ?? '');
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function buildRows(messages: Message[]) {
  const close = (a?: Message, b?: Message) =>
    !!a &&
    !!b &&
    a.senderType === b.senderType &&
    dayKey(a) === dayKey(b) &&
    Math.abs(new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()) <
      GROUP_GAP_MS;
  return messages.map((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    return {
      m,
      day: !prev || dayKey(prev) !== dayKey(m) ? dayLabel(m) : '',
      start: !close(prev, m),
      end: !close(m, next),
    };
  });
}

export default function ConversationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const conversationId = params.id;
  const { user } = useAuth();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [visitor, setVisitor] = useState<VisitorDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState('');
  const [typingBy, setTypingBy] = useState<TypingSender>(null);
  const [online, setOnline] = useState(false);
  const [live, setLive] = useState<Live>('connecting');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [notificationsPaused, setNotificationsPaused] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [actionMenuMessageId, setActionMenuMessageId] = useState<string | null>(null);
  const [retrySend, setRetrySend] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  const seenIds = useRef(new Set<string>());
  const endRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentTypingLastAt = useRef(0);
  const activeSocket = useRef<Socket | null>(null);
  const typingSenderRef = useRef<TypingSender>(null);
  const visitorIdRef = useRef<string | undefined>(undefined);
  const pendingSend = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    if (!actionMenuMessageId) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('[data-message-action-menu]')) {
        setActionMenuMessageId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionMenuMessageId(null);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [actionMenuMessageId]);

  const closed = conversation?.status === 'closed';

  const updateTypingSender = (sender: TypingSender) => {
    typingSenderRef.current = sender;
    setTypingBy(sender);
  };

  const appendMessage = useCallback((msg: Message) => {
    if (seenIds.current.has(msg.id)) return;
    seenIds.current.add(msg.id);
    setMessages((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    seenIds.current = new Set();
    setMessages([]);
    setConversation(null);
    setVisitor(null);
    updateTypingSender(null);
    setError('');
    (async () => {
      try {
        const [conv, page, notificationPreference] = await Promise.all([
          api.getConversation(conversationId),
          api.listMessages(conversationId),
          api.getNotificationPreference(conversationId),
        ]);
        if (cancelled) return;
        setConversation(conv);
        setSubject(conv.subject ?? '');
        setNotificationsPaused(notificationPreference.paused);
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

  useEffect(() => {
    const id = conversation?.visitorId;
    visitorIdRef.current = id ?? undefined;
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

  useEffect(() => {
    let socket: Socket | null = null;
    let waitTimer: ReturnType<typeof setInterval> | null = null;

    const start = (): boolean => {
      const token = getAccessToken();
      if (!token) return false;
      const s = connectAgentSocket(token, {
        onMessage: (payload) => {
          const p = payload as Message & { conversationId?: string; conversation_id?: string };
          const cid = p.conversationId ?? p.conversation_id;
          if (cid === conversationId) {
            if (p.senderType === 'ai') updateTypingSender(null);
            appendMessage(p);
          }
        },
        onMessageUpdated: (payload) => {
          const message = payload as Message;
          if (message.conversationId === conversationId) {
            setMessages((current) => current.map((item) => item.id === message.id ? message : item));
          }
        },
        onMessageDeleted: (payload) => {
          const event = payload as { conversationId: string; messageId: string };
          if (event.conversationId === conversationId) {
            setMessages((current) => current.filter((item) => item.id !== event.messageId));
          }
        },
        onConversationDeleted: (payload) => {
          if ((payload as { conversationId?: string }).conversationId === conversationId) {
            router.replace('/conversations');
          }
        },
        onTyping: (payload) => {
          const p = payload as { conversationId: string; typing: boolean; by?: string };
          if (p.conversationId !== conversationId) return;
          const sender = p.by === 'ai' ? 'ai' : p.by === 'visitor' ? 'visitor' : null;
          if (p.typing && !sender) return;
          if (!p.typing && typingSenderRef.current !== sender) return;
          updateTypingSender(p.typing ? sender : null);
          if (typingTimer.current) clearTimeout(typingTimer.current);
          if (p.typing) typingTimer.current = setTimeout(() => updateTypingSender(null), 3000);
        },
        onVisitorPresence: (payload) => {
          const p = payload as { visitorId: string; online: boolean };
          if (p.visitorId === visitorIdRef.current) setOnline(p.online);
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
      socket = s;
      activeSocket.current = s;
      const join = () => {
        joinConversation(s, conversationId);
        setLive('live');
      };
      s.on('connect', join);
      s.on('disconnect', () => setLive('offline'));
      s.on('connect_error', () => setLive('offline'));
      if (s.connected) join();
      return true;
    };

    setLive('connecting');
    if (!start()) {
      waitTimer = setInterval(() => {
        if (start() && waitTimer) {
          clearInterval(waitTimer);
          waitTimer = null;
        }
      }, 500);
    }

    return () => {
      if (waitTimer) clearInterval(waitTimer);
      if (agentTypingTimer.current) clearTimeout(agentTypingTimer.current);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      socket?.emit('typing', { conversationId, typing: false });
      if (activeSocket.current === socket) activeSocket.current = null;
      socket?.close();
    };
  }, [conversationId, appendMessage, router]);

  useEffect(() => {
    if (live === 'live') return;
    const t = setInterval(() => {
      api
        .listMessages(conversationId)
        .then((page) => {
          for (const m of page.items) appendMessage(m);
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, [live, conversationId, appendMessage]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, typingBy]);

  function emitAgentTyping(typing: boolean) {
    if (typing) {
      const now = Date.now();
      if (now - agentTypingLastAt.current > 1000) {
        activeSocket.current?.emit('typing', { conversationId, typing: true });
        agentTypingLastAt.current = now;
      }
      if (agentTypingTimer.current) clearTimeout(agentTypingTimer.current);
      agentTypingTimer.current = setTimeout(() => {
        activeSocket.current?.emit('typing', { conversationId, typing: false });
        agentTypingLastAt.current = 0;
      }, 1500);
    } else {
      if (agentTypingTimer.current) clearTimeout(agentTypingTimer.current);
      activeSocket.current?.emit('typing', { conversationId, typing: false });
      agentTypingLastAt.current = 0;
    }
  }

  async function onSend(e?: React.FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || (closed && !editingMessageId) || busyAction) return;
    setBusyAction(true);
    if (agentTypingTimer.current) clearTimeout(agentTypingTimer.current);
    emitAgentTyping(false);
    setDraft('');
    if (composerRef.current) composerRef.current.style.height = 'auto';
    try {
      if (editingMessageId) {
        const message = await api.editMessage(conversationId, editingMessageId, body);
        setMessages((current) => current.map((item) => item.id === message.id ? message : item));
        setEditingMessageId(null);
      } else {
        const key = pendingSend.current?.body === body ? pendingSend.current.key : crypto.randomUUID();
        pendingSend.current = { body, key };
        appendMessage(await api.sendMessage(conversationId, body, key));
        pendingSend.current = null;
      }
      setRetrySend(false);
    } catch (err) {
      setDraft(body);
      setError(err instanceof Error ? err.message : 'Send failed');
      setRetrySend(!editingMessageId);
    } finally {
      setBusyAction(false);
    }
  }

  async function toggleNotifications() {
    try {
      const result = await api.updateNotificationPreference(conversationId, !notificationsPaused);
      setNotificationsPaused(result.paused);
      setConversationNotificationsPaused(conversationId, result.paused);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update notification settings');
    }
  }

  async function deleteConversation() {
    if (!window.confirm('Delete this conversation and hide its messages from the workspace?')) return;
    try {
      await api.deleteConversation(conversationId);
      router.replace('/conversations');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete conversation');
    }
  }

  async function deleteMessage(message: Message) {
    if (!window.confirm('Delete this message?')) return;
    try {
      await api.deleteMessage(conversationId, message.id);
      setMessages((current) => current.filter((item) => item.id !== message.id));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete message');
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
  const metaEntries = Object.entries(visitor?.meta ?? {});
  const others = (visitor?.conversations ?? []).filter((c) => c.id !== conversationId);
  const rows = buildRows(messages);
  const sub = online
    ? 'Online'
    : visitor?.lastSeen
      ? `Last seen ${timeAgo(visitor.lastSeen)}`
      : 'Offline';

  return (
    <div className={`inbox${infoOpen ? ' cv-info' : ''}`}>
      <InboxList selectedId={conversationId} />

      <div className="cv-thread">
        <div className="cv-head">
          <Link href="/conversations" className="icon-btn cv-back" aria-label="Back to inbox">
            <ArrowLeftIcon size={17} />
          </Link>
          <span className="cv-avatar">{initials(displayName)}</span>
          <div className="cv-who">
            <b>{conversation?.subject || displayName}</b>
            <small>
              <i className={`cv-dot${online ? ' on' : ''}`} />
              {sub}
            </small>
          </div>
          {conversation && !closed && !conversation.assignedTo && (
            <button className="cv-ghost" type="button" onClick={() => void assignToMe()}>
              Assign to me
            </button>
          )}
          <select
            className="cv-select"
            aria-label="Conversation status"
            value={conversation?.status ?? 'open'}
            disabled={!conversation}
            onChange={(e) => void setStatus(e.target.value as ConversationStatus)}
          >
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="closed">Closed</option>
          </select>
          <button
            className={`icon-btn${infoOpen ? ' cv-on' : ''}`}
            type="button"
            aria-label="Contact details"
            aria-pressed={infoOpen}
            onClick={() => setInfoOpen((o) => !o)}
          >
            <UserIcon size={16} />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label={notificationsPaused ? 'Resume notifications' : 'Pause notifications'}
            aria-pressed={notificationsPaused}
            onClick={() => void toggleNotifications()}
          >
            {notificationsPaused ? <BellOff size={16} /> : <Bell size={16} />}
          </button>
          <button className="icon-btn" type="button" aria-label="Delete conversation" onClick={() => void deleteConversation()}>
            <Trash2 size={16} />
          </button>
        </div>

        {error && (
          <div className="alert cv-alert">
            {error}
            {retrySend && <button className="cv-retry" type="button" onClick={() => void onSend()}>Retry send</button>}
          </div>
        )}

        <div className="cv-msgs">
          {rows.map(({ m, day, start, end }) => (
            <Fragment key={m.id}>
              {day && <div className="cv-day">{day}</div>}
              <div
                className={`cv-row ${m.senderType === 'agent' ? 'a' : m.senderType === 'ai' ? 'ai' : 'v'}${start ? ' start' : ''}${end ? ' end' : ''}`}
              >
                <div className="cv-message-wrap">
                {m.senderType === 'agent' && m.senderId === user?.id && (
                  <div className="cv-message-actions" data-message-action-menu>
                    <button
                      className="cv-message-menu-trigger"
                      type="button"
                      aria-label="More message actions"
                      aria-haspopup="menu"
                      aria-expanded={actionMenuMessageId === m.id}
                      onClick={() => setActionMenuMessageId((current) => current === m.id ? null : m.id)}
                    >
                      <MoreVertical size={16} />
                    </button>
                    {actionMenuMessageId === m.id && (
                      <div className="cv-message-menu" role="menu" aria-label="Message actions">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setActionMenuMessageId(null);
                            setEditingMessageId(m.id);
                            setDraft(m.body);
                            composerRef.current?.focus();
                          }}
                        >
                          <Pencil size={14} />
                          <span>Edit</span>
                        </button>
                        <button type="button" role="menuitem" className="danger" onClick={() => {
                          setActionMenuMessageId(null);
                          void deleteMessage(m);
                        }}>
                          <Trash2 size={14} />
                          <span>Delete</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
                  <div className="cv-bubble">
                    {(String(m.senderType) === 'ai' || String(m.senderType) === 'bot') && (
                      <span className="cv-tag">AI</span>
                    )}
                    {m.body}
                  </div>
                </div>
                {end && <span className="cv-time">{timeLabel(m.createdAt)}{m.editedAt ? ' · edited' : ''}</span>}
              </div>
            </Fragment>
          ))}
          {typingBy && (
            <div className={`cv-row ${typingBy === 'ai' ? 'ai' : 'v'} start end`}>
              <div className="cv-typing" aria-label={typingBy === 'ai' ? 'AI assistant is typing' : 'Visitor is typing'}>
                <i />
                <i />
                <i />
                <span>{typingBy === 'ai' ? 'AI assistant is typing' : 'Visitor is typing'}</span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {closed && !editingMessageId ? (
          <div className="cv-closed">
            <span>This conversation is closed.</span>
            <button className="cv-ghost" type="button" onClick={() => void setStatus('open')}>
              Reopen
            </button>
          </div>
        ) : (
          <form className="cv-composer" onSubmit={onSend}>
            {editingMessageId && (
              <button
                className="cv-icon"
                type="button"
                aria-label="Cancel edit"
                onClick={() => { setEditingMessageId(null); setDraft(''); }}
              >
                <X size={15} />
              </button>
            )}
            <div className="emoji-wrap">
              <button
                className="cv-icon"
                type="button"
                aria-label="Insert emoji"
                aria-expanded={emojiOpen}
                onClick={() => setEmojiOpen((o) => !o)}
              >
                <SmileIcon size={18} />
              </button>
              {emojiOpen && (
                <div className="emoji-pop">
                  {EMOJIS.map((e) => (
                    <button key={e} type="button" aria-label="Insert emoji" onClick={() => insertEmoji(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <textarea
              ref={composerRef}
              rows={1}
              placeholder="Write a reply…"
              aria-label="Reply"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                emitAgentTyping(Boolean(e.target.value));
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
            />
            <button className="cv-send" type="submit" aria-label={editingMessageId ? 'Save message' : 'Send'} disabled={!draft.trim() || busyAction}>
              {editingMessageId ? <Pencil size={16} /> : <SendIcon size={16} />}
            </button>
          </form>
        )}
      </div>

      {infoOpen && (
        <aside className="cv-panel" aria-label="Contact details">
          <h3>Details</h3>
          <dl className="cv-kv">
            <div>
              <dt>Name</dt>
              <dd>{visitor?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{visitor?.email ?? '—'}</dd>
            </div>
            <div>
              <dt>Visitor ID</dt>
              <dd className="mono">{conversation?.visitorId?.slice(0, 12) ?? '—'}</dd>
            </div>
            <div>
              <dt>First seen</dt>
              <dd>{visitor ? new Date(visitor.firstSeen).toLocaleDateString() : '—'}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{visitor ? timeAgo(visitor.lastSeen) : '—'}</dd>
            </div>
          </dl>

          <label className="cv-field">
            <span>Subject</span>
            <input
              value={subject}
              placeholder="Add a subject"
              onChange={(e) => setSubject(e.target.value)}
              onBlur={() => void saveSubject()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveSubject();
                }
              }}
            />
          </label>

          {metaEntries.length > 0 && (
            <>
              <h4>Attributes</h4>
              <dl className="cv-kv">
                {metaEntries.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—')}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {others.length > 0 && (
            <>
              <h4>Other conversations</h4>
              <div className="cv-list">
                {others.map((c) => (
                  <Link key={c.id} href={`/conversations/${c.id}`}>
                    <span>{c.subject ?? 'Conversation'}</span>
                    <small>{timeAgo(c.lastMessageAt)}</small>
                  </Link>
                ))}
              </div>
            </>
          )}
        </aside>
      )}
    </div>
  );
}