/**
 * Single place to load `.env` from the backend folder (never rely on process.cwd).
 * Loads MarryBackend/.env then optional MarryBackend/.env.local (overrides).
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const backendRoot = path.join(__dirname, '..');

function loadFile(name, override) {
  const full = path.join(backendRoot, name);
  if (!fs.existsSync(full)) return;
  const r = dotenv.config({ path: full, override: !!override });
  if (r.error) console.warn('[loadEnv]', name, r.error.message);
}

loadFile('.env', false);
loadFile('.env.local', true);

// Strip accidental wrapping quotes/spaces some editors add
function clean(key) {
  const v = process.env[key];
  if (typeof v !== 'string') return;
  const t = v.trim().replace(/^["']+|["']+$/g, '').trim();
  if (t !== v) process.env[key] = t;
}
clean('GOOGLE_CLIENT_ID');
clean('GOOGLE_WEB_CLIENT_ID');
