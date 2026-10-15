'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, getAccessToken, type Conversation, type Message } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { connectAgentSocket, joinConversation, type Socket } from '@/lib/socket';

const TIME = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' });

/** Conversation detail: history + live messages/typing + reply composer. */
export default function ConversationDetailPage() {
  const params = useParams<{ id: string }>();
  const conversationId = params.id;
  const { user } = useAuth();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [typing, setTyping] = useState(false);
  const [online, setOnline] = useState(false);

  const seenIds = useRef(new Set<string>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
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

  // Live socket: join room, receive messages + visitor typing.
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const socket = connectAgentSocket(token, {
      onMessage: (payload) => {
        // Server contract: message:new carries { conversationId, message }.
        const p = payload as { conversationId?: string; message?: Message } | null;
        const m = p?.message;
        if (m && typeof m.id === 'string') appendMessage(m);
      },
      onTyping: (payload) => {
        const p = payload as { by?: string; typing?: boolean };
        if (p.by !== 'visitor') return;
        setTyping(Boolean(p.typing));
        if (typingTimer.current) clearTimeout(typingTimer.current);
        if (p.typing) typingTimer.current = setTimeout(() => setTyping(false), 4000);
      },
      onStatus: (s) => setOnline(s === 'online'),
    });
    socketRef.current = socket;
    joinConversation(socket, conversationId);
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      socket.close();
      socketRef.current = null;
    };
  }, [conversationId, appendMessage]);

  // Auto-scroll on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

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

  async function setStatus(status: 'open' | 'closed') {
    try {
      setConversation(await api.updateConversation(conversationId, { status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  return (
    <>
      <div className="chat-head">
        <Link href="/conversations" className="btn secondary small">
          ← Inbox
        </Link>
        <span
          className={`status-dot ${online ? 'online' : ''}`}
          title={online ? 'Connected' : 'Disconnected'}
        />
        <span className="title">
          {conversation?.subject ?? `Visitor ${conversation?.visitorId?.slice(0, 8) ?? ''}`}
        </span>
        {conversation && (
          <>
            <span className={`badge ${conversation.status}`}>{conversation.status}</span>
            {conversation.status !== 'closed' && (
              <>
                {!conversation.assignedTo && (
                  <button className="btn secondary small" onClick={() => void assignToMe()}>
                    Assign to me
                  </button>
                )}
                <button className="btn danger small" onClick={() => void setStatus('closed')}>
                  Close
                </button>
              </>
            )}
            {conversation.status === 'closed' && (
              <button className="btn secondary small" onClick={() => void setStatus('open')}>
                Reopen
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <div className="alert error" style={{ margin: 12 }}>
          {error}
        </div>
      )}
      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.senderType}`}>
            <span className="body">{m.body}</span>
            <span className="time">{TIME.format(new Date(m.createdAt))}</span>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="typing-line">{typing ? 'Visitor is typing…' : ''}</div>
      <form className="chat-composer" onSubmit={onSend}>
        <textarea
          rows={1}
          placeholder={conversation?.status === 'closed' ? 'Conversation is closed' : 'Type a reply…'}
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
          Send
        </button>
      </form>
    </>
  );
}
