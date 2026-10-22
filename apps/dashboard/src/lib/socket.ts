import { io, type Socket } from 'socket.io-client';
import { API_URL, getAccessToken, refreshSession } from './api';

export type { Socket };

/** Agent-side socket wiring: workspace room (inbox updates) + per-conversation
 *  rooms (live messages, typing). Agents auto-join `workspace:{id}` on connect. */
export interface AgentSocketHandlers {
  onMessage?: (payload: unknown) => void;
  onTyping?: (payload: unknown) => void;
  onConversationUpdated?: (payload: unknown) => void;
  onVisitorPresence?: (payload: unknown) => void;
  onStatus?: (status: 'connecting' | 'online' | 'offline') => void;
}

export function connectAgentSocket(
  token: string,
  handlers: AgentSocketHandlers = {},
): Socket {
  const socket = io(API_URL, {
    path: '/ws',
    transports: ['websocket'],
    // Function form: every (re)connect reads the CURRENT access token (it expires every 15 min).
    auth: (cb) => cb({ token: getAccessToken() ?? token }),
  });

  // Server rejects an expired/invalid token with connect_error {message:'unauthorized'}.
  // Refresh once, then reconnect with the new token instead of looping on a dead one.
  let refreshing = false;
  socket.on('connect_error', async (err) => {
    if (err.message !== 'unauthorized' || refreshing) return;
    refreshing = true;
    try {
      await refreshSession();
      socket.connect();
    } catch {
      handlers.onStatus?.('offline');
    } finally {
      refreshing = false;
    }
  });

  socket.on('connect', () => handlers.onStatus?.('online'));
  socket.io.on('reconnect_attempt', () => handlers.onStatus?.('connecting'));
  socket.on('disconnect', () => handlers.onStatus?.('offline'));

  if (handlers.onConversationUpdated) {
    socket.on('conversation:updated', handlers.onConversationUpdated);
  }
  if (handlers.onVisitorPresence) {
    socket.on('visitor:presence', handlers.onVisitorPresence);
  }
  if (handlers.onMessage) socket.on('message:new', handlers.onMessage);
  if (handlers.onTyping) socket.on('typing', handlers.onTyping);

  return socket;
}

/** Join a conversation room (gate for message:send + typing relay). */
export function joinConversation(socket: Socket, conversationId: string): void {
  socket.emit('conversation:join', { conversationId }, (ack: { ok?: boolean }) => {
    if (!ack?.ok) console.warn('[dashboard] conversation:join not acknowledged');
  });
}
