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

// Update media (rename and/or move to folder)
router.patch('/:mediaId', [
  body('name').optional().trim().notEmpty().withMessage('Media name cannot be empty'),
  body('folderId').optional(),
], async (req, res) => {
  try {
    const { mediaId } = req.params;
    const userId = req.user.id;
    const media = await Media.findOne({ where: { id: parseInt(mediaId), userId } });
    if (!media) return res.status(404).json({ success: false, message: 'Media not found' });

    if (req.body.name !== undefined) {
      const name = (req.body.name && typeof req.body.name === 'string') ? req.body.name.trim() : '';
      if (!name) return res.status(400).json({ success: false, message: 'Media name cannot be empty' });
      media.name = name;
    }
    if (req.body.folderId !== undefined) {
      const raw = req.body.folderId;
      let newFolderId = null;
      if (raw !== null && raw !== '' && raw !== 'null') {
        const fid = parseInt(raw, 10);
        if (!Number.isNaN(fid)) {
          const folder = await Folder.findOne({ where: { id: fid, userId } });
          if (!folder) return res.status(400).json({ success: false, message: 'Folder not found' });
          if (folder.userPlanId !== media.userPlanId) return res.status(400).json({ success: false, message: 'Folder must be on same drive' });
          newFolderId = folder.id;
        }
      }
      media.folderId = newFolderId;
    }
    await media.save();
    res.json(media);
  } catch (error) {
    console.error('Update media error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Copy media to same or another folder (same drive)
router.post('/:mediaId/copy', [
  body('folderId').optional(),
], async (req, res) => {
  try {
    const { mediaId } = req.params;
    const userId = req.user.id;
    const media = await Media.findOne({ where: { id: parseInt(mediaId), userId } });
    if (!media) return res.status(404).json({ success: false, message: 'Media not found' });

    const raw = req.body.folderId;
    let folderId = null;
    if (raw !== undefined && raw !== null && raw !== '' && raw !== 'null') {
      const fid = parseInt(raw, 10);
      if (!Number.isNaN(fid)) {
        const folder = await Folder.findOne({ where: { id: fid, userId } });
        if (!folder) return res.status(400).json({ success: false, message: 'Folder not found' });
        if (folder.userPlanId !== media.userPlanId) return res.status(400).json({ success: false, message: 'Folder must be on same drive' });
        folderId = folder.id;
      }
    }

    const copy = await Media.create({
      userId,
      name: media.name,
      url: media.url,
      s3Key: media.s3Key,
      category: media.category,
      size: media.size,
      mimeType: media.mimeType,
      folderId,
      userPlanId: media.userPlanId,
      uploadedBy: media.uploadedBy,
    });

    if (media.userPlanId) {
      const plan = await UserStoragePlan.findByPk(media.userPlanId);
      if (plan) {
        plan.usedStorage = (Number(plan.usedStorage) || 0) + media.size;
        await plan.save();
      }
    } else {
      const sizeInGB = media.size / (1024 * 1024 * 1024);
      let storage = await Storage.findOne({ where: { userId } });
      if (storage) {
        const newUsed = parseFloat(storage.usedStorage) + sizeInGB;
        await storage.update({
          usedStorage: newUsed,
          availableStorage: Math.max(0, parseFloat(storage.totalStorage) - newUsed),
        });
      }
    }

    res.status(201).json(copy);
  } catch (error) {
    console.error('Copy media error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
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
        storage = await Storage.create({ userId, totalStorage: 0, usedStorage: 0, availableStorage: 0 });
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
        storage = await Storage.create({ userId, totalStorage: 0, usedStorage: 0, availableStorage: 0 });
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

// Get folders (optional parentFolderId = null for root, userPlanId to filter by drive)
router.get('/folders/list', async (req, res) => {
  try {
    const userId = req.user.id;
    const { parentFolderId, userPlanId } = req.query;
    const where = { userId };
    if (parentFolderId !== undefined && parentFolderId !== null) {
      if (parentFolderId === '' || parentFolderId === 'null') {
        where.parentFolderId = null;
      } else {
        const pid = parseInt(parentFolderId, 10);
        if (!Number.isNaN(pid)) where.parentFolderId = pid;
      }
    }
    if (userPlanId !== undefined && userPlanId !== null && userPlanId !== '' && userPlanId !== 'default') {
      const planId = parseInt(userPlanId, 10);
      if (!Number.isNaN(planId)) where.userPlanId = planId;
    } else if (userPlanId === 'default' || userPlanId === '') {
      where.userPlanId = null;
    }
    const folders = await Folder.findAll({
      where,
      order: [['name', 'ASC'], ['createdAt', 'DESC']],
    });
    res.json(folders);
  } catch (error) {
    console.error('Get folders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create folder (name, planId, parentFolderId for nested folders)
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
    let parentFolderId = null;
    const rawParent = req.body.parentFolderId ?? req.body.parentId;
    if (rawParent !== undefined && rawParent !== null && rawParent !== '' && rawParent !== 'null') {
      const pid = parseInt(rawParent, 10);
      if (!Number.isNaN(pid)) {
        const parent = await Folder.findOne({ where: { id: pid, userId } });
        if (!parent) return res.status(400).json({ success: false, message: 'Parent folder not found' });
        parentFolderId = parent.id;
        if (userPlanId === null && parent.userPlanId !== null) userPlanId = parent.userPlanId;
        if (userPlanId !== null && parent.userPlanId !== null && parent.userPlanId !== userPlanId) {
          return res.status(400).json({ success: false, message: 'Parent folder must be on same drive' });
        }
      }
    }

    const folder = await Folder.create({
      userId,
      name,
      userPlanId: userPlanId ?? null,
      parentFolderId,
    });

    res.json(folder);
  } catch (error) {
    console.error('Create folder error:', error);
    const message = error.message || (error.original && error.original.message) || 'Server error';
    res.status(500).json({ success: false, message });
  }
});

// Update folder (rename and/or move to another folder)
router.patch('/folders/:folderId', [
  body('name').optional().trim().notEmpty().withMessage('Folder name cannot be empty'),
  body('parentFolderId').optional(),
], async (req, res) => {
  try {
    const { folderId } = req.params;
    const userId = req.user.id;
    const folder = await Folder.findOne({ where: { id: parseInt(folderId), userId } });
    if (!folder) return res.status(404).json({ success: false, message: 'Folder not found' });

    if (req.body.name !== undefined) {
      const name = (req.body.name && typeof req.body.name === 'string') ? req.body.name.trim() : '';
      if (!name) return res.status(400).json({ success: false, message: 'Folder name cannot be empty' });
      folder.name = name;
    }
    if (req.body.parentFolderId !== undefined) {
      const raw = req.body.parentFolderId;
      let newParentId = null;
      if (raw !== null && raw !== '' && raw !== 'null') {
        const pid = parseInt(raw, 10);
        if (!Number.isNaN(pid)) {
          if (pid === folder.id) return res.status(400).json({ success: false, message: 'Folder cannot be its own parent' });
          const parent = await Folder.findOne({ where: { id: pid, userId } });
          if (!parent) return res.status(400).json({ success: false, message: 'Parent folder not found' });
          let check = parent;
          while (check && check.parentFolderId) {
            if (check.parentFolderId === folder.id) return res.status(400).json({ success: false, message: 'Cannot move folder inside its own descendant' });
            check = await Folder.findOne({ where: { id: check.parentFolderId, userId } });
          }
          newParentId = parent.id;
        }
      }
      folder.parentFolderId = newParentId;
    }
    await folder.save();
    res.json(folder);
  } catch (error) {
    console.error('Update folder error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Delete folder (reparent subfolders and media to this folder's parent, then delete)
router.delete('/folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    const userId = req.user.id;
    const folderIdNum = parseInt(folderId, 10);
    const folder = await Folder.findOne({ where: { id: folderIdNum, userId } });
    if (!folder) {
      return res.status(404).json({ success: false, message: 'Folder not found' });
    }
    const newParentId = folder.parentFolderId;

    await Folder.update(
      { parentFolderId: newParentId },
      { where: { parentFolderId: folderIdNum, userId } }
    );
    await Media.update(
      { folderId: newParentId },
      { where: { folderId: folderIdNum, userId } }
    );

    await folder.destroy();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete folder error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper: collect all descendant folder ids (recursive)
async function getDescendantFolderIds(userId, folderId, result = new Set()) {
  const children = await Folder.findAll({ where: { userId, parentFolderId: folderId }, attributes: ['id'] });
  for (const c of children) {
    result.add(c.id);
    await getDescendantFolderIds(userId, c.id, result);
  }
  return result;
}

// Move folder (and all its media) to another drive. Optional toFolderId = parent folder on destination drive.
router.post('/folders/:folderId/move-to-drive', [
  body('toUserPlanId').notEmpty().withMessage('Destination drive is required'),
  body('toFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { folderId } = req.params;
    const userId = req.user.id;
    const toRaw = req.body.toUserPlanId;
    const toId = toRaw === 'default' || toRaw === '' ? 'default' : parseInt(toRaw, 10);
    const newPlanId = toId === 'default' ? null : toId;
    let toFolderId = req.body.toFolderId != null && req.body.toFolderId !== '' ? parseInt(req.body.toFolderId, 10) : null;
    if (toFolderId !== null && Number.isNaN(toFolderId)) toFolderId = null;
    if (newPlanId !== null) {
      const toPlan = await UserStoragePlan.findOne({ where: { id: newPlanId, userId } });
      if (!toPlan) return res.status(404).json({ success: false, message: 'Destination drive not found' });
    }
    if (toFolderId != null) {
      const destFolder = await Folder.findOne({ where: { id: toFolderId, userId, userPlanId: newPlanId } });
      if (!destFolder) return res.status(400).json({ success: false, message: 'Destination folder not found on that drive' });
    }

    const folder = await Folder.findOne({ where: { id: parseInt(folderId, 10), userId } });
    if (!folder) return res.status(404).json({ success: false, message: 'Folder not found' });

    const allIds = new Set([folder.id]);
    await getDescendantFolderIds(userId, folder.id, allIds);
    const folderIds = Array.from(allIds);

    const targetFolder = await Folder.create({
      userId,
      name: folder.name,
      userPlanId: newPlanId,
      parentFolderId: toFolderId,
    });

    const mediaInTree = await Media.findAll({
      where: { userId, folderId: { [Op.in]: folderIds } },
    });
    for (const m of mediaInTree) {
      await m.update({ userPlanId: newPlanId, folderId: targetFolder.id });
    }

    const fromPlanId = folder.userPlanId;
    if (fromPlanId) {
      const sumFrom = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: fromPlanId },
        raw: true,
      });
      const usedFrom = Math.max(0, Number(sumFrom[0]?.total) || 0);
      const planFrom = await UserStoragePlan.findByPk(fromPlanId);
      if (planFrom) await planFrom.update({ usedStorage: usedFrom });
    } else {
      const defaultSum = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: null },
        raw: true,
      });
      const usedBytes = Number(defaultSum[0]?.total) || 0;
      const usedGB = usedBytes / BYTES_PER_GB;
      let storage = await Storage.findOne({ where: { userId } });
      if (storage) await storage.update({ usedStorage: usedGB, availableStorage: Math.max(0, parseFloat(storage.totalStorage) - usedGB) });
    }
    if (newPlanId) {
      const sumTo = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: newPlanId },
        raw: true,
      });
      const usedTo = Math.max(0, Number(sumTo[0]?.total) || 0);
      const planTo = await UserStoragePlan.findByPk(newPlanId);
      if (planTo) await planTo.update({ usedStorage: usedTo });
    } else {
      const defaultSum = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: null },
        raw: true,
      });
      const usedBytes = Number(defaultSum[0]?.total) || 0;
      const usedGB = usedBytes / BYTES_PER_GB;
      let storage = await Storage.findOne({ where: { userId } });
      if (storage) await storage.update({ usedStorage: usedGB, availableStorage: Math.max(0, parseFloat(storage.totalStorage) - usedGB) });
    }

    const toDelete = folderIds.slice().sort((a, b) => b - a);
    for (const fid of toDelete) {
      await Media.update({ folderId: null }, { where: { folderId: fid, userId } });
      const f = await Folder.findByPk(fid);
      if (f) await f.destroy();
    }

    res.json({ success: true, targetFolderId: targetFolder.id, movedMediaCount: mediaInTree.length });
  } catch (error) {
    console.error('Move folder to drive error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Copy folder (and all its media) to another drive. Optional toFolderId = parent folder on destination drive.
router.post('/folders/:folderId/copy-to-drive', [
  body('toUserPlanId').notEmpty().withMessage('Destination drive is required'),
  body('toFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { folderId } = req.params;
    const userId = req.user.id;
    const toRaw = req.body.toUserPlanId;
    const toId = toRaw === 'default' || toRaw === '' ? 'default' : parseInt(toRaw, 10);
    const newPlanId = toId === 'default' ? null : toId;
    let toFolderId = req.body.toFolderId != null && req.body.toFolderId !== '' ? parseInt(req.body.toFolderId, 10) : null;
    if (toFolderId !== null && Number.isNaN(toFolderId)) toFolderId = null;
    if (newPlanId !== null) {
      const toPlan = await UserStoragePlan.findOne({ where: { id: newPlanId, userId } });
      if (!toPlan) return res.status(404).json({ success: false, message: 'Destination drive not found' });
    }
    if (toFolderId != null) {
      const destFolder = await Folder.findOne({ where: { id: toFolderId, userId, userPlanId: newPlanId } });
      if (!destFolder) return res.status(400).json({ success: false, message: 'Destination folder not found on that drive' });
    }

    const folder = await Folder.findOne({ where: { id: parseInt(folderId, 10), userId } });
    if (!folder) return res.status(404).json({ success: false, message: 'Folder not found' });

    const allIds = new Set([folder.id]);
    await getDescendantFolderIds(userId, folder.id, allIds);
    const folderIds = Array.from(allIds);

    const targetFolder = await Folder.create({
      userId,
      name: folder.name,
      userPlanId: newPlanId,
      parentFolderId: toFolderId,
    });

    const mediaInTree = await Media.findAll({
      where: { userId, folderId: { [Op.in]: folderIds } },
    });
    for (const m of mediaInTree) {
      await Media.create({
        userId,
        name: m.name,
        url: m.url,
        s3Key: m.s3Key,
        category: m.category,
        size: m.size,
        mimeType: m.mimeType,
        folderId: targetFolder.id,
        userPlanId: newPlanId,
        uploadedBy: m.uploadedBy,
      });
    }

    if (newPlanId) {
      const sumTo = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: newPlanId },
        raw: true,
      });
      const usedTo = Math.max(0, Number(sumTo[0]?.total) || 0);
      const planTo = await UserStoragePlan.findByPk(newPlanId);
      if (planTo) await planTo.update({ usedStorage: usedTo });
    } else {
      const defaultSum = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: null },
        raw: true,
      });
      const usedBytes = Number(defaultSum[0]?.total) || 0;
      const usedGB = usedBytes / BYTES_PER_GB;
      let storage = await Storage.findOne({ where: { userId } });
      if (storage) await storage.update({ usedStorage: usedGB, availableStorage: Math.max(0, parseFloat(storage.totalStorage) - usedGB) });
    }

    res.json({ success: true, targetFolderId: targetFolder.id, copiedMediaCount: mediaInTree.length });
  } catch (error) {
    console.error('Copy folder to drive error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

module.exports = router;
