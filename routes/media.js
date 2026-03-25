const express = require('express');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { fn, col } = require('sequelize');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Media, Folder, Storage, UserStoragePlan } = require('../models');
const { authMiddleware } = require('../middleware/auth');
const { generateUploadURL, generateDownloadURL, deleteFile, uploadFileToS3, uploadBufferToS3, isS3Configured, getBackblazeStatus } = require('../services/s3Service');

const router = express.Router();

// Path structure: userId (unique) → drive name → folder → file (first upload creates folders)
const getDriveSlug = (userPlanId) => {
  if (userPlanId == null || userPlanId === '' || userPlanId === 'default') return 'default';
  return `plan-${userPlanId}`;
};
const getFolderSlug = (folderId) => (folderId != null && folderId !== '') ? `f-${folderId}` : 'root';

const mediaStorage = multer.diskStorage({
  destination: async function (req, file, cb) {
    try {
      const userId = req.user?.id;
      if (!userId) return cb(new Error('Unauthorized'));
      const { userPlanId, folderId } = req.body || {};
      const driveSlug = getDriveSlug(userPlanId);
      const folderSlug = getFolderSlug(folderId);
      const uploadPath = path.join(__dirname, '..', 'upload', String(userId), driveSlug, folderSlug);
      fs.mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    } catch (err) {
      cb(err);
    }
  },
  filename: function (req, file, cb) {
    const ext = (file.originalname && file.originalname.includes('.')) ? path.extname(file.originalname) : '';
    cb(null, Date.now() + '-' + (path.basename(file.originalname || 'file', ext) || 'file').replace(/[^a-zA-Z0-9._-]/g, '_') + ext);
  },
});
const uploadMulter = multer({ storage: mediaStorage });

// Direct upload: keep in memory (no local disk write). Chunked uploads still use local chunk staging.
const uploadMulterMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // up to 50MB for direct uploads
});

// Chunked upload: store chunks in memory then write to disk (max 10MB per chunk)
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const CHUNKS_DIR = path.join(__dirname, '..', 'chunks');
try { fs.mkdirSync(CHUNKS_DIR, { recursive: true }); } catch (_) { }

const chunkUploadMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Backblaze B2 config status (public debug, no secrets)
router.get('/backblaze-status', (req, res) => {
  res.json(getBackblazeStatus());
});

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

    if (folderId !== undefined && folderId !== null) {
      if (folderId === '' || folderId === 'null') {
        where.folderId = null;
      } else {
        const fid = parseInt(folderId, 10);
        if (!Number.isNaN(fid)) where.folderId = fid;
      }
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

    const list = media.map((m) => m.get ? m.get({ plain: true }) : m);
    if (isS3Configured()) {
      await Promise.all(list.map(async (item) => {
        if (item.s3Key) {
          try {
            item.url = await generateDownloadURL(item.s3Key, 3600);
          } catch (_) { }
        }
      }));
    }
    res.json(list);
  } catch (error) {
    console.error('Get media list error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- Chunked upload routes (must be before /:mediaId so path is not matched as mediaId) ----------
function getChunkUploadDir(uploadId) {
  const dir = path.join(CHUNKS_DIR, String(uploadId).replace(/[^a-zA-Z0-9_-]/g, ''));
  return dir;
}
function getChunkMetaPath(uploadId) {
  return path.join(getChunkUploadDir(uploadId), 'meta.json');
}
router.get('/chunk-upload-status', async (req, res) => {
  const uploadId = (req.query.uploadId || '').trim();
  const empty = () => res.json({ uploadId: uploadId || '', receivedChunks: [], totalChunks: null, meta: null });
  if (!uploadId) return res.status(400).json({ success: false, message: 'uploadId required' });
  try {
    const dir = getChunkUploadDir(uploadId);
    if (!fs.existsSync(dir)) return empty();
    let meta = null;
    const metaPath = getChunkMetaPath(uploadId);
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_) { }
    }
    const receivedChunks = [];
    const files = fs.readdirSync(dir);
    files.forEach((f) => {
      const n = parseInt(f, 10);
      if (!Number.isNaN(n) && f === String(n)) receivedChunks.push(n);
    });
    receivedChunks.sort((a, b) => a - b);
    return res.json({
      uploadId,
      receivedChunks,
      totalChunks: meta ? meta.totalChunks : null,
      meta: meta ? { fileName: meta.fileName, fileSize: meta.fileSize, mimeType: meta.mimeType } : null,
    });
  } catch (err) {
    console.error('Chunk status error:', err);
    return empty();
  }
});
// Longer timeout for chunk upload (5 min) so large/slow uploads don't get killed
const CHUNK_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
router.post('/upload-chunk', (req, res, next) => {
  req.setTimeout(CHUNK_UPLOAD_TIMEOUT_MS);
  res.setTimeout(CHUNK_UPLOAD_TIMEOUT_MS);
  next();
}, chunkUploadMulter.single('chunk'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, message: 'No chunk file' });
    const { uploadId, chunkIndex, totalChunks, fileName, fileSize, mimeType, userPlanId, folderId } = req.body || {};
    const userId = req.user.id;
    if (!uploadId || (chunkIndex === undefined || chunkIndex === '') || (totalChunks === undefined || totalChunks === '')) {
      return res.status(400).json({ success: false, message: 'uploadId, chunkIndex, totalChunks required' });
    }
    const idx = parseInt(chunkIndex, 10);
    const total = parseInt(totalChunks, 10);
    if (Number.isNaN(idx) || Number.isNaN(total) || idx < 0 || total < 1 || idx >= total) {
      return res.status(400).json({ success: false, message: 'Invalid chunkIndex or totalChunks' });
    }
    const dir = getChunkUploadDir(uploadId);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.error('Chunk mkdir error:', e);
      return res.status(500).json({ success: false, message: 'Failed to create upload directory' });
    }
    const chunkPath = path.join(dir, String(idx));
    try {
      fs.writeFileSync(chunkPath, req.file.buffer);
    } catch (e) {
      console.error('Chunk write error:', e);
      return res.status(500).json({ success: false, message: 'Failed to write chunk (disk full?)' });
    }
    const metaPath = getChunkMetaPath(uploadId);
    if (!fs.existsSync(metaPath)) {
      const meta = {
        userId,
        totalChunks: total,
        fileName: (fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_'),
        fileSize: parseInt(fileSize, 10) || 0,
        mimeType: mimeType || 'application/octet-stream',
        userPlanId: userPlanId != null && userPlanId !== '' ? String(userPlanId) : null,
        folderId: folderId != null && folderId !== '' ? String(folderId) : null,
      };
      try {
        fs.writeFileSync(metaPath, JSON.stringify(meta));
      } catch (e) {
        console.error('Chunk meta write error:', e);
      }
    }
    return res.json({ success: true, chunkIndex: idx, totalChunks: total });
  } catch (err) {
    console.error('Upload chunk error:', err);
    if (res.headersSent) return;
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});
const COMPLETE_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000; // 15 min for merge + S3
router.post('/complete-chunked-upload', (req, res, next) => {
  req.setTimeout(COMPLETE_UPLOAD_TIMEOUT_MS);
  res.setTimeout(COMPLETE_UPLOAD_TIMEOUT_MS);
  next();
}, [
  body('uploadId').notEmpty().withMessage('uploadId required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { uploadId } = req.body;
    const userId = req.user.id;
    const dir = getChunkUploadDir(uploadId);
    const metaPath = getChunkMetaPath(uploadId);
    if (!fs.existsSync(dir) || !fs.existsSync(metaPath)) {
      return res.status(404).json({ success: false, message: 'Chunk upload not found or incomplete' });
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.userId !== userId) return res.status(403).json({ success: false, message: 'Forbidden' });
    const totalChunks = meta.totalChunks;
    const receivedChunks = [];
    fs.readdirSync(dir).forEach((f) => {
      const n = parseInt(f, 10);
      if (!Number.isNaN(n) && f === String(n)) receivedChunks.push(n);
    });
    for (let i = 0; i < totalChunks; i++) {
      if (!receivedChunks.includes(i)) {
        return res.status(400).json({ success: false, message: `Missing chunk ${i}` });
      }
    }
    const sizeNum = meta.fileSize || 0;
    const sizeInGB = sizeNum / (1024 * 1024 * 1024);
    let folderIdValue = null;
    if (meta.folderId) {
      const folder = await Folder.findOne({ where: { id: parseInt(meta.folderId, 10), userId } });
      if (folder) folderIdValue = folder.id;
    }
    const driveSlug = getDriveSlug(meta.userPlanId);
    const folderSlug = getFolderSlug(folderIdValue);
    let planIdToSet = null;
    if (meta.userPlanId && meta.userPlanId !== 'default') {
      const planId = parseInt(meta.userPlanId, 10);
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
    if (!isS3Configured()) {
      return res.status(503).json({ success: false, message: 'Backblaze B2 not configured' });
    }
    const mergePath = path.join(dir, '_merged');
    try {
      const fd = fs.openSync(mergePath, 'w');
      try {
        for (let i = 0; i < totalChunks; i++) {
          const chunkPath = path.join(dir, String(i));
          const buf = fs.readFileSync(chunkPath);
          fs.writeSync(fd, buf);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (mergeErr) {
      console.error('Merge chunks error:', mergeErr);
      if (fs.existsSync(mergePath)) try { fs.unlinkSync(mergePath); } catch (_) { }
      if (!res.headersSent) return res.status(500).json({ success: false, message: 'Merge failed. ' + (mergeErr.message || '') });
      return;
    }
    const ext = (meta.fileName && meta.fileName.includes('.')) ? path.extname(meta.fileName) : '';
    const finalName = `${Date.now()}-${(path.basename(meta.fileName || 'file', ext) || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}${ext}`;
    const filePath = `${userId}/${driveSlug}/${folderSlug}/${finalName}`;
    const fullS3Key = `uploads/${filePath}`;
    let url;
    try {
      url = await uploadFileToS3(fullS3Key, mergePath, meta.mimeType);
    } catch (s3Err) {
      console.error('Chunked merge Backblaze upload error:', s3Err);
      try { fs.unlinkSync(mergePath); } catch (_) { }
      return res.status(500).json({ success: false, message: 'Upload to storage failed' });
    }
    try {
      fs.unlinkSync(mergePath);
      for (let i = 0; i < totalChunks; i++) fs.unlinkSync(path.join(dir, String(i)));
      fs.unlinkSync(metaPath);
      fs.rmdirSync(dir);
    } catch (e) { console.error('Chunk cleanup error:', e.message); }
    const media = await Media.create({
      userId,
      userPlanId: planIdToSet,
      folderId: folderIdValue,
      name: meta.fileName,
      url,
      s3Key: fullS3Key,
      mimeType: meta.mimeType,
      size: sizeNum,
      category: (meta.mimeType || '').startsWith('video/') ? 'video' : 'image',
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
        plan.usedStorage = Math.max(0, Number(sumRows[0]?.totalBytes) || 0);
        await plan.save();
      }
    } else {
      let storage = await Storage.findOne({ where: { userId } });
      if (!storage) storage = await Storage.create({ userId, totalStorage: 0, usedStorage: 0, availableStorage: 0 });
      const newUsed = parseFloat(storage.usedStorage) + sizeInGB;
      await storage.update({ usedStorage: newUsed, availableStorage: parseFloat(storage.totalStorage) - newUsed });
    }
    return res.json({ success: true, media });
  } catch (err) {
    console.error('Complete chunked upload error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message || 'Server error', error: err.code || err.name });
    }
  }
});
router.post('/abort-chunked-upload', [
  body('uploadId').notEmpty().withMessage('uploadId required'),
], async (req, res) => {
  try {
    const { uploadId } = req.body;
    const userId = req.user.id;
    const dir = getChunkUploadDir(uploadId);
    const metaPath = getChunkMetaPath(uploadId);
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.userId !== userId) return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch (_) { } });
      try { fs.rmdirSync(dir); } catch (_) { }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Server error' });
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

    const out = media.get ? media.get({ plain: true }) : media;
    if (isS3Configured() && out.s3Key) {
      try {
        out.url = await generateDownloadURL(out.s3Key, 3600);
      } catch (_) { }
    }
    res.json(out);
  } catch (error) {
    console.error('Get media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update media (rename and/or move to folder) — MOVE = update one row's folderId, no copy
router.patch('/:mediaId', [
  body('name').optional().trim().notEmpty().withMessage('Media name cannot be empty'),
  body('folderId').optional(),
], async (req, res) => {
  try {
    const mediaIdNum = parseInt(req.params.mediaId, 10);
    if (Number.isNaN(mediaIdNum)) return res.status(400).json({ success: false, message: 'Invalid media id' });
    const userId = req.user.id;
    const media = await Media.findOne({ where: { id: mediaIdNum, userId } });
    if (!media) return res.status(404).json({ success: false, message: 'Media not found' });

    const updates = {};
    if (req.body.name !== undefined) {
      const name = (req.body.name && typeof req.body.name === 'string') ? req.body.name.trim() : '';
      if (!name) return res.status(400).json({ success: false, message: 'Media name cannot be empty' });
      updates.name = name;
    }
    if (req.body.folderId !== undefined) {
      const raw = req.body.folderId;
      let newFolderId = null;
      if (raw !== null && raw !== '' && raw !== 'null') {
        const fid = parseInt(raw, 10);
        if (!Number.isNaN(fid)) {
          const folder = await Folder.findOne({ where: { id: fid, userId } });
          if (!folder) return res.status(400).json({ success: false, message: 'Folder not found' });
          const mediaPlan = media.userPlanId == null ? null : Number(media.userPlanId);
          const folderPlan = folder.userPlanId == null ? null : Number(folder.userPlanId);
          if (mediaPlan !== folderPlan) return res.status(400).json({ success: false, message: 'Folder must be on same drive' });
          newFolderId = folder.id;
        }
      }
      updates.folderId = newFolderId;
    }
    if (Object.keys(updates).length === 0) return res.json(media);

    const [affectedRows] = await Media.update(updates, { where: { id: mediaIdNum, userId } });
    if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Media not found' });
    const updated = await Media.findOne({
      where: { id: mediaIdNum, userId },
      include: [{ model: Folder, as: 'folder', attributes: ['id', 'name'], required: false }],
    });
    res.json(updated);
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
        const mediaPlan = media.userPlanId == null ? null : Number(media.userPlanId);
        const folderPlan = folder.userPlanId == null ? null : Number(folder.userPlanId);
        if (mediaPlan !== folderPlan) return res.status(400).json({ success: false, message: 'Folder must be on same drive' });
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

// Get presigned URL for upload. Path: userId → drive → folder → file (Backblaze B2)
router.post('/upload-url', [
  body('fileName').notEmpty().withMessage('File name is required'),
  body('mimeType').notEmpty().withMessage('MIME type is required'),
  body('size').isNumeric().withMessage('Size is required'),
  body('userPlanId').optional(),
  body('folderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { fileName, mimeType, size, userPlanId, folderId } = req.body;
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

    const result = await generateUploadURL(fileName, mimeType, userId, userPlanId || null, folderId || null);

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

// Direct upload to Backblaze (no local file write) - FormData: media, userPlanId, folderId
router.post('/upload', uploadMulterMemory.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const userId = req.user.id;
    console.log('Upload: file=', req.file.originalname, 'size=', req.file.size, 'userId=', userId);
    const { userPlanId, folderId } = req.body || {};
    const sizeNum = req.file.size;
    const sizeInGB = sizeNum / (1024 * 1024 * 1024);

    let folderIdValue = null;
    if (folderId) {
      const folder = await Folder.findOne({ where: { id: parseInt(folderId, 10), userId } });
      if (folder) folderIdValue = folder.id;
    }

    const driveSlug = getDriveSlug(userPlanId);
    const folderSlug = getFolderSlug(folderIdValue);

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
      let storage = await Storage.findOne({ where: { userId } });
      if (!storage) {
        storage = await Storage.create({ userId, totalStorage: 1, usedStorage: 0, availableStorage: 1 });
      }
      if (parseFloat(storage.availableStorage) < sizeInGB) {
        return res.status(400).json({ success: false, message: 'Insufficient storage space' });
      }
    }

    if (!isS3Configured()) {
      return res.status(503).json({
        success: false,
        message: 'Backblaze B2 not configured. Set S3_ENDPOINT, BACKBLAZE_KEY_ID, BACKBLAZE_APPLICATION_KEY, and S3_BUCKET_NAME in server .env.',
      });
    }

    if (!req.file.buffer) {
      return res.status(400).json({ success: false, message: 'No file buffer received' });
    }

    // Create a stable object name (so the S3 key has an extension).
    const originalname = req.file.originalname || 'file';
    const ext = (path.extname(originalname) || '').toLowerCase();
    const base = (path.basename(originalname, ext) || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = `${Date.now()}-${base}${ext || ''}`;

    const filePath = `${userId}/${driveSlug}/${folderSlug}/${finalName}`;
    const fullS3Key = `uploads/${filePath}`;
    let url;
    try {
      url = await uploadBufferToS3(fullS3Key, req.file.buffer, req.file.mimetype);
    } catch (s3Err) {
      const code = s3Err.name || s3Err.Code;
      const detail = s3Err.message || s3Err.Message || '';
      console.error('Backblaze upload error:', code, detail, s3Err);

      const isInvalidKey = (code === 'InvalidAccessKeyId' || String(detail).includes('Malformed Access Key') || String(detail).includes('is not valid'));
      const isNetwork = (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || String(detail).includes('ENOTFOUND') || String(detail).includes('getaddrinfo'));

      let message = 'Upload to Backblaze B2 failed.';
      if (isNetwork) message = 'Cannot reach Backblaze. Check S3_ENDPOINT in .env and network.';
      else if (isInvalidKey) message = 'Backblaze key invalid. Use an Application Key (not Master) from B2 Console. In .env set BACKBLAZE_KEY_ID and BACKBLAZE_APPLICATION_KEY="K005..." (with quotes if key has +). Restart server.';
      else message += ' Check S3_ENDPOINT, BACKBLAZE_KEY_ID, BACKBLAZE_APPLICATION_KEY, S3_BUCKET_NAME in server .env.';

      return res.status(500).json({
        success: false,
        message,
        error: code ? `${code}: ${detail}` : detail,
      });
    }

    const media = await Media.create({
      userId,
      userPlanId: planIdToSet,
      folderId: folderIdValue,
      name: req.file.originalname,
      url,
      s3Key: fullS3Key,
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
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) { }
    console.error('Media upload error:', error);
    const isDbError = error.name === 'SequelizeConnectionError' || error.original?.code === 'ECONNRESET' || error.original?.code === 'ETIMEDOUT' || (error.message && /ECONNRESET|ETIMEDOUT|connect/i.test(error.message));
    if (isDbError) {
      return res.status(503).json({ success: false, message: 'Database unavailable. Try again later.' });
    }
    const msg = error.message || 'Server error';
    res.status(500).json({ success: false, message: msg, error: error.message });
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

    // Delete file: local disk if url starts with /upload/, else Backblaze B2
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
          const folderIdNum = Number(folder.id);
          if (pid === folderIdNum) return res.status(400).json({ success: false, message: 'Folder cannot be its own parent' });
          const parent = await Folder.findOne({ where: { id: pid, userId } });
          if (!parent) return res.status(400).json({ success: false, message: 'Parent folder not found' });
          // Reject if new parent is the folder we're moving or any of its descendants (would create a cycle)
          let check = parent;
          while (check) {
            if (Number(check.id) === folderIdNum) return res.status(400).json({ success: false, message: 'Cannot move folder inside its own descendant' });
            if (check.parentFolderId == null) break;
            if (Number(check.parentFolderId) === folderIdNum) return res.status(400).json({ success: false, message: 'Cannot move folder inside its own descendant' });
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
