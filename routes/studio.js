

const express = require('express');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { fn, col } = require('sequelize');
const { StudioClient, Media, Storage, FundRequest, User, StoragePlan, UserStoragePlan } = require('../models');
const { authMiddleware, studioMiddleware } = require('../middleware/auth');
const { generateUploadURL, deleteFile } = require('../services/s3Service');
const { getCommissionPerGB } = require('../services/commissionService');
const { getBankDetails, setBankDetails } = require('../services/studioBankService');
const router = express.Router();

/** Expiry = purchase date + period. Handles month-end (e.g. Jan 31 + 1 month = Feb 28). */
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

// Dependencies for file upload
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Multer storage config for dynamic folder path
const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    try {
      const { clientId } = req.params;
      const { userPlanId, folderId } = req.body;
      const client = await require('../models').StudioClient.findByPk(clientId);
      if (!client) return cb(new Error('Client not found'));
      let folderName = 'root';
      if (folderId) {
        const folder = await require('../models').Folder.findByPk(folderId);
        if (folder) folderName = folder.name;
      }
      const uploadPath = path.join(__dirname, '..', 'upload', String(client.userId), String(userPlanId || 'no-plan'), folderName);
      require('fs').mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    } catch (err) {
      cb(err);
    }
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });

// Upload media file for a client, userPlanId, and folderId
router.post('/clients/:clientId/uploadMedia', upload.single('media'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { userPlanId, folderId } = req.body;
    const client = await require('../models').StudioClient.findByPk(clientId);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    let folderName = 'root';
    let folderIdValue = null;
    if (folderId) {
      const folder = await require('../models').Folder.findByPk(folderId);
      if (folder) {
        folderName = folder.name;
        folderIdValue = folder.id;
      }
    }
    // Save metadata in Media table
    const media = await require('../models').Media.create({
      userId: client.userId,
      userPlanId: userPlanId || null,
      folderId: folderIdValue,
      name: req.file.originalname,
      url: `/upload/${client.userId}/${userPlanId || 'no-plan'}/${folderName}/${req.file.filename}`,
      s3Key: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
      category: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
    });

    // Update usedStorage in UserStoragePlan and return updated plan storage for frontend
    let planStorage = null;
    if (userPlanId) {
      const plan = await require('../models').UserStoragePlan.findByPk(userPlanId);
      if (plan) {
        plan.usedStorage = (plan.usedStorage || 0) + req.file.size;
        await plan.save();
        // Recompute from Media so DB and response are in sync with actual files
        const sumRows = await Media.findAll({
          attributes: [[fn('SUM', col('size')), 'totalBytes']],
          where: { userId: client.userId, userPlanId: plan.id },
          raw: true,
        });
        const usedBytes = Math.max(0, Number(sumRows[0]?.totalBytes) || plan.usedStorage);
        plan.usedStorage = usedBytes;
        await plan.save();
        const totalGB = Number(plan.totalStorage) || 0;
        const usedGB = usedBytes / (1024 * 1024 * 1024);
        planStorage = {
          planId: plan.id,
          usedStorage: usedBytes,
          totalStorage: totalGB,
          usedStorageGB: usedGB,
          availableStorageGB: Math.max(0, totalGB - usedGB),
        };
      }
    }

    // Studio earnings: add (upload size in GB × admin commission per GB from DB)
    const commissionPerGB = await getCommissionPerGB();
    if (commissionPerGB > 0 && req.user && req.user.id) {
      const sizeInGB = req.file.size / (1024 * 1024 * 1024);
      const earningsToAdd = sizeInGB * commissionPerGB;
      const studio = await User.findByPk(req.user.id);
      if (studio) {
        const current = parseFloat(studio.earnings) || 0;
        studio.earnings = current + earningsToAdd;
        await studio.save();
      }
    }

    res.json({ success: true, media, planStorage });
  } catch (error) {
    console.error('Upload media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});




// ...existing code...




// Get folders for a client and userPlanId (for /getFolders endpoint)
router.get('/clients/getFolders', async (req, res) => {
  try { 
    const { userPlanId,clientId } = req.query;
    const client = await require('../models').StudioClient.findByPk(clientId);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const where = { userId: client.userId };
    if (userPlanId) where.userPlanId = userPlanId;
    const folders = await require('../models').Folder.findAll({ where, order: [['createdAt', 'DESC']] });
    res.json({ success: true, folders });
  } catch (error) {
    console.error('Fetch folders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// Create folder for a client (optionally for a specific userPlanId)
router.post('/clients/:clientId/folders', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, userPlanId } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Folder name is required' });
    }
    // Find client to get userId
    const client = await StudioClient.findByPk(clientId);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    // Optionally, check userPlanId exists for this user
    if (userPlanId) {
      const plan = await UserStoragePlan.findOne({ where: { id: userPlanId, userId: client.userId } });
      if (!plan) return res.status(400).json({ success: false, message: 'Invalid userPlanId for this client' });
    }
    // Create folder
    const folder = await require('../models').Folder.create({
      userId: client.userId,
      name: name.trim(),
      userPlanId: userPlanId || null,
    });
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// Get all purchased plans for a client
router.get('/clients/:clientId/plans', async (req, res) => {
  try {
    const { clientId } = req.params;
    // Find client to get userId
    const client = await StudioClient.findByPk(clientId);
    if (!client) {
      console.log(`[PLANS] clientId ${clientId} not found`);
      return res.status(404).json({ success: false, message: 'Client not found' });
    }
    const userPlans = await UserStoragePlan.findAll({
      where: { userId: client.userId },
      order: [['expiryDate', 'DESC']],
    });

    // Compute actual used storage per plan from Media table (usedStorage is only ever increased on upload, never on delete - so recalc from reality)
    const planIds = userPlans.map((p) => p.id);
    const usedByPlan = await Media.findAll({
      attributes: ['userPlanId', [fn('SUM', col('size')), 'totalBytes']],
      where: { userId: client.userId, userPlanId: { [Op.in]: planIds } },
      group: ['userPlanId'],
      raw: true,
    });
    const usedMap = {};
    usedByPlan.forEach((row) => {
      usedMap[row.userPlanId] = Number(row.totalBytes) || 0;
    });

    const plansWithUsed = userPlans.map((plan) => {
      const planData = plan.get ? plan.get({ plain: true }) : plan;
      planData.usedStorage = usedMap[plan.id] != null ? usedMap[plan.id] : (plan.usedStorage || 0);
      return planData;
    });

    console.log(`[PLANS] clientId: ${clientId}, userId: ${client.userId}, plans found: ${userPlans.length}`);
    res.json(plansWithUsed);
  } catch (error) {
    console.error('Get user plans error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// ...existing code...


// Public: studio self-registration
router.post('/register', [
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

    // Check duplicates by email or mobile
    const existing = await User.findOne({ where: { [Op.or]: [{ email }, { mobile }] } });
    if (existing) return res.status(400).json({ success: false, message: 'Email or mobile already used' });

    const studio = await User.create({ email, name, mobile, password, userType: 'studio', isActive: false, city, address, pincode });
    return res.json({ success: true, studio });
  } catch (error) {
    console.error('Studio registration error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// All routes require studio authentication
router.use(authMiddleware);
router.use(studioMiddleware);

// Get studio dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const studioId = req.user.id;

    // Get clients
    const clients = await StudioClient.findAll({ where: { studioId } });
    const clientIds = clients.map(c => c.userId);

    // Get client media
    const clientMedia = await Media.findAll({
      where: { userId: { [Op.in]: clientIds } },
    });
    
    const videoCount = clientMedia.filter(m => m.category === 'video').length;
    const imageCount = clientMedia.filter(m => m.category === 'image').length;

    res.json({
      videoCount,
      imageCount,
      totalClients: clients.length,
      totalMedia: clientMedia.length,
      earnings: parseFloat(req.user.earnings) || 0,
      walletBalance: parseFloat(req.user.walletBalance) || 0,
    });
  } catch (error) {
    console.error('Get studio dashboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get studio clients
router.get('/clients', async (req, res) => {
  try {
    const studioId = req.user.id;
    const { search } = req.query;

    let where = { studioId };
    
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
      ];
    }

    const clients = await StudioClient.findAll({
      where,
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email', 'mobile'],
        required: false,
      }],
      order: [['createdAt', 'DESC']],
    });

    res.json(clients);
  } catch (error) {
    console.error('Get studio clients error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add studio client - handler shared for /clients and legacy /addClients
const addClientValidators = [
  body('name').notEmpty().withMessage('Name is required'),
];

const addClientHandler = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const studioId = req.user.id;
    let { name, email, mobile } = req.body;

    // Check if client already exists for this studio by email or mobile
    const existingClient = await StudioClient.findOne({
      where: {
        studioId,
        [Op.or]: [
          email ? { email } : null,
          mobile ? { mobile } : null,
        ].filter(Boolean),
      },
    });
    if (existingClient) {
      return res.status(400).json({ success: false, message: 'Client already exists for this studio' });
    }

    // Find or create underlying User record for the client
    let user = null;
    if (email) {
      user = await User.findOne({ where: { email } });
    }
    if (!user && mobile) {
      user = await User.findOne({ where: { mobile } });
    }

    if (!user) {
      user = await User.create({
        name: name || 'Client',
        email: email || null,
        mobile: mobile || null,
        userType: 'customer',
        isActive: true,
      });
    }

    // Now create StudioClient linking to the User
    const client = await StudioClient.create({
      studioId,
      userId: user.id,
      name: name || user.name,
      email: email || user.email,
      mobile: mobile || user.mobile,
    });

    res.json(client);
  } catch (error) {
    console.error('Add studio client error:', error);
    // Return stack for easier local debugging
    res.status(500).json({ success: false, message: 'Server error', error: error.message, stack: error.stack });
  }
};

router.post('/clients', addClientValidators, addClientHandler);
router.post('/addClients', addClientValidators, addClientHandler);

// Update studio client
router.patch('/clients/:clientId', [
  body('name').optional().notEmpty().withMessage('Name cannot be empty'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { clientId } = req.params;
    const studioId = req.user.id;
    const updateData = req.body;

    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId), studioId },
    });

    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    await client.update(updateData);

    res.json({ success: true, client });
  } catch (error) {
    console.error('Update studio client error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete studio client
router.delete('/clients/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const studioId = req.user.id;

    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId), studioId },
    });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    await client.destroy();

    res.json({ success: true });
  } catch (error) {
    console.error('Delete studio client error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get client details
router.get('/clients/:clientId/details', async (req, res) => {
  try {
    const { clientId } = req.params;
    const studioId = req.user.id;

    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId), studioId },
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email', 'mobile'],
        required: false,
      }],
    });
    
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const media = await Media.findAll({
      where: { userId: client.userId },
      order: [['uploadDate', 'DESC']],
    });
    const userStorage = await Storage.findOne({ where: { userId: client.userId } });

    res.json({
      client,
      media,
      storage: userStorage || { totalStorage: 0, usedStorage: 0, availableStorage: 0 },
    });
  } catch (error) {
    console.error('Get client details error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete client media (studio can delete media belonging to their client)
router.delete('/clients/:clientId/media/:mediaId', async (req, res) => {
  try {
    const { clientId, mediaId } = req.params;
    const studioId = req.user.id;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const media = await Media.findOne({ where: { id: parseInt(mediaId), userId: client.userId } });
    if (!media) return res.status(404).json({ success: false, message: 'Media not found' });
    const userId = client.userId;
    try {
      if (media.url && media.url.startsWith('/upload/')) {
        const filePath = path.join(__dirname, '..', media.url);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        await deleteFile(media.s3Key);
      }
    } catch (delError) {
      console.error('File delete error:', delError);
    }
    const sizeInGB = media.size / (1024 * 1024 * 1024);
    const storage = await Storage.findOne({ where: { userId } });
    if (storage) {
      const newUsedStorage = Math.max(0, parseFloat(storage.usedStorage) - sizeInGB);
      await storage.update({
        usedStorage: newUsedStorage,
        availableStorage: parseFloat(storage.totalStorage) - newUsedStorage,
      });
    }
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
    console.error('Delete client media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Purchase space for client
router.post('/clients/:clientId/purchase-space', [
  body('storage').isNumeric().withMessage('Storage is required'),
  body('period').isIn(['month', 'year']).withMessage('Period must be month or year'),
  body('price').isNumeric().withMessage('Price is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { clientId } = req.params;
    const studioId = req.user.id;
    const { storage, period, price } = req.body;

    // Verify client belongs to studio
    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId), studioId },
    });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // Get or create storage record
    let userStorage = await Storage.findOne({ where: { userId: client.userId } });
    if (!userStorage) {
      userStorage = await Storage.create({
        userId: client.userId,
        totalStorage: 1,
        usedStorage: 0,
        availableStorage: 1,
      });
    }

    // Add storage
    const newTotalStorage = parseFloat(userStorage.totalStorage) + parseFloat(storage);
    await userStorage.update({
      totalStorage: newTotalStorage,
      availableStorage: newTotalStorage - parseFloat(userStorage.usedStorage),
    });

    res.json({ success: true, storage: userStorage });
  } catch (error) {
    console.error('Purchase space for client error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Purchase a storage plan (membership) for a client
router.post('/clients/:clientId/purchase-plan', [
  body('planId').notEmpty().withMessage('Plan ID is required'),
  body('storage').optional().isNumeric().withMessage('Storage must be numeric for per_gb plans'),
  body('period').optional().isIn(['month', 'year']).withMessage('Period must be month or year'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { clientId } = req.params;
    const studioId = req.user.id;
    const { planId, storage: requestedStorage, period } = req.body;

    // Verify client belongs to studio
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Find plan
    const plan = await StoragePlan.findByPk(parseInt(planId));
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

    // Determine storage to add
    let storageToAdd = 0;
    if (plan.category === 'fixed') {
      storageToAdd = parseFloat(plan.storage);
    } else if (plan.category === 'per_gb') {
      if (!requestedStorage) return res.status(400).json({ success: false, message: 'Storage amount required for per_gb plans' });
      storageToAdd = parseFloat(requestedStorage);
    }

    const purchaseDate = new Date();
    const periodType = period === 'year' ? 'year' : 'month';

    // Check for existing active plan for user and plan (not yet expired)
    let userPlan = await UserStoragePlan.findOne({
      where: {
        userId: client.userId,
        planId: plan.id,
        status: 'active',
        expiryDate: { [Op.gt]: purchaseDate },
      },
    });

    let expiryDate;
    if (userPlan) {
      // Renewal: extend from current expiry (so we add period to end of current plan)
      const baseDate = userPlan.expiryDate > purchaseDate ? new Date(userPlan.expiryDate) : purchaseDate;
      expiryDate = addPeriodToDate(baseDate, periodType);
      userPlan.totalStorage += storageToAdd;
      userPlan.availableStorage += storageToAdd;
      userPlan.expiryDate = expiryDate;
      await userPlan.save();
    } else {
      // New plan: expiry = purchase date + period
      expiryDate = addPeriodToDate(purchaseDate, periodType);
      userPlan = await UserStoragePlan.create({
        userId: client.userId,
        planId: plan.id,
        totalStorage: storageToAdd,
        usedStorage: 0,
        availableStorage: storageToAdd,
        expiryDate,
        status: 'active',
      });
    }

    // Credit studio wallet by commission: (storage sold in GB × admin commission per GB from DB)
    const commissionPerGB = await getCommissionPerGB();
    const walletCredit = storageToAdd * commissionPerGB;
    if (walletCredit > 0) {
      const studio = await User.findByPk(studioId);
      if (studio) {
        const currentWallet = parseFloat(studio.walletBalance) || 0;
        studio.walletBalance = currentWallet + walletCredit;
        await studio.save();
      }
    }

    // Return plan and user storage plan
    res.json({ success: true, plan, userPlan, added: storageToAdd });
  } catch (error) {
    console.error('Purchase plan for client error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Move media from one plan (drive) to another for the same client. Optional mediaIds = move only selected.
router.post('/clients/:clientId/move-media', [
  body('fromUserPlanId').isInt().withMessage('Source plan ID is required'),
  body('toUserPlanId').isInt().withMessage('Destination plan ID is required'),
  body('mediaIds').optional().isArray().withMessage('mediaIds must be an array'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { clientId } = req.params;
    const studioId = req.user.id;
    const { fromUserPlanId, toUserPlanId, mediaIds: requestedMediaIds } = req.body;

    if (Number(fromUserPlanId) === Number(toUserPlanId)) {
      return res.status(400).json({ success: false, message: 'Source and destination must be different' });
    }

    const client = await StudioClient.findOne({ where: { id: parseInt(clientId), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const [fromPlan, toPlan] = await Promise.all([
      UserStoragePlan.findOne({ where: { id: parseInt(fromUserPlanId), userId: client.userId } }),
      UserStoragePlan.findOne({ where: { id: parseInt(toUserPlanId), userId: client.userId } }),
    ]);
    if (!fromPlan) return res.status(404).json({ success: false, message: 'Source plan not found' });
    if (!toPlan) return res.status(404).json({ success: false, message: 'Destination plan not found' });

    const where = { userId: client.userId, userPlanId: fromPlan.id };
    if (Array.isArray(requestedMediaIds) && requestedMediaIds.length > 0) {
      where.id = { [Op.in]: requestedMediaIds.map((id) => parseInt(id, 10)) };
    }

    const moved = await Media.update(
      { userPlanId: toPlan.id },
      { where }
    );
    const count = moved[0] || 0;

    // Recompute usedStorage for both plans from Media
    const [fromSum, toSum] = await Promise.all([
      Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId: client.userId, userPlanId: fromPlan.id },
        raw: true,
      }),
      Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId: client.userId, userPlanId: toPlan.id },
        raw: true,
      }),
    ]);
    const fromUsed = Math.max(0, Number(fromSum[0]?.total) || 0);
    const toUsed = Math.max(0, Number(toSum[0]?.total) || 0);
    await fromPlan.update({ usedStorage: fromUsed });
    await toPlan.update({ usedStorage: toUsed });

    res.json({ success: true, movedCount: count, fromPlan: fromPlan.id, toPlan: toPlan.id });
  } catch (error) {
    console.error('Move media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get upload URL for client media
router.post('/clients/:clientId/upload-url', [
  body('fileName').notEmpty().withMessage('File name is required'),
  body('mimeType').notEmpty().withMessage('MIME type is required'),
  body('size').isNumeric().withMessage('Size is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { clientId } = req.params;
    const studioId = req.user.id;
    const { fileName, mimeType, size } = req.body;

    // Verify client belongs to studio
    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId), studioId },
    });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // Check storage availability
    const storage = await Storage.findOne({ where: { userId: client.userId } });
    const sizeInGB = size / (1024 * 1024 * 1024);

    if (!storage || parseFloat(storage.availableStorage) < sizeInGB) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient storage space',
      });
    }

    // Generate upload URL
    const { uploadURL, s3Key, url } = await generateUploadURL(fileName, mimeType, client.userId);

    res.json({
      success: true,
      uploadURL,
      s3Key,
      url,
    });
  } catch (error) {
    console.error('Generate upload URL error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Save media for client
router.post('/clients/:clientId/media', [
  body('name').notEmpty().withMessage('Name is required'),
  body('url').notEmpty().withMessage('URL is required'),
  body('s3Key').notEmpty().withMessage('S3 key is required'),
  body('category').isIn(['image', 'video', 'document', 'other']).withMessage('Invalid category'),
  body('size').isNumeric().withMessage('Size is required'),
  body('mimeType').notEmpty().withMessage('MIME type is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { clientId } = req.params;
    const studioId = req.user.id;
    const { name, url, s3Key, category, size, mimeType, folderId } = req.body;

    // Verify client belongs to studio
    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId), studioId },
    });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // Create media record
    const media = await Media.create({
      userId: client.userId,
      name,
      url,
      s3Key,
      category,
      size: parseInt(size),
      mimeType,
      folderId: folderId ? parseInt(folderId) : null,
      uploadedBy: 'studio',
    });

    // Update storage usage
    const sizeInGB = size / (1024 * 1024 * 1024);
    let storage = await Storage.findOne({ where: { userId: client.userId } });
    
    if (!storage) {
      storage = await Storage.create({
        userId: client.userId,
        totalStorage: 1,
        usedStorage: 0,
        availableStorage: 1,
      });
    }
    
    const newUsedStorage = parseFloat(storage.usedStorage) + sizeInGB;
    await storage.update({
      usedStorage: newUsedStorage,
      availableStorage: parseFloat(storage.totalStorage) - newUsedStorage,
    });

    res.json(media);
  } catch (error) {
    console.error('Save client media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get fund requests (with wallet balance for withdraw UI)
router.get('/fund-requests', async (req, res) => {
  try {
    const studioId = req.user.id;
    const requests = await FundRequest.findAll({
      where: { studioId },
      order: [['createdAt', 'DESC']],
    });
    const walletBalance = parseFloat(req.user.walletBalance) || 0;
    const earnings = parseFloat(req.user.earnings) || 0;
    res.json({ requests, walletBalance, earnings });
  } catch (error) {
    console.error('Get fund requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create fund request (withdraw request)
router.post('/fund-requests', [
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount is required and must be positive'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const studioId = req.user.id;
    const amount = parseFloat(req.body.amount);

    const walletBalance = parseFloat(req.user.walletBalance) || 0;
    if (amount > walletBalance) {
      return res.status(400).json({ success: false, message: 'Amount cannot exceed wallet balance (₹' + walletBalance.toFixed(2) + ')' });
    }

    const request = await FundRequest.create({
      studioId,
      amount,
      status: 'pending',
    });

    // Deduct amount from studio wallet when request is created
    const studio = await User.findByPk(studioId);
    if (studio) {
      studio.walletBalance = Math.max(0, walletBalance - amount);
      await studio.save();
    }

    res.json(request);
  } catch (error) {
    console.error('Create fund request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get studio bank details
router.get('/bank-details', async (req, res) => {
  try {
    const studioId = req.user.id;
    const details = getBankDetails(studioId);
    res.json(details);
  } catch (error) {
    console.error('Get bank details error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Save studio bank details
router.put('/bank-details', [
  body('accountHolderName').optional().trim(),
  body('accountNumber').optional().trim(),
  body('ifsc').optional().trim(),
  body('bankName').optional().trim(),
  body('branch').optional().trim(),
], async (req, res) => {
  try {
    const studioId = req.user.id;
    const details = setBankDetails(studioId, {
      accountHolderName: req.body.accountHolderName,
      accountNumber: req.body.accountNumber,
      ifsc: req.body.ifsc,
      bankName: req.body.bankName,
      branch: req.body.branch,
    });
    res.json(details);
  } catch (error) {
    console.error('Save bank details error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
