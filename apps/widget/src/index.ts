import { LiveChatWidget } from './widget.js';

/**
 * Auto-mount: reads `data-public-key` / `data-api-url` from the script tag
 * (or window.LiveChatConfig), creates the widget, and exposes it as
 * window.LiveChat (open/close/identify/setAttributes/on/destroy).
 *
 *   <script src="https://cdn.example.com/widget.js"
 *           data-public-key="pk_…" data-api-url="https://api.example.com" async></script>
 */
function boot(): void {
  // SSR / prerender safety: no DOM → nothing to mount.
  if (typeof document === 'undefined') return;
  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    (document.querySelector('script[data-public-key]') as HTMLScriptElement | null);
  const cfg = (window as unknown as { LiveChatConfig?: { publicKey?: string; apiUrl?: string } })
    .LiveChatConfig;

  const publicKey = script?.dataset.publicKey ?? cfg?.publicKey;
  const apiUrl = script?.dataset.apiUrl ?? cfg?.apiUrl;
  if (!publicKey || !apiUrl) {
    console.warn('[livechat] widget.js loaded without data-public-key/data-api-url');
    return;
  }

  const widget = new LiveChatWidget({ apiUrl, publicKey });
  (window as unknown as { LiveChat: LiveChatWidget }).LiveChat = widget;
  void widget.boot();
}

boot();
