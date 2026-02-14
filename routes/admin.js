const express = require('express');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { User, Media, Storage, StoragePlan, UserStoragePlan, StudioClient, FundRequest } = require('../models');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { getCommissionPerGB, setCommissionPerGB } = require('../services/commissionService');

const router = express.Router();

// All routes require admin authentication
router.use(authMiddleware);
router.use(adminMiddleware);

// Stats for dashboard (counts only, no heavy lists)
router.get('/stats', async (req, res) => {
  try {
    const [totalUsers, totalStudios, totalMedia, totalVideos, totalImages] = await Promise.all([
      User.count({ where: { userType: 'customer' } }),
      User.count({ where: { userType: 'studio' } }),
      Media.count(),
      Media.count({ where: { category: 'video' } }),
      Media.count({ where: { category: 'image' } }),
    ]);
    res.json({ totalUsers, totalStudios, totalMedia, totalVideos, totalImages });
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all users (customers) – paginated, 50 per page
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    const where = { userType: 'customer' };
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { mobile: { [Op.like]: `%${search}%` } },
      ];
    }

    const { count, rows } = await User.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      attributes: { exclude: ['password'] },
      limit,
      offset,
    });

    const total = count;
    const totalPages = Math.ceil(total / limit) || 1;
    res.json({ data: rows, total, page, limit, totalPages });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get single customer details (storage, media count, etc.)
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findOne({
      where: { id: parseInt(req.params.id), userType: 'customer' },
      attributes: { exclude: ['password'] },
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const storage = await Storage.findOne({ where: { userId: user.id } });
    const mediaCount = await Media.count({ where: { userId: user.id } });
    const videoCount = await Media.count({ where: { userId: user.id, category: 'video' } });
    const imageCount = await Media.count({ where: { userId: user.id, category: 'image' } });
    res.json({
      ...user.toJSON(),
      storage: storage || { totalStorage: 0, usedStorage: 0, availableStorage: 0 },
      mediaCount,
      videoCount,
      imageCount,
    });
  } catch (error) {
    console.error('Get user detail error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all studios – paginated, 50 per page
router.get('/allStudios', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    const where = { userType: 'studio' };
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { mobile: { [Op.like]: `%${search}%` } },
      ];
    }

    const { count, rows } = await User.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      attributes: { exclude: ['password'] },
      limit,
      offset,
    });

    const total = count;
    const totalPages = Math.ceil(total / limit) || 1;
    res.json({ data: rows, total, page, limit, totalPages });
  } catch (error) {
    console.error('Get all studios error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Approve or reject a studio (set isActive)
router.patch('/studios/:studioId/approve', [
  body('isActive').isBoolean().withMessage('isActive boolean required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { studioId } = req.params;
    const { isActive } = req.body;

    const studio = await User.findOne({ where: { id: parseInt(studioId), userType: 'studio' } });
    if (!studio) return res.status(404).json({ success: false, message: 'Studio not found' });

    await studio.update({ isActive });
    res.json({ success: true, studio });
  } catch (error) {
    console.error('Approve studio error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create a new studio user (admin)
router.post('/studios', [
  body('email').isEmail().withMessage('Valid email required'),
  body('name').notEmpty().withMessage('Name is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 chars'),
  body('city').optional().isString(),
  body('address').optional().isString(),
  body('pincode').optional().isString(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, name, password, mobile, city, address, pincode } = req.body;

    // Check duplicate
    const existing = await User.findOne({ where: { [Op.or]: [{ email }, { mobile }] } });
    if (existing) return res.status(400).json({ success: false, message: 'Email or mobile already used' });

  const studio = await User.create({ email, name, mobile, password, userType: 'studio', isActive: false, city, address, pincode });
    res.json({ success: true, studio });
  } catch (error) {
    console.error('Create studio error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get studio count (efficient) - must be before /studios/:studioId
router.get('/studios/count', async (req, res) => {
  try {
    const count = await User.count({ where: { userType: 'studio' } });
    res.json({ count });
  } catch (error) {
    console.error('Get studio count error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get studio's clients (for admin studio detail page) – include walletBalance, earnings
router.get('/studios/:studioId/clients', async (req, res) => {
  try {
    const { studioId } = req.params;
    const studio = await User.findOne({ where: { id: parseInt(studioId), userType: 'studio' }, attributes: ['id', 'name', 'email', 'mobile', 'isActive', 'city', 'address', 'pincode', 'walletBalance', 'earnings', 'createdAt'] });
    if (!studio) return res.status(404).json({ success: false, message: 'Studio not found' });
    const clients = await StudioClient.findAll({
      where: { studioId: parseInt(studioId) },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'mobile', 'createdAt'] }],
      order: [['createdAt', 'DESC']],
    });
    res.json({ studio, clients });
  } catch (error) {
    console.error('Get studio clients error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all media – paginated, 50 per page
router.get('/media', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const { category, userId, search } = req.query;

    let where = {};
    if (category && category !== 'all') where.category = category;
    if (userId) where.userId = parseInt(userId);
    if ((search || '').trim()) where.name = { [Op.like]: `%${(search || '').trim()}%` };

    const { count, rows } = await Media.findAndCountAll({
      where,
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email', 'mobile'],
        required: false,
      }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    const total = count;
    const totalPages = Math.ceil(total / limit) || 1;
    res.json({ data: rows, total, page, limit, totalPages });
  } catch (error) {
    console.error('Get all media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete media (admin)
router.delete('/media/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    
    const media = await Media.findByPk(parseInt(mediaId));
    if (!media) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }

    // Delete from S3 (if needed)
    // await deleteFile(media.s3Key);

    // Update user storage (Storage model)
    const sizeInGB = media.size / (1024 * 1024 * 1024);
    const storage = await Storage.findOne({ where: { userId: media.userId } });
    if (storage) {
      const newUsedStorage = Math.max(0, parseFloat(storage.usedStorage) - sizeInGB);
      await storage.update({
        usedStorage: newUsedStorage,
        availableStorage: parseFloat(storage.totalStorage) - newUsedStorage,
      });
    }

    // If media belonged to a plan, subtract from UserStoragePlan.usedStorage (bytes)
    if (media.userPlanId) {
      const plan = await UserStoragePlan.findByPk(media.userPlanId);
      if (plan) {
        plan.usedStorage = Math.max(0, (Number(plan.usedStorage) || 0) - media.size);
        await plan.save();
      }
    }

    await media.destroy();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Block/unblock media
router.patch('/media/:mediaId/block', [
  body('blocked').isBoolean().withMessage('Blocked status is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { mediaId } = req.params;
    const { blocked } = req.body;

    const media = await Media.findByPk(parseInt(mediaId));
    if (!media) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }

    await media.update({ blocked });

    res.json({ success: true, media });
  } catch (error) {
    console.error('Block media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all storage usage
router.get('/storage', async (req, res) => {
  try {
    const storage = await Storage.findAll({
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email', 'mobile'],
        required: false,
      }],
      order: [['userId', 'ASC']],
    });
    res.json(storage);
  } catch (error) {
    console.error('Get all storage error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get storage plans
router.get('/plans', async (req, res) => {
  try {
    const plans = await StoragePlan.findAll({
      order: [['storage', 'ASC']],
    });
    res.json(plans);
  } catch (error) {
    console.error('Get storage plans error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create/Update storage plan
router.post('/plans', [
  body('storage').isNumeric().withMessage('Storage is required'),
  body('price').isNumeric().withMessage('Price is required'),
  body('period').isIn(['month', 'year']).withMessage('Period must be month or year'),
  body('category').optional().isIn(['per_gb', 'fixed']).withMessage('Invalid category'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id, storage, price, period, periodLabel, isActive } = req.body;
  const category = req.body.category || 'fixed';

    if (id) {
      // Update existing plan
      const plan = await StoragePlan.findByPk(parseInt(id));
      if (!plan) {
        return res.status(404).json({ success: false, message: 'Plan not found' });
      }
      await plan.update({ storage, price, period, periodLabel, isActive, category });
      res.json({ success: true, plan });
    } else {
      // Create new plan
      const plan = await StoragePlan.create({
        storage,
        price,
        period,
        periodLabel: periodLabel || `per ${period}`,
        category,
        isActive: isActive !== undefined ? isActive : true,
      });
      res.json({ success: true, plan });
    }
  } catch (error) {
    console.error('Create/Update storage plan error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete storage plan
router.delete('/plans/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    const plan = await StoragePlan.findByPk(parseInt(planId));
    if (plan) {
      await plan.destroy();
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete storage plan error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all withdraw (fund) requests – for admin list
router.get('/fund-requests', async (req, res) => {
  try {
    const requests = await FundRequest.findAll({
      order: [['createdAt', 'DESC']],
      include: [{ model: User, as: 'studio', attributes: ['id', 'name', 'email', 'mobile'], required: true }],
    });
    res.json(requests);
  } catch (error) {
    console.error('Get fund requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Approve withdraw request (amount already deducted from wallet at request time)
router.patch('/fund-requests/:id/approve', [
  body('remarks').optional().trim(),
], async (req, res) => {
  try {
    const { id } = req.params;
    const request = await FundRequest.findByPk(parseInt(id));
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request already processed' });
    }
    request.status = 'approved';
    request.remarks = req.body.remarks || request.remarks || '';
    request.processedAt = new Date();
    await request.save();
    res.json({ success: true, request });
  } catch (error) {
    console.error('Approve fund request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Reject withdraw request – refund amount to studio wallet
router.patch('/fund-requests/:id/reject', [
  body('remarks').optional().trim(),
], async (req, res) => {
  try {
    const { id } = req.params;
    const request = await FundRequest.findByPk(parseInt(id));
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request already processed' });
    }
    const studio = await User.findByPk(request.studioId);
    if (studio) {
      const current = parseFloat(studio.walletBalance) || 0;
      const amount = parseFloat(request.amount) || 0;
      studio.walletBalance = current + amount;
      await studio.save();
    }
    request.status = 'rejected';
    request.remarks = req.body.remarks || request.remarks || '';
    request.processedAt = new Date();
    await request.save();
    res.json({ success: true, request });
  } catch (error) {
    console.error('Reject fund request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add fund to studio wallet (admin)
router.post('/studios/:studioId/add-fund', [
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { studioId } = req.params;
    const amount = parseFloat(req.body.amount);
    const studio = await User.findOne({ where: { id: parseInt(studioId), userType: 'studio' } });
    if (!studio) return res.status(404).json({ success: false, message: 'Studio not found' });
    const current = parseFloat(studio.walletBalance) || 0;
    studio.walletBalance = current + amount;
    await studio.save();
    res.json({ success: true, walletBalance: parseFloat(studio.walletBalance) });
  } catch (error) {
    console.error('Add fund to studio error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get commission per 1 GB (studio payout) – from DB
router.get('/commission', async (req, res) => {
  try {
    const commissionPerGB = await getCommissionPerGB();
    res.json({ commissionPerGB });
  } catch (error) {
    console.error('Get commission error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Set commission per 1 GB – saved in DB
router.put('/commission', [
  body('commissionPerGB').isFloat({ min: 0 }).withMessage('Commission must be a non-negative number'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const commissionPerGB = await setCommissionPerGB(req.body.commissionPerGB);
    res.json({ success: true, commissionPerGB });
  } catch (error) {
    console.error('Set commission error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
