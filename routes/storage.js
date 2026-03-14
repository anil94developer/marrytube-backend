const express = require('express');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { fn, col } = require('sequelize');
const { Storage, StoragePlan, Media, UserStoragePlan, Folder, User } = require('../models');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const BYTES_PER_GB = 1024 * 1024 * 1024;

// Pending Cashfree orders: order_id -> { userId, storage, period, planId, price }
const pendingOrders = new Map();

// Use production API when CASHFREE_ENV=PRODUCTION or when secret key looks like production (cfsk_ma_prod_*)
const getCashfreeBase = () => {
  if (process.env.CASHFREE_ENV === 'PRODUCTION') return 'https://api.cashfree.com/pg';
  const secret = process.env.CASHFREE_SECRET_KEY || '';
  if (secret.includes('_prod_') || secret.startsWith('cfsk_ma_prod_')) return 'https://api.cashfree.com/pg';
  return 'https://sandbox.cashfree.com/pg';
};
const getCashfreeMode = () => (getCashfreeBase().includes('sandbox') ? 'sandbox' : 'production');
const CASHFREE_HEADERS = () => ({
  'Content-Type': 'application/json',
  'x-api-version': '2023-08-01',
  'x-client-id': (process.env.CASHFREE_CLIENT_ID || '').trim(),
  'x-client-secret': (process.env.CASHFREE_SECRET_KEY || '').trim(),
});

// Dashboard stats for logged-in user (storage + media counts)
router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    let storage = await Storage.findOne({ where: { userId } });
    if (!storage) {
      storage = await Storage.create({
        userId,
        totalStorage: 0,
        usedStorage: 0,
        availableStorage: 0,
      });
    }
    const videoCount = await Media.count({ where: { userId, category: 'video' } });
    const imageCount = await Media.count({ where: { userId, category: 'image' } });
    res.json({
      storage: {
        totalStorage: parseFloat(storage.totalStorage) || 0,
        usedStorage: parseFloat(storage.usedStorage) || 0,
        availableStorage: parseFloat(storage.availableStorage) ?? (parseFloat(storage.totalStorage) || 0) - (parseFloat(storage.usedStorage) || 0),
      },
      videoCount,
      imageCount,
    });
  } catch (error) {
    console.error('Get storage dashboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get storage plans
router.get('/plans', async (req, res) => {
  try {
    const plans = await StoragePlan.findAll({
      where: { isActive: true },
      order: [['storage', 'ASC']],
    });
    res.json(plans);
  } catch (error) {
  console.error('Get storage plans error:', error);
  // Return error details for local debugging
  res.status(500).json({ success: false, message: 'Server error', error: error.message, stack: error.stack });
  }
});

// Get user storage (requires auth)
router.get('/user', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    let storage = await Storage.findOne({ where: { userId } });

    if (!storage) {
      // Create default storage (0 GB — no free storage for new users)
      storage = await Storage.create({
        userId,
        totalStorage: 0,
        usedStorage: 0,
        availableStorage: 0,
      });
    }

    res.json(storage);
  } catch (error) {
    console.error('Get user storage error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get my drives (purchased plans for logged-in user) — same shape as studio client plans
router.get('/my-plans', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const userPlans = await UserStoragePlan.findAll({
      where: { userId },
      order: [['expiryDate', 'DESC'], ['id', 'ASC']],
    });
    const planIds = userPlans.map((p) => p.id);
    const usedByPlan = planIds.length
      ? await Media.findAll({
          attributes: ['userPlanId', [fn('SUM', col('size')), 'totalBytes']],
          where: { userId, userPlanId: { [Op.in]: planIds } },
          group: ['userPlanId'],
          raw: true,
        })
      : [];
    const usedMap = {};
    usedByPlan.forEach((row) => {
      usedMap[row.userPlanId] = Number(row.totalBytes) || 0;
    });
    const plansWithUsed = userPlans.map((plan) => {
      const p = plan.get ? plan.get({ plain: true }) : plan;
      p.usedStorage = usedMap[plan.id] != null ? usedMap[plan.id] : Number(p.usedStorage) || 0;
      return p;
    });

    if (plansWithUsed.length > 0) {
      return res.json(plansWithUsed);
    }

    // No UserStoragePlan: return one "default" drive from Storage (0 GB for new users — no free storage)
    // let storage = await Storage.findOne({ where: { userId } });
    // if (!storage) {
    //   storage = await Storage.create({
    //     userId,
    //     totalStorage: 0,
    //     usedStorage: 0,
    //     availableStorage: 0,
    //   });
    // }
    // const totalGB = parseFloat(storage.totalStorage) || 0;
    // const usedGB = parseFloat(storage.usedStorage) || 0;
    // const defaultDrive = {
    //   id: 'default',
    //   userId,
    //   totalStorage: totalGB,
    //   usedStorage: Math.round(usedGB * BYTES_PER_GB),
    //   availableStorage: Math.max(0, totalGB - usedGB),
    //   expiryDate: null,
    //   createdAt: storage.createdAt,
    //   status: 'active',
    //   isDefault: true,
    // };
    // res.json([defaultDrive]);
  } catch (error) {
    console.error('Get my plans error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Purchase storage (user self-purchase). Creates UserStoragePlan when planId provided, same as studio.
function addPeriodToDate(purchaseDate, period) {
  const d = new Date(purchaseDate);
  const day = d.getDate();
  d.setDate(1);
  if (period === 'month') {
    d.setMonth(d.getMonth() + 1);
  } else if (period === 'year') {
    d.setFullYear(d.getFullYear() + 1);
  }
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

// Fulfill storage purchase (shared by /purchase and payment-success)
async function fulfillStoragePurchase(userId, storage, period, planId) {
  const storageNum = parseFloat(storage);
  if (planId != null && planId !== '' && !Number.isNaN(parseInt(planId, 10))) {
    const plan = await StoragePlan.findByPk(parseInt(planId, 10));
    if (plan) {
      let storageToAdd = storageNum;
      if (plan.category === 'fixed') storageToAdd = parseFloat(plan.storage);

      const purchaseDate = new Date();
      const periodType = period === 'year' ? 'year' : 'month';
      let userPlan = await UserStoragePlan.findOne({
        where: { userId, planId: plan.id, status: 'active', expiryDate: { [Op.gt]: purchaseDate } },
      });

      let expiryDate;
      if (userPlan) {
        const baseDate = userPlan.expiryDate > purchaseDate ? new Date(userPlan.expiryDate) : purchaseDate;
        expiryDate = addPeriodToDate(baseDate, periodType);
        userPlan.totalStorage += storageToAdd;
        userPlan.availableStorage += storageToAdd;
        userPlan.expiryDate = expiryDate;
        await userPlan.save();
      } else {
        expiryDate = addPeriodToDate(purchaseDate, periodType);
        await UserStoragePlan.create({
          userId,
          planId: plan.id,
          totalStorage: storageToAdd,
          usedStorage: 0,
          availableStorage: storageToAdd,
          expiryDate,
          status: 'active',
        });
      }
    }
  }

  let userStorage = await Storage.findOne({ where: { userId } });
  if (!userStorage) {
    userStorage = await Storage.create({
      userId,
      totalStorage: 0,
      usedStorage: 0,
      availableStorage: 0,
    });
  }
  const newTotalStorage = parseFloat(userStorage.totalStorage) + storageNum;
  await userStorage.update({
    totalStorage: newTotalStorage,
    availableStorage: newTotalStorage - parseFloat(userStorage.usedStorage),
  });
  return userStorage;
}

// Create Cashfree order and return payment_session_id for checkout
router.post('/create-order', authMiddleware, [
  body('storage').isNumeric().withMessage('Storage amount is required'),
  body('period').isIn(['month', 'year']).withMessage('Period must be month or year'),
  body('price').isNumeric().withMessage('Price is required'),
  body('planId').optional(),
  body('returnUrl').optional().isString().trim().withMessage('returnUrl must be a string'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    if (!process.env.CASHFREE_CLIENT_ID || !process.env.CASHFREE_SECRET_KEY) {
      return res.status(503).json({ success: false, message: 'Payment gateway not configured' });
    }

    const { storage, period, price, planId, returnUrl } = req.body;
    const userId = req.user.id;
    const user = await User.findByPk(userId);
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });

    const orderId = `marry_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const orderAmount = parseFloat(price).toFixed(2);
    const frontendOrigin = process.env.FRONTEND_URL || 'http://localhost:3001';
    let returnUrlFinal = returnUrl || `${frontendOrigin}/storage-plans?order_id=${orderId}&payment=success`;
    // Cashfree requires HTTPS return_url: rewrite http -> https (for localhost use https://localhost)
    if (returnUrlFinal.startsWith('http://')) {
      returnUrlFinal = returnUrlFinal.replace(/^http:\/\//, 'https://');
    }

    const payload = {
      order_id: orderId,
      order_amount: parseFloat(orderAmount),
      order_currency: 'INR',
      customer_details: {
        customer_id: String(userId),
        customer_name: (user.name || 'Customer').slice(0, 100),
        customer_email: user.email || `user${userId}@marrytube.local`,
        customer_phone: (user.mobile || user.alternatePhone || '9999999999').replace(/\D/g, '').slice(-10) || '9999999999',
      },
      order_meta: {
        return_url: returnUrlFinal,
        notify_url: process.env.CASHFREE_WEBHOOK_URL || undefined,
      },
    };

    const cfRes = await fetch(`${getCashfreeBase()}/orders`, {
      method: 'POST',
      headers: CASHFREE_HEADERS(),
      body: JSON.stringify(payload),
    });
    const data = await cfRes.json();
    if (!cfRes.ok || !data.payment_session_id) {
      console.error('Cashfree create order error:', data);
      let msg = data.message || data.error?.message || 'Failed to create payment order';
      if (msg.toLowerCase().includes('auth') || msg.toLowerCase().includes('authentication')) {
        msg = 'Cashfree auth failed. Use production keys with CASHFREE_ENV=PRODUCTION (or sandbox keys with DEVELOPMENT). Check CASHFREE_CLIENT_ID and CASHFREE_SECRET_KEY.';
      }
      return res.status(400).json({ success: false, message: msg });
    }

    pendingOrders.set(orderId, {
      userId,
      storage: parseFloat(storage),
      period: period || 'month',
      planId: planId != null && planId !== '' ? planId : null,
      price: parseFloat(price),
    });

    res.json({
      success: true,
      orderId: data.order_id,
      paymentSessionId: data.payment_session_id,
      returnUrl: returnUrlFinal,
      cashfreeMode: getCashfreeMode(),
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Called after successful Cashfree payment — fulfills storage purchase
router.post('/payment-success', authMiddleware, [
  body('order_id').notEmpty().withMessage('Order ID is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { order_id } = req.body;
    const userId = req.user.id;

    const pending = pendingOrders.get(order_id);
    if (!pending) {
      return res.status(404).json({ success: false, message: 'Order not found or already fulfilled' });
    }
    if (pending.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Order does not belong to you' });
    }

    const userStorage = await fulfillStoragePurchase(
      pending.userId,
      pending.storage,
      pending.period,
      pending.planId
    );
    pendingOrders.delete(order_id);

    res.json({
      success: true,
      message: `${pending.storage} GB storage purchased successfully`,
      storage: userStorage,
    });
  } catch (error) {
    console.error('Payment success fulfill error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

router.post('/purchase', authMiddleware, [
  body('storage').isNumeric().withMessage('Storage amount is required'),
  body('period').isIn(['month', 'year']).withMessage('Period must be month or year'),
  body('price').isNumeric().withMessage('Price is required'),
  body('planId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { storage, period, planId } = req.body;
    const userId = req.user.id;
    const storageNum = parseFloat(storage);
    const userStorage = await fulfillStoragePurchase(userId, storageNum, period || 'month', planId);
    res.json({
      success: true,
      message: `${storageNum} GB storage purchased successfully`,
      storage: userStorage,
    });
  } catch (error) {
    console.error('Purchase storage error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Move media between drives (user's own). Optional toFolderId = folder on destination drive.
router.post('/move-media', authMiddleware, [
  body('fromUserPlanId').notEmpty().withMessage('Source drive is required'),
  body('toUserPlanId').notEmpty().withMessage('Destination drive is required'),
  body('mediaIds').optional().isArray().withMessage('mediaIds must be an array'),
  body('toFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const userId = req.user.id;
    const fromRaw = req.body.fromUserPlanId;
    const toRaw = req.body.toUserPlanId;
    const mediaIds = Array.isArray(req.body.mediaIds) ? req.body.mediaIds.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id)) : null;
    let toFolderId = req.body.toFolderId != null && req.body.toFolderId !== '' ? parseInt(req.body.toFolderId, 10) : null;
    if (toFolderId !== null && Number.isNaN(toFolderId)) toFolderId = null;

    const fromId = fromRaw === 'default' || fromRaw === '' ? 'default' : parseInt(fromRaw, 10);
    const toId = toRaw === 'default' || toRaw === '' ? 'default' : parseInt(toRaw, 10);
    if (fromId === toId) {
      return res.status(400).json({ success: false, message: 'Source and destination must be different' });
    }

    const newPlanId = toId === 'default' ? null : toId;
    if (newPlanId !== null) {
      const toPlan = await UserStoragePlan.findOne({ where: { id: newPlanId, userId } });
      if (!toPlan) return res.status(404).json({ success: false, message: 'Destination drive not found' });
    }
    if (toFolderId != null) {
      const destFolder = await Folder.findOne({ where: { id: toFolderId, userId, userPlanId: newPlanId } });
      if (!destFolder) return res.status(400).json({ success: false, message: 'Destination folder not found on that drive' });
    }

    const where = { userId };
    if (fromId === 'default') {
      where.userPlanId = null;
    } else {
      const fromPlan = await UserStoragePlan.findOne({ where: { id: fromId, userId } });
      if (!fromPlan) return res.status(404).json({ success: false, message: 'Source drive not found' });
      where.userPlanId = fromPlan.id;
    }
    if (mediaIds && mediaIds.length > 0) where.id = { [Op.in]: mediaIds };

    const count = await Media.update({ userPlanId: newPlanId, folderId: toFolderId }, { where });
    const movedCount = count[0] || 0;

    // Recompute used: for each plan that had or now has media for this user
    const planIds = [];
    if (fromId !== 'default') planIds.push(fromId);
    if (toId !== 'default') planIds.push(toId);
    if (planIds.length > 0) {
      for (const pid of planIds) {
        const sum = await Media.findAll({
          attributes: [[fn('SUM', col('size')), 'total']],
          where: { userId, userPlanId: pid },
          raw: true,
        });
        const used = Math.max(0, Number(sum[0]?.total) || 0);
        const plan = await UserStoragePlan.findByPk(pid);
        if (plan) await plan.update({ usedStorage: used });
      }
    }
    if (fromId === 'default' || toId === 'default') {
      const defaultSum = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: null },
        raw: true,
      });
      const usedBytes = Number(defaultSum[0]?.total) || 0;
      const usedGB = usedBytes / BYTES_PER_GB;
      let storage = await Storage.findOne({ where: { userId } });
      if (storage) {
        await storage.update({
          usedStorage: usedGB,
          availableStorage: Math.max(0, parseFloat(storage.totalStorage) - usedGB),
        });
      }
    }

    res.json({ success: true, movedCount, fromPlan: fromId, toPlan: toId });
  } catch (error) {
    console.error('Move media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Copy media to another drive. Optional toFolderId = folder on destination drive.
router.post('/copy-media', authMiddleware, [
  body('fromUserPlanId').notEmpty().withMessage('Source drive is required'),
  body('toUserPlanId').notEmpty().withMessage('Destination drive is required'),
  body('mediaIds').optional().isArray().withMessage('mediaIds must be an array'),
  body('toFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const userId = req.user.id;
    const fromRaw = req.body.fromUserPlanId;
    const toRaw = req.body.toUserPlanId;
    const mediaIds = Array.isArray(req.body.mediaIds) ? req.body.mediaIds.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id)) : null;
    let toFolderId = req.body.toFolderId != null && req.body.toFolderId !== '' ? parseInt(req.body.toFolderId, 10) : null;
    if (toFolderId !== null && Number.isNaN(toFolderId)) toFolderId = null;

    const fromId = fromRaw === 'default' || fromRaw === '' ? 'default' : parseInt(fromRaw, 10);
    const toId = toRaw === 'default' || toRaw === '' ? 'default' : parseInt(toRaw, 10);
    if (fromId === toId) {
      return res.status(400).json({ success: false, message: 'Source and destination must be different' });
    }

    const newPlanId = toId === 'default' ? null : toId;
    if (newPlanId !== null) {
      const toPlan = await UserStoragePlan.findOne({ where: { id: newPlanId, userId } });
      if (!toPlan) return res.status(404).json({ success: false, message: 'Destination drive not found' });
    }
    if (toFolderId != null) {
      const destFolder = await Folder.findOne({ where: { id: toFolderId, userId, userPlanId: newPlanId } });
      if (!destFolder) return res.status(400).json({ success: false, message: 'Destination folder not found on that drive' });
    }

    const where = { userId };
    if (fromId === 'default') {
      where.userPlanId = null;
    } else {
      const fromPlan = await UserStoragePlan.findOne({ where: { id: fromId, userId } });
      if (!fromPlan) return res.status(404).json({ success: false, message: 'Source drive not found' });
      where.userPlanId = fromPlan.id;
    }
    if (mediaIds && mediaIds.length > 0) where.id = { [Op.in]: mediaIds };

    const items = await Media.findAll({ where });
    let copied = 0;
    for (const m of items) {
      await Media.create({
        userId,
        name: m.name,
        url: m.url,
        s3Key: m.s3Key,
        category: m.category,
        size: m.size,
        mimeType: m.mimeType,
        folderId: toFolderId,
        userPlanId: newPlanId,
        uploadedBy: m.uploadedBy,
      });
      copied++;
    }

    if (toId === 'default') {
      const defaultSum = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: null },
        raw: true,
      });
      const usedBytes = Number(defaultSum[0]?.total) || 0;
      const usedGB = usedBytes / BYTES_PER_GB;
      let storage = await Storage.findOne({ where: { userId } });
      if (storage) {
        await storage.update({
          usedStorage: usedGB,
          availableStorage: Math.max(0, parseFloat(storage.totalStorage) - usedGB),
        });
      }
    } else {
      const sum = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: newPlanId },
        raw: true,
      });
      const used = Math.max(0, Number(sum[0]?.total) || 0);
      const plan = await UserStoragePlan.findByPk(newPlanId);
      if (plan) await plan.update({ usedStorage: used });
    }

    res.json({ success: true, copiedCount: copied, toPlan: toId });
  } catch (error) {
    console.error('Copy media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
