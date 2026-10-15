/**
 * Realtime fan-out registry (blueprint §9).
 *
 * REST handlers (send message, assign, close) must also push events to
 * connected sockets. The gateway registers an emitter here at boot; before
 * that (and in service-level tests without a gateway) emits are no-ops.
 * Keeps the services free of any socket.io dependency.
 */
export interface RealtimeEmitter {
  toConversation(conversationId: string, event: string, payload: unknown): void;
  toWorkspace(workspaceId: string, event: string, payload: unknown): void;
}

let emitter: RealtimeEmitter | null = null;

export function registerRealtime(impl: RealtimeEmitter | null): void {
  emitter = impl;
}

export function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  emitter?.toConversation(conversationId, event, payload);
}

export function emitToWorkspace(workspaceId: string, event: string, payload: unknown): void {
  emitter?.toWorkspace(workspaceId, event, payload);
}
