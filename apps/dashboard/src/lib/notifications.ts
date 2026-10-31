export interface Notification {
  id: string;
  title: string;
  body: string;
  href?: string;
  read: boolean;
  createdAt: string;
}

type Listener = (n: Notification) => void;

const listeners = new Set<Listener>();
let notifications: Notification[] = [];
let pausedConversationIds = new Set<string>();
let notificationPreferencesReady = false;
let pendingConversationChanges: unknown[] = [];

const MAX = 200;

export function resetNotificationPreferences() {
  pausedConversationIds = new Set();
  notificationPreferencesReady = false;
  pendingConversationChanges = [];
}

export function setPausedConversations(conversationIds: string[]) {
  pausedConversationIds = new Set(conversationIds);
  notificationPreferencesReady = true;
  const pending = pendingConversationChanges;
  pendingConversationChanges = [];
  pending.forEach(notifyConversationChange);
}

export function setConversationNotificationsPaused(conversationId: string, paused: boolean) {
  if (paused) pausedConversationIds.add(conversationId);
  else pausedConversationIds.delete(conversationId);
}

/** Subscribe to new notifications. Returns an unsubscribe function. */
export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish a notification from a live workspace event. */
export function publish(input: Omit<Notification, 'id' | 'read' | 'createdAt'>) {
  const item: Notification = {
    ...input,
    id: crypto.randomUUID(),
    read: false,
    createdAt: new Date().toISOString(),
  };
  notifications = [item, ...notifications].slice(0, MAX);
  listeners.forEach((fn) => fn(item));
  return item;
}

export function notifyVisitorOnline(payload: unknown) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('visitorId' in payload) ||
    typeof payload.visitorId !== 'string' ||
    !('online' in payload) ||
    payload.online !== true
  ) return;
  return publish({
    title: 'Visitor is online',
    body: 'A visitor has opened the chat widget.',
    href: `/visitors/${encodeURIComponent(payload.visitorId)}`,
  });
}

export function notifyConversationChange(payload: unknown) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('conversationId' in payload) ||
    typeof payload.conversationId !== 'string' ||
    (!('status' in payload) && !('assignedTo' in payload))
  ) return;
  if (!notificationPreferencesReady) {
    pendingConversationChanges.push(payload);
    return;
  }
  if (pausedConversationIds.has(payload.conversationId)) return;
  return publish({
    title: 'Conversation updated',
    body: 'A conversation status or assignment changed.',
    href: `/conversations/${encodeURIComponent(payload.conversationId)}`,
  });
}

export function getNotifications(): Notification[] {
  return [...notifications];
}

export function unreadCount(): number {
  return notifications.filter((n) => !n.read).length;
}

export function markAllRead() {
  notifications = notifications.map((n) => ({ ...n, read: true }));
}

export function markRead(id: string) {
  notifications = notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
}

export function clearNotifications() {
  notifications = [];
}
