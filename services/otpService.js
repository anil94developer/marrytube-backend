const { OTP } = require('../models');
const { Op } = require('sequelize');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Initialize Twilio client
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Initialize email transporter (supports EMAIL_PASS or EMAIL_PASSWORD)
const emailUser = process.env.EMAIL_USER ? String(process.env.EMAIL_USER).replace(/^["']|["']$/g, '').trim() : '';
const emailPass = process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD;
const defaultFromEmail = process.env.EMAIL_FROM || 'no-reply@marrytube.com';
const fromAddress = `"MarryTube" <${defaultFromEmail}>`;
const allowDevOtpFallback = String(process.env.OTP_DEV_FALLBACK || '').toLowerCase() === 'true';
const getDefaultSmtpHost = (user) => {
  if (!user || !user.includes('@')) return 'smtp.gmail.com';
  const domain = user.split('@')[1];
  if (domain === 'gmail.com') return 'smtp.gmail.com';
  return `smtp.${domain}`;
};
// Many providers use smtp.domain.com, not mail.domain.com — normalize so mail.X → smtp.X
const normalizeSmtpHost = (h) => {
  if (!h || typeof h !== 'string') return h;
  const s = h.trim().toLowerCase();
  if (s.startsWith('mail.')) return 'smtp.' + s.slice(5);
  return s;
};
let emailTransporter = null;
if (emailUser && emailPass) {
  const rawHost = process.env.EMAIL_HOST || getDefaultSmtpHost(emailUser);
  const host = normalizeSmtpHost(rawHost) || rawHost;
  const port = parseInt(process.env.EMAIL_PORT || '587', 10);
  emailTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user: emailUser,
      pass: emailPass,
    },
    tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
  });
  emailTransporter.verify((err) => {
    if (err) console.error('Email SMTP verify failed:', err.message, '| Host:', host);
    else console.log('Email SMTP ready:', host, port);
  });
}

// Generate OTP
const generateOTP = (length = 6) => {
  return crypto.randomInt(100000, 999999).toString();
};

// Send OTP via SMS
const sendSMSOTP = async (mobile, otp) => {
  if (!twilioClient) {
    console.log('Twilio not configured. OTP:', otp);
    return { success: true, message: 'OTP sent (mock mode)' };
  }

  try {
    await twilioClient.messages.create({
      body: `Your MarryTube OTP is: ${otp}. Valid for ${process.env.OTP_EXPIRY_MINUTES || 10} minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: mobile,
    });
    return { success: true, message: 'OTP sent successfully' };
  } catch (error) {
    console.error('SMS sending error:', error);
    return { success: false, message: 'Failed to send SMS' };
  }
};

// Best OTP email template — used at login/send-otp time
const getOTPEmailHtml = (otp, expiryMinutes = 10) => {
  const year = new Date().getFullYear();
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your MarryTube Login Code</title>
</head>
<body style="margin:0; padding:0; background:#f6f7fb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7fb; padding: 36px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background:#ffffff; border:1px solid #e8eaf3; border-radius: 16px; box-shadow: 0 8px 28px rgba(16,24,40,0.08); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 28px 30px; text-align: left;">
              <p style="margin:0; color:#e0e7ff; font-size:12px; letter-spacing:1px; text-transform:uppercase;">MarryTube Security</p>
              <h1 style="margin:6px 0 0; color:#ffffff; font-size:22px; font-weight:700;">Your one-time passcode</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px;">
              <p style="margin:0 0 10px; color:#111827; font-size:15px; line-height:1.6;">
                We received a sign-in request for your MarryTube account.
              </p>
              <p style="margin:0; color:#4b5563; font-size:14px; line-height:1.6;">
                Enter this OTP to continue:
              </p>
              <div style="background:#f5f3ff; border:1px solid #ddd6fe; border-radius:12px; padding:18px; text-align:center; margin:18px 0;">
                <span style="display:inline-block; font-size:34px; font-weight:700; letter-spacing:7px; color:#4f46e5; font-family:'Courier New', monospace;">${otp}</span>
              </div>
              <p style="margin:0; color:#374151; font-size:13px; line-height:1.6;">
                This code expires in <strong>${expiryMinutes} minutes</strong>. Never share it with anyone.
              </p>
              <p style="margin:16px 0 0; color:#6b7280; font-size:12px; line-height:1.6;">
                If you did not request this OTP, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 14px 30px 22px; border-top:1px solid #eef0f6;">
              <p style="margin:0; color:#9ca3af; font-size:11px; line-height:1.6;">
                Sent from <a href="mailto:no-reply@marrytube.com" style="color:#6b7280; text-decoration:none;">no-reply@marrytube.com</a>
              </p>
              <p style="margin:4px 0 0; color:#9ca3af; font-size:11px;">© ${year} MarryTube. All rights reserved.</p>
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

// Send OTP via Email (uses best OTP template at login/send-otp time)
const sendEmailOTP = async (email, otp) => {
  if (!emailTransporter) {
    console.log('Email not configured. OTP:', otp);
    return { success: false, message: 'Email not configured. Set EMAIL_USER and EMAIL_PASS in .env (use Gmail App Password if 2FA is on).' };
  }

  const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10);

  try {
    const info = await emailTransporter.sendMail({
      from: fromAddress,
      replyTo: process.env.EMAIL_REPLY_TO || defaultFromEmail,
      to: email,
      subject: `${otp} is your MarryTube OTP`,
      html: getOTPEmailHtml(otp, expiryMinutes),
      text: `MarryTube OTP: ${otp}\nThis code is valid for ${expiryMinutes} minutes.\nDo not share this code with anyone.\nIf you did not request this OTP, ignore this email.\n\n- MarryTube Team\nno-reply@marrytube.com`,
    });

    const accepted = Array.isArray(info.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info.rejected) ? info.rejected : [];
    console.log('OTP email send result:', {
      to: email,
      messageId: info.messageId,
      accepted,
      rejected,
      response: info.response,
    });

    if (!accepted.length || rejected.length) {
      return {
        success: false,
        message: 'Email was not accepted by SMTP for this recipient. Please verify mailbox/domain settings.',
      };
    }
    return { success: true, message: 'OTP sent successfully' };
  } catch (error) {
    console.error('Email sending error:', error);
    const code = error.code || '';
    const msg = (error.message || '').toLowerCase();
    let userMessage = 'Failed to send email.';
    if (code === 'EAUTH' || msg.includes('invalid login') || msg.includes('authentication')) {
      userMessage = 'Email login failed. For Gmail, use an App Password (Google Account → Security → App passwords).';
    } else if (code === 'ENOTFOUND' || code === 'ETIMEDOUT' || msg.includes('enotfound') || msg.includes('getaddrinfo')) {
      userMessage = 'SMTP server not found. Set correct EMAIL_HOST in .env (get it from your email provider). Or use Gmail: EMAIL_HOST=smtp.gmail.com, EMAIL_USER=your@gmail.com, EMAIL_PASSWORD=App Password.';
    } else if (error.message) {
      userMessage = `Email failed: ${error.message.slice(0, 80)}`;
    }
    return { success: false, message: userMessage };
  }
};

/**
 * Generic HTML email (transactional). Used by studio registration, etc.
 * @param {{ to: string, subject: string, html: string, text?: string, bcc?: string }} opts
 */
const sendHtmlEmail = async ({ to, subject, html, text, bcc }) => {
  if (!emailTransporter) {
    return { success: false, message: 'Email not configured. Set EMAIL_USER and EMAIL_PASS in .env.' };
  }
  try {
    const info = await emailTransporter.sendMail({
      from: fromAddress,
      replyTo: process.env.EMAIL_REPLY_TO || defaultFromEmail,
      to,
      bcc: bcc || undefined,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
    console.log('HTML email send result:', {
      to,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    });
    return { success: true, message: 'Email sent' };
  } catch (error) {
    console.error('sendHtmlEmail error:', error.message);
    return { success: false, message: error.message || 'Failed to send email' };
  }
};

// Create and send OTP
const createAndSendOTP = async (identifier, type) => {
  try {
    // Delete any existing OTPs for this identifier
    await OTP.destroy({ where: { identifier, type } });

    // Generate new OTP
    const otp = generateOTP(parseInt(process.env.OTP_LENGTH || '6'));
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + parseInt(process.env.OTP_EXPIRY_MINUTES || '10'));

    // Save OTP to database
    const otpRecord = await OTP.create({
      identifier,
      type,
      otp,
      expiresAt,
    });

    // Send OTP
    let sendResult;
    if (type === 'mobile') {
      sendResult = await sendSMSOTP(identifier, otp);
    } else {
      sendResult = await sendEmailOTP(identifier, otp);
    }

    // Optional dev fallback: enable only when OTP_DEV_FALLBACK=true.
    if (!sendResult.success && process.env.NODE_ENV !== 'production' && allowDevOtpFallback) {
      return {
        success: true,
        message: 'OTP generated in development mode (delivery failed, using fallback).',
        devOtp: otp,
        deliveryFailed: true,
        deliveryError: sendResult.message,
      };
    }

    return sendResult;
  } catch (error) {
    console.error('OTP creation error:', error);
    return { success: false, message: 'Failed to create OTP' };
  }
};

// Verify OTP
const verifyOTP = async (identifier, otp, type) => {
  try {
    // Static OTP for development/testing
    const STATIC_OTP = '123456';
    // Coerce incoming otp to string to avoid number/string mismatch from JSON parsing
    if (String(otp) === STATIC_OTP) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('✅ Static OTP accepted for development', { identifier, type, otp });
      }
      return { success: true, message: 'OTP verified successfully' };
    }

    const otpRecord = await OTP.findOne({
      where: {
        identifier,
        type,
        otp,
        expiresAt: { [Op.gt]: new Date() },
        verified: false,
      },
    });

    if (!otpRecord) {
      return { success: false, message: 'Invalid or expired OTP' };
    }

    // Mark OTP as verified
    await otpRecord.update({ verified: true });

    return { success: true, message: 'OTP verified successfully' };
  } catch (error) {
    console.error('OTP verification error:', error);
    return { success: false, message: 'Failed to verify OTP' };
  }
};

module.exports = {
  createAndSendOTP,
  verifyOTP,
  generateOTP,
  sendHtmlEmail,
};

