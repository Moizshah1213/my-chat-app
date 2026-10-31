import { fetchSettings, submitQuery, visitorInit } from './api.js';
import { JellyBlobMascot, type BlobMood } from './blob.js';
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
const AI_TYPING_HIDE_MS = 130_000;
const TYPING_EMIT_MS = 1500;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type View = 'intro' | 'chat' | 'query';
type Tab = 'chat' | 'query';

const DEFAULT_PRECHAT: PrechatField[] = [
  { name: 'name', label: 'Full name', type: 'text', required: true },
  { name: 'email', label: 'Email address', type: 'email', required: true },
];

const ICONS = {
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 21l2-5.6A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
} as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function firstName(user: LiveChatUser | null): string {
  const n = user?.name?.trim();
  return n ? (n.split(/\s+/)[0] ?? '') : '';
}

function readableTextColor(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return '#fff';
  const channels = [0, 2, 4].map((index) => {
    const value = Number.parseInt(match[1]!.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  return luminance > 0.42 ? '#111' : '#fff';
}

function readablePalette(hex: string) {
  return readableTextColor(hex) === '#111'
    ? {
        text: '#18181b',
        soft: '#38383d',
        muted: '#73737b',
        surface: '#f0f0f2',
        surface2: '#fff',
        line: 'rgba(0,0,0,.12)',
        caret: '#55555d',
        focusLine: 'rgba(0,0,0,.3)',
      }
    : {
        text: '#fff',
        soft: '#e6e6e8',
        muted: '#7a7a80',
        surface: '#1b1b1c',
        surface2: '#0b0b0c',
        line: 'rgba(255,255,255,.11)',
        caret: '#b7b7bd',
        focusLine: 'rgba(255,255,255,.3)',
      };
}

/**
 * The embeddable widget.
 *
 * - Boot: fetch public settings → build Shadow DOM (launcher + panel).
 * - First open: a welcome screen asks for full name + email.
 * - Then two tabs: "Live chat" (visitor_init → Socket.IO; a human agent or the
 *   AI assistant replies) and "Send a query" (email form → POST /widget/v1/queries).
 * - All dynamic content is rendered with textContent (XSS-safe).
 * - a11y: role=dialog, tablist, labelled controls, Esc closes, focus management.
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
  private view: View = 'intro';
  private tab: Tab = 'chat';
  private awaitingReply = false;
  private connected = false;
  /** Metadata from setAttributes(...) — forwarded to visitor_init → visitors.meta. */
  private attributes: Record<string, unknown> = {};

  // Cached DOM refs (assigned in buildDom).
  private launcher!: HTMLButtonElement;
  private badge!: HTMLSpanElement;
  private panel!: HTMLDivElement;
  private statusEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private views!: Record<View, HTMLElement>;
  private introForm!: HTMLElement;
  private introTitle!: HTMLElement;
  private bodyEl!: HTMLDivElement;
  private heroEl!: HTMLElement;
  private heroTitle!: HTMLElement;
  private chipsEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private footerEl!: HTMLDivElement;
  private typingEl: HTMLDivElement | null = null;
  private typingSender: 'agent' | 'ai' | null = null;
  private composer: HTMLTextAreaElement | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private typingHideTimer: ReturnType<typeof setTimeout> | null = null;
  private moodTimer: ReturnType<typeof setTimeout> | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTypingEmit = 0;
  private readonly blobs: JellyBlobMascot[] = [];
  private launcherBlob: JellyBlobMascot | null = null;
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
    // A returning visitor who already identified skips the welcome form.
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

  /** Open the panel; shows the welcome form first, then starts the chat session. */
  async open(): Promise<void> {
    if (this.destroyed || !this.settings || this.isOpen) return;
    this.isOpen = true;
    this.panel.hidden = false;
    this.unread = 0;
    this.badge.dataset.show = '0';
    this.launcher.setAttribute('aria-expanded', 'true');
    this.emit('open', undefined);
    if (this.settings.prechatEnabled && !this.prechatCompleted) {
      this.showView('intro');
      this.introForm.querySelector('input')?.focus();
      return;
    }
    this.prechatCompleted = true;
    await this.startSession();
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
   * Attach known identity: persists locally, skips the welcome form, and
   * re-inits a live session so the server attaches name/email.
   */
  identify(user: LiveChatUser): void {
    if (!user || typeof user !== 'object') return;
    const next: LiveChatUser = { ...(this.user ?? {}), ...user };
    if (!next.name && !next.email) return;
    this.user = next;
    setStorage(USER_PREFIX + this.publicKey, JSON.stringify(next));
    const wasIntro = !this.prechatCompleted;
    this.prechatCompleted = true;
    if (this.host) this.refreshGreeting();
    if (this.visitor) void this.resetSession();
    else if (wasIntro && this.isOpen) void this.startSession();
  }

  /**
   * Custom metadata — scalar values only, capped to mirror the server-side
   * limits; merged into visitors.meta via visitor_init.
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
    for (const t of [this.typingTimer, this.typingHideTimer, this.moodTimer, this.errorTimer]) {
      if (t) clearTimeout(t);
    }
    for (const b of this.blobs) b.destroy();
    this.launcherBlob?.destroy();
    document.removeEventListener('keydown', this.onKeydown);
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

  /** After the welcome form (or for a known visitor): pick a tab and connect. */
  private async startSession(): Promise<void> {
    const s = this.settings;
    // Nobody to answer live (outside hours and no AI) → lead with the email form.
    const liveAvailable = !!s && (!isOffline(s.workingHours) || s.aiEnabled);
    this.tab = liveAvailable ? 'chat' : 'query';
    this.tabsEl.hidden = false;
    this.refreshGreeting();
    this.setTab(this.tab, false);
    try {
      await this.ensureInitialized();
    } catch (err) {
      this.emit('error', err);
      this.showError('Live chat is unavailable right now. Try again, or send us a query.');
    }
    if (this.isOpen && this.tab === 'chat') this.composer?.focus();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.visitor) return;
    this.visitor = await visitorInit(
      this.apiUrl,
      this.publicKey,
      this.anonId,
      this.user ?? {},
      {
        ...this.attributes,
        ...Object.fromEntries(
          Object.entries(this.user ?? {}).filter(
            ([key, value]) => key !== 'name' && key !== 'email' && typeof value === 'string',
          ),
        ),
      },
    );
    this.renderComposer();
    // Returning visitor: visitor_init returns recent history so a reload
    // re-opens the conversation in place. Live fan-out racing this render is
    // deduped by seenIds inside appendMessage.
    for (const m of this.visitor.messages ?? []) this.appendMessage(m);
    this.connectSocket();
  }

  /** Re-init after identify() so the new name/email is attached server-side. */
  private async resetSession(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    this.visitor = null;
    this.connected = false;
    this.clearMessages();
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
      onTyping: (typing, by) => this.showTyping(typing, by),
      onStatus: (status) => this.updateStatus(status),
    });
  }

  // --- DOM -------------------------------------------------------------------

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
    wrap.dataset.theme = s.theme;
    wrap.dataset.gradient = String(s.backgroundGradient);
    const palette = readablePalette(s.backgroundColor);
    wrap.style.setProperty('--lc-color', s.color);
    wrap.style.setProperty('--lc-visitor-bubble', s.color);
    wrap.style.setProperty('--lc-visitor-text', readableTextColor(s.color));
    wrap.style.setProperty('--lc-agent-bubble', s.agentBubbleColor);
    wrap.style.setProperty('--lc-agent-text', readableTextColor(s.agentBubbleColor));
    wrap.style.setProperty('--lc-bg', s.backgroundColor);
    wrap.style.setProperty('--lc-bg-end', s.backgroundGradientColor);
    wrap.style.setProperty('--lc-button', s.buttonColor);
    wrap.style.setProperty('--lc-button-text', readableTextColor(s.buttonColor));
    wrap.style.setProperty('--lc-text', palette.text);
    wrap.style.setProperty('--lc-soft', palette.soft);
    wrap.style.setProperty('--lc-muted', palette.muted);
    wrap.style.setProperty('--lc-surface', palette.surface);
    wrap.style.setProperty('--lc-surface-2', palette.surface2);
    wrap.style.setProperty('--lc-line', palette.line);
    wrap.style.setProperty('--lc-caret', palette.caret);
    wrap.style.setProperty('--lc-focus-line', palette.focusLine);
    wrap.innerHTML = `
      <button class="lc-launcher" type="button" aria-expanded="false" aria-label="Open live chat">
        <canvas class="lc-launcher-orb" aria-hidden="true"></canvas>
        <span class="lc-badge" data-show="0" aria-hidden="true">0</span>
      </button>
      <div class="lc-panel" hidden role="dialog" aria-modal="false" aria-label="Live chat">
        <div class="lc-header">
          <div class="lc-brand"><span class="lc-logo"></span><span class="lc-status" data-state="online"></span></div>
          <button class="lc-round lc-close x-icon" type="button" aria-label="Close chat">${ICONS.close}</button>
        </div>
        <div class="lc-tabs" role="tablist" aria-label="How would you like to reach us?" hidden>
          <button class="lc-tab" type="button" role="tab" data-tab="chat" aria-selected="true">${ICONS.chat}Live chat</button>
          <button class="lc-tab" type="button" role="tab" data-tab="query" aria-selected="false">${ICONS.mail}Send a query</button>
        </div>
        <section class="lc-view lc-intro" data-view="intro" hidden>
          <div class="lc-hero"><canvas aria-label="Assistant orb"></canvas><h2></h2><p></p></div>
          <div class="lc-intro-form"></div>
        </section>
        <section class="lc-view lc-chat" data-view="chat" hidden>
          <div class="lc-body" role="log" aria-live="polite" tabindex="0">
            <div class="lc-hero"><canvas aria-label="Assistant orb"></canvas><h2></h2><p></p></div>
          </div>
          <div class="lc-chips" hidden></div>
          <div class="lc-error" role="alert" hidden></div>
          <div class="lc-footer"></div>
        </section>
        <section class="lc-view lc-query" data-view="query" hidden></section>
      </div>`;

    this.host = host;
    const q = <T extends HTMLElement>(sel: string): T => wrap.querySelector(sel) as T;
    this.launcher = q('.lc-launcher');
    this.badge = q('.lc-badge');
    this.panel = q('.lc-panel');
    this.statusEl = q('.lc-status');
    this.tabsEl = q('.lc-tabs');
    this.introForm = q('.lc-intro-form');
    this.introTitle = q('.lc-intro .lc-hero h2');
    this.bodyEl = q('.lc-body');
    this.heroEl = q('.lc-body .lc-hero');
    this.heroTitle = q('.lc-body .lc-hero h2');
    this.chipsEl = q('.lc-chips');
    this.errorEl = q('.lc-error');
    this.footerEl = q('.lc-footer');
    this.views = {
      intro: q('[data-view="intro"]'),
      chat: q('[data-view="chat"]'),
      query: q('[data-view="query"]'),
    };
    this.root.appendChild(wrap);

    // Orbs: launcher, header logo (when the workspace has no logo), two heroes.
    this.launcherBlob = new JellyBlobMascot(q<HTMLCanvasElement>('.lc-launcher-orb'), { radius: 0.4 });
    const heroCanvases = wrap.querySelectorAll<HTMLCanvasElement>('.lc-hero canvas');
    heroCanvases.forEach((c) => this.blobs.push(new JellyBlobMascot(c, { interactive: true })));
    const logo = q('.lc-logo');
    if (s.logoUrl) {
      const img = document.createElement('img');
      img.src = s.logoUrl;
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        this.mountHeaderOrb(logo);
      });
      logo.appendChild(img);
    } else {
      this.mountHeaderOrb(logo);
    }

    // Static copy.
    const sub = s.greeting ?? 'How can we help you today?';
    wrap.querySelectorAll('.lc-hero p').forEach((p) => (p.textContent = sub));
    this.refreshGreeting();
    this.renderIntro(s.prechatFields.length > 0 ? s.prechatFields : DEFAULT_PRECHAT);
    this.renderChips(s.quickReplies ?? []);
    this.renderOfflineNotice();
    this.setBaseStatus();

    this.launcher.addEventListener('click', () => this.toggle());
    q('.lc-close').addEventListener('click', () => this.close());
    wrap.querySelectorAll<HTMLButtonElement>('.lc-tab').forEach((t) =>
      t.addEventListener('click', () => this.setTab(t.dataset.tab === 'query' ? 'query' : 'chat')),
    );
    document.addEventListener('keydown', this.onKeydown);
    document.body.appendChild(host);
  }

  private mountHeaderOrb(container: HTMLElement): void {
    const c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    container.appendChild(c);
    this.blobs.push(new JellyBlobMascot(c, { radius: 0.44 }));
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.close();
  };

  private showView(view: View): void {
    this.view = view;
    for (const [name, node] of Object.entries(this.views)) node.hidden = name !== view;
  }

  private setTab(tab: Tab, focus = true): void {
    this.tab = tab;
    this.tabsEl.querySelectorAll<HTMLButtonElement>('.lc-tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    });
    this.showView(tab);
    if (tab === 'query') this.renderQuery();
    if (!focus) return;
    if (tab === 'chat') this.composer?.focus();
    else this.views.query.querySelector<HTMLElement>('input, textarea')?.focus();
  }

  private setMood(mood: BlobMood): void {
    for (const b of this.blobs) b.setMood(mood);
  }

  private pulseHappy(): void {
    this.setMood('happy');
    for (const b of this.blobs) b.poke(0.3);
    this.launcherBlob?.poke(0.35);
    if (this.moodTimer) clearTimeout(this.moodTimer);
    this.moodTimer = setTimeout(() => this.setMood('idle'), 1800);
  }

  /** "Welcome Kris" once we know the name. */
  private refreshGreeting(): void {
    const first = firstName(this.user);
    const text = first ? `Welcome ${first}` : 'Welcome';
    this.heroTitle.textContent = text;
    this.introTitle.textContent = 'Welcome';
  }

  private setBaseStatus(): void {
    const s = this.settings;
    if (!s) return;
    if (!isOffline(s.workingHours)) this.setStatus('We’re online', 'online');
    else if (s.aiEnabled) this.setStatus('AI assistant is online', 'online');
    else this.setStatus('Currently offline', 'away');
  }

  private setStatus(text: string, state: 'online' | 'away' | 'connecting'): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.state = state;
  }

  // --- Welcome form (full name + email) ---------------------------------------

  private renderIntro(fields: PrechatField[]): void {
    const form = el('form', 'lc-form');
    form.noValidate = true;
    const inputs: HTMLInputElement[] = [];
    const rows: HTMLElement[] = [];

    for (const f of fields) {
      const label = el('label', 'lc-field', f.label ?? f.name);
      const input = document.createElement('input');
      input.name = f.name;
      input.type = f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text';
      input.autocomplete = f.name === 'email' ? 'email' : f.name === 'name' ? 'name' : 'off';
      input.required = f.required !== false;
      input.placeholder =
        f.name === 'name' ? 'Your full name' : f.name === 'email' ? 'you@example.com' : `Enter ${f.label ?? f.name}`;
      input.maxLength = 200;
      const saved = this.user?.[f.name as keyof LiveChatUser];
      if (saved) input.value = String(saved);
      const err = el('span', 'lc-field-error');
      label.append(input, err);
      form.appendChild(label);
      inputs.push(input);
      rows.push(label);
    }

    const formError = el('div', 'lc-form-error');
    formError.setAttribute('role', 'alert');
    const submit = el('button', 'lc-btn', 'Continue');
    submit.type = 'submit';
    form.append(formError, submit);
    form.appendChild(el('p', 'lc-fine', 'We’ll use your email to follow up if we miss you.'));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let firstBad: HTMLInputElement | null = null;
      inputs.forEach((input, i) => {
        const row = rows[i] as HTMLElement;
        const msg = row.querySelector('.lc-field-error') as HTMLElement;
        const v = input.value.trim();
        let problem = '';
        if (input.required && !v) problem = 'This field is required.';
        else if (input.type === 'email' && v && !EMAIL_RE.test(v)) problem = 'Enter a valid email address.';
        msg.textContent = problem;
        row.dataset.invalid = problem ? '1' : '0';
        if (problem && !firstBad) firstBad = input;
      });
      if (firstBad) {
        (firstBad as HTMLInputElement).focus();
        return;
      }
      const user: LiveChatUser = { ...(this.user ?? {}) };
      for (const input of inputs) {
        const v = input.value.trim();
        if (v) (user as Record<string, string>)[input.name] = v;
      }
      this.user = user;
      this.prechatCompleted = true;
      setStorage(USER_PREFIX + this.publicKey, JSON.stringify(user));
      void this.startSession();
    });

    this.introForm.appendChild(form);
  }

  // --- Live chat tab ----------------------------------------------------------

  private renderChips(replies: string[]): void {
    this.chipsEl.textContent = '';
    const list = replies.filter((r) => typeof r === 'string' && r.trim()).slice(0, 6);
    this.chipsEl.hidden = list.length === 0;
    for (const text of list) {
      const b = el('button', 'lc-chip', text);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (!this.composer) return;
        this.composer.value = text;
        this.composer.focus();
        this.setMood('listening');
      });
      this.chipsEl.appendChild(b);
    }
  }

  private renderOfflineNotice(): void {
    const s = this.settings;
    this.bodyEl.querySelector('.lc-offline')?.remove();
    if (!s || !isOffline(s.workingHours)) return;
    const notice = el('div', 'lc-offline');
    notice.appendChild(
      el(
        'span',
        undefined,
        s.offlineMessage ??
          (s.aiEnabled
            ? 'Our team is offline. Our AI assistant can help right now.'
            : 'We’re offline right now. Leave a message and we’ll reply by email.'),
      ),
    );
    const link = el('button', 'lc-link', 'Send a query instead');
    link.type = 'button';
    link.addEventListener('click', () => this.setTab('query'));
    notice.appendChild(link);
    this.bodyEl.insertBefore(notice, this.heroEl);
  }

  private renderComposer(): void {
    this.footerEl.textContent = '';
    const form = el('form', 'lc-composer');

    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Type your message…';
    ta.setAttribute('aria-label', 'Message');
    ta.maxLength = 4000;

    const send = el('button', 'lc-round lc-send x-icon');
    send.type = 'submit';
    send.setAttribute('aria-label', 'Send message');
    send.innerHTML = ICONS.send;

    ta.addEventListener('input', () => {
      this.emitTyping();
      if (!this.awaitingReply) this.setMood(ta.value ? 'listening' : 'idle');
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
      if (!body) {
        form.classList.remove('lc-shake');
        void form.offsetWidth;
        form.classList.add('lc-shake');
        return;
      }
      ta.value = '';
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
    const sender = msg.senderType === 'visitor' ? 'visitor' : msg.senderType === 'ai' ? 'ai' : 'agent';
    const node = el('div', 'lc-msg');
    node.dataset.sender = sender;
    if (sender === 'ai') node.appendChild(el('span', 'lc-msg-tag', 'AI assistant'));
    node.appendChild(el('span', undefined, msg.body)); // textContent only — XSS-safe
    node.appendChild(
      el(
        'span',
        'lc-msg-meta',
        new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ),
    );
    this.heroEl.hidden = true;
    this.chipsEl.hidden = true;
    this.typingEl?.remove();
    this.typingEl = null;
    this.typingSender = null;
    this.bodyEl.appendChild(node);
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  private receiveMessage(msg: ChatMessage): void {
    this.appendMessage(msg);
    this.emit('message', msg);
    if (msg.senderType !== 'visitor') {
      this.awaitingReply = false;
      this.pulseHappy();
      if (!this.isOpen) {
        this.unread += 1;
        this.badge.textContent = String(this.unread);
        this.badge.dataset.show = '1';
      }
    }
  }

  private async sendMessage(body: string): Promise<void> {
    if (!this.socket || !this.visitor) {
      this.showError('Not connected yet. Please try again in a moment.');
      return;
    }
    this.awaitingReply = true;
    this.setMood('thinking');
    if (this.moodTimer) clearTimeout(this.moodTimer);
    // Safety net so the orb never "thinks" forever if nobody answers.
    this.moodTimer = setTimeout(() => {
      this.awaitingReply = false;
      this.setMood('idle');
    }, 25_000);
    this.socket.emit(
      'message:send',
      { conversationId: this.visitor.conversationId, body, idempotencyKey: uuid() },
      (ack: { ok?: boolean; message?: ChatMessage; error?: { message?: string } }) => {
        if (!ack?.ok) {
          this.awaitingReply = false;
          this.setMood('idle');
          const m = ack?.error?.message ?? 'Message failed to send.';
          this.emit('error', m);
          this.showError(m);
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
      this.socket?.emit('typing', { conversationId: this.visitor?.conversationId, typing: false });
    }, TYPING_EMIT_MS);
  }

  private showTyping(typing: boolean, by: 'agent' | 'ai'): void {
    if (!typing) {
      if (this.typingSender !== by) return;
      this.typingEl?.remove();
      this.typingEl = null;
      this.typingSender = null;
      if (this.typingHideTimer) clearTimeout(this.typingHideTimer);
      return;
    }
    if (!this.typingEl || this.typingSender !== by) {
      this.typingEl?.remove();
      const t = el('div', 'lc-typing');
      const label = by === 'ai' ? 'AI assistant is typing' : 'An agent is typing';
      t.setAttribute('aria-label', label);
      t.appendChild(el('span', 'lc-typing-label', label));
      t.append(el('i'), el('i'), el('i'));
      this.typingEl = t;
      this.typingSender = by;
    }
    this.heroEl.hidden = true;
    this.bodyEl.appendChild(this.typingEl);
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    this.setMood('thinking');
    if (this.typingHideTimer) clearTimeout(this.typingHideTimer);
    this.typingHideTimer = setTimeout(() => {
      this.typingEl?.remove();
      this.typingEl = null;
      this.typingSender = null;
    }, by === 'ai' ? AI_TYPING_HIDE_MS : TYPING_HIDE_MS);
  }

  private updateStatus(status: 'connecting' | 'online' | 'offline'): void {
    this.connected = status === 'online';
    if (status === 'online') this.setBaseStatus();
    else this.setStatus(status === 'connecting' ? 'Connecting…' : 'Reconnecting…', 'connecting');
  }

  private showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => (this.errorEl.hidden = true), 7000);
  }

  /** Drop messages/typing but keep the hero, notice and composer. */
  private clearMessages(): void {
    this.bodyEl.querySelectorAll('.lc-msg, .lc-typing').forEach((n) => n.remove());
    this.typingEl = null;
    this.typingSender = null;
    if (this.typingHideTimer) clearTimeout(this.typingHideTimer);
    this.seenIds.clear();
    this.heroEl.hidden = false;
    this.chipsEl.hidden = this.chipsEl.childElementCount === 0;
  }

  // --- Send a query tab -------------------------------------------------------

  private renderQuery(): void {
    const view = this.views.query;
    if (view.dataset.built === '1') return;
    view.dataset.built = '1';
    this.buildQueryForm();
  }

  private buildQueryForm(): void {
    const view = this.views.query;
    view.textContent = '';

    const head = el('div', 'lc-query-head');
    head.append(
      el('h3', undefined, 'Send us a query'),
      el('p', undefined, 'Leave your question and we’ll reply to your email.'),
    );

    const form = el('form', 'lc-form');
    form.noValidate = true;

    const mk = (labelText: string, control: HTMLInputElement | HTMLTextAreaElement) => {
      const label = el('label', 'lc-field', labelText);
      const err = el('span', 'lc-field-error');
      label.append(control, err);
      form.appendChild(label);
      return { label, err, control };
    };

    const emailIn = document.createElement('input');
    emailIn.type = 'email';
    emailIn.name = 'email';
    emailIn.autocomplete = 'email';
    emailIn.placeholder = 'you@example.com';
    emailIn.maxLength = 200;
    emailIn.value = this.user?.email ?? '';
    const subjectIn = document.createElement('input');
    subjectIn.type = 'text';
    subjectIn.name = 'subject';
    subjectIn.placeholder = 'What is this about? (optional)';
    subjectIn.maxLength = 200;
    const msgIn = document.createElement('textarea');
    msgIn.name = 'message';
    msgIn.placeholder = 'Describe your question…';
    msgIn.maxLength = 4000;

    const email = mk('Email address', emailIn);
    const subject = mk('Subject', subjectIn);
    const message = mk('Your query', msgIn);

    const formError = el('div', 'lc-form-error');
    formError.setAttribute('role', 'alert');
    const submit = el('button', 'lc-btn', 'Send query');
    submit.type = 'submit';
    form.append(formError, submit);

    const flag = (f: { label: HTMLElement; err: HTMLElement }, problem: string): boolean => {
      f.err.textContent = problem;
      f.label.dataset.invalid = problem ? '1' : '0';
      return !!problem;
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      formError.textContent = '';
      const ev = emailIn.value.trim();
      const mv = msgIn.value.trim();
      const badEmail = flag(email, !ev ? 'Email is required.' : !EMAIL_RE.test(ev) ? 'Enter a valid email address.' : '');
      const badMsg = flag(message, !mv ? 'Please write your query.' : mv.length < 5 ? 'Add a few more details.' : '');
      if (badEmail) return emailIn.focus();
      if (badMsg) return msgIn.focus();

      submit.disabled = true;
      submit.textContent = 'Sending…';
      const payload = {
        name: this.user?.name,
        email: ev,
        subject: subjectIn.value.trim() || undefined,
        message: mv,
      };
      submitQuery(this.apiUrl, this.publicKey, this.anonId, payload)
        .then(() => {
          // Remember the email for the next visit.
          this.user = { ...(this.user ?? {}), email: ev };
          setStorage(USER_PREFIX + this.publicKey, JSON.stringify(this.user));
          this.renderQuerySent(ev);
          this.setMood('happy');
          this.pulseHappy();
        })
        .catch((err: unknown) => {
          this.emit('error', err);
          formError.textContent = 'We couldn’t send your query. Check your connection and try again.';
          submit.disabled = false;
          submit.textContent = 'Send query';
        });
    });

    view.append(head, form);
  }

  private renderQuerySent(email: string): void {
    const view = this.views.query;
    view.textContent = '';
    const box = el('div', 'lc-sent');
    const icon = el('div', 'lc-sent-icon');
    icon.innerHTML = ICONS.check;
    const again = el('button', 'lc-btn', 'Send another query');
    again.type = 'button';
    again.addEventListener('click', () => this.buildQueryForm());
    box.append(
      icon,
      el('h3', undefined, 'Query sent'),
      el('p', undefined, `We’ll reply to ${email} as soon as we can.`),
      again,
    );
    view.appendChild(box);
  }
}
