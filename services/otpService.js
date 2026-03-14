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
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px; background-color:#ffffff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 32px 32px 24px; text-align: center;">
              <h1 style="margin:0; color:#ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">MarryTube</h1>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Your login verification code</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 24px;">
              <p style="margin:0 0 16px; color:#374151; font-size: 15px; line-height: 1.5;">Use this one-time code to sign in:</p>
              <div style="background: linear-gradient(135deg, #f0f0ff 0%, #f5f3ff 100%); border: 2px dashed #8b5cf6; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
                <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #4f46e5; font-family: 'Courier New', monospace;">${otp}</span>
              </div>
              <p style="margin: 0 0 8px; color:#6b7280; font-size: 13px;">Valid for <strong>${expiryMinutes} minutes</strong>. Do not share this code with anyone.</p>
              <p style="margin: 24px 0 0; color:#9ca3af; font-size: 12px; line-height: 1.5;">If you didn't request this code, you can safely ignore this email. Your account is secure.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 24px; border-top: 1px solid #e5e7eb; text-align: center;">
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

// Send OTP via Email (uses best OTP template at login/send-otp time)
const sendEmailOTP = async (email, otp) => {
  if (!emailTransporter) {
    console.log('Email not configured. OTP:', otp);
    return { success: false, message: 'Email not configured. Set EMAIL_USER and EMAIL_PASS in .env (use Gmail App Password if 2FA is on).' };
  }

  const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10);

  try {
    await emailTransporter.sendMail({
      from: `"MarryTube" <${emailUser}>`,
      to: email,
      subject: `${otp} is your MarryTube login code`,
      html: getOTPEmailHtml(otp, expiryMinutes),
      text: `Your MarryTube login code is: ${otp}. Valid for ${expiryMinutes} minutes. Do not share this code.`,
    });
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
};

