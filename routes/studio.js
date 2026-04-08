

const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { fn, col } = require('sequelize');
const { StudioClient, Media, Storage, FundRequest, User, StoragePlan, UserStoragePlan, Folder, Share } = require('../models');
const { authMiddleware, studioMiddleware } = require('../middleware/auth');
const {
  generateUploadURL,
  deleteFile,
  uploadBufferToS3,
  isS3Configured,
  buildS3Key,
  createMultipartUpload,
  uploadMultipartPart,
  completeMultipartUpload,
  abortMultipartUpload,
  getObjectPublicUrl,
  presignExistingObject,
} = require('../services/s3Service');
const { getCommissionPerGB } = require('../services/commissionService');
const { fulfillPurchasePlanForClient } = require('../services/studioClientPlanPurchase');
const { getBankDetails, setBankDetails } = require('../services/studioBankService');
const { sendStudioRegistrationPendingEmail } = require('../services/studioEmailService');
const { deleteFolderCascadeForUser, getDescendantFolderIds } = require('../services/folderDeleteService');
const router = express.Router();

const BYTES_PER_GB = 1024 * 1024 * 1024;

/** Private B2 buckets do not allow anonymous GET on s3.*.backblazeb2.com URLs — use presigned URLs in API responses. */
const B2_VIEW_URL_TTL = parseInt(process.env.B2_VIEW_URL_TTL_SECONDS || '86400', 10);

async function signMediaForResponse(m) {
  if (!m) return null;
  const plain = typeof m.toJSON === 'function' ? m.toJSON() : (m.get ? m.get({ plain: true }) : { ...m });
  if (isS3Configured()) {
    try {
      const signed = await presignExistingObject(plain, B2_VIEW_URL_TTL);
      if (signed) plain.url = signed;
    } catch (e) {
      console.error('signMediaForResponse:', e.message);
    }
  }
  return plain;
}

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const studioChunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** Chunked studio uploads: parts go straight to Backblaze via S3 multipart (no local disk). */
const studioMultipartSessions = new Map();
const STUDIO_SESSION_TTL_MS = parseInt(process.env.STUDIO_UPLOAD_SESSION_TTL_MS || String(24 * 60 * 60 * 1000), 10);

function sanitizeClientUploadId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 160);
}

async function cleanupStudioMultipartSession(clientUploadId) {
  const sid = sanitizeClientUploadId(clientUploadId);
  const s = studioMultipartSessions.get(sid);
  if (!s) return;
  if (s.s3Key && s.awsUploadId) {
    await abortMultipartUpload(s.s3Key, s.awsUploadId);
  }
  studioMultipartSessions.delete(sid);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of studioMultipartSessions.entries()) {
    if (sess.createdAt && now - sess.createdAt > STUDIO_SESSION_TTL_MS) {
      cleanupStudioMultipartSession(id).catch(() => {});
    }
  }
}, 60 * 60 * 1000);

/** Avoid duplicate B2 multipart sessions when two chunks arrive in parallel. */
const studioSessionCreateLocks = new Map();

/** Quota check before writing to B2 (avoids orphan objects). */
async function validateStudioUploadEligibility({ clientUserId, fileSize, userPlanId }) {
  const sizeInGB = fileSize / (1024 * 1024 * 1024);
  if (userPlanId) {
    const plan = await UserStoragePlan.findOne({ where: { id: parseInt(userPlanId, 10), userId: clientUserId } });
    if (!plan) return { error: { status: 400, message: 'Invalid user plan for this client' } };
    const totalBytes = (parseFloat(plan.totalStorage) || 0) * (1024 * 1024 * 1024);
    const usedBytes = Number(plan.usedStorage) || 0;
    if (usedBytes + fileSize > totalBytes) return { error: { status: 400, message: 'Insufficient space in this drive' } };
  } else {
    const storage = await Storage.findOne({ where: { userId: clientUserId } });
    if (!storage || parseFloat(storage.availableStorage) < sizeInGB) {
      return { error: { status: 400, message: 'Insufficient storage space' } };
    }
  }
  return { ok: true };
}

async function saveStudioMediaAndStorage({ studioUserId, clientUserId, fileName, mimeType, fileSize, userPlanId, folderId, s3Key, url }) {
  const sizeInGB = fileSize / (1024 * 1024 * 1024);
  let folderIdValue = null;
  if (folderId) {
    const folder = await Folder.findOne({ where: { id: parseInt(folderId, 10), userId: clientUserId } });
    if (folder) folderIdValue = folder.id;
  }

  let planIdToSet = null;
  let planStorage = null;
  if (userPlanId) {
    const plan = await UserStoragePlan.findOne({ where: { id: parseInt(userPlanId, 10), userId: clientUserId } });
    if (!plan) return { error: { status: 400, message: 'Invalid user plan for this client' } };

    const totalBytes = (parseFloat(plan.totalStorage) || 0) * (1024 * 1024 * 1024);
    const usedBytes = Number(plan.usedStorage) || 0;
    if (usedBytes + fileSize > totalBytes) return { error: { status: 400, message: 'Insufficient space in this drive' } };

    planIdToSet = plan.id;
  } else {
    const storage = await Storage.findOne({ where: { userId: clientUserId } });
    if (!storage || parseFloat(storage.availableStorage) < sizeInGB) {
      return { error: { status: 400, message: 'Insufficient storage space' } };
    }
  }

  const media = await Media.create({
    userId: clientUserId,
    userPlanId: planIdToSet,
    folderId: folderIdValue,
    name: fileName,
    url,
    s3Key,
    mimeType,
    size: fileSize,
    category: mimeType.startsWith('video/') ? 'video' : 'image',
  });

  if (planIdToSet) {
    const plan = await UserStoragePlan.findByPk(planIdToSet);
    if (plan) {
      const sumRows = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'totalBytes']],
        where: { userId: clientUserId, userPlanId: plan.id },
        raw: true,
      });
      const usedBytes = Math.max(0, Number(sumRows[0]?.totalBytes) || 0);
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
  } else {
    let storage = await Storage.findOne({ where: { userId: clientUserId } });
    if (!storage) storage = await Storage.create({ userId: clientUserId, totalStorage: 0, usedStorage: 0, availableStorage: 0 });
    const newUsed = parseFloat(storage.usedStorage) + sizeInGB;
    await storage.update({
      usedStorage: newUsed,
      availableStorage: parseFloat(storage.totalStorage) - newUsed,
    });
  }

  const commissionPerGB = await getCommissionPerGB();
  if (commissionPerGB > 0 && studioUserId) {
    const studio = await User.findByPk(studioUserId);
    if (studio) {
      const current = parseFloat(studio.earnings) || 0;
      studio.earnings = current + (sizeInGB * commissionPerGB);
      await studio.save();
    }
  }
  return { media, planStorage };
}

// Upload media for client (Backblaze B2 direct upload, no local file storage)
router.post('/clients/:clientId/uploadMedia', authMiddleware, studioMiddleware, upload.single('media'), async (req, res) => {
  try {
    if (!isS3Configured()) return res.status(503).json({ success: false, message: 'Backblaze B2 not configured' });
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, message: 'No media file' });
    const { clientId } = req.params;
    const { userPlanId, folderId } = req.body;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId: req.user.id } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const pre = await validateStudioUploadEligibility({
      clientUserId: client.userId,
      fileSize: req.file.size,
      userPlanId: userPlanId || null,
    });
    if (pre.error) return res.status(pre.error.status).json({ success: false, message: pre.error.message });

    const uploadMeta = await generateUploadURL(
      req.file.originalname,
      req.file.mimetype || 'application/octet-stream',
      client.userId,
      userPlanId || null,
      folderId || null
    );
    try {
      await uploadBufferToS3(uploadMeta.s3Key, req.file.buffer, req.file.mimetype);
    } catch (e) {
      try { await deleteFile(uploadMeta.s3Key); } catch (_) { }
      throw e;
    }
    const saved = await saveStudioMediaAndStorage({
      studioUserId: req.user.id,
      clientUserId: client.userId,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype || 'application/octet-stream',
      fileSize: req.file.size,
      userPlanId: userPlanId || null,
      folderId: folderId || null,
      s3Key: uploadMeta.s3Key,
      url: uploadMeta.url,
    });
    if (saved.error) {
      try { await deleteFile(uploadMeta.s3Key); } catch (_) { }
      return res.status(saved.error.status).json({ success: false, message: saved.error.message });
    }
    const mediaOut = await signMediaForResponse(saved.media);
    res.json({ success: true, media: mediaOut, planStorage: saved.planStorage });
  } catch (error) {
    console.error('Upload media error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/clients/:clientId/chunk-upload-status', authMiddleware, studioMiddleware, async (req, res) => {
  const { clientId } = req.params;
  const uploadId = (req.query.uploadId || '').trim();
  const empty = () => res.json({ uploadId: uploadId || '', receivedChunks: [], totalChunks: null, meta: null });
  if (!uploadId) return res.status(400).json({ success: false, message: 'uploadId required' });
  const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId: req.user.id } });
  if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
  try {
    const sid = sanitizeClientUploadId(uploadId);
    const session = studioMultipartSessions.get(sid);
    if (!session || session.clientId !== client.id || session.studioUserId !== req.user.id) return empty();
    const receivedChunks = [...session.receivedIndices].sort((a, b) => a - b);
    const m = session.meta;
    return res.json({
      uploadId,
      receivedChunks,
      totalChunks: session.totalChunks,
      meta: m ? { fileName: m.fileName, fileSize: m.fileSize, mimeType: m.mimeType } : null,
    });
  } catch (_) {
    return empty();
  }
});

router.post('/clients/:clientId/upload-chunk', authMiddleware, studioMiddleware, studioChunkUpload.single('chunk'), async (req, res) => {
  try {
    if (!isS3Configured()) return res.status(503).json({ success: false, message: 'Backblaze B2 not configured' });
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, message: 'No chunk file' });
    const { clientId } = req.params;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId: req.user.id } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const { uploadId, chunkIndex, totalChunks, fileName, fileSize, mimeType, userPlanId, folderId } = req.body || {};
    if (!uploadId || chunkIndex === undefined || totalChunks === undefined) {
      return res.status(400).json({ success: false, message: 'uploadId, chunkIndex, totalChunks required' });
    }
    const idx = parseInt(chunkIndex, 10);
    const total = parseInt(totalChunks, 10);
    if (Number.isNaN(idx) || Number.isNaN(total) || idx < 0 || total < 1 || idx >= total) {
      return res.status(400).json({ success: false, message: 'Invalid chunkIndex or totalChunks' });
    }

    const sid = sanitizeClientUploadId(uploadId);

    const initSession = async () => {
      const safeName = (fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const fsz = parseInt(fileSize, 10) || 0;
      const up = userPlanId != null && userPlanId !== '' ? userPlanId : null;
      const fd = folderId != null && folderId !== '' ? folderId : null;

      const quota = await validateStudioUploadEligibility({
        clientUserId: client.userId,
        fileSize: fsz,
        userPlanId: up,
      });
      if (quota.error) {
        const err = new Error(quota.error.message);
        err.status = quota.error.status;
        throw err;
      }

      const s3Key = buildS3Key(client.userId, up, fd, safeName);
      const mime = mimeType || 'application/octet-stream';
      const awsUploadId = await createMultipartUpload(s3Key, mime);

      const session = {
        createdAt: Date.now(),
        studioUserId: req.user.id,
        clientId: client.id,
        clientUserId: client.userId,
        s3Key,
        awsUploadId,
        totalChunks: total,
        meta: {
          fileName: safeName,
          fileSize: fsz,
          mimeType: mime,
          userPlanId: up != null ? String(up) : null,
          folderId: fd != null ? String(fd) : null,
        },
        partsByNumber: new Map(),
        receivedIndices: new Set(),
      };
      studioMultipartSessions.set(sid, session);
      return session;
    };

    let session = studioMultipartSessions.get(sid);
    if (!session) {
      if (!studioSessionCreateLocks.has(sid)) {
        studioSessionCreateLocks.set(sid, initSession());
      }
      try {
        await studioSessionCreateLocks.get(sid);
      } catch (e) {
        studioSessionCreateLocks.delete(sid);
        const status = e.status || 500;
        return res.status(status).json({ success: false, message: e.message || 'Upload init failed' });
      }
      studioSessionCreateLocks.delete(sid);
      session = studioMultipartSessions.get(sid);
    }

    if (!session) {
      return res.status(500).json({ success: false, message: 'Could not start multipart upload' });
    }
    if (session.studioUserId !== req.user.id || session.clientId !== client.id) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    if (session.totalChunks !== total) {
      return res.status(400).json({ success: false, message: 'totalChunks mismatch' });
    }

    const partNumber = idx + 1;
    const partInfo = await uploadMultipartPart(session.s3Key, session.awsUploadId, partNumber, req.file.buffer);
    session.partsByNumber.set(partNumber, partInfo);
    session.receivedIndices.add(idx);

    return res.json({ success: true, chunkIndex: idx, totalChunks: total });
  } catch (err) {
    console.error('Studio upload chunk error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.post('/clients/:clientId/complete-chunked-upload', authMiddleware, studioMiddleware, [
  body('uploadId').notEmpty().withMessage('uploadId required'),
], async (req, res) => {
  try {
    if (!isS3Configured()) return res.status(503).json({ success: false, message: 'Backblaze B2 not configured' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { clientId } = req.params;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId: req.user.id } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const { uploadId } = req.body;
    const sid = sanitizeClientUploadId(uploadId);
    const session = studioMultipartSessions.get(sid);
    if (!session || session.clientId !== client.id) {
      return res.status(404).json({ success: false, message: 'Chunk upload not found or incomplete' });
    }
    if (session.studioUserId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const meta = session.meta;
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.receivedIndices.has(i)) {
        return res.status(400).json({ success: false, message: `Missing chunk ${i}` });
      }
    }

    const quota = await validateStudioUploadEligibility({
      clientUserId: client.userId,
      fileSize: meta.fileSize || 0,
      userPlanId: meta.userPlanId || null,
    });
    if (quota.error) return res.status(quota.error.status).json({ success: false, message: quota.error.message });

    const parts = [];
    for (let p = 1; p <= session.totalChunks; p++) {
      const pi = session.partsByNumber.get(p);
      if (!pi) return res.status(400).json({ success: false, message: `Missing multipart part ${p}` });
      parts.push(pi);
    }

    try {
      await completeMultipartUpload(session.s3Key, session.awsUploadId, parts);
    } catch (e) {
      console.error('completeMultipartUpload:', e);
      try {
        await abortMultipartUpload(session.s3Key, session.awsUploadId);
      } catch (_) { }
      studioMultipartSessions.delete(sid);
      return res.status(500).json({ success: false, message: e.message || 'Failed to finalize upload' });
    }

    const publicRefUrl = getObjectPublicUrl(session.s3Key);
    const saved = await saveStudioMediaAndStorage({
      studioUserId: req.user.id,
      clientUserId: client.userId,
      fileName: meta.fileName,
      mimeType: meta.mimeType || 'application/octet-stream',
      fileSize: meta.fileSize || 0,
      userPlanId: meta.userPlanId || null,
      folderId: meta.folderId || null,
      s3Key: session.s3Key,
      url: publicRefUrl,
    });
    if (saved.error) {
      try { await deleteFile(session.s3Key); } catch (_) { }
      await cleanupStudioMultipartSession(uploadId);
      return res.status(saved.error.status).json({ success: false, message: saved.error.message });
    }

    studioMultipartSessions.delete(sid);
    const mediaOut = await signMediaForResponse(saved.media);
    res.json({ success: true, media: mediaOut, planStorage: saved.planStorage });
  } catch (err) {
    console.error('Studio complete chunked upload error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

router.post('/clients/:clientId/abort-chunked-upload', authMiddleware, studioMiddleware, [
  body('uploadId').notEmpty().withMessage('uploadId required'),
], async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId: req.user.id } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const { uploadId } = req.body;
    const sid = sanitizeClientUploadId(uploadId);
    const session = studioMultipartSessions.get(sid);
    if (session && (session.studioUserId !== req.user.id || session.clientId !== client.id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    await cleanupStudioMultipartSession(uploadId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});




// ...existing code...




// Get folders for a client (by drive + parent). Requires studio auth; verifies studio owns client.
router.get('/clients/getFolders', authMiddleware, studioMiddleware, async (req, res) => {
  try {
    const { userPlanId, clientId, parentFolderId } = req.query;
    if (userPlanId === undefined || userPlanId === null || userPlanId === '') {
      return res.status(400).json({ success: false, message: 'userPlanId is required' });
    }
    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId, 10), studioId: req.user.id },
    });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const where = { userId: client.userId };
    if (userPlanId !== 'default') {
      const pid = parseInt(userPlanId, 10);
      if (!Number.isNaN(pid)) where.userPlanId = pid;
    } else {
      where.userPlanId = null;
    }
    if (parentFolderId !== undefined) {
      if (parentFolderId === '' || parentFolderId === 'null') {
        where.parentFolderId = null;
      } else {
        const p = parseInt(parentFolderId, 10);
        if (!Number.isNaN(p)) where.parentFolderId = p;
      }
    }

    const folders = await Folder.findAll({
      where,
      order: [['name', 'ASC'], ['createdAt', 'DESC']],
    });
    res.json({ success: true, folders });
  } catch (error) {
    console.error('Fetch folders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create folder for a client (drive + optional parent folder)
router.post('/clients/:clientId/folders', authMiddleware, studioMiddleware, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, userPlanId, parentFolderId } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Folder name is required' });
    }
    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId, 10), studioId: req.user.id },
    });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    let resolvedPlanId = null;
    if (userPlanId !== undefined && userPlanId !== null && userPlanId !== '' && userPlanId !== 'default') {
      const plan = await UserStoragePlan.findOne({
        where: { id: parseInt(userPlanId, 10), userId: client.userId },
      });
      if (!plan) return res.status(400).json({ success: false, message: 'Invalid userPlanId for this client' });
      resolvedPlanId = plan.id;
    }

    let parentFolderIdValue = null;
    const rawParent = parentFolderId ?? req.body.parentId;
    if (rawParent !== undefined && rawParent !== null && rawParent !== '' && rawParent !== 'null') {
      const pid = parseInt(rawParent, 10);
      if (!Number.isNaN(pid)) {
        const parent = await Folder.findOne({ where: { id: pid, userId: client.userId } });
        if (!parent) return res.status(400).json({ success: false, message: 'Parent folder not found' });
        parentFolderIdValue = parent.id;
        if (resolvedPlanId === null && parent.userPlanId !== null) resolvedPlanId = parent.userPlanId;
        if (resolvedPlanId !== null && parent.userPlanId !== null && parent.userPlanId !== resolvedPlanId) {
          return res.status(400).json({ success: false, message: 'Parent folder must be on the same drive' });
        }
      }
    }

    const folder = await Folder.create({
      userId: client.userId,
      name: name.trim(),
      userPlanId: resolvedPlanId,
      parentFolderId: parentFolderIdValue,
    });
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete folder (cascade: nested folders + media) — same behavior as user panel
router.delete('/clients/:clientId/folders/:folderId', authMiddleware, studioMiddleware, async (req, res) => {
  try {
    const { clientId, folderId } = req.params;
    const folderIdNum = parseInt(folderId, 10);
    if (Number.isNaN(folderIdNum)) {
      return res.status(400).json({ success: false, message: 'Invalid folder id' });
    }
    const client = await StudioClient.findOne({
      where: { id: parseInt(clientId, 10), studioId: req.user.id },
    });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const folder = await Folder.findOne({ where: { id: folderIdNum, userId: client.userId } });
    if (!folder) return res.status(404).json({ success: false, message: 'Folder not found' });

    const stats = await deleteFolderCascadeForUser(client.userId, folderIdNum);
    res.json({
      success: true,
      deletedFolders: stats.deletedFolders,
      deletedMedia: stats.deletedMedia,
    });
  } catch (error) {
    console.error('Studio delete folder error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
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

    // Check duplicates by email or mobile (only include mobile in OR when provided — undefined breaks Sequelize/MySQL OR)
    const orConditions = [{ email }];
    if (mobile != null && String(mobile).trim() !== '') {
      orConditions.push({ mobile: String(mobile).trim() });
    }
    const existing = await User.findOne({ where: { [Op.or]: orConditions } });
    if (existing) return res.status(400).json({ success: false, message: 'Email or mobile already used' });

    const studio = await User.create({
      email,
      name,
      mobile: mobile != null && String(mobile).trim() !== '' ? String(mobile).trim() : null,
      password,
      userType: 'studio',
      isActive: false,
      city,
      address,
      pincode,
    });

    let emailSent = false;
    let emailNotice = null;
    try {
      const mailResult = await sendStudioRegistrationPendingEmail({
        toEmail: email,
        name: studio.name || name,
        studioId: studio.id,
      });
      emailSent = !!mailResult.success;
      if (!mailResult.success) {
        emailNotice = mailResult.message || 'Email could not be sent (check SMTP in .env).';
        console.warn('Studio registration email:', emailNotice);
      }
    } catch (mailErr) {
      console.error('Studio registration email error:', mailErr);
      emailNotice = 'Registration saved, but confirmation email failed.';
    }

    return res.json({
      success: true,
      studio,
      emailSent,
      ...(emailNotice ? { message: emailNotice } : {}),
    });
  } catch (error) {
    console.error('Studio registration error:', error);
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: error.errors?.map((e) => ({ field: e.path, message: e.message })) || [],
      });
    }
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ success: false, message: 'Email or mobile already used' });
    }
    const sqlMsg = error.parent?.sqlMessage || error.original?.sqlMessage;
    const hint =
      sqlMsg && /Data truncated|ENUM|userType/i.test(sqlMsg)
        ? 'If userType fails: run SQL to add studio to ENUM — see docs/FIX_USER_TYPE_ENUM.md'
        : undefined;
    const detail =
      process.env.NODE_ENV !== 'production' ? sqlMsg || error.message : undefined;
    res.status(500).json({
      success: false,
      message: 'Server error',
      ...(detail && { detail }),
      ...(hint && { hint }),
    });
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

// Get studio clients (optional server-side pagination: page, limit; search; sort=name_asc|name_desc|created_desc)
router.get('/clients', async (req, res) => {
  try {
    const studioId = req.user.id;
    const { search } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const sortKey = (req.query.sort || 'created_desc').toString();

    let where = { studioId };
    
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
      ];
    }

    let order = [['createdAt', 'DESC']];
    if (sortKey === 'name_asc') order = [['name', 'ASC']];
    else if (sortKey === 'name_desc') order = [['name', 'DESC']];
    else if (sortKey === 'created_asc') order = [['createdAt', 'ASC']];

    const count = await StudioClient.count({ where });
    const rows = await StudioClient.findAll({
      where,
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email', 'mobile'],
        required: false,
      }],
      order,
      limit,
      offset,
    });

    const legacy = req.query.legacy === '1';
    if (legacy) {
      return res.json(rows);
    }

    res.json({
      data: rows,
      total: count,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    });
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
    const includeMedia = req.query.includeMedia !== 'false';

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

    let media = [];
    if (includeMedia) {
      const mediaRows = await Media.findAll({
        where: { userId: client.userId },
        order: [['uploadDate', 'DESC']],
      });
      media = await Promise.all(mediaRows.map((row) => signMediaForResponse(row)));
    }
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

/** Paginated media for a client drive (list/grid). Default sort: uploadDate DESC. */
router.get('/clients/:clientId/media', authMiddleware, studioMiddleware, async (req, res) => {
  try {
    const clientIdNum = parseInt(req.params.clientId, 10);
    if (Number.isNaN(clientIdNum)) {
      return res.status(400).json({ success: false, message: 'Invalid client id' });
    }
    const studioId = req.user.id;
    const client = await StudioClient.findOne({ where: { id: clientIdNum, studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const userId = client.userId;
    const q = req.query;
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const sortDir = (q.sort === 'asc' || q.sortOrder === 'asc') ? 'ASC' : 'DESC';

    const where = { userId };

    if (q.userPlanId === 'default' || q.userPlanId === '' || q.userPlanId == null) {
      where.userPlanId = null;
    } else if (q.userPlanId !== undefined) {
      const planId = parseInt(q.userPlanId, 10);
      if (!Number.isNaN(planId)) where.userPlanId = planId;
    }

    if (q.category && ['video', 'image', 'document', 'other'].includes(q.category)) {
      where.category = q.category;
    }

    if (q.folderId === undefined || q.folderId === null || q.folderId === '' || q.folderId === 'null') {
      where.folderId = null;
    } else {
      const fid = parseInt(q.folderId, 10);
      if (!Number.isNaN(fid)) where.folderId = fid;
    }

    if (q.search && String(q.search).trim()) {
      where.name = { [Op.like]: `%${String(q.search).trim()}%` };
    }

    const now = new Date();
    if (q.datePreset === 'today') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      where.uploadDate = { [Op.gte]: start };
    } else if (q.datePreset === 'week') {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      where.uploadDate = { [Op.gte]: start };
    } else if (q.datePreset === 'month') {
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      where.uploadDate = { [Op.gte]: start };
    }

    const planCountWhere = { userId };
    if (q.userPlanId === 'default' || q.userPlanId === '' || q.userPlanId == null) {
      planCountWhere.userPlanId = null;
    } else if (q.userPlanId !== undefined) {
      const pid = parseInt(q.userPlanId, 10);
      if (!Number.isNaN(pid)) planCountWhere.userPlanId = pid;
    }
    const totalOnPlan = await Media.count({ where: planCountWhere });

    const total = await Media.count({ where });
    const rows = await Media.findAll({
      where,
      limit,
      offset,
      order: [['uploadDate', sortDir]],
      include: [{ model: Folder, as: 'folder', attributes: ['id', 'name'], required: false }],
    });
    const data = await Promise.all(rows.map((row) => signMediaForResponse(row)));

    res.json({
      success: true,
      data,
      total,
      totalOnPlan,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('Studio client media list error:', error);
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

// Update client media (rename and/or move within same drive) — studio
router.patch('/clients/:clientId/media/:mediaId', [
  body('name').optional().trim().notEmpty().withMessage('Media name cannot be empty'),
  body('folderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { clientId, mediaId } = req.params;
    const studioId = req.user.id;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const mediaIdNum = parseInt(mediaId, 10);
    if (Number.isNaN(mediaIdNum)) return res.status(400).json({ success: false, message: 'Invalid media id' });
    const media = await Media.findOne({ where: { id: mediaIdNum, userId: client.userId } });
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
          const folder = await Folder.findOne({ where: { id: fid, userId: client.userId } });
          if (!folder) return res.status(400).json({ success: false, message: 'Folder not found' });
          const mediaPlan = media.userPlanId == null ? null : Number(media.userPlanId);
          const folderPlan = folder.userPlanId == null ? null : Number(folder.userPlanId);
          if (mediaPlan !== folderPlan) return res.status(400).json({ success: false, message: 'Folder must be on same drive' });
          newFolderId = folder.id;
        }
      }
      updates.folderId = newFolderId;
    }
    if (Object.keys(updates).length === 0) {
      const out = await signMediaForResponse(media);
      return res.json(out);
    }
    const [affectedRows] = await Media.update(updates, { where: { id: mediaIdNum, userId: client.userId } });
    if (affectedRows === 0) return res.status(404).json({ success: false, message: 'Media not found' });
    const updated = await Media.findOne({
      where: { id: mediaIdNum, userId: client.userId },
      include: [{ model: Folder, as: 'folder', attributes: ['id', 'name'], required: false }],
    });
    const out = await signMediaForResponse(updated);
    res.json(out);
  } catch (error) {
    console.error('Update client media error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Copy client media to another folder on the same drive (new DB row, same file key)
router.post('/clients/:clientId/media/:mediaId/copy', [
  body('folderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { clientId, mediaId } = req.params;
    const studioId = req.user.id;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const userId = client.userId;
    const media = await Media.findOne({ where: { id: parseInt(mediaId, 10), userId } });
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

    const copyWithFolder = await Media.findOne({
      where: { id: copy.id, userId },
      include: [{ model: Folder, as: 'folder', attributes: ['id', 'name'], required: false }],
    });
    const out = await signMediaForResponse(copyWithFolder);
    res.status(201).json(out);
  } catch (error) {
    console.error('Copy client media error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Create share link for client's folder, file, or drive (same public /share/:token as user panel; nested folder contents are browsable)
router.post('/clients/:clientId/share', [
  body('resourceType').isIn(['folder', 'media', 'drive']).withMessage('resourceType must be folder, media, or drive'),
  body('resourceId').isInt({ min: 0 }).withMessage('resourceId is required (0 for default drive)'),
  body('expiresInDays').optional().isInt({ min: 1, max: 365 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { clientId } = req.params;
    const studioId = req.user.id;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const userId = client.userId;

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
    console.error('Studio create share error:', error);
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

    const periodType = period === 'year' ? 'year' : 'month';
    try {
      const { plan, userPlan, added } = await fulfillPurchasePlanForClient({
        clientUserId: client.userId,
        planId,
        requestedStorage,
        period: periodType,
        studioId,
      });
      return res.json({ success: true, plan, userPlan, added });
    } catch (e) {
      if (e.statusCode === 404) return res.status(404).json({ success: false, message: e.message });
      if (e.statusCode === 400) return res.status(400).json({ success: false, message: e.message });
      throw e;
    }
  } catch (error) {
    console.error('Purchase plan for client error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Move media from one plan (drive) to another for the same client. Optional mediaIds = move only selected.
// Optional toFolderId: destination folder on target drive (must belong to toUserPlanId). Omit/null = drive root.
router.post('/clients/:clientId/move-media', [
  body('fromUserPlanId').isInt().withMessage('Source plan ID is required'),
  body('toUserPlanId').isInt().withMessage('Destination plan ID is required'),
  body('mediaIds').optional().isArray().withMessage('mediaIds must be an array'),
  body('toFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { clientId } = req.params;
    const studioId = req.user.id;
    const { fromUserPlanId, toUserPlanId, mediaIds: requestedMediaIds, toFolderId: rawToFolderId } = req.body;

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

    let newFolderId = null;
    if (rawToFolderId !== undefined && rawToFolderId !== null && rawToFolderId !== '' && rawToFolderId !== 'null') {
      const fid = parseInt(rawToFolderId, 10);
      if (Number.isNaN(fid)) {
        return res.status(400).json({ success: false, message: 'Invalid toFolderId' });
      }
      const destFolder = await Folder.findOne({
        where: { id: fid, userId: client.userId, userPlanId: toPlan.id },
      });
      if (!destFolder) {
        return res.status(400).json({ success: false, message: 'Destination folder not found on the target drive' });
      }
      newFolderId = destFolder.id;
    }

    const where = { userId: client.userId, userPlanId: fromPlan.id };
    if (Array.isArray(requestedMediaIds) && requestedMediaIds.length > 0) {
      where.id = { [Op.in]: requestedMediaIds.map((id) => parseInt(id, 10)) };
    }

    const moved = await Media.update(
      { userPlanId: toPlan.id, folderId: newFolderId },
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

// Copy media between drives or duplicate to another folder on the same drive (when fromUserPlanId === toUserPlanId and mediaIds provided).
router.post('/clients/:clientId/copy-media', [
  body('fromUserPlanId').isInt().withMessage('Source plan ID is required'),
  body('toUserPlanId').isInt().withMessage('Destination plan ID is required'),
  body('mediaIds').optional().isArray().withMessage('mediaIds must be an array'),
  body('toFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { clientId } = req.params;
    const studioId = req.user.id;
    const { fromUserPlanId, toUserPlanId, mediaIds: requestedMediaIds, toFolderId: rawToFolderId } = req.body;

    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const userId = client.userId;

    const fromPlan = await UserStoragePlan.findOne({ where: { id: parseInt(fromUserPlanId, 10), userId } });
    const toPlan = await UserStoragePlan.findOne({ where: { id: parseInt(toUserPlanId, 10), userId } });
    if (!fromPlan) return res.status(404).json({ success: false, message: 'Source plan not found' });
    if (!toPlan) return res.status(404).json({ success: false, message: 'Destination plan not found' });

    let newFolderId = null;
    if (rawToFolderId !== undefined && rawToFolderId !== null && rawToFolderId !== '' && rawToFolderId !== 'null') {
      const fid = parseInt(rawToFolderId, 10);
      if (Number.isNaN(fid)) {
        return res.status(400).json({ success: false, message: 'Invalid toFolderId' });
      }
      const destFolder = await Folder.findOne({
        where: { id: fid, userId, userPlanId: toPlan.id },
      });
      if (!destFolder) {
        return res.status(400).json({ success: false, message: 'Destination folder not found on the target drive' });
      }
      newFolderId = destFolder.id;
    }

    const sameDrive = Number(fromUserPlanId) === Number(toUserPlanId);
    const mediaIds = Array.isArray(requestedMediaIds)
      ? requestedMediaIds.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id))
      : [];

    if (sameDrive) {
      if (mediaIds.length === 0) {
        return res.status(400).json({ success: false, message: 'mediaIds required when copying on the same drive' });
      }
      let copied = 0;
      for (const mid of mediaIds) {
        const m = await Media.findOne({
          where: { id: mid, userId, userPlanId: fromPlan.id },
        });
        if (!m) continue;
        await Media.create({
          userId,
          name: m.name,
          url: m.url,
          s3Key: m.s3Key,
          category: m.category,
          size: m.size,
          mimeType: m.mimeType,
          folderId: newFolderId,
          userPlanId: toPlan.id,
          uploadedBy: m.uploadedBy,
        });
        copied++;
      }
      const sum = await Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: toPlan.id },
        raw: true,
      });
      const used = Math.max(0, Number(sum[0]?.total) || 0);
      await toPlan.update({ usedStorage: used });
      return res.json({ success: true, copiedCount: copied, toPlan: toPlan.id });
    }

    if (mediaIds.length === 0) {
      return res.status(400).json({ success: false, message: 'mediaIds required for cross-drive copy' });
    }

    let copied = 0;
    for (const mid of mediaIds) {
      const m = await Media.findOne({
        where: { id: mid, userId, userPlanId: fromPlan.id },
      });
      if (!m) continue;
      await Media.create({
        userId,
        name: m.name,
        url: m.url,
        s3Key: m.s3Key,
        category: m.category,
        size: m.size,
        mimeType: m.mimeType,
        folderId: newFolderId,
        userPlanId: toPlan.id,
        uploadedBy: m.uploadedBy,
      });
      copied++;
    }

    const [fromSum, toSum] = await Promise.all([
      Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: fromPlan.id },
        raw: true,
      }),
      Media.findAll({
        attributes: [[fn('SUM', col('size')), 'total']],
        where: { userId, userPlanId: toPlan.id },
        raw: true,
      }),
    ]);
    await fromPlan.update({ usedStorage: Math.max(0, Number(fromSum[0]?.total) || 0) });
    await toPlan.update({ usedStorage: Math.max(0, Number(toSum[0]?.total) || 0) });

    res.json({ success: true, copiedCount: copied, fromPlan: fromPlan.id, toPlan: toPlan.id });
  } catch (error) {
    console.error('Studio copy media error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Update folder (rename / reparent within same drive)
router.patch('/clients/:clientId/folders/:folderId', [
  body('name').optional().trim().notEmpty().withMessage('Folder name cannot be empty'),
  body('parentFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { clientId, folderId } = req.params;
    const studioId = req.user.id;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const userId = client.userId;
    const folderIdNum = parseInt(folderId, 10);
    if (Number.isNaN(folderIdNum)) return res.status(400).json({ success: false, message: 'Invalid folder id' });

    const folder = await Folder.findOne({ where: { id: folderIdNum, userId } });
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
          const folderIdInner = Number(folder.id);
          if (pid === folderIdInner) return res.status(400).json({ success: false, message: 'Folder cannot be its own parent' });
          const parent = await Folder.findOne({ where: { id: pid, userId } });
          if (!parent) return res.status(400).json({ success: false, message: 'Parent folder not found' });
          const folderPlan = folder.userPlanId == null ? null : Number(folder.userPlanId);
          const parentPlan = parent.userPlanId == null ? null : Number(parent.userPlanId);
          if (folderPlan !== parentPlan) {
            return res.status(400).json({ success: false, message: 'Parent must be on the same drive' });
          }
          let check = parent;
          while (check) {
            if (Number(check.id) === folderIdInner) {
              return res.status(400).json({ success: false, message: 'Cannot move folder inside its own descendant' });
            }
            if (check.parentFolderId == null) break;
            if (Number(check.parentFolderId) === folderIdInner) {
              return res.status(400).json({ success: false, message: 'Cannot move folder inside its own descendant' });
            }
            check = await Folder.findOne({ where: { id: check.parentFolderId, userId } });
          }
          newParentId = parent.id;
        }
      }
      folder.parentFolderId = newParentId;
    }
    await folder.save();
    res.json({ success: true, folder });
  } catch (error) {
    console.error('Studio update folder error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Move folder tree to another drive (flattened under one new folder on destination). Same behavior as user /media/folders/:id/move-to-drive
router.post('/clients/:clientId/folders/:folderId/move-to-drive', [
  body('toUserPlanId').notEmpty().withMessage('Destination drive is required'),
  body('toFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { clientId, folderId } = req.params;
    const studioId = req.user.id;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const userId = client.userId;

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
      if (storage) {
        await storage.update({
          usedStorage: usedGB,
          availableStorage: Math.max(0, parseFloat(storage.totalStorage) - usedGB),
        });
      }
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
      if (storage) {
        await storage.update({
          usedStorage: usedGB,
          availableStorage: Math.max(0, parseFloat(storage.totalStorage) - usedGB),
        });
      }
    }

    const toDelete = folderIds.slice().sort((a, b) => b - a);
    for (const fid of toDelete) {
      await Media.update({ folderId: null }, { where: { folderId: fid, userId } });
      const f = await Folder.findByPk(fid);
      if (f) await f.destroy();
    }

    res.json({ success: true, targetFolderId: targetFolder.id, movedMediaCount: mediaInTree.length });
  } catch (error) {
    console.error('Studio move folder to drive error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// Copy folder tree to another drive (new folder + duplicate media rows). Same as user /media/folders/:id/copy-to-drive
router.post('/clients/:clientId/folders/:folderId/copy-to-drive', [
  body('toUserPlanId').notEmpty().withMessage('Destination drive is required'),
  body('toFolderId').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { clientId, folderId } = req.params;
    const studioId = req.user.id;
    const client = await StudioClient.findOne({ where: { id: parseInt(clientId, 10), studioId } });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const userId = client.userId;

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
      if (storage) {
        await storage.update({
          usedStorage: usedGB,
          availableStorage: Math.max(0, parseFloat(storage.totalStorage) - usedGB),
        });
      }
    }

    res.json({ success: true, targetFolderId: targetFolder.id, copiedMediaCount: mediaInTree.length });
  } catch (error) {
    console.error('Studio copy folder to drive error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
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

    const mediaOut = await signMediaForResponse(media);
    res.json(mediaOut);
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
