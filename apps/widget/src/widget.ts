import { fetchSettings, visitorInit } from './api.js';
import { connectChat } from './socket.js';
import { STYLES } from './styles.js';
import { isOffline, setStorage, storage, uuid } from './utils.js';
import type {
  ChatMessage,
  LiveChatUser,
  PrechatField,
  VisitorInitResult,
  WidgetEvent,
  WidgetOptions,
  WidgetSettings,
} from './types.js';
import type { Socket } from 'socket.io-client';

const ANON_PREFIX = 'livechat:anon:';
const USER_PREFIX = 'livechat:user:';
const TYPING_HIDE_MS = 4000;
const TYPING_EMIT_MS = 1500;

/**
 * The embeddable widget (blueprint §7/§10/§11).
 *
 * - Boot: fetch public settings → build Shadow DOM (launcher + panel).
 * - On first open: visitor_init (public key) → visitor token → socket connect
 *   → join conversation. Pre-chat fields gate the first message.
 * - All dynamic content is rendered with textContent (XSS-safe, §8.2).
 * - a11y: role=dialog, labelled controls, Esc closes, focus to composer.
 */
export class LiveChatWidget {
  private readonly apiUrl: string;
  private readonly publicKey: string;
  private readonly anonId: string;
  private host!: HTMLElement;
  private root!: ShadowRoot;
  private settings: WidgetSettings | null = null;
  private visitor: VisitorInitResult | null = null;
  private user: LiveChatUser | null = null;
  private socket: Socket | null = null;
  private isOpen = false;
  private unread = 0;
  private destroyed = false;
  private prechatCompleted = false;
  /** Metadata from setAttributes(...) — forwarded to visitor_init → visitors.meta. */
  private attributes: Record<string, unknown> = {};

  // Cached DOM refs (assigned in buildDom).
  private launcher!: HTMLButtonElement;
  private badge!: HTMLSpanElement;
  private panel!: HTMLDivElement;
  private bodyEl!: HTMLDivElement;
  private footerEl!: HTMLDivElement;
  private typingEl: HTMLDivElement | null = null;
  private composer!: HTMLTextAreaElement;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private typingHideTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTypingEmit = 0;
  /** Ids already rendered (history ∪ live fan-out ∪ send acks) — dedupe source. */
  private readonly seenIds = new Set<string>();

  private readonly handlers = new Map<WidgetEvent, Set<(payload: unknown) => void>>();

  constructor(options: WidgetOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.publicKey = options.publicKey;
    const anonKey = ANON_PREFIX + this.publicKey;
    const existing = storage(anonKey);
    if (existing) {
      this.anonId = existing;
    } else {
      this.anonId = uuid();
      setStorage(anonKey, this.anonId);
    }
    const savedUser = storage(USER_PREFIX + this.publicKey);
    if (savedUser) {
      try {
        this.user = JSON.parse(savedUser) as LiveChatUser;
      } catch {
        this.user = null;
      }
    }
    // A returning visitor who already identified skips the pre-chat form.
    if (this.user?.name || this.user?.email) this.prechatCompleted = true;
  }

  // --- Public JS API ---------------------------------------------------------

  /** Fetch settings and mount the launcher. Safe to call once. */
  async boot(): Promise<void> {
    if (this.destroyed || this.host) return;
    try {
      this.settings = await fetchSettings(this.apiUrl, this.publicKey);
    } catch (err) {
      this.emit('error', err);
      console.error('[livechat] boot failed', err);
      return;
    }
    if (this.destroyed) return;
    this.buildDom();
    this.emit('ready', undefined);
  }

  /** Open the chat panel; initializes the visitor session on first open. */
  async open(): Promise<void> {
    if (this.destroyed || !this.settings || this.isOpen) return;
    this.isOpen = true;
    this.panel.hidden = false;
    this.unread = 0;
    this.badge.dataset.show = '0';
    this.launcher.setAttribute('aria-expanded', 'true');
    this.emit('open', undefined);
    try {
      await this.ensureInitialized();
    } catch (err) {
      this.emit('error', err);
      this.showError(err);
    }
    this.composer.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panel.hidden = true;
    this.launcher.setAttribute('aria-expanded', 'false');
    this.emit('close', undefined);
    this.launcher.focus();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }


  /**
   * Attach known identity (blueprint §11): persists locally, skips the pre-chat
   * form, and re-inits a live session so the server attaches name/email.
   */
  identify(user: LiveChatUser): void {
    if (!user || typeof user !== 'object') return;
    const next: LiveChatUser = { ...(this.user ?? {}), ...user };
    if (!next.name && !next.email) return;
    this.user = next;
    setStorage(USER_PREFIX + this.publicKey, JSON.stringify(next));
    this.prechatCompleted = true;
    if (this.visitor) void this.resetSession(); // attach identity server-side
  }

  /**
   * Custom metadata (blueprint §11) — scalar values only, capped to mirror the
   * server-side zod limits; merged into visitors.meta via visitor_init.
   */
  setAttributes(attributes: Record<string, unknown>): void {
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return;
    const clean: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(attributes)) {
      if (!k || k.length > 64) continue;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
      if (typeof v === 'string' && v.length > 500) continue;
      clean[k] = v;
      if (++n >= 50) break;
    }
    if (Object.keys(clean).length === 0) return;
    this.attributes = { ...this.attributes, ...clean };
    // A live session re-inits so the server merges the new attributes now;
    // before first open the attributes ride along on the initial visitor_init.
    if (this.visitor) void this.resetSession();
  }

  on(event: WidgetEvent, handler: (payload: unknown) => void): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: WidgetEvent, handler: (payload: unknown) => void): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  /** Tear everything down (used by SPAs on route changes / teardown). */
  destroy(): void {
    this.destroyed = true;
    this.socket?.close();
    this.socket = null;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    if (this.typingHideTimer) clearTimeout(this.typingHideTimer);
    this.host?.remove();
  }

  private emit(event: WidgetEvent, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(payload);
      } catch (err) {
        console.error('[livechat] event handler failed', err);
      }
    }
  }

  // --- Session ---------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.visitor) return;
    this.visitor = await visitorInit(
      this.apiUrl,
      this.publicKey,
      this.anonId,
      this.user ?? {},
      this.attributes,
    );
    this.renderChatView();
    // Returning visitor: visitor_init returns the recent history so a reload
    // re-opens the conversation where it left off. Live fan-out of any message
    // racing this render is deduped by seenIds inside appendMessage.
    for (const m of this.visitor.messages ?? []) {
      this.appendMessage(m);
    }
    this.connectSocket();
  }

  /** Re-init after identify() so the new name/email is attached server-side. */
  private async resetSession(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    this.visitor = null;
    this.clearBody();
    try {
      await this.ensureInitialized();
    } catch (err) {
      this.emit('error', err);
    }
  }

  private connectSocket(): void {
    if (!this.visitor) return;
    this.socket = connectChat(this.apiUrl, this.visitor.token, this.visitor.conversationId, {
      onMessage: (msg) => this.receiveMessage(msg),
      onTyping: (typing) => this.showTyping(typing),
      onStatus: (status) => this.updateStatus(status),
    });
  }

  // --- DOM -------------------------------------------------------------------

  /** Mount host + shadow root, build the launcher and (hidden) panel skeleton. */
  private buildDom(): void {
    const s = this.settings;
    if (!s) return;

    const host = document.createElement('div');
    host.className = 'lc-host';
    this.root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    this.root.appendChild(style);

    // Static skeleton only — no user data ever goes through innerHTML.
    const wrap = document.createElement('div');
    wrap.className = 'lc-root';
    wrap.dataset.position = s.position;
    wrap.style.setProperty('--lc-color', s.color);
    wrap.innerHTML = `
      <button class="lc-launcher" type="button" aria-expanded="false" aria-label="Open live chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
        </svg>
        <span>Chat with us</span>
        <span class="lc-badge" data-show="0" aria-hidden="true">0</span>
      </button>
      <div class="lc-panel" hidden role="dialog" aria-modal="false" aria-label="Live chat">
        <div class="lc-header">
          <span class="lc-header-title"></span>
          <span class="lc-header-status"></span>
          <button class="lc-close" type="button" aria-label="Close chat">&times;</button>
        </div>
        <div class="lc-body" role="log" aria-live="polite" tabindex="0"></div>
        <div class="lc-footer"></div>
      </div>`;

    this.host = host;
    this.launcher = wrap.querySelector('.lc-launcher') as HTMLButtonElement;
    this.badge = wrap.querySelector('.lc-badge') as HTMLSpanElement;
    this.panel = wrap.querySelector('.lc-panel') as HTMLDivElement;
    this.bodyEl = wrap.querySelector('.lc-body') as HTMLDivElement;
    this.footerEl = wrap.querySelector('.lc-footer') as HTMLDivElement;
    this.root.appendChild(wrap);

    // Header: logo (from settings URL) + greeting title.
    const title = this.root.querySelector('.lc-header-title') as HTMLElement;
    title.textContent = s.greeting ?? 'Chat with us';
    if (s.logoUrl) {
      const img = document.createElement('img');
      img.src = s.logoUrl;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      this.root.querySelector('.lc-header')?.prepend(img);
    }

    this.launcher.addEventListener('click', () => this.toggle());
    (this.root.querySelector('.lc-close') as HTMLButtonElement).addEventListener('click', () =>
      this.close(),
    );
    document.addEventListener('keydown', this.onKeydown);
    document.body.appendChild(host);
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.close();
  };

  /** First-open view: empty state, optional offline notice, pre-chat form. */
  private renderChatView(): void {
    this.clearBody();
    const empty = document.createElement('div');
    empty.className = 'lc-empty';
    empty.textContent = 'Say hello — we usually reply in a few minutes.';
    this.bodyEl.appendChild(empty);

    const s = this.settings;
    if (!s) return;
    if (isOffline(s.workingHours)) {
      const notice = document.createElement('div');
      notice.className = 'lc-offline';
      notice.textContent = s.offlineMessage ?? "We're offline right now — leave a message!";
      this.bodyEl.appendChild(notice);
    }

    // Pre-chat gates the composer ONLY when fields are configured and the
    // visitor hasn't completed them yet. No configured fields → straight to
    // the composer (otherwise an empty form would dead-end "Start chat").
    const needsPrechat = s.prechatFields.length > 0 && !this.prechatCompleted;
    this.footerEl.textContent = '';
    if (needsPrechat) this.renderPrechat(s.prechatFields);
    else this.renderComposer();
  }

  /** Pre-chat form (name/email + configured fields) — gates the composer. */
  private renderPrechat(fields: PrechatField[]): void {
    const form = document.createElement('form');
    form.className = 'lc-prechat';
    form.noValidate = true;

    const error = document.createElement('div');
    error.className = 'lc-prechat-error';
    error.setAttribute('role', 'alert');

    const inputs: HTMLInputElement[] = [];
    for (const f of fields) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.name = f.name;
      input.type = f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text';
      input.autocomplete = f.name === 'email' ? 'email' : f.name === 'name' ? 'name' : 'off';
      input.required = f.required !== false;
      label.textContent = f.label ?? f.name;
      label.appendChild(input);
      form.appendChild(label);
      inputs.push(input);
      if (this.user?.[f.name as keyof LiveChatUser]) {
        input.value = String(this.user[f.name as keyof LiveChatUser]);
      }
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'lc-btn';
    submit.textContent = 'Start chat';
    form.appendChild(error);
    form.appendChild(submit);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      for (const input of inputs) {
        if (input.required && !input.value.trim()) {
          error.textContent = `Please fill in "${input.name}".`;
          input.focus();
          return;
        }
        if (input.type === 'email' && input.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.value)) {
          error.textContent = 'Please enter a valid email address.';
          input.focus();
          return;
        }
      }
      error.textContent = '';
      const user: LiveChatUser = { ...(this.user ?? {}) };
      let captured = false;
      for (const input of inputs) {
        const v = input.value.trim();
        if (v) {
          (user as Record<string, string>)[input.name] = v;
          captured = true;
        }
      }
      // Pre-chat complete: never show the form again this session, or for a
      // returning visitor who already identified.
      this.prechatCompleted = true;
      this.user = user;
      setStorage(USER_PREFIX + this.publicKey, JSON.stringify(user));
      if (captured && this.visitor) {
        void this.resetSession(); // re-init so the server attaches the identity
      } else {
        this.renderComposer();
      }
    });

    this.footerEl.appendChild(form);
    form.querySelector('input')?.focus();
  }

  /** Message composer (textarea + send button). */
  private renderComposer(): void {
    this.footerEl.textContent = '';
    const form = document.createElement('form');
    form.className = 'lc-composer';

    const ta = document.createElement('textarea');
    ta.rows = 1;
    ta.placeholder = 'Type a message…';
    ta.setAttribute('aria-label', 'Message');
    ta.maxLength = 4000;

    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'lc-btn';
    send.textContent = 'Send';

    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 96)}px`;
      this.emitTyping();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body) return;
      ta.value = '';
      ta.style.height = 'auto';
      void this.sendMessage(body);
    });

    form.append(ta, send);
    this.footerEl.appendChild(form);
    this.composer = ta;
  }

  // --- Messages --------------------------------------------------------------

  private appendMessage(msg: ChatMessage): void {
    if (this.seenIds.has(msg.id)) return; // history ∩ fan-out ∩ ack overlap
    this.seenIds.add(msg.id);
    const el = document.createElement('div');
    el.className = 'lc-msg';
    el.dataset.sender = msg.senderType === 'visitor' ? 'visitor' : 'agent';
    const text = document.createElement('span');
    text.textContent = msg.body; // textContent only — XSS-safe (§8.2)
    el.appendChild(text);
    const meta = document.createElement('span');
    meta.className = 'lc-msg-meta';
    meta.textContent = new Date(msg.createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    el.appendChild(meta);
    this.bodyEl.querySelector('.lc-empty')?.remove();
    this.bodyEl.appendChild(el);
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  private receiveMessage(msg: ChatMessage): void {
    this.appendMessage(msg);
    this.emit('message', msg);
    if (!this.isOpen) {
      this.unread += 1;
      this.badge.textContent = String(this.unread);
      this.badge.dataset.show = '1';
    }
  }

  private async sendMessage(body: string): Promise<void> {
    if (!this.socket || !this.visitor) return;
    this.socket.emit(
      'message:send',
      {
        conversationId: this.visitor.conversationId,
        body,
        idempotencyKey: uuid(),
      },
      (ack: { ok?: boolean; message?: ChatMessage; error?: { message?: string } }) => {
        if (!ack?.ok) {
          this.emit('error', ack?.error?.message ?? 'send failed');
          this.showError(ack?.error?.message ?? 'Message failed to send.');
          return;
        }
        // The ack carries the persisted message; if the room fan-out lands
        // first, seenIds makes this append a no-op (whichever wins, one bubble).
        if (ack.message) this.appendMessage(ack.message);
      },
    );
  }

  private emitTyping(): void {
    if (!this.socket || !this.visitor) return;
    const now = Date.now();
    if (now - this.lastTypingEmit < TYPING_EMIT_MS) return;
    this.lastTypingEmit = now;
    this.socket.emit('typing', { conversationId: this.visitor.conversationId, typing: true });
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.socket?.emit('typing', { conversationId: this.visitor!.conversationId, typing: false });
    }, TYPING_EMIT_MS);
  }

  private showTyping(typing: boolean): void {
    if (!this.typingEl) {
      this.typingEl = document.createElement('div');
      this.typingEl.className = 'lc-typing';
    }
    if (typing) {
      this.typingEl.textContent = 'Agent is typing…';
      this.bodyEl.appendChild(this.typingEl);
      this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
      if (this.typingHideTimer) clearTimeout(this.typingHideTimer);
      this.typingHideTimer = setTimeout(() => {
        this.typingEl?.remove();
        this.typingEl = null;
      }, TYPING_HIDE_MS);
    } else {
      this.typingEl?.remove();
    }
  }

  private updateStatus(status: 'connecting' | 'online' | 'offline'): void {
    const el = this.root.querySelector('.lc-header-status');
    if (!el) return;
    el.textContent =
      status === 'online' ? 'Online' : status === 'connecting' ? 'Connecting…' : 'Offline';
  }

  private showError(message: unknown): void {
    const el = document.createElement('div');
    el.className = 'lc-error';
    el.setAttribute('role', 'alert');
    el.textContent = typeof message === 'string' ? message : 'Something went wrong.';
    this.footerEl.appendChild(el);
  }

  private clearBody(): void {
    this.bodyEl.textContent = '';
    this.typingEl?.remove();
    this.typingEl = null;
    this.seenIds.clear();
  }
}
