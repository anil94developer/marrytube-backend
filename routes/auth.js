const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { User, Storage } = require('../models');
const { createAndSendOTP, verifyOTP } = require('../services/otpService');
const { verifyGoogleCredential, getGoogleAudiences } = require('../services/googleAuthService');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Public: verify MarryBackend/.env loaded GOOGLE_CLIENT_ID (restart API after edits)
router.get('/google-config-status', (_req, res) => {
  const ids = getGoogleAudiences();
  res.json({
    configured: ids.length > 0,
    hint:
      ids.length > 0
        ? undefined
        : 'Add GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com to MarryBackend/.env and restart nodemon.',
  });
});

// Generate JWT token
const generateToken = (userId) => {
  const secret = process.env.JWT_SECRET;
  if (!secret || !String(secret).trim()) {
    const err = new Error('Server misconfiguration: set JWT_SECRET in MarryBackend/.env');
    err.code = 'JWT_SECRET_MISSING';
    throw err;
  }
  return jwt.sign({ userId }, secret, { expiresIn: '30d' });
};

async function ensureCustomerLoginStorage(user) {
  if (!user || user.userType !== 'customer') return;
  const [storage] = await Storage.findOrCreate({
    where: { userId: user.id },
    defaults: { userId: user.id, totalStorage: 0, usedStorage: 0, availableStorage: 0 },
  });
  if (parseFloat(storage.totalStorage) === 0 && parseFloat(storage.usedStorage) === 0) {
    await storage.update({ totalStorage: 0, availableStorage: 0 });
  }
}

// Google Sign-In (JWT credential from GIS). userType: customer | studio
router.post('/google', [
  body('credential').notEmpty().withMessage('Google credential is required'),
  body('userType').optional().isIn(['customer', 'studio']).withMessage('Invalid user type'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userType = req.body.userType || 'customer';

    let profile;
    try {
      profile = await verifyGoogleCredential(req.body.credential);
    } catch (e) {
      const status = e.code === 'GOOGLE_NOT_CONFIGURED' ? 503 : 400;
      return res.status(status).json({
        success: false,
        message: e.message || 'Invalid Google credential',
      });
    }

    let user = await User.findOne({ where: { email: profile.email } });
    let isNewUser = false;

    if (!user && userType === 'customer') {
      user = await User.create({
        email: profile.email,
        name: profile.name || 'User',
        userType: 'customer',
      });
      await Storage.findOrCreate({
        where: { userId: user.id },
        defaults: { userId: user.id, totalStorage: 0, usedStorage: 0, availableStorage: 0 },
      });
      isNewUser = true;
    }

    if (!user && userType === 'studio') {
      return res.status(403).json({
        success: false,
        message:
          'No studio account exists for this Google email. Register your studio first or contact admin.',
        studioNotFound: true,
      });
    }

    if (user.userType !== userType) {
      return res.status(400).json({
        success: false,
        message: `This email is registered as ${user.userType}. Use the ${user.userType} login link instead.`,
      });
    }

    if (
      profile.name &&
      profile.name.trim() &&
      (!user.name || user.name.trim() === '' || user.name === 'User')
    ) {
      await user.update({ name: profile.name });
    }

    if (user.userType === 'studio' && !user.isActive) {
      return res.status(403).json({
        success: false,
        message:
          'Your studio account is pending admin approval. You cannot sign in until it is approved.',
        pendingApproval: true,
      });
    }

    const refreshed = await User.findByPk(user.id);
    await ensureCustomerLoginStorage(refreshed);

    const token = generateToken(refreshed.id);
    const userData = refreshed.toJSON();

    res.json({
      success: true,
      user: userData,
      token,
      isNewUser,
    });
  } catch (error) {
    console.error('Google login error:', error);
    if (error.code === 'JWT_SECRET_MISSING') {
      return res.status(503).json({ success: false, message: error.message });
    }
    const devMsg = error?.message ? String(error.message).slice(0, 220) : '';
    const message =
      process.env.NODE_ENV === 'production' ? 'Server error' : devMsg || 'Server error';
    res.status(500).json({ success: false, message });
  }
});

// Send OTP
router.post('/send-otp', [
  body('identifier').notEmpty().withMessage('Identifier is required'),
  body('type').isIn(['email', 'mobile']).withMessage('Type must be email or mobile'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { identifier, type } = req.body;
    const result = await createAndSendOTP(identifier, type);

    if (result.success) {
      const payload = { success: true, message: result.message || 'OTP sent successfully' };
      if (result.devOtp && process.env.NODE_ENV !== 'production') {
        payload.devOtp = result.devOtp;
        payload.deliveryFailed = !!result.deliveryFailed;
        if (result.deliveryError) payload.deliveryError = result.deliveryError;
      }
      res.json(payload);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Verify OTP and login/register
router.post('/verify-otp', [
  body('identifier').notEmpty().withMessage('Identifier is required'),
  body('otp').notEmpty().withMessage('OTP is required'),
  body('type').isIn(['email', 'mobile']).withMessage('Type must be email or mobile'),
  body('userType').optional().isIn(['customer', 'admin', 'studio']).withMessage('Invalid user type'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { identifier, otp, type, userType = 'customer' } = req.body;

    // Verify OTP
    const otpResult = await verifyOTP(identifier, otp, type);
    if (!otpResult.success) {
      return res.status(400).json(otpResult);
    }

    // Find or create user
    let user;
    let isNewUser = false;
    if (type === 'email') {
      user = await User.findOne({ where: { email: identifier } });
      if (!user) {
        user = await User.create({
          email: identifier,
          userType,
        });
        if (userType === 'customer') {
          await Storage.findOrCreate({
            where: { userId: user.id },
            defaults: { userId: user.id, totalStorage: 0, usedStorage: 0, availableStorage: 0 },
          });
        }
        isNewUser = true;
      }
    } else {
      user = await User.findOne({ where: { mobile: identifier } });
      if (!user) {
        user = await User.create({
          mobile: identifier,
          userType,
        });
        if (userType === 'customer') {
          await Storage.findOrCreate({
            where: { userId: user.id },
            defaults: { userId: user.id, totalStorage: 0, usedStorage: 0, availableStorage: 0 },
          });
        }
        isNewUser = true;
      }
    }

    await ensureCustomerLoginStorage(user);

    // Generate token
    const token = generateToken(user.id);

    // Return user data (password is already excluded by toJSON)
    const userData = user.toJSON();

    res.json({
      success: true,
      user: userData,
      token,
      isNewUser, // Indicates if user was just registered
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Studio login (email/password)
router.post('/studio/login', [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findOne({
      where: { email, userType: 'studio' },
      attributes: { include: ['password'] },
    });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message:
          'Your studio account is pending admin approval. You cannot sign in until it is approved.',
        pendingApproval: true,
      });
    }

    const token = generateToken(user.id);
    const userData = user.toJSON();

    res.json({
      success: true,
      user: userData,
      token,
    });
  } catch (error) {
    console.error('Studio login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin login (email/password)
router.post('/admin/login', [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findOne({
      where: { email, userType: 'admin' },
      attributes: { include: ['password'] },
    });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = generateToken(user.id);
    const userData = user.toJSON();

    res.json({
      success: true,
      user: userData,
      token,
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Change phone number
router.post('/change-phone', authMiddleware, [
  body('newPhone').notEmpty().withMessage('New phone number is required'),
  body('otp').notEmpty().withMessage('OTP is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { newPhone, otp } = req.body;

    // Verify OTP
    const otpResult = await verifyOTP(newPhone, otp, 'mobile');
    if (!otpResult.success) {
      return res.status(400).json(otpResult);
    }

    // Update user phone
    await req.user.update({ mobile: newPhone });

    res.json({ success: true, message: 'Phone number changed successfully' });
  } catch (error) {
    console.error('Change phone error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get current user
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userData = req.user.toJSON();
    res.json({ success: true, user: userData });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
