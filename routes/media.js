const express = require('express');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { fn, col } = require('sequelize');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Media, Folder, Storage, UserStoragePlan } = require('../models');
const { authMiddleware } = require('../middleware/auth');
const { generateUploadURL, deleteFile } = require('../services/s3Service');

const router = express.Router();

// Multer for direct upload (like studio uploadMedia) - avoids S3 credentials
const mediaStorage = multer.diskStorage({
  destination: async function (req, file, cb) {
    try {
      const userId = req.user?.id;
      if (!userId) return cb(new Error('Unauthorized'));
      const { userPlanId, folderId } = req.body || {};
      let folderName = 'root';
      if (folderId) {
        const folder = await Folder.findOne({ where: { id: parseInt(folderId, 10), userId } });
        if (folder) folderName = folder.name;
      }
      const uploadPath = path.join(__dirname, '..', 'upload', String(userId), String(userPlanId || 'no-plan'), folderName);
      fs.mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    } catch (err) {
      cb(err);
    }
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + (file.originalname || 'file'));
  },
});
const uploadMulter = multer({ storage: mediaStorage });

// All routes require authentication
router.use(authMiddleware);

// Get media list (optional userPlanId: 'default' or plan id to scope by drive)
router.get('/list', async (req, res) => {
  try {
    const { category, folderId, userPlanId } = req.query;
    const userId = req.user.id;

    let where = { userId };

    if (userPlanId === 'default' || userPlanId === '' || userPlanId == null) {
      where.userPlanId = null;
    } else if (userPlanId) {
      const planId = parseInt(userPlanId, 10);
      if (!Number.isNaN(planId)) where.userPlanId = planId;
    }

    if (category) {
      where.category = category;
    }

    if (folderId === '') {
      where.folderId = null;
    } else if (folderId) {
      where.folderId = parseInt(folderId);
    }

    const media = await Media.findAll({
      where,
      order: [['uploadDate', 'DESC']],
      include: [{
        model: Folder,
        as: 'folder',
        attributes: ['id', 'name'],
        required: false,
      }],
    });

    res.json(media);
  } catch (error) {
    console.error('Get media list error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get single media by ID
router.get('/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    const userId = req.user.id;

    const media = await Media.findOne({
      where: { id: parseInt(mediaId), userId },
      include: [{
        model: Folder,
        as: 'folder',
        attributes: ['id', 'name'],
        required: false,
      }],
    });

    if (!media) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }

    res.json(media);
  } catch (error) {
    console.error('Get media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get presigned URL for upload (optional userPlanId: 'default' or plan id for drive)
router.post('/upload-url', [
  body('fileName').notEmpty().withMessage('File name is required'),
  body('mimeType').notEmpty().withMessage('MIME type is required'),
  body('size').isNumeric().withMessage('Size is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { fileName, mimeType, size, userPlanId } = req.body;
    const userId = req.user.id;
    const sizeNum = parseInt(size, 10);
    const sizeInGB = sizeNum / (1024 * 1024 * 1024);

    if (userPlanId && userPlanId !== 'default') {
      const planId = parseInt(userPlanId, 10);
      if (!Number.isNaN(planId)) {
        const plan = await UserStoragePlan.findOne({ where: { id: planId, userId } });
        if (plan) {
          const totalBytes = (parseFloat(plan.totalStorage) || 0) * (1024 * 1024 * 1024);
          const usedBytes = Number(plan.usedStorage) || 0;
          if (usedBytes + sizeNum > totalBytes) {
            return res.status(400).json({ success: false, message: 'Insufficient space in this drive' });
          }
        }
      }
    } else {
      const storage = await Storage.findOne({ where: { userId } });
      if (!storage || parseFloat(storage.availableStorage) < sizeInGB) {
        return res.status(400).json({ success: false, message: 'Insufficient storage space' });
      }
    }

    const result = await generateUploadURL(fileName, mimeType, userId);

    res.json({
      success: true,
      uploadURL: result.uploadURL,
      s3Key: result.s3Key,
      url: result.url,
    });
  } catch (error) {
    console.error('Generate upload URL error:', error);
    const message = error.message || (error.Code && error.Code + ': ' + error.message) || 'Server error';
    res.status(500).json({ success: false, message });
  }
});

// Direct multipart upload (like studio uploadMedia) - FormData: media, userPlanId, folderId
router.post('/upload', uploadMulter.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const userId = req.user.id;
    const { userPlanId, folderId } = req.body || {};
    const sizeNum = req.file.size;
    const sizeInGB = sizeNum / (1024 * 1024 * 1024);

    let folderName = 'root';
    let folderIdValue = null;
    if (folderId) {
      const folder = await Folder.findOne({ where: { id: parseInt(folderId, 10), userId } });
      if (folder) {
        folderName = folder.name;
        folderIdValue = folder.id;
      }
    }

    let planIdToSet = null;
    if (userPlanId && userPlanId !== 'default') {
      const planId = parseInt(userPlanId, 10);
      if (!Number.isNaN(planId)) {
        const plan = await UserStoragePlan.findOne({ where: { id: planId, userId } });
        if (plan) {
          const totalBytes = (parseFloat(plan.totalStorage) || 0) * (1024 * 1024 * 1024);
          const usedBytes = Number(plan.usedStorage) || 0;
          if (usedBytes + sizeNum > totalBytes) {
            return res.status(400).json({ success: false, message: 'Insufficient space in this drive' });
          }
          planIdToSet = plan.id;
        }
      }
    } else {
      const storage = await Storage.findOne({ where: { userId } });
      if (!storage || parseFloat(storage.availableStorage) < sizeInGB) {
        return res.status(400).json({ success: false, message: 'Insufficient storage space' });
      }
    }

    const media = await Media.create({
      userId,
      userPlanId: planIdToSet,
      folderId: folderIdValue,
      name: req.file.originalname,
      url: `/upload/${userId}/${userPlanId || 'no-plan'}/${folderName}/${req.file.filename}`,
      s3Key: req.file.filename,
      mimeType: req.file.mimetype,
      size: sizeNum,
      category: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
      uploadedBy: 'user',
    });

    if (planIdToSet) {
      const plan = await UserStoragePlan.findByPk(planIdToSet);
      if (plan) {
        const sumRows = await Media.findAll({
          attributes: [[fn('SUM', col('size')), 'totalBytes']],
          where: { userId, userPlanId: plan.id },
          raw: true,
        });
        const usedBytes = Math.max(0, Number(sumRows[0]?.totalBytes) || 0);
        plan.usedStorage = usedBytes;
        await plan.save();
      }
    } else {
      let storage = await Storage.findOne({ where: { userId } });
      if (!storage) {
        storage = await Storage.create({ userId, totalStorage: 1, usedStorage: 0, availableStorage: 1 });
      }
      const newUsedStorage = parseFloat(storage.usedStorage) + sizeInGB;
      await storage.update({
        usedStorage: newUsedStorage,
        availableStorage: parseFloat(storage.totalStorage) - newUsedStorage,
      });
    }

    res.json({ success: true, media });
  } catch (error) {
    console.error('Media upload error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Save media after upload (optional userPlanId: 'default' or plan id for drive)
router.post('/save', [
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

    const { name, url, s3Key, category, size, mimeType, folderId, userPlanId } = req.body;
    const userId = req.user.id;
    const sizeNum = parseInt(size, 10);
    const sizeInGB = sizeNum / (1024 * 1024 * 1024);

    let planIdToSet = null;
    if (userPlanId && userPlanId !== 'default') {
      const planId = parseInt(userPlanId, 10);
      if (!Number.isNaN(planId)) {
        const plan = await UserStoragePlan.findOne({ where: { id: planId, userId } });
        if (plan) {
          const totalBytes = (parseFloat(plan.totalStorage) || 0) * (1024 * 1024 * 1024);
          const usedBytes = Number(plan.usedStorage) || 0;
          if (usedBytes + sizeNum > totalBytes) {
            return res.status(400).json({ success: false, message: 'Insufficient space in this drive' });
          }
          planIdToSet = plan.id;
        }
      }
    }

    const media = await Media.create({
      userId,
      name,
      url,
      s3Key,
      category,
      size: sizeNum,
      mimeType,
      folderId: folderId ? parseInt(folderId) : null,
      userPlanId: planIdToSet,
      uploadedBy: 'user',
    });

    if (planIdToSet) {
      const plan = await UserStoragePlan.findByPk(planIdToSet);
      if (plan) {
        const newUsed = (Number(plan.usedStorage) || 0) + sizeNum;
        await plan.update({ usedStorage: newUsed });
      }
    } else {
      let storage = await Storage.findOne({ where: { userId } });
      if (!storage) {
        storage = await Storage.create({ userId, totalStorage: 1, usedStorage: 0, availableStorage: 1 });
      }
      const newUsedStorage = parseFloat(storage.usedStorage) + sizeInGB;
      await storage.update({
        usedStorage: newUsedStorage,
        availableStorage: parseFloat(storage.totalStorage) - newUsedStorage,
      });
    }

    res.json(media);
  } catch (error) {
    console.error('Save media error:', error);
    const message = error.message || (error.original && error.original.message) || 'Server error';
    res.status(500).json({ success: false, message });
  }
});

// Delete media
router.delete('/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    const userId = req.user.id;

    const media = await Media.findOne({ where: { id: parseInt(mediaId), userId } });
    if (!media) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }

    // Delete file: local disk if url starts with /upload/, else S3
    try {
      if (media.url && media.url.startsWith('/upload/')) {
        const filePath = path.join(__dirname, '..', media.url);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        await deleteFile(media.s3Key);
      }
    } catch (delError) {
      console.error('File delete error:', delError);
      // Continue even if delete fails
    }

    // Update storage usage (user-level Storage model)
    const sizeInGB = media.size / (1024 * 1024 * 1024);
    const storage = await Storage.findOne({ where: { userId } });
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

    // Delete media record
    await media.destroy();

    res.json({ success: true });
  } catch (error) {
    console.error('Delete media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Folder management

// Get folders
router.get('/folders/list', async (req, res) => {
  try {
    const userId = req.user.id;
    const folders = await Folder.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
    });
    res.json(folders);
  } catch (error) {
    console.error('Get folders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create folder (user panel). Same as studio: { name, planId }. planId = UserStoragePlan id (null for default drive).
router.post('/folders', [
  body('name').trim().notEmpty().withMessage('Folder name is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const name = (req.body.name && typeof req.body.name === 'string') ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ success: false, message: 'Folder name is required' });
    }
    const userId = req.user.id;
    let userPlanId = null;
    const planId = req.body.planId ?? req.body.userPlanId;
    if (planId !== undefined && planId !== null && planId !== '' && planId !== 'default') {
      const id = parseInt(planId, 10);
      if (!Number.isNaN(id)) {
        const plan = await UserStoragePlan.findOne({ where: { id, userId } });
        if (!plan) return res.status(400).json({ success: false, message: 'Invalid planId for this user' });
        userPlanId = plan.id;
      }
    }

    const folder = await Folder.create({
      userId,
      name,
      userPlanId: userPlanId ?? null,
    });

    res.json(folder);
  } catch (error) {
    console.error('Create folder error:', error);
    const message = error.message || (error.original && error.original.message) || 'Server error';
    res.status(500).json({ success: false, message });
  }
});

// Delete folder
router.delete('/folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    const userId = req.user.id;

    const folder = await Folder.findOne({ where: { id: parseInt(folderId), userId } });
    if (!folder) {
      return res.status(404).json({ success: false, message: 'Folder not found' });
    }

    // Remove folderId from media items
    await Media.update(
      { folderId: null },
      { where: { folderId: parseInt(folderId), userId } }
    );

    // Delete folder
    await folder.destroy();

    res.json({ success: true });
  } catch (error) {
    console.error('Delete folder error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
