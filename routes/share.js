const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { Share, Folder, Media, UserStoragePlan } = require('../models');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Helper: check if folderId is the shared root or a descendant of it
async function isFolderUnderShare(userId, sharedFolderId, folderId) {
  if (parseInt(folderId, 10) === parseInt(sharedFolderId, 10)) return true;
  let current = await Folder.findOne({ where: { id: folderId, userId } });
  while (current && current.parentFolderId) {
    if (current.parentFolderId === sharedFolderId) return true;
    current = await Folder.findOne({ where: { id: current.parentFolderId, userId } });
  }
  return current && current.id === sharedFolderId;
}

// Helper: check if folder belongs to the shared drive (for drive share)
function isFolderOnDrive(folder, driveResourceId) {
  if (driveResourceId === 0) return folder.userPlanId === null;
  return folder.userPlanId === driveResourceId;
}

// Public: resolve share token and return read-only folder/media structure. Optional ?folderId= for subfolder.
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const folderIdParam = req.query.folderId;
    const share = await Share.findOne({
      where: {
        token,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: new Date() } },
        ],
      },
    });
    if (!share) return res.status(404).json({ success: false, message: 'Link not found or expired' });

    if (share.resourceType === 'media') {
      const media = await Media.findOne({
        where: { id: share.resourceId, userId: share.userId },
        include: [{ model: Folder, as: 'folder', attributes: ['id', 'name'], required: false }],
      });
      if (!media) return res.status(404).json({ success: false, message: 'Media not found' });
      const m = media.get ? media.get({ plain: true }) : media;
      return res.json({ type: 'media', media: { id: m.id, name: m.name, url: m.url, category: m.category, mimeType: m.mimeType, size: m.size } });
    }

    // drive share: resourceId 0 = default drive, else = UserStoragePlan id. Return root or subfolder when folderId provided.
    if (share.resourceType === 'drive') {
      const drivePlanId = share.resourceId === 0 ? null : share.resourceId;
      const folderWhere = { userId: share.userId, userPlanId: drivePlanId };

      if (folderIdParam) {
        const fid = parseInt(folderIdParam, 10);
        if (Number.isNaN(fid)) return res.status(400).json({ success: false, message: 'Invalid folder' });
        const folder = await Folder.findOne({ where: { id: fid, userId: share.userId } });
        if (!folder) return res.status(404).json({ success: false, message: 'Folder not found' });
        if (!isFolderOnDrive(folder, share.resourceId)) return res.status(403).json({ success: false, message: 'Folder not in this drive' });

        const subfolders = await Folder.findAll({
          where: { userId: share.userId, parentFolderId: folder.id },
          order: [['name', 'ASC']],
          attributes: ['id', 'name', 'parentFolderId'],
        });
        const mediaList = await Media.findAll({
          where: { userId: share.userId, folderId: folder.id },
          order: [['name', 'ASC']],
          attributes: ['id', 'name', 'url', 'category', 'mimeType', 'size'],
        });
        return res.json({
          type: 'folder',
          folder: { id: folder.id, name: folder.name },
          subfolders: subfolders.map((f) => ({ id: f.id, name: f.name })),
          media: mediaList.map((m) => ({ id: m.id, name: m.name, url: m.url, category: m.category, mimeType: m.mimeType, size: m.size })),
        });
      }

      const rootFolders = await Folder.findAll({
        where: { ...folderWhere, parentFolderId: null },
        order: [['name', 'ASC']],
        attributes: ['id', 'name', 'parentFolderId'],
      });
      const rootMedia = await Media.findAll({
        where: { userId: share.userId, userPlanId: drivePlanId, folderId: null },
        order: [['name', 'ASC']],
        attributes: ['id', 'name', 'url', 'category', 'mimeType', 'size'],
      });
      const driveName = share.resourceId === 0 ? 'Default drive' : 'Drive';
      return res.json({
        type: 'folder',
        folder: { id: null, name: driveName },
        subfolders: rootFolders.map((f) => ({ id: f.id, name: f.name })),
        media: rootMedia.map((m) => ({ id: m.id, name: m.name, url: m.url, category: m.category, mimeType: m.mimeType, size: m.size })),
      });
    }

    // folder share: show shared root or a subfolder (when folderId is provided and allowed)
    let folder;
    if (folderIdParam) {
      const fid = parseInt(folderIdParam, 10);
      if (Number.isNaN(fid)) return res.status(400).json({ success: false, message: 'Invalid folder' });
      const allowed = await isFolderUnderShare(share.userId, share.resourceId, fid);
      if (!allowed) return res.status(403).json({ success: false, message: 'Folder not in shared scope' });
      folder = await Folder.findOne({ where: { id: fid, userId: share.userId } });
    } else {
      folder = await Folder.findOne({ where: { id: share.resourceId, userId: share.userId } });
    }
    if (!folder) return res.status(404).json({ success: false, message: 'Folder not found' });

    const subfolders = await Folder.findAll({
      where: { userId: share.userId, parentFolderId: folder.id },
      order: [['name', 'ASC']],
      attributes: ['id', 'name', 'parentFolderId'],
    });
    const mediaList = await Media.findAll({
      where: { userId: share.userId, folderId: folder.id },
      order: [['name', 'ASC']],
      attributes: ['id', 'name', 'url', 'category', 'mimeType', 'size'],
    });

    res.json({
      type: 'folder',
      folder: { id: folder.id, name: folder.name },
      subfolders: subfolders.map((f) => ({ id: f.id, name: f.name })),
      media: mediaList.map((m) => ({ id: m.id, name: m.name, url: m.url, category: m.category, mimeType: m.mimeType, size: m.size })),
    });
  } catch (error) {
    console.error('Resolve share error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create share link (auth required). resourceType: folder | media | drive. For drive, resourceId: 0 = default drive, else plan id.
router.post('/', authMiddleware, [
  body('resourceType').isIn(['folder', 'media', 'drive']).withMessage('resourceType must be folder, media, or drive'),
  body('resourceId').isInt({ min: 0 }).withMessage('resourceId is required (0 for default drive)'),
  body('expiresInDays').optional().isInt({ min: 1, max: 365 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = req.user.id;
    const { resourceType, resourceId, expiresInDays } = req.body;

    if (resourceType === 'folder') {
      const folder = await Folder.findOne({ where: { id: resourceId, userId } });
      if (!folder) return res.status(404).json({ success: false, message: 'Folder not found' });
    } else if (resourceType === 'media') {
      const media = await Media.findOne({ where: { id: resourceId, userId } });
      if (!media) return res.status(404).json({ success: false, message: 'Media not found' });
    } else if (resourceType === 'drive') {
      if (resourceId !== 0) {
        const plan = await UserStoragePlan.findOne({ where: { id: resourceId, userId } });
        if (!plan) return res.status(404).json({ success: false, message: 'Drive not found' });
      }
    }

    const token = crypto.randomBytes(24).toString('hex');
    let expiresAt = null;
    if (expiresInDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + parseInt(expiresInDays, 10));
    }

    await Share.create({
      token,
      resourceType,
      resourceId,
      userId,
      expiresAt,
    });

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const shareUrl = `${baseUrl}/share/${token}`;

    res.status(201).json({ success: true, token, shareUrl, expiresAt });
  } catch (error) {
    console.error('Create share error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
