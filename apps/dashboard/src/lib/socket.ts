import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

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
    auth: { token },
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
