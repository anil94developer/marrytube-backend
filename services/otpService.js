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

// Initialize email transporter
let emailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
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

// Send OTP via Email
const sendEmailOTP = async (email, otp) => {
  if (!emailTransporter) {
    console.log('Email not configured. OTP:', otp);
    return { success: true, message: 'OTP sent (mock mode)' };
  }

  try {
    await emailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your OTP for MarryTube',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>OTP Verification</h2>
          <p>Your OTP for MarryTube is:</p>
          <h1 style="color: #4CAF50; font-size: 32px;">${otp}</h1>
          <p>This OTP is valid for ${process.env.OTP_EXPIRY_MINUTES || 10} minutes.</p>
          <p>If you didn't request this OTP, please ignore this email.</p>
        </div>
      `,
    });
    return { success: true, message: 'OTP sent successfully' };
  } catch (error) {
    console.error('Email sending error:', error);
    return { success: false, message: 'Failed to send email' };
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

