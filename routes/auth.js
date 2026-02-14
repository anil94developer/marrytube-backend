const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { User } = require('../models');
const { createAndSendOTP, verifyOTP } = require('../services/otpService');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

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
      res.json({ success: true, message: 'OTP sent successfully' });
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
        isNewUser = true;
      }
    } else {
      user = await User.findOne({ where: { mobile: identifier } });
      if (!user) {
        user = await User.create({
          mobile: identifier,
          userType,
        });
        isNewUser = true;
      }
    }

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
