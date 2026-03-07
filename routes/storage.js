const express = require('express');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { fn, col } = require('sequelize');
const { Storage, StoragePlan, Media, UserStoragePlan, Folder } = require('../models');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const BYTES_PER_GB = 1024 * 1024 * 1024;

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

    const { storage, period, price, planId } = req.body;
    const userId = req.user.id;
    const storageNum = parseFloat(storage);

    if (planId != null && planId !== '' && !Number.isNaN(parseInt(planId, 10))) {
      const plan = await StoragePlan.findByPk(parseInt(planId, 10));
      if (plan) {
        let storageToAdd = storageNum;
        if (plan.category === 'fixed') {
          storageToAdd = parseFloat(plan.storage);
        }

        const purchaseDate = new Date();
        const periodType = (period === 'year' ? 'year' : 'month');
        let userPlan = await UserStoragePlan.findOne({
          where: {
            userId,
            planId: plan.id,
            status: 'active',
            expiryDate: { [Op.gt]: purchaseDate },
          },
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
          userPlan = await UserStoragePlan.create({
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
