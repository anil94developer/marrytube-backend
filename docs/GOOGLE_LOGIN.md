# Google Sign-In (`GOOGLE_CLIENT_ID`)

## Backend (`.env` file location)

Variables are read from **`MarryBackend/.env`** next to `server.js` (not necessarily your shell’s working directory—the app loads that path explicitly).

```env
GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
```


JWT is verified server-side with [google-auth-library](https://www.npmjs.com/package/google-auth-library).  
Comma-separated IDs are supported if you use multiple OAuth Web clients (`GOOGLE_CLIENT_ID=id1,id2`).

Same client must be configured in **Google Cloud Console** → APIs & Services → Credentials → OAuth 2.0 Client ID (**Web application**):

- **Authorized JavaScript origins**: `http://localhost:3000` (and production URL).
- Authorized redirect URIs are optional for GIS button / One Tap (popup flow).

Endpoints:

| Method | Path | Body |
|--------|------|------|
| `POST` | `/api/auth/google` | `{ credential: "<GIS JWT>", userType?: "customer" \| "studio" }` |

- **Customer**: Creates account if the email is new; JWT must match Gmail / verified Google email.
- **Studio**: User must already exist (`userType: studio`), same Gmail as studio email, and **`isActive: true`** (admin approved).

## Frontend (CRA)

Create React App **only** exposes vars prefixed with `REACT_APP_`:

```env
REACT_APP_GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
```

Must match backend `GOOGLE_CLIENT_ID`.

Then install the Google React helper (if missing):

```bash
cd MarryTube && npm install @react-oauth/google
```

Restart `npm start` after changing `.env`.
