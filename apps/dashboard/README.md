# @livechat/dashboard

Agent dashboard — **Next.js 15 (App Router) + React 19**, plain CSS (no UI
framework). Talks to the API with a typed fetch client (`src/lib/api.ts`):
Bearer access token + credentialed refresh cookie, auto refresh-then-retry on
401, uniform `ApiError`.

## Develop

```bash
# API must be running on :4000 (pnpm --filter @livechat/api dev)
pnpm --filter @livechat/dashboard dev      # → http://localhost:3000
pnpm --filter @livechat/dashboard build    # production build
```

`NEXT_PUBLIC_API_URL` (default `http://localhost:4000`) points the dashboard
at the API; the API's `PUBLIC_APP_ORIGIN=http://localhost:3000` allowlists it
for credentialed CORS (see `apps/api/.env`).

## Pages

| Route | What |
|---|---|
| `/login`, `/signup` | Auth (2FA code prompt appears when enabled) |
| `/conversations` | Inbox — status/assignee filters, keyset “load more”, live `conversation:updated` updates |
| `/conversations/[id]` | Chat — history, live messages + visitor typing (Socket.IO), assign to me, close/reopen, reply |
| `/settings/api-keys` | Mint widget keys (shown once), list, revoke, embed snippet |
| `/settings/widget` | Brand color, position, greeting, offline message, language, domain allowlist |
| `/settings/members` | Team list, invite (token shown once), role changes, removal |

Auth state lives in `src/lib/auth.tsx` (`AuthProvider` + `useAuth`); the
`(app)` route group guards all authenticated pages. Socket wiring is in
`src/lib/socket.ts` (agents auto-join the workspace room on connect).
