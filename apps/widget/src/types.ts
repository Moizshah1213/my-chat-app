/** Public widget settings — the projection returned by GET /widget/v1/settings. */
export interface WidgetSettings {
  color: string;
  logoUrl: string | null;
  position: 'left' | 'right';
  greeting: string | null;
  offlineMessage: string | null;
  prechatFields: PrechatField[];
  workingHours: Record<string, unknown>;
  aiEnabled: boolean;
  language: string;
}

/** A pre-chat form field, e.g. { name: 'email', label: 'Email', required: true }. */
export interface PrechatField {
  name: string;
  label?: string;
  type?: 'text' | 'email' | 'tel';
  required?: boolean;
}

/** Result of POST /widget/v1/visitor_init. */
export interface VisitorInitResult {
  visitorId: string;
  conversationId: string;
  token: string;
  expiresAt: string;
  /** Recent conversation history (oldest→newest) so a reload re-opens in place. */
  messages?: ChatMessage[];
}

/** A chat message as fanned out by the `message:new` socket event. */
export interface ChatMessage {
  id: string;
  body: string;
  senderType: 'agent' | 'visitor';
  createdAt: string;
}

/** Events the host page can subscribe to via LiveChat.on(...). */
export type WidgetEvent = 'ready' | 'open' | 'close' | 'message' | 'error';

export interface LiveChatUser {
  name?: string;
  email?: string;
}

export interface WidgetOptions {
  /** Base URL of the API, e.g. https://api.example.com */
  apiUrl: string;
  /** Widget public key (pk_…), minted in the dashboard. */
  publicKey: string;
}
