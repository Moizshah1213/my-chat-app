# API Contract — LiveChat (mobile client)

Every request/response example below was **captured live** against the dev API
(`http://localhost:4000`) using a throwaway test user, then had **every token,
email, id and secret replaced with fake values**. Shapes were cross-checked
against source (`apps/api/src/**`, `packages/shared/src/**`). If an endpoint is
not in this file it is listed under [MISSING](#8-missing-endpoints) — it does not exist.

- **Base URL (dev):** `http://localhost:4000` (production = your deployed API origin). Paths already include `/v1` — clients add no extra prefix.
- **Headers:** `Content-Type: application/json` on every request with a body; `Authorization: Bearer <accessToken>` on every authenticated request.
- **Request bodies are STRICT** (zod `.strict()`): unknown fields → `400 validation_failed` with `unrecognized_keys` in `details`. Send exactly the fields listed.
- **Timestamps** are ISO-8601 UTC strings (e.g. `"2026-10-17T13:13:41.117Z"`).
- **Ids** are UUID v4 strings.
- Status codes differ per endpoint: login/signup/refresh = **200**, message send = **201**, invitations create = **201**, forgot/resend-verification = **202** (see each section).

## Session object (returned by signup / login / 2fa/verify / refresh)

Real capture (faked values):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_ACCESS_TOKEN_PAYLOAD.c2lnbmF0dXJlLWZha2U",
  "refreshToken": "ZmFrZS1yZWZyZXNoLXRva2VuLTAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm",
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "owner.test@example.com",
    "name": "Test Owner",
    "emailVerifiedAt": null,
    "totpEnabled": false
  },
  "workspaceId": "22222222-2222-4222-8222-222222222222",
  "role": "owner"
}
```

Notes:
- `accessToken` is a JWT (HS256), TTL **15 min** (900 s). Claims: `sub` (user id), `workspaceId`, `role`, `jti`, `iat`, `exp`, `iss: "livechat"`, `aud: "livechat-app"`.
- `refreshToken` is an opaque random token (32 bytes base64url, 43–44 chars), TTL **30 days**, and it **rotates** on every refresh.
- `emailVerifiedAt` is an ISO date or `null` — there is **no** boolean `emailVerified` field.
- `user.totpEnabled` tells you whether login will demand a second factor.

---

## 1. How auth works

### 1.1 Access token → `Authorization` header (mobile path)

Send `Authorization: Bearer <accessToken>` on every authenticated request.
Server-side resolution order (`apps/api/src/guards.ts`):

1. `Authorization: Bearer …` header — **use this on mobile**.
2. Fallback: `access_token` cookie — the guards accept it, but **the API never sets an `access_token` cookie**, so it does not affect clients.

There is no other REST auth mechanism (no query-string tokens). `workspaceId` and `role` come **only** from the verified JWT — never from URL, query or body.

### 1.2 Refresh token → JSON body (mobile) vs cookie (browser)

`POST /v1/auth/refresh` and `POST /v1/auth/logout` accept the refresh token from **either**:

- JSON body `{ "refreshToken": "…" }` ← **mobile must use this**, or
- the HttpOnly cookie set at login (browser). For refresh, one of the two must be present or you get `401 unauthenticated "Missing refresh token"` (captured). For logout, missing credentials still return `200 { "ok": true }` (captured — idempotent).

Real `Set-Cookie` captured at login (browser-only concern; value faked):

```http
Set-Cookie: refresh_token=ZmFrZS1yZWZyZXNoLXRva2VuLTAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm; Max-Age=2592000; Domain=localhost; Path=/v1/auth; Expires=Mon, 16 Nov 2026 13:13:39 GMT; HttpOnly; SameSite=Lax
```

- Scope: `Path=/v1/auth`, `HttpOnly`, `SameSite=Lax`, `Max-Age=2592000` (30 d); `Secure`/`Domain` follow env.
- Mobile clients: **ignore cookies entirely** — never send or parse them; every session response already carries `refreshToken` in its body.

### 1.3 tempToken (2FA bridge only)

The `tempToken` from a 2FA-required login is a JWT with audience `livechat-app-2fa`, TTL **10 min**. It is accepted **only** by `POST /v1/auth/2fa/verify` and rejected everywhere else (audience mismatch) — never use it as a bearer token.

### 1.4 Roles

Exactly three workspace roles (`packages/shared/src/constants.ts`), carried in the JWT `role` claim:

| role | typical use |
|---|---|
| `owner` | created by signup; full control (delete/billing/change member roles) |
| `admin` | management: invites, API keys, audit, widget settings |
| `agent` | inbox only: read/write conversations |

Capability matrix (deny-by-default; insufficient role → `403 forbidden "Insufficient role"`, captured live for `agent` on `GET /v1/members`):

| capability | owner | admin | agent |
|---|---|---|---|
| `workspace:read` | ✅ | ✅ | ✅ |
| `workspace:update` | ✅ | ✅ | — |
| `workspace:delete`, `billing:manage` | ✅ | — | — |
| `members:read`, `members:invite`, `members:remove` | ✅ | ✅ | — |
| `members:update-role` | ✅ | — | — |
| `apikeys:read`, `apikeys:manage`, `audit:read` | ✅ | ✅ | — |
| `conversations:read`, `conversations:write` | ✅ | ✅ | ✅ |
| `settings:update` (widget) | ✅ | ✅ | — |

All conversation/message endpoints below require `conversations:read` / `conversations:write` → **any role** succeeds (captured for `owner` and `agent`).

### 1.5 Rate limits (429)

In-memory fixed window per route (key = IP, or IP+email on credential routes). Captured live:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many requests. Retry after 60s"
  }
}
```

| route | limit |
|---|---|
| `POST /v1/auth/login` | 10/min per (IP + email) |
| `POST /v1/auth/signup` | 10/min per IP |
| `POST /v1/auth/refresh`, `POST /v1/auth/logout` | 120/min per IP |
| `POST /v1/auth/logout-all`, `POST /v1/auth/2fa/*`, `POST /v1/auth/reset-password`, `POST /v1/auth/verify-email` | 10/min per IP |
| `POST /v1/auth/resend-verification`, `POST /v1/auth/forgot-password` | 5/min per (IP + email) |
| `POST /v1/invitations/accept` 10/min, `GET /v1/invitations/:token` 30/min | per IP |
| `POST /widget/v1/visitor_init` 30/min, `GET /widget/v1/settings` 60/min | per IP |
| WS `message:send` | 30/min per principal → ack `{"ok":false,"error":{"code":"rate_limited","message":"Too many messages. Retry in 30s"}}` |

No `X-RateLimit-*` headers are emitted — parse the wait time from the message and back off.

---

## 2. Error format

Every non-2xx HTTP response (global exception filter):

```json
{
  "error": {
    "code": "<machine_code>",
    "message": "<human-readable message>"
  }
}
```

Schema failures additionally carry `"details": [ …zod issues… ]` — see the live `validation_failed` examples below.

- `details` is **omitted entirely** when absent — it is never `null` or `[]`. Only schema (zod) failures carry it.
- `code` values are stable strings; branch on `code` + HTTP status, not on `message`.

### Codes observed live (with real examples)

**`validation_failed` (400)** — with zod `details` (captured: `?limit=999`):

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Validation failed",
    "details": [
      {
        "code": "too_big",
        "maximum": 100,
        "type": "number",
        "inclusive": true,
        "exact": false,
        "message": "Number must be less than or equal to 100",
        "path": ["limit"]
      }
    ]
  }
}
```

**`validation_failed` (400)** — without `details` (captured: `GET /v1/conversations/not-a-uuid`):

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid id"
  }
}
```

**`validation_failed` (400)** — business-rule rejection (captured: sending into a closed conversation):

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Conversation is closed"
  }
}
```

**`unauthenticated` (401)** — missing/garbage bearer (captured on `GET /v1/conversations`):

```json
{
  "error": {
    "code": "unauthenticated",
    "message": "Authentication required"
  }
}
```

**`invalid_credentials` (401)** — wrong password (captured):

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Invalid email or password"
  }
}
```

Also produced live on this code: `"Invalid authentication code"` (wrong TOTP/backup code) and `"Refresh token reuse detected; sessions revoked"`. Source-defined siblings you may see: `"Invalid refresh token"`, `"Refresh token expired"`, `"Invalid or expired 2FA token"`, `"Account temporarily locked. Try again later."` (after 8 failed logins → 15-minute lock).

**`forbidden` (403)** — role lacks capability (captured: agent calls `GET /v1/members`):

```json
{
  "error": {
    "code": "forbidden",
    "message": "Insufficient role"
  }
}
```

**`not_found` (404)** — captured (`GET /v1/conversations/<unknown uuid>`; same for any missing conversation):

```json
{
  "error": {
    "code": "not_found",
    "message": "Conversation not found"
  }
}
```

**`conflict` (409)** — captured (duplicate signup):

```json
{
  "error": {
    "code": "conflict",
    "message": "Email already registered"
  }
}
```

**`rate_limited` (429)** — example in §1.5.

**`http_error` (400 / 404)** — framework-level failures (captured):

```json
{
  "error": {
    "code": "http_error",
    "message": "Cannot GET /v1/nope"
  }
}
```

```json
{
  "error": {
    "code": "http_error",
    "message": "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
  }
}
```

(The second one = malformed JSON body. Fix your serializer; retrying unchanged will never succeed.)

**`internal_error` (500)** — source-defined fallback for unexpected exceptions (never contains internals):

```json
{
  "error": {
    "code": "internal_error",
    "message": "Internal server error"
  }
}
```

Also defined in shared code but not client-triggerable in practice: `tenant_required` (400).

---

## 3. Pagination shape

Both list endpoints return **keyset** (cursor) pagination with this envelope — captured live:

```json
{
  "items": [],
  "nextCursor": null
}
```

(`items` holds the page rows; `nextCursor` is non-null exactly when another page exists. Real non-empty pages: §5.1 and §6.1.)

- `nextCursor` is an **opaque base64url string** (internally `epochMillis:uuid`) — treat as a black box, URL-encode it when putting it in a query string.
- `nextCursor: null` ⇔ no more pages. Non-null ⇔ pass it back to fetch the next (older) page.
- There is **no** `page`/`offset`/`total` — do not expect numbers.

| endpoint | page-size param | continuation param | order |
|---|---|---|---|
| `GET /v1/conversations` | `limit` (1–100, default **50**) | `cursor` (from `nextCursor`) | newest activity first (`lastMessageAt` desc) |
| `GET /v1/conversations/:id/messages` | `limit` (1–100, default **50**) | `before` (from `nextCursor`) | page window = newest `limit` messages; items inside a page are **oldest → newest** (chat order) |

Chat pattern: first call with no `before` → newest page; keep passing `nextCursor` as `before` to walk back in history.

---

## 4. Auth endpoints

### 4.1 POST /v1/auth/signup

- **Auth:** public.
- **Body:** `{ "email": string(≤254, lowercased+trimmed), "password": string(10–256), "name": string(1–120), "workspaceName": string(1–120) }`
- **200** → session object (a new workspace is created; your role is `owner`; a refresh cookie is also set for browsers):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_ACCESS_TOKEN_PAYLOAD.c2lnbmF0dXJlLWZha2U",
  "refreshToken": "ZmFrZS1yZWZyZXNoLXRva2VuLTAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm",
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "owner.test@example.com",
    "name": "Test Owner",
    "emailVerifiedAt": null,
    "totpEnabled": false
  },
  "workspaceId": "22222222-2222-4222-8222-222222222222",
  "role": "owner"
}
```

- **409** `conflict` `"Email already registered"` (captured) · **400** `validation_failed` (weak/short password, extra fields) · **429** after 10 signups/min/IP.

### 4.2 POST /v1/auth/login — normal response AND the “2FA required” response

- **Auth:** public.
- **Body:** `{ "email": string, "password": string, "totpCode"?: string(6-digit TOTP or backup code) }` (all optional fields strict — no other keys).

**Success (no 2FA enabled) — HTTP 200** (captured):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_ACCESS_TOKEN_PAYLOAD.c2lnbmF0dXJlLWZha2U",
  "refreshToken": "ZmFrZS1yZWZyZXNoLXRva2VuLTAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm",
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "owner.test@example.com",
    "name": "Test Owner",
    "emailVerifiedAt": null,
    "totpEnabled": false
  },
  "workspaceId": "22222222-2222-4222-8222-222222222222",
  "role": "owner"
}
```

**2FA required — HTTP 200** (captured; note: **200, not 401**; there is no `accessToken`/`refreshToken` yet):

```json
{
  "requires2fa": true,
  "tempToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_TEMP_2FA_TOKEN_PAYLOAD.c2lnbmF0dXJlLWZha2U"
}
```

Client flow: if `requires2fa` → show code screen → `POST /v1/auth/2fa/verify` with `{ code, tempToken }` (§4.3). `tempToken` lives 10 minutes.

**Alternative one-shot login (captured):** if 2FA is enabled you may pass `totpCode` directly in the login body and get a full session in one round trip — response is byte-identical to the normal success above (with `"totpEnabled": true` in `user`).

**Wrong credentials — HTTP 401** (captured):

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Invalid email or password"
  }
}
```

(after 8 consecutive failures the account locks for 15 min: `"Account temporarily locked. Try again later."`)

### 4.3 POST /v1/auth/2fa/verify — TOTP **and** backup code (and enrollment confirm)

One route, **two modes** (the body decides):

#### Mode A — complete a two-step login (mobile; NO Authorization header)

- **Auth:** public (the `tempToken` proves the password step passed).
- **Body:** `{ "code": string, "tempToken": string }`
  - `code` = **6-digit TOTP** from the authenticator app **or** a **backup code** `xxxxx-xxxxx` (5+5 chars, letters/digits, case-insensitive). Regex: `^(\d{6}|[a-z0-9]{5}-[a-z0-9]{5})$`.
  - Backup codes are **single-use** — each works exactly once, then it is consumed server-side.
- **200 with TOTP** (captured — session object):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_ACCESS_TOKEN_PAYLOAD.c2lnbmF0dXJlLWZha2U",
  "refreshToken": "ZmFrZS1yZWZyZXNoLXRva2VuLTAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm",
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "owner.test@example.com",
    "name": "Test Owner",
    "emailVerifiedAt": null,
    "totpEnabled": true
  },
  "workspaceId": "22222222-2222-4222-8222-222222222222",
  "role": "owner"
}
```

- **200 with backup code** — identical shape (captured with a `xxxxx-xxxxx` code in `code`).
- **401** wrong code (captured):

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Invalid authentication code"
  }
}
```

- **401** `invalid_credentials` `"Invalid or expired 2FA token"` when `tempToken` is bogus/expired (10-min TTL) or the account no longer has 2FA on.
- Same 10/min/IP rate limit as other auth routes.

#### Mode B — confirm 2FA **enrollment** (step 2 of turning 2FA on)

- **Auth:** `Authorization: Bearer <accessToken>` (no `tempToken`).
- **Body:** `{ "code": "123456" }` (TOTP only).
- **200** → recovery codes, returned **exactly once** (captured):

```json
{
  "recoveryCodes": [
    "aaaaa-bbbbb",
    "ccccc-ddddd",
    "eeeee-fffff",
    "ggggg-hhhhh",
    "iiiii-jjjjj",
    "kkkkk-lllll",
    "mmmmm-nnnnn",
    "ooooo-ppppp",
    "qqqqq-rrrrr",
    "sssss-ttttt"
  ]
}
```

(10 codes, format `xxxxx-xxxxx` over an alphabet without `l`/`o`/`0`/`1` — store them offline immediately; the server keeps only argon2 hashes.)

**Step 1 of enrollment — POST /v1/auth/2fa/setup** (Bearer, no body) → **200** (captured):

```json
{
  "secret": "FAKEBASE32SECRETFAKEBASE32SECRET",
  "otpauthUrl": "otpauth://totp/LiveChat:owner.test%40example.com?secret=FAKEBASE32SECRET&issuer=LiveChat"
}
```

Scan `otpauthUrl` (or key the `secret` into the authenticator), then Mode B. The pending secret is inert until Mode B succeeds. `POST /v1/auth/2fa/disable` (Bearer, `{ password, code }` → `200 { "ok": true }`) exists (source-verified, not exercised in this capture).

### 4.4 POST /v1/auth/refresh

- **Auth:** public — credential = refresh token in **body** `{ "refreshToken": "…" }` (mobile) or the `refresh_token` cookie (browser).
- **200** → full session object; **the refresh token ROTATES** — replace your stored copy with the response's `refreshToken` on every call, atomically (captured):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_ACCESS_TOKEN_PAYLOAD.c2lnbmF0dXJlLWZha2U",
  "refreshToken": "ZmFrZS1yZWZyZXNoLXRva2VuLTAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVm",
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "owner.test@example.com",
    "name": "Test Owner",
    "emailVerifiedAt": null,
    "totpEnabled": true
  },
  "workspaceId": "22222222-2222-4222-8222-222222222222",
  "role": "owner"
}
```

- **401** reuse detection — presenting an already-rotated token revokes the whole session family (captured):

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Refresh token reuse detected; sessions revoked"
  }
}
```

- **401** no token at all (captured) — note the code is `unauthenticated`, not `invalid_credentials`:

```json
{
  "error": {
    "code": "unauthenticated",
    "message": "Missing refresh token"
  }
}
```

- **401** after logout-all (captured — the revoked token reports as reuse).
- Client rule: never use one `refreshToken` from two devices/places concurrently — rotation means the loser gets 401 and both get signed out.

### 4.5 POST /v1/auth/logout

- **Auth:** public — refresh token in **body** `{ "refreshToken": "…" }` or cookie.
- Revokes the whole refresh-token *family* (= that login session) server-side and clears the cookie. **Idempotent** — unknown/missing/already-revoked tokens still succeed (captured both ways):

```json
{
  "ok": true
}
```

- **200** even when called with **no credentials at all** (captured): the response is still `{ "ok": true }`.
- Logout revokes refresh tokens only — the current `accessToken` keeps working until its 15-minute expiry (stateless JWT; verified live: `GET /v1/auth/me` still returned 200 right after logout-all). Clear local state immediately; do not wait for expiry.

### 4.6 POST /v1/auth/logout-all

- **Auth:** **Bearer required** (`Authorization: Bearer <accessToken>`); no body.
- **200** (captured):

```json
{
  "revoked": 4
}
```

- Semantics (important, verified live):
  - **Browser** (refresh cookie sent): revokes every *other* session and keeps the cookie session.
  - **Mobile** (no cookie): nothing is kept → **all** refresh-token families are revoked, **including the caller's**. After this call, refresh with your own token returns `401 invalid_credentials` (captured). Treat logout-all as a full sign-out → local login screen.
- Rate limit 10/min/IP.

### 4.7 Other auth routes (exist; marked if exercised)

| route | auth | status/shape |
|---|---|---|
| `GET /v1/auth/me` | Bearer | **captured 200:** `{ "userId": "11111111-1111-4111-8111-111111111111", "workspaceId": "22222222-2222-4222-8222-222222222222", "role": "owner" }` — cheap token-validity check |
| `POST /v1/auth/verify-email` `{ token }` | public | 200 `{ "ok": true }` (source-verified) |
| `POST /v1/auth/resend-verification` `{ email }` | public | 202 `{ "ok": true }`, no account enumeration (source-verified) |
| `POST /v1/auth/forgot-password` `{ email }` | public | 202 `{ "ok": true }` / 429 captured (source-verified for 202) |
| `POST /v1/auth/reset-password` `{ token, password }` | public | 200 `{ "ok": true }` (source-verified) |
| `GET /v1/auth/sessions` | Bearer | array of `{ id, ip, userAgent, createdAt, expiresAt, current }` (source-verified, not captured) |
| `DELETE /v1/auth/sessions/:id` | Bearer | 200 `{ "ok": true }`, revokes one session (source-verified, not captured) |
| `POST /v1/auth/2fa/disable` `{ password, code }` | Bearer | 200 `{ "ok": true }` (source-verified, not captured) |

---

## 5. Conversations

All routes below: `Authorization: Bearer <accessToken>` + capability `conversations:read`/`conversations:write` → **owner, admin or agent** all pass. The workspace always comes from the token.

Conversation status enum: **`"open"` | `"pending"` | `"closed"`** (there is no `"resolved"` — *resolve* = set `closed`; *reopen* = set `open`).

### 5.1 GET /v1/conversations — list with filters + pagination

**Query (all optional):**

| param | values | notes |
|---|---|---|
| `status` | `open` \| `pending` \| `closed` | exact match |
| `assignee` | `me` \| `unassigned` \| `any` | `me` = your user id; `any`/omitted = no filter |
| `limit` | 1–100 (default 50) | |
| `cursor` | opaque string | from previous page's `nextCursor` |

Example: `GET /v1/conversations?status=open&assignee=unassigned&limit=50`

**200 — page 1** (captured with `?limit=1`; faked ids):

```json
{
  "items": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "status": "open",
      "assignedTo": null,
      "subject": null,
      "closedAt": null,
      "lastMessageAt": "2026-10-17T13:13:40.979Z",
      "createdAt": "2026-10-17T13:13:40.979Z",
      "visitor": {
        "id": "55555555-5555-4555-8555-555555555555",
        "name": "Fake Visitor B",
        "email": null
      }
    }
  ],
  "nextCursor": "MTc5MjE5NTI0MTk3OTo2NjY2NjY2Ni02NjY2LTQ2NjYtODY2Ni02NjY2NjY2NjY2NjY"
}
```

**200 — page 2** (`?limit=1&cursor=<nextCursor>`, captured; end of list):

```json
{
  "items": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "status": "open",
      "assignedTo": null,
      "subject": null,
      "closedAt": null,
      "lastMessageAt": "2026-10-17T13:13:40.926Z",
      "createdAt": "2026-10-17T13:13:40.926Z",
      "visitor": {
        "id": "33333333-3333-4333-8333-333333333333",
        "name": "Fake Visitor A",
        "email": null
      }
    }
  ],
  "nextCursor": null
}
```

- **400** `validation_failed` with `details` for bad `limit` (§2) · **400** `"Invalid cursor"` for a mangled cursor (source-verified) · **401/403** per §2.

### 5.2 GET /v1/conversations/:id — detail

- **Auth:** Bearer + `conversations:read`. `:id` must be a UUID.
- **200** (captured):

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "status": "open",
  "assignedTo": null,
  "subject": null,
  "closedAt": null,
  "lastMessageAt": "2026-10-17T13:13:40.926Z",
  "createdAt": "2026-10-17T13:13:40.926Z",
  "visitor": {
    "id": "33333333-3333-4333-8333-333333333333",
    "name": "Fake Visitor A",
    "email": null
  }
}
```

- **400** `{"code":"validation_failed","message":"Invalid id"}` for a non-UUID `:id` (captured).
- **404** `not_found` `"Conversation not found"` (captured) — also returned for conversations of another tenant (no existence leak).

### 5.3 PATCH /v1/conversations/:id — assign / resolve / reopen

- **Auth:** Bearer + `conversations:write` (any role).
- **Body (strict, at least one field):**
  - `status`: `"open" | "pending" | "closed"`
  - `assignedTo`: UUID of a **member user of this workspace**, or `null` to unassign (non-member → 400 `"Assignee is not a member of this workspace"`, source-verified)
  - `subject`: string 1–200 or `null`
- Empty body `{}` → **400** (captured):

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Validation failed",
    "details": [
      {
        "code": "custom",
        "message": "At least one field to update is required",
        "path": []
      }
    ]
  }
}
```

**Assign — `{"assignedTo":"11111111-1111-4111-8111-111111111111"}` → 200** (captured):

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "status": "open",
  "assignedTo": "11111111-1111-4111-8111-111111111111",
  "subject": null,
  "closedAt": null,
  "lastMessageAt": "2026-10-17T13:13:40.926Z",
  "createdAt": "2026-10-17T13:13:40.926Z",
  "visitor": {
    "id": null,
    "name": null,
    "email": null
  }
}
```

> **Real quirk (captured):** the PATCH response does **not** join visitor data — `visitor` is always nulls here. Re-`GET /v1/conversations/:id` if you need it. Everything else is current.

**Resolve — `{"status":"closed"}` → 200** (captured; `closedAt` is stamped):

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "status": "closed",
  "assignedTo": "11111111-1111-4111-8111-111111111111",
  "subject": null,
  "closedAt": "2026-10-17T13:13:41.176Z",
  "lastMessageAt": "2026-10-17T13:13:41.145Z",
  "createdAt": "2026-10-17T13:13:40.926Z",
  "visitor": { "id": null, "name": null, "email": null }
}
```

**Reopen — `{"status":"open"}` → 200** (captured; `closedAt` cleared):

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "status": "open",
  "assignedTo": "11111111-1111-4111-8111-111111111111",
  "subject": null,
  "closedAt": null,
  "lastMessageAt": "2026-10-17T13:13:41.145Z",
  "createdAt": "2026-10-17T13:13:40.926Z",
  "visitor": { "id": null, "name": null, "email": null }
}
```

- **404** unknown id · **400** non-UUID / empty body / non-member assignee · **403** role (all per §2).
- Every successful PATCH also fans out Socket.IO `conversation:updated` to connected agents (§7).

---

## 6. Messages

### 6.1 GET /v1/conversations/:id/messages — list (pagination)

- **Auth:** Bearer + `conversations:read` (any role).
- **Query:** `limit` (1–100, default 50), `before` (opaque `nextCursor` from the previous page).
- **200 — newest page** (`?limit=2`, captured; items are **oldest → newest** inside the page):

```json
{
  "items": [
    {
      "id": "77777777-7777-4777-8777-777777777702",
      "conversationId": "44444444-4444-4444-8444-444444444444",
      "senderType": "agent",
      "senderId": "11111111-1111-4111-8111-111111111111",
      "body": "Thanks — we are looking into it now.",
      "bodyType": "text",
      "createdAt": "2026-10-17T13:13:41.134Z"
    },
    {
      "id": "77777777-7777-4777-8777-777777777703",
      "conversationId": "44444444-4444-4444-8444-444444444444",
      "senderType": "agent",
      "senderId": "11111111-1111-4111-8111-111111111111",
      "body": "Anything else we can check for you?",
      "bodyType": "text",
      "createdAt": "2026-10-17T13:13:41.145Z"
    }
  ],
  "nextCursor": "MTc5MjE5NTI0MTEzNDo3Nzc3Nzc3Ny03Nzc3LTQ3NzctODc3Ny03Nzc3Nzc3Nzc3MDI"
}
```

**200 — older page** (`?limit=2&before=<nextCursor>`, captured; last page):

```json
{
  "items": [
    {
      "id": "77777777-7777-4777-8777-777777777701",
      "conversationId": "44444444-4444-4444-8444-444444444444",
      "senderType": "agent",
      "senderId": "11111111-1111-4111-8111-111111111111",
      "body": "Hello! How can we help you today?",
      "bodyType": "text",
      "createdAt": "2026-10-17T13:13:41.117Z"
    }
  ],
  "nextCursor": null
}
```

- `senderType` is `"agent"` or `"visitor"`; `senderId` is the agent's user id or the visitor's id.
- Deleted messages are filtered out server-side. **401/403/400/404** per §2.

### 6.2 POST /v1/conversations/:id/messages — send (REST)

- **Auth:** Bearer + `conversations:write` (any role). The comment in source calls this “REST send path (tests, future mobile app); the widget uses the socket” — it is a first-class endpoint.
- **Body (strict):** `{ "body": string(1–4000 chars), "idempotencyKey"?: string(1–64) }`
- **201 Created** (captured):

```json
{
  "id": "77777777-7777-4777-8777-777777777701",
  "conversationId": "44444444-4444-4444-8444-444444444444",
  "senderType": "agent",
  "senderId": "11111111-1111-4111-8111-111111111111",
  "body": "Hello! How can we help you today?",
  "bodyType": "text",
  "createdAt": "2026-10-17T13:13:41.117Z"
}
```

- **Idempotency (source-verified):** re-sending with the same `idempotencyKey` in the same workspace returns the **original message** instead of creating a duplicate — use a key per user-tap so retries are safe.
- **400** `"Conversation is closed"` (captured) — reopen first (§5.3).
- **400** `validation_failed` with `details` for `unrecognized_keys` (captured) or body > 4000 chars:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Validation failed",
    "details": [
      {
        "code": "unrecognized_keys",
        "keys": ["nonsense"],
        "path": [],
        "message": "Unrecognized key(s) in object: 'nonsense'"
      }
    ]
  }
}
```

- **404** unknown conversation · **401/403** per §2.
- A successful send fans out `message:new` + `conversation:updated` to sockets (§7) — if your own socket is joined you will also receive the echo; render from **either** the REST 201 **or** the WS event, de-duplicated by message `id`.

---

## 7. Socket.IO (realtime)

### 7.1 Connection & auth handshake

- **Endpoint:** same origin as REST, Socket.IO **path `/ws`**, default namespace, CORS `*`.
- **Auth:** pass the token in the handshake `auth` object — **not** in the URL, **not** in cookies:

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:4000', {
  path: '/ws',
  transports: ['websocket'],   // polling also works; dashboard/widget use websocket
  auth: { token: accessToken } // agent access token …
  // auth: { token: visitorToken } …or a visitor token from POST /widget/v1/visitor_init
});
```

- The two token audiences are disjoint (agent JWT vs visitor JWT) — each is accepted only as its own kind, so neither can impersonate the other.
- **Rejection (captured):** missing or invalid `auth.token` → the client emits **`connect_error`** and never reaches any room:

```json
{ "message": "unauthorized" }
```

(captured for both “garbage token” and “no token”. Reconnect logic: this is fatal for that attempt — re-authenticate (refresh) before reconnecting.)

### 7.2 Rooms

| room | joined how | purpose |
|---|---|---|
| `workspace:{workspaceId}` | **automatic** on connect (agent) | inbox-wide updates |
| `agent:{userId}` | **automatic** on connect (agent) | direct targeting |
| `visitor:{visitorId}` | **automatic** on connect (visitor) | visitor targeting |
| `conversation:{conversationId}` | **manually** via `conversation:join` | messages + typing for one conversation |

Agents are auto-subscribed to workspace-wide events; you must `conversation:join` each conversation you open before sending/typing in it.

### 7.3 Client → server events (all acknowledged)

Every client→server event takes an ack callback. Success/failure envelope (captured):

```json
{ "ok": true }
```
```json
{
  "ok": false,
  "error": { "code": "forbidden", "message": "Join the conversation before sending" }
}
```

Success acks may carry extra result fields (`conversationId`, `message`) — see each event below.

**`conversation:join`** — payload `{ "conversationId": "<uuid>" }` → ack (captured):

```json
{
  "ok": true,
  "conversationId": "44444444-4444-4444-8444-444444444444"
}
```

Server verifies the conversation exists and belongs to your workspace (for visitors: that you own it) before joining; failures come back in the ack (`not_found`, `validation_failed`, …).

**`conversation:leave`** — payload `{ "conversationId": "<uuid>" }` → ack (captured):

```json
{ "ok": true }
```

**`message:send`** — payload `{ "conversationId": "<uuid>", "body": "<1–4000 chars>", "idempotencyKey"?: "<1–64>" }` → ack with the persisted message (captured, agent side):

```json
{
  "ok": true,
  "message": {
    "id": "77777777-7777-4777-8777-777777777704",
    "conversationId": "44444444-4444-4444-8444-444444444444",
    "senderType": "agent",
    "senderId": "11111111-1111-4111-8111-111111111111",
    "body": "Realtime reply from the agent.",
    "bodyType": "text",
    "createdAt": "2026-10-17T13:13:41.521Z"
  }
}
```

Visitor side is identical apart from `"senderType": "visitor"` / `senderId = visitorId` (captured).

Failure acks (all captured):

```json
{
  "ok": false,
  "error": { "code": "forbidden", "message": "Join the conversation before sending" }
}
```

(= sent before `conversation:join`). Rate limit (source-verified): `{"ok":false,"error":{"code":"rate_limited","message":"Too many messages. Retry in 30s"}}` after 30 sends/min. Sending into a closed conversation returns the same ack shape with `validation_failed` / `"Conversation is closed"` (REST path captured; WS shares the service code).

**`typing`** — payload `{ "conversationId": "<uuid>", "typing": true|false }` → ack (captured):

```json
{ "ok": true }
```

Typing is relayed live, never stored. Join first (same `forbidden` ack otherwise, source-verified).

### 7.4 Server → client events (complete inventory)

All four were captured live in a single session; there are **no other** server-emitted event names in the gateway.

**`message:new`** — to `conversation:{id}` (every member incl. the sender). Triggered by WS send, REST send, and visitor sends:

```json
{
  "conversationId": "44444444-4444-4444-8444-444444444444",
  "message": {
    "id": "77777777-7777-4777-8777-777777777705",
    "conversationId": "44444444-4444-4444-8444-444444444444",
    "senderType": "visitor",
    "senderId": "33333333-3333-4333-8333-333333333333",
    "body": "Hi — I need help with my order.",
    "bodyType": "text",
    "createdAt": "2026-10-17T13:13:41.761Z"
  }
}
```

**`conversation:updated`** — has **two real payload variants** (both captured):

Variant A — new activity, to `workspace:{id}` (refresh your inbox row):

```json
{
  "conversationId": "44444444-4444-4444-8444-444444444444",
  "lastMessageAt": "2026-10-17T13:13:41.761Z"
}
```

Variant B — status/assignment change (from `PATCH /v1/conversations/:id`), to `workspace:{id}` **and** `conversation:{id}`:

```json
{
  "conversationId": "44444444-4444-4444-8444-444444444444",
  "status": "pending",
  "assignedTo": "11111111-1111-4111-8111-111111111111"
}
```

> **Real quirk (captured):** an agent socket that is in *both* rooms receives variant B **twice**. De-duplicate (or handle idempotently). `assignedTo` may be `null`.

**`visitor:presence`** — to `workspace:{id}`, when a visitor's socket count goes 0→1 (`online:true`) or 1→0 (`online:false`):

```json
{
  "visitorId": "33333333-3333-4333-8333-333333333333",
  "online": true
}
```

```json
{
  "visitorId": "33333333-3333-4333-8333-333333333333",
  "online": false
}
```

**`typing`** — relayed to `conversation:{id}` **except** the sender (captured with `by:"visitor"`; `by:"agent"` is identical per source):

```json
{
  "conversationId": "44444444-4444-4444-8444-444444444444",
  "typing": true,
  "by": "visitor",
  "senderId": "33333333-3333-4333-8333-333333333333"
}
```

(`by` is `"agent" | "visitor"`; `senderId` is the agent user id or visitor id. Not persisted — if you reconnect you will not get a replay.)

### 7.5 Realtime client rules (all verified live)

1. Connect with `auth: { token }`; on `connect_error` refresh the access token and reconnect (never loop on a dead token).
2. `conversation:join` before `message:send`/`typing` → otherwise `forbidden` acks.
3. Expect your **own** sent messages echoed back as `message:new` (you're in the room) — dedupe against the ack/REST response by message `id`.
4. Expect possible **duplicate** `conversation:updated` (§7.4) — handle idempotently.
5. Full observed order in one session: `message:new` → `conversation:updated(A)` → `visitor:presence(true)` → `typing` → `message:new` → `conversation:updated(A)` → `conversation:updated(B)` ×2 → `message:new` → `conversation:updated(A)` → `visitor:presence(false)`.
6. WS sends are rate-limited 30/min per principal; back off per the ack message.

---

## 8. MISSING endpoints

These do **not** exist in the API (verified by controller scan) — do not build a client against them:

- `DELETE /v1/conversations/:id` (or any conversation deletion) — close it instead.
- Message **edit** or **delete** over REST or WS (the only trace: server filters `deleted_at` when listing).
- Conversation **search**, tags, priorities, custom fields, snooze, canned replies.
- Unread counters / badge counts / `GET …/unread`.
- **Push notifications**: no device-token (FCM/APNs) registration endpoint anywhere.
- **Attachments / file upload** — message `body` is plain text, ≤4000 chars, `bodyType` is always `"text"`.
- Change-password-while-signed-in (only `forgot-password` → `reset-password` via emailed token).
- A literal `"resolved"`/`"solved"` status — only `open|pending|closed`.
- Numeric `page`/`offset`/`total` pagination — keyset cursors only.
- REST typing or presence endpoints — WS events only.
- 2FA QR **image** — only `otpauthUrl`/`secret` are returned.
- WebSocket auth via query parameter or cookie — handshake `auth.token` only.
- Generic “search messages” / cross-conversation message list.

Endpoints that exist but were **not exercised** in this capture (marked source-verified in §4.7 and below): `GET /v1/workspace`, `GET /v1/members` (only the agent **403** path was captured), `PATCH/DELETE /v1/members…`, `GET /v1/invitations/:token`, `GET/POST/DELETE /v1/api-keys`, `GET /v1/audit-logs`, `GET /v1/visitors`, `GET/PATCH /v1/widget/settings`, `GET /widget/v1/settings`. Invitation **create** (`201 { invitationId, token }`) and **accept** (`200 { accessToken, user, workspaceId, role }` — note: **no `refreshToken` field** in the body, cookie only) *were* captured live during role testing.

---

## 9. Mobile client checklist

1. **Sign up / log in** (§4.1/§4.2) → persist `accessToken` + `refreshToken` in Keychain/SecureStore (never plain storage). Ignore all `Set-Cookie` headers.
2. **2FA UX:** login returns `200 { requires2fa, tempToken }` → code screen → `POST /v1/auth/2fa/verify { code, tempToken }` (TOTP *or* `xxxxx-xxxxx` backup code) → session. Or one-shot: include `totpCode` in the login body.
3. **Authenticated calls:** `Authorization: Bearer <accessToken>` only. On `401 unauthenticated` → `POST /v1/auth/refresh { refreshToken }` → retry the original request **once**. On refresh `401` → wipe session → login screen. Persist the rotated `refreshToken` before retrying.
4. **Sign out:** `POST /v1/auth/logout { refreshToken }` (idempotent) → wipe local state. **Sign out everywhere:** `POST /v1/auth/logout-all` (Bearer) → also wipes *this* device's refresh token on mobile → login screen.
5. **Inbox:** `GET /v1/conversations?…` with cursor loop (`nextCursor` → `cursor`) (§3/§5). Open thread → detail + `GET …/messages` (`before` loop).
6. **Send:** `POST …/messages` with an `idempotencyKey` per user tap; treat `201` as source of truth and de-dupe WS echoes by message `id`.
7. **Realtime:** Socket.IO `path:'/ws'`, `auth:{ token }` (§7); join each open conversation; handle duplicate `conversation:updated` and own-message echo.
8. **Errors:** branch on `error.code` + HTTP status (§2); surface `error.message` only as text. Back off on `429` using the seconds in the message.
9. **Strict schemas:** never send extra fields; `null` means “clear this field” on PATCH.

### Provenance of this document

- Captured on **2026-10-17** against the dev API at `http://localhost:4000` with a throwaway user/workspace created for the purpose (64 live request/response exchanges, incl. Socket.IO acks and events).
- Probe script: `apps/api/scripts/contract-probe.ts` — it re-runs every capture and **redacts tokens/emails/ids/secrets at print time**; full transcript: `tmp/probe-out.txt`.
- Shapes cross-checked against `apps/api/src/*.controller.ts`, `chat.gateway.ts`, `conversations.service.ts`, `auth-service.ts`, `guards.ts`, `filters.ts` and `packages/shared/src/{schemas,constants,errors}.ts`.
- Every token, email, id and secret in this file is **fake** (`example.com` addresses, `…-0000-4000-8000-…` UUIDs, `FAKE_…` JWT payloads). No real credentials or customer data are present. Items labeled *source-verified* were read from code but not hit during the capture; everything labeled *captured* is a byte-faithful response (values aside).






