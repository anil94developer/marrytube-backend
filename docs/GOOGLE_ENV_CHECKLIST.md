## Fix “Google Sign-In not configured”

### 1) Put the Client ID in the **correct file**

File path (must exist):

```
Marry store/MarryBackend/.env
```

**Same folder as** `server.js` — **not** the repo root and **not** only `MarryTube/.env`.

Add this line (no spaces around `=`, no quotes unless your tool requires them):

```env
GOOGLE_CLIENT_ID=PASTE_YOUR.apps.googleusercontent.com
```

(Optional second name, same value:)

```env
GOOGLE_WEB_CLIENT_ID=PASTE_YOUR.apps.googleusercontent.com
```

### 2) Frontend (React) still needs

In `MarryTube/.env`:

```env
REACT_APP_GOOGLE_CLIENT_ID=PASTE_YOUR.apps.googleusercontent.com
```

Restart **`npm start`** after changing frontend env.

### 3) Restart the **API**

Stop and start `nodemon` / `npm run dev` so the backend process reloads `.env`.

### 4) Check that the backend sees it

Open in browser or curl:

`http://localhost:5001/api/auth/google-config-status`

You want:

```json
{ "configured": true }
```

If `configured` is **false**, the `.env` file is wrong folder, typo in key name, or the server wasn’t restarted.
