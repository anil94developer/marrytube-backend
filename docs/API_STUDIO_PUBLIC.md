# Studio & public API (no repo secrets)

**Open source** means the *code* is public — it does **not** mean every HTTP route is unauthenticated.  
Some routes are **public** (no `Authorization` header). Others need **admin** or **studio** login for security.

---

## 1. Truly public — call from anywhere (Postman, app, `curl`)

No Bearer token. Only `Content-Type: application/json` where noted.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Server + DB check |
| `POST` | `/api/studio/register` | Studio self-registration (pending approval email) |
| `POST` | `/api/auth/studio/login` | Studio login (email + password) after admin approves |

**Base URL:** `http://<host>:<PORT>` — e.g. `http://localhost:5000` (see `PORT` in `.env`).

### Register studio (public)

```http
POST /api/studio/register
Content-Type: application/json
```

```json
{
  "email": "studio@example.com",
  "name": "My Studio",
  "password": "atleast6chars",
  "city": "Mumbai",
  "address": "Optional",
  "pincode": "400001"
}
```

**Success:** `200` — `{ "success": true, "studio": { ... }, "emailSent": true|false }`  
**Errors:** `400` validation or duplicate email/mobile.

### Studio login (public — uses email + password, not a static API key)

```http
POST /api/auth/studio/login
Content-Type: application/json
```

```json
{
  "email": "studio@example.com",
  "password": "atleast6chars"
}
```

**Success:** `200` — `{ "success": true, "token": "<jwt>", "user": { ... } }`  
Use that `token` only for **studio-protected** routes:  
`Authorization: Bearer <token>` (value comes from **this response**, not from the repo).

---

## 2. Admin approve studio — not “globally open” (by design)

`PATCH /api/admin/studios/:studioId/approve` is **not** public.  
If it were callable with **no** login, anyone on the internet could approve any studio.

**How it works in production:**

1. An **admin user** exists only on **your** server/database (not in GitHub).
2. Admin logs in: `POST /api/auth/admin/login` with that admin’s **email + password**.
3. Response includes a **JWT** — use it until it expires:

```http
PATCH /api/admin/studios/5/approve
Content-Type: application/json
Authorization: Bearer <jwt-from-admin-login-response>
```

```json
{ "isActive": true }
```

There is **no** shared “global” admin token in the repository — each admin gets a token by logging in.

### Example: get token in one shell line (bash)

Replace admin email/password with your real admin credentials:

```bash
BASE="http://localhost:5000"
TOKEN=$(curl -s -X POST "$BASE/api/auth/admin/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yoursite.com","password":"your-admin-password"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")

curl -s -X PATCH "$BASE/api/admin/studios/5/approve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"isActive":true}'
```

---

## 3. CORS / “global” clients

Browsers send an `Origin` header. This server’s CORS allows common localhost origins and can be extended for your production domain.  
**Mobile apps** and **`curl`** often have no origin — they are allowed.

---

## 4. Env vars (links in registration emails)

| Variable | Role |
|----------|------|
| `FRONTEND_URL` | Base URL for “Studio login” links in emails |
| SMTP vars (`EMAIL_*`) | Sending pending / approval emails |

No admin token is stored in `.env` for approving studios — use **admin login** instead.
