import { io, type Socket } from 'socket.io-client';
import type { ChatMessage } from './types.js';

export interface SocketHandlers {
  onMessage(msg: ChatMessage): void;
  onTyping(typing: boolean): void;
  onStatus(status: 'connecting' | 'online' | 'offline'): void;
}

/**
 * Connect to the chat gateway (/ws) with the visitor token, join the
 * conversation room, and wire message + typing events. socket.io auto-
 * reconnects; on every (re)connect we re-join the room.
 */
export function connectChat(
  apiUrl: string,
  token: string,
  conversationId: string,
  handlers: SocketHandlers,
): Socket {
  const socket = io(apiUrl, {
    path: '/ws',
    transports: ['websocket'],
    auth: { token },
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

  socket.on('connect', () => {
    handlers.onStatus('online');
    socket.emit('conversation:join', { conversationId }, (ack: { ok?: boolean }) => {
      if (!ack?.ok) console.warn('[livechat] conversation:join was not acknowledged');
    });
  });
  socket.io.on('reconnect_attempt', () => handlers.onStatus('connecting'));
  socket.on('disconnect', () => handlers.onStatus('offline'));

  socket.on('message:new', (payload: unknown) => {
    // Server contract: message:new carries { conversationId, message }.
    const p = payload as { conversationId?: string; message?: Partial<ChatMessage> } | null;
    const m = p?.message;
    if (m && typeof m.id === 'string' && typeof m.body === 'string') {
      handlers.onMessage(m as ChatMessage);
    }
  });
  socket.on('typing', (payload: unknown) => {
    const p = payload as { conversationId?: string; typing?: boolean; by?: string } | null;
    if (p && p.conversationId === conversationId && p.by === 'agent') {
      handlers.onTyping(Boolean(p.typing));
    }
  });

  return socket;
}
