/** Public widget settings — the projection returned by GET /widget/v1/settings. */
export interface WidgetSettings {
  color: string;
  theme: 'dark' | 'light';
  backgroundColor: string;
  backgroundGradient: boolean;
  backgroundGradientColor: string;
  buttonColor: string;
  agentBubbleColor: string;
  logoUrl: string | null;
  position: 'left' | 'right';
  greeting: string | null;
  offlineMessage: string | null;
  prechatFields: PrechatField[];
  prechatEnabled: boolean;
  workingHours: Record<string, unknown>;
  aiEnabled: boolean;
  language: string;
  /** Optional suggested first messages shown as chips on the welcome screen. */
  quickReplies: string[];
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
  /** 'ai' = automated reply when no human agent is available. */
  senderType: 'agent' | 'visitor' | 'ai';
  createdAt: string;
}

/** Events the host page can subscribe to via LiveChat.on(...). */
export type WidgetEvent = 'ready' | 'open' | 'close' | 'message' | 'error';

export interface LiveChatUser {
  name?: string;
  email?: string;
  [key: string]: string | undefined;
}

export interface WidgetOptions {
  /** Base URL of the API, e.g. https://api.example.com */
  apiUrl: string;
  /** Widget public key (qvse_…), minted in the dashboard. */
  publicKey: string;
}

/** Body of POST /widget/v1/queries — the "Send a query" (email) tab. */
export interface QueryPayload {
  name?: string;
  email: string;
  subject?: string;
  message: string;
}
