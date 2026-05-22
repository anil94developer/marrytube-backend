# Google Sign-In console errors explained

## 1. `The given origin is not allowed for the given client ID`

Google only allows Sign-In from URLs you whitelist.

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**.
2. Open your **OAuth 2.0 Client ID** (type **Web application**).
3. Under **Authorized JavaScript origins**, add **every URL you actually use**:

| Use this browser address | Origins you must add |
|--------------------------|----------------------|
| `http://localhost:3000/` | `http://localhost:3000` |
| `http://127.0.0.1:3000/` | `http://127.0.0.1:3000` |

They are **different** origins; add **both** if you sometimes use each.

Production: also add `https://yourdomain.com` (no trailing path).

Save, wait **up to ~5 minutes**, hard-refresh (`Ctrl+Shift+R`).

---

## 2. `FedCM was disabled…` / `403` / `AbortError`

- **FedCM** is tied to Chrome’s federated-login / privacy flow. Third-party cookie / site settings blocks can disable it.
- **Fix UX:** Use the app with **`useOneTap={false}`** (only the “Continue with Google” button)—we set this so One Tap/FedCM is not required.

User actions:

- Chrome: padlock/site icon → allow third-party cookies for localhost (or disable strict blocking for testing).
- Or try another browser/incognito once origins are correct.

---

## 3. `Cross-Origin-Opener-Policy would block … postMessage`

Usually happens together with popup / GIS when COOP conflicts. Often disappears after **Authorized origins** are correct.

If it persists:

- Prefer exact origin match (`localhost` vs `127.0.0.1`).
- Disable aggressive extensions temporarily.

---

## 4. `500` on `POST /api/auth/google`

Common causes:

- **`JWT_SECRET` missing** in `MarryBackend/.env` — add a strong random secret and restart the API.
- **Database error** creating user — check server terminal logs (`Google login error:`).

Development: the JSON body should include a useful `message` when `NODE_ENV` is not production.
