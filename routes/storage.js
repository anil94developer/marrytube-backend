const express = require('express');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { fn, col } = require('sequelize');
const { Storage, StoragePlan, Media, UserStoragePlan, Folder, User, Transaction, StudioClient } = require('../models');
const { authMiddleware, studioMiddleware } = require('../middleware/auth');
const { fulfillPurchasePlanForClient } = require('../services/studioClientPlanPurchase');

const router = express.Router();
const BYTES_PER_GB = 1024 * 1024 * 1024;

// Pending Cashfree orders: kind 'storage' (self) | 'studio_client' (studio pays for client plan)
const pendingOrders = new Map();

// Use production API when CASHFREE_ENV=PRODUCTION or when secret key looks like production (cfsk_ma_prod_*)
const getCashfreeBase = () => {
  if (process.env.CASHFREE_BASE_URL) return process.env.CASHFREE_BASE_URL.replace(/\/$/, '');
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

// Get current user's transactions (purchase history)
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { rows, count } = await Transaction.findAndCountAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });
    const planIds = [...new Set(rows.map((t) => t.planId).filter(Boolean))];
    const plans = planIds.length ? await StoragePlan.findAll({ where: { id: planIds }, raw: true }) : [];
    const planMap = Object.fromEntries(plans.map((p) => [p.id, p]));
    res.json({
      transactions: rows.map((t) => {
        const plan = t.planId ? planMap[t.planId] : null;
        return {
          id: t.id,
          orderId: t.orderId,
          amount: parseFloat(t.amount),
          currency: t.currency,
          storage: parseFloat(t.storage),
          period: t.period,
          planId: t.planId,
          plan: plan ? { id: plan.id, storage: parseFloat(plan.storage), period: plan.period, price: parseFloat(plan.price), category: plan.category } : null,
          status: t.status,
          paymentGateway: t.paymentGateway,
          description: t.description,
          createdAt: t.createdAt,
        };
      }),
      total: count,
    });
  } catch (error) {
    console.error('Get transactions error:', error);
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
      // Create default storage (1 GB free for new users)
      storage = await Storage.create({
        userId,
        totalStorage: 1,
        usedStorage: 0,
        availableStorage: 1,
      });
    } else if (parseFloat(storage.totalStorage) === 0 && parseFloat(storage.usedStorage) === 0) {
      await storage.update({ totalStorage: 1, availableStorage: 1 });
      storage.totalStorage = 1;
      storage.availableStorage = 1;
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
    const includeDefault = ['1', 'true', 'yes'].includes(String(req.query.includeDefault || '').toLowerCase());
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
      // Explicit catalog FK so clients never confuse with user_storage_plans.id
      const mapped = plansWithUsed.map((row) => {
        const o = row && typeof row === 'object' ? { ...row } : row;
        if (o && typeof o === 'object') {
          o.catalogPlanId = o.planId != null ? o.planId : null;
        }
        return o;
      });
      return res.json(mapped);
    }

    if (!includeDefault) {
      // Purchased plans only mode: hide default free drive from this endpoint.
      return res.json([]);
    }

    // No UserStoragePlan: return one "default" drive with 1 GB free so upload works without purchase
    let storage = await Storage.findOne({ where: { userId } });
    if (!storage) {
      storage = await Storage.create({
        userId,
        totalStorage: 1,
        usedStorage: 0,
        availableStorage: 1,
      });
    } else if (parseFloat(storage.totalStorage) === 0 && parseFloat(storage.usedStorage) === 0) {
      await storage.update({ totalStorage: 1, availableStorage: 1 });
      storage.totalStorage = 1;
      storage.availableStorage = 1;
    }
    const totalGB = parseFloat(storage.totalStorage) || 0;
    const usedGB = parseFloat(storage.usedStorage) || 0;
    const defaultDrive = {
      id: 'default',
      userId,
      totalStorage: totalGB,
      usedStorage: usedGB * BYTES_PER_GB,
      availableStorage: Math.max(0, totalGB - usedGB),
      expiryDate: null,
      createdAt: storage.createdAt,
      status: 'active',
      isDefault: true,
    };
    return res.json([defaultDrive]);
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

/** Coerce renew flag from JSON (clients sometimes send string "true"). */
function toBoolRenew(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

// Fulfill storage purchase (shared by /purchase and payment-success)
async function fulfillStoragePurchase(userId, storage, period, planId, isRenew = false) {
  const renew = toBoolRenew(isRenew);
  const storageNum = parseFloat(storage);
  let storageDelta = storageNum;
  if (planId != null && planId !== '' && !Number.isNaN(parseInt(planId, 10))) {
    const plan = await StoragePlan.findByPk(parseInt(planId, 10));
    if (plan) {
      let storageToAdd = storageNum;
      if (plan.category === 'fixed') storageToAdd = parseFloat(plan.storage);
      storageDelta = storageToAdd;

      const purchaseDate = new Date();
      const periodType = period === 'year' ? 'year' : 'month';
      let userPlan = null;
      if (renew) {
        // Latest row for this catalog plan (any status) — avoids "renew" creating a 2nd row + double GB.
        userPlan = await UserStoragePlan.findOne({
          where: { userId, planId: plan.id },
          order: [['expiryDate', 'DESC'], ['id', 'DESC']],
        });
      }

      let expiryDate;
      if (userPlan) {
        // Renew (same plan row): ONLY extend expiry — never increase plan GB or aggregate storage.
        // New GB only when a new UserStoragePlan row is created below (new purchase / add-on).
        const baseDate = userPlan.expiryDate > purchaseDate ? new Date(userPlan.expiryDate) : purchaseDate;
        expiryDate = addPeriodToDate(baseDate, periodType);
        userPlan.expiryDate = expiryDate;
        if (userPlan.status !== 'active') userPlan.status = 'active';
        await userPlan.save();
        storageDelta = 0;
      } else if (!renew) {
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
        // storageDelta stays storageToAdd → aggregate storage increases once
      } else {
        // renew=true but no row found — do not create duplicate or add GB (prevents 1GB → 2GB bug)
        console.warn('Renew requested but no UserStoragePlan row for user/plan', { userId, planId: plan.id });
        storageDelta = 0;
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
  const newTotalStorage = parseFloat(userStorage.totalStorage) + storageDelta;
  await userStorage.update({
    totalStorage: Math.max(0, newTotalStorage),
    availableStorage: Math.max(0, newTotalStorage - parseFloat(userStorage.usedStorage)),
  });
  return userStorage;
}

// Create Cashfree order and return payment_session_id for checkout
router.post('/create-order', authMiddleware, [
  body('storage').isNumeric().withMessage('Storage amount is required'),
  body('period').isIn(['month', 'year']).withMessage('Period must be month or year'),
  body('price').isNumeric().withMessage('Price is required'),
  body('planId').optional(),
  body('isRenew').optional({ nullable: true }).custom((v) => {
    if (v === undefined || v === null || v === '') return true;
    return [true, false, 'true', 'false', 1, 0, '1', '0'].includes(v);
  }).withMessage('isRenew must be boolean'),
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

    const { storage, period, price, planId, isRenew = false, returnUrl } = req.body;
    const userId = req.user.id;
    const user = await User.findByPk(userId);
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });

    const orderId = `marry_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const orderAmount = parseFloat(price).toFixed(2);
    const frontendOrigin = process.env.FRONTEND_URL || 'http://localhost:3001';
    let returnUrlFinal = returnUrl || `${frontendOrigin}/storage-plans?order_id=${orderId}&payment=success`;
    // Cashfree production requires HTTPS. For localhost keep http so redirect works (no SSL on dev).
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(returnUrlFinal) || returnUrlFinal.includes('localhost') || returnUrlFinal.includes('127.0.0.1');
    if (!isLocalhost && returnUrlFinal.startsWith('http://')) {
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

    let cfRes;
    try {
      cfRes = await fetch(`${getCashfreeBase()}/orders`, {
        method: 'POST',
        headers: CASHFREE_HEADERS(),
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      const cause = fetchErr.cause || fetchErr;
      const isNetwork = cause.code === 'ENOTFOUND' || cause.code === 'ECONNREFUSED' || cause.message?.includes('fetch failed');
      console.error('Cashfree create order error:', fetchErr);
      if (isNetwork) {
        return res.status(503).json({
          success: false,
          message: 'Cannot reach Cashfree (network or DNS). Check internet, firewall, or use CASHFREE_BASE_URL in .env. For production use CASHFREE_ENV=PRODUCTION.',
        });
      }
      throw fetchErr;
    }
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
      kind: 'storage',
      userId,
      storage: parseFloat(storage),
      period: period || 'month',
      planId: planId != null && planId !== '' ? planId : null,
      isRenew: toBoolRenew(isRenew),
      price: parseFloat(price),
    });

    try {
      await Transaction.create({
        userId,
        orderId: data.order_id || orderId,
        amount: parseFloat(orderAmount),
        currency: 'INR',
        storage: parseFloat(storage),
        period: period || 'month',
        planId: planId != null && planId !== '' ? parseInt(planId, 10) : null,
        status: 'pending',
        paymentGateway: 'cashfree',
        description: `Storage ${storage} GB (${period || 'month'})`,
      });
    } catch (txErr) {
      console.error('Transaction create (pending) error:', txErr.message);
    }

    res.json({
      success: true,
      orderId: data.order_id || orderId,
      paymentSessionId: data.payment_session_id,
      returnUrl: returnUrlFinal,
      cashfreeMode: getCashfreeMode(),
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Studio pays cashfree for a client's storage plan (same fulfillment as /studio/clients/:id/purchase-plan)
router.post('/create-studio-client-order', authMiddleware, studioMiddleware, [
  body('clientId').isInt().withMessage('clientId is required'),
  body('planId').notEmpty().withMessage('Plan ID is required'),
  body('storage').optional().isNumeric().withMessage('Storage must be numeric for per_gb plans'),
  body('period').optional().isIn(['month', 'year']).withMessage('Period must be month or year'),
  body('isRenew').optional({ nullable: true }).custom((v) => {
    if (v === undefined || v === null || v === '') return true;
    return [true, false, 'true', 'false', 1, 0, '1', '0'].includes(v);
  }).withMessage('isRenew must be boolean'),
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

    const studioId = req.user.id;
    const { clientId, planId, storage: requestedStorage, period: periodFromBody, isRenew = false, returnUrl } = req.body;

    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId, 10), studioId },
    });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const plan = await StoragePlan.findByPk(parseInt(planId, 10));
    if (!plan || !plan.isActive) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (periodFromBody && periodFromBody !== plan.period) {
      return res.status(400).json({ success: false, message: 'Period does not match selected plan' });
    }

    let orderAmount;
    let requestedStorageForFulfill = null;
    if (plan.category === 'fixed') {
      orderAmount = parseFloat(plan.price);
    } else if (plan.category === 'per_gb') {
      if (requestedStorage == null || Number.isNaN(parseFloat(requestedStorage))) {
        return res.status(400).json({ success: false, message: 'Storage amount required for per_gb plans' });
      }
      const gb = parseFloat(requestedStorage);
      if (gb < 1) {
        return res.status(400).json({ success: false, message: 'Select at least 1 GB' });
      }
      requestedStorageForFulfill = gb;
      orderAmount = gb * parseFloat(plan.price);
    } else {
      return res.status(400).json({ success: false, message: 'Unsupported plan category' });
    }

    const periodType = plan.period === 'year' ? 'year' : 'month';
    const user = await User.findByPk(studioId);
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });

    const orderId = `marry_sc_${studioId}_${clientId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const orderAmountStr = parseFloat(orderAmount).toFixed(2);
    const frontendOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
    let returnUrlFinal = returnUrl || `${frontendOrigin}/studio/clients/${clientId}?order_id=${orderId}&payment=success`;
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(returnUrlFinal) || returnUrlFinal.includes('localhost') || returnUrlFinal.includes('127.0.0.1');
    if (!isLocalhost && returnUrlFinal.startsWith('http://')) {
      returnUrlFinal = returnUrlFinal.replace(/^http:\/\//, 'https://');
    }

    const payload = {
      order_id: orderId,
      order_amount: parseFloat(orderAmountStr),
      order_currency: 'INR',
      customer_details: {
        customer_id: `studio_${studioId}`,
        customer_name: (user.name || 'Studio').slice(0, 100),
        customer_email: user.email || `studio${studioId}@marrytube.local`,
        customer_phone: (user.mobile || user.alternatePhone || '9999999999').replace(/\D/g, '').slice(-10) || '9999999999',
      },
      order_meta: {
        return_url: returnUrlFinal,
        notify_url: process.env.CASHFREE_WEBHOOK_URL || undefined,
      },
    };

    let cfRes;
    try {
      cfRes = await fetch(`${getCashfreeBase()}/orders`, {
        method: 'POST',
        headers: CASHFREE_HEADERS(),
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      console.error('Cashfree create studio-client order error:', fetchErr);
      return res.status(503).json({
        success: false,
        message: 'Cannot reach payment gateway. Check network or Cashfree configuration.',
      });
    }
    const data = await cfRes.json();
    if (!cfRes.ok || !data.payment_session_id) {
      console.error('Cashfree create studio-client order error:', data);
      let msg = data.message || data.error?.message || 'Failed to create payment order';
      return res.status(400).json({ success: false, message: msg });
    }

    const storageGbForTx = plan.category === 'fixed' ? parseFloat(plan.storage) : (requestedStorageForFulfill || 0);

    pendingOrders.set(orderId, {
      kind: 'studio_client',
      studioUserId: studioId,
      clientId: client.id,
      clientUserId: client.userId,
      planId: plan.id,
      requestedStorage: requestedStorageForFulfill,
      period: periodType,
      isRenew: toBoolRenew(isRenew),
      price: parseFloat(orderAmountStr),
    });

    try {
      await Transaction.create({
        userId: studioId,
        orderId: data.order_id || orderId,
        amount: parseFloat(orderAmountStr),
        currency: 'INR',
        storage: storageGbForTx,
        period: periodType,
        planId: plan.id,
        status: 'pending',
        paymentGateway: 'cashfree',
        description: `Client plan (client #${clientId})`,
      });
    } catch (txErr) {
      console.error('Transaction create (studio client pending) error:', txErr.message);
    }

    res.json({
      success: true,
      orderId: data.order_id || orderId,
      paymentSessionId: data.payment_session_id,
      returnUrl: returnUrlFinal,
      cashfreeMode: getCashfreeMode(),
    });
  } catch (error) {
    console.error('Create studio-client order error:', error);
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

    const kind = pending.kind || 'storage';

    if (kind === 'studio_client') {
      if (pending.studioUserId !== userId) {
        return res.status(403).json({ success: false, message: 'Order does not belong to you' });
      }
      try {
        await fulfillPurchasePlanForClient({
          clientUserId: pending.clientUserId,
          planId: pending.planId,
          requestedStorage: pending.requestedStorage,
          period: pending.period,
          isRenew: toBoolRenew(pending.isRenew),
          studioId: pending.studioUserId,
        });
      } catch (fulfillErr) {
        console.error('Studio client plan fulfill error:', fulfillErr);
        return res.status(500).json({ success: false, message: fulfillErr.message || 'Fulfillment failed' });
      }
      pendingOrders.delete(order_id);

      try {
        const tx = await Transaction.findOne({ where: { orderId: order_id, userId } });
        if (tx) await tx.update({ status: 'success' });
      } catch (txErr) {
        console.error('Transaction update (success) error:', txErr.message);
      }

      return res.json({
        success: true,
        message: 'Plan activated for your client',
        kind: 'studio_client',
        clientId: pending.clientId,
      });
    }

    if (pending.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Order does not belong to you' });
    }

    const userStorage = await fulfillStoragePurchase(
      pending.userId,
      pending.storage,
      pending.period,
      pending.planId,
      pending.isRenew
    );
    pendingOrders.delete(order_id);

    try {
      const tx = await Transaction.findOne({ where: { orderId: order_id, userId } });
      if (tx) {
        await tx.update({ status: 'success' });
      }
    } catch (txErr) {
      console.error('Transaction update (success) error:', txErr.message);
    }

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
  body('isRenew').optional({ nullable: true }).custom((v) => {
    if (v === undefined || v === null || v === '') return true;
    return [true, false, 'true', 'false', 1, 0, '1', '0'].includes(v);
  }).withMessage('isRenew must be boolean'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { storage, period, planId, isRenew = false } = req.body;
    const userId = req.user.id;
    const storageNum = parseFloat(storage);
    const userStorage = await fulfillStoragePurchase(userId, storageNum, period || 'month', planId, isRenew);
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
