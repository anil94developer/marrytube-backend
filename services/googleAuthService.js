/**
 * Verify Google Identity Services JWT (credential) server-side using GOOGLE_CLIENT_ID.
 */
const { OAuth2Client } = require('google-auth-library');

function getGoogleAudiences() {
  const raw =
    process.env.GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_WEB_CLIENT_ID ||
    '';
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * @param {string} idToken - JWT from Google button / One Tap
 * @returns {Promise<{ googleId: string, email: string, name: string, picture?: string }>}
 */
async function verifyGoogleCredential(idToken) {
  const audiences = getGoogleAudiences();
  if (audiences.length === 0) {
    const err = new Error(
      'Google Sign-In not configured: set GOOGLE_CLIENT_ID in MarryBackend/.env ' +
      '(OAuth 2.0 Web Client ID from Google Cloud Console, same ID as frontend REACT_APP_GOOGLE_CLIENT_ID), then restart the API server.'
    );
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }

  const primary = audiences[0];
  const client = new OAuth2Client(primary);

  const ticket = await client.verifyIdToken({
    idToken,
    audience: audiences.length === 1 ? primary : audiences,
  });

  const payload = ticket.getPayload();
  if (!payload?.email) {
    const err = new Error('Google account has no email');
    err.code = 'NO_EMAIL';
    throw err;
  }
  if (payload.email_verified === false) {
    const err = new Error('Google email must be verified');
    err.code = 'EMAIL_UNVERIFIED';
    throw err;
  }

  return {
    googleId: payload.sub,
    email: String(payload.email).toLowerCase().trim(),
    name: payload.name || 'User',
    picture: payload.picture,
  };
}

module.exports = {
  verifyGoogleCredential,
  getGoogleAudiences,
};
