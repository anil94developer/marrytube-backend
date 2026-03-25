/**
 * Studio registration emails — uses SMTP from .env (same as OTP).
 * Optional: ADMIN_NOTIFY_EMAIL=bcc@example.com to notify admins of new signups.
 */
const { sendHtmlEmail } = require('./otpService');

const escapeHtml = (s) => {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

const getFrontendBase = () => {
  const u = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
  return u;
};

/**
 * Premium transactional template — “account pending approval” (studio self-registration).
 */
const getStudioPendingApprovalHtml = ({ name, email, studioId }) => {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const year = new Date().getFullYear();
  const loginUrl = `${getFrontendBase()}/studio/login`;
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Studio registration received</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color:#ffffff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #0d9488 0%, #6366f1 100%); padding: 32px 32px 24px; text-align: center;">
              <h1 style="margin:0; color:#ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">MarryTube Studio</h1>
              <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 14px;">Registration received — approval pending</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 8px;">
              <p style="margin:0 0 12px; color:#111827; font-size: 16px; font-weight: 600;">Hi ${safeName},</p>
              <p style="margin:0 0 16px; color:#374151; font-size: 15px; line-height: 1.6;">
                Thank you for registering as a <strong>Studio</strong> on MarryTube. Your account is <strong>pending admin approval</strong>.
              </p>
              <div style="background: #f9fafb; border-left: 4px solid #6366f1; border-radius: 8px; padding: 16px 18px; margin: 20px 0;">
                <p style="margin:0 0 8px; color:#6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;">Registered email</p>
                <p style="margin:0; color:#111827; font-size: 15px; font-weight: 500;">${safeEmail}</p>
                <p style="margin: 12px 0 0; color:#6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;">Reference</p>
                <p style="margin:0; color:#4b5563; font-size: 13px; font-family: ui-monospace, monospace;">Studio ID #${escapeHtml(String(studioId))}</p>
              </div>
              <p style="margin: 0 0 20px; color:#374151; font-size: 15px; line-height: 1.6;">
                You’ll receive another email when your account is <strong>approved</strong>. Until then, studio login may be unavailable.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto 24px;">
                <tr>
                  <td style="border-radius: 10px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);">
                    <a href="${loginUrl}" style="display: inline-block; padding: 14px 28px; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px;">Go to Studio login</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0; color:#9ca3af; font-size: 12px; line-height: 1.5;">
                If you didn’t create this account, you can ignore this message or contact support.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 28px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin:0; color:#9ca3af; font-size: 11px;">© ${year} MarryTube. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};

/**
 * Send “pending approval” email to the studio registrant.
 * Does not throw — returns { success, message }.
 */
async function sendStudioRegistrationPendingEmail({ toEmail, name, studioId }) {
  const subject = 'MarryTube — Studio registration received (pending approval)';
  const html = getStudioPendingApprovalHtml({
    name: name || 'there',
    email: toEmail,
    studioId,
  });
  const bcc = (process.env.ADMIN_NOTIFY_EMAIL || '').trim() || undefined;
  return sendHtmlEmail({
    to: toEmail,
    subject,
    html,
    text: `Hi ${name || 'there'}, your MarryTube Studio registration is pending. Email: ${toEmail}. Studio ID #${studioId}. Login: ${getFrontendBase()}/studio/login`,
    bcc,
  });
}

const getStudioApprovedHtml = ({ name, email }) => {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const year = new Date().getFullYear();
  const loginUrl = `${getFrontendBase()}/studio/login`;
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Studio account approved</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color:#ffffff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); padding: 32px 32px 24px; text-align: center;">
              <h1 style="margin:0; color:#ffffff; font-size: 22px; font-weight: 700;">You’re approved ✓</h1>
              <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 14px;">Your MarryTube Studio account is active</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 8px;">
              <p style="margin:0 0 12px; color:#111827; font-size: 16px; font-weight: 600;">Hi ${safeName},</p>
              <p style="margin:0 0 18px; color:#374151; font-size: 15px; line-height: 1.6;">
                Great news — your studio account (<strong>${safeEmail}</strong>) has been <strong>approved</strong>. You can sign in and start managing clients.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto 24px;">
                <tr>
                  <td style="border-radius: 10px; background: linear-gradient(135deg, #059669 0%, #10b981 100%);">
                    <a href="${loginUrl}" style="display: inline-block; padding: 14px 28px; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px;">Sign in to Studio</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0; color:#9ca3af; font-size: 12px;">© ${year} MarryTube</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};

async function sendStudioAccountApprovedEmail({ toEmail, name }) {
  const subject = 'MarryTube — Your Studio account is approved';
  const html = getStudioApprovedHtml({ name: name || 'there', email: toEmail });
  return sendHtmlEmail({
    to: toEmail,
    subject,
    html,
    text: `Hi ${name || 'there'}, your MarryTube Studio account is approved. Sign in: ${getFrontendBase()}/studio/login`,
  });
}

module.exports = {
  getStudioPendingApprovalHtml,
  sendStudioRegistrationPendingEmail,
  sendStudioAccountApprovedEmail,
};
