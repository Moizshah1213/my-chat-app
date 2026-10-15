# @livechat/widget

Embeddable live-chat widget — a single self-contained `dist/widget.js`
(~58kb, Socket.IO bundled). Zero framework dependencies; renders inside a
**Shadow DOM** so host-page CSS can't leak in (and vice versa).

## Build

```bash
pnpm --filter @livechat/widget build   # → dist/widget.js
```

Serve `dist/widget.js` from your CDN (or the API host) and embed it:

```html
<script
  src="https://cdn.example.com/widget.js"
  data-public-key="pk_…"
  data-api-url="https://api.example.com"
  async
></script>
```

`data-public-key` comes from the dashboard (API keys page); `data-api-url` is
the API origin. Alternatively set `window.LiveChatConfig = { publicKey, apiUrl }`
before loading the script.

## JavaScript API (`window.LiveChat`)

```js
LiveChat.open();                    // open the panel
LiveChat.close();                   // close it
LiveChat.identify({ name: 'Ada', email: 'ada@example.com' }); // attach identity
LiveChat.setAttributes({ plan: 'pro' }); // custom metadata (forwarded later)
LiveChat.on('message', (msg) => console.log(msg));   // 'ready' | 'open' | 'close' | 'message' | 'error'
LiveChat.off('message', handler);
LiveChat.destroy();                 // full teardown (SPA route changes)
```

## Behavior

- **Settings** — fetched once from `GET /widget/v1/settings?key=pk_…`; drives
  color, position, greeting, logo, language, pre-chat fields, offline message.
- **Identity** — an anonymous id is persisted in `localStorage` so returning
  visitors resume their conversation; `identify()` restarts the session with
  the real name/email.
- **Chat** — `POST /widget/v1/visitor_init` mints a short-lived visitor token,
  the widget joins the conversation over Socket.IO (`/ws`) and sends with
  per-message idempotency keys. Messages render as text only (XSS-safe).
- **Offline** — when `workingHours` (shape `{ days: { mon: ['09:00','17:00'] } }`)
  puts the workspace offline, the offline message is shown above the composer.
- **a11y** — `role="dialog"`, labelled controls, `Esc` closes, focus moves to
  the composer on open, unread badge on the launcher, `prefers-reduced-motion`
  respected, mobile-responsive layout.
