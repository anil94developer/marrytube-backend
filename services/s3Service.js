const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// Backblaze B2 only (S3-compatible API). No Amazon S3.
// Required .env: S3_ENDPOINT (must match bucket region, e.g. https://s3.us-west-004.backblazeb2.com),
//   BACKBLAZE_KEY_ID, BACKBLAZE_APPLICATION_KEY, S3_BUCKET_NAME
const rawEndpoint = (process.env.S3_ENDPOINT || process.env.BACKBLAZE_B2_ENDPOINT || '').trim();
const S3_ENDPOINT = rawEndpoint ? rawEndpoint.replace(/\/$/, '') : null;
const accessKeyId = (process.env.BACKBLAZE_KEY_ID || '').trim();
const rawSecret = process.env.BACKBLAZE_APPLICATION_KEY || '';
const secretAccessKey = (typeof rawSecret === 'string' ? rawSecret : String(rawSecret)).replace(/^["']|["']$/g, '').trim();
// Region from endpoint (e.g. s3.us-west-004.backblazeb2.com -> us-west-004) or B2_REGION
let B2_REGION = (process.env.B2_REGION || process.env.AWS_REGION || '').trim();
if (!B2_REGION && S3_ENDPOINT) {
  const m = S3_ENDPOINT.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/);
  B2_REGION = m ? m[1] : 'us-west-004';
}
if (!B2_REGION) B2_REGION = 'us-west-004';

 
let s3 = null;
if (S3_ENDPOINT && accessKeyId && secretAccessKey) {
  s3 = new AWS.S3({
    endpoint: S3_ENDPOINT,
    accessKeyId,
    secretAccessKey,
    region: B2_REGION,
    s3ForcePathStyle: true,
    signatureVersion: 'v4',
  });
}

const getSignedUrlV2 = (operation, params, expiresInSeconds) => {
  if (!s3) throw new Error('Backblaze S3 client not configured');
  return new Promise((resolve, reject) => {
    s3.getSignedUrl(operation, { ...params, Expires: expiresInSeconds }, (err, url) => {
      if (err) return reject(err);
      resolve(url);
    });
  });
};

const BUCKET_NAME = (process.env.S3_BUCKET_NAME || 'marrytube-bucket').trim();

/**
 * S3-style URL for the object path. For Backblaze B2, anonymous GET usually fails unless the bucket
 * is fully public — private buckets need presigned URLs (see generateDownloadURL). Still stored as
 * a stable reference alongside s3Key.
 */
function getObjectPublicUrl(s3Key) {
  if (!S3_ENDPOINT) return '';
  return `${S3_ENDPOINT}/${BUCKET_NAME}/${s3Key}`;
}

// Path structure: userId (unique) → drive name → folder name → file (handled across project)
const getDriveSlug = (userPlanId) => {
  if (userPlanId == null || userPlanId === '' || userPlanId === 'default') return 'default';
  return `plan-${userPlanId}`;
};
const getFolderSlug = (folderId) => (folderId != null && folderId !== '') ? `f-${folderId}` : 'root';

/** Build S3 key: uploads/{userId}/{driveSlug}/{folderSlug}/{uuid}.ext */
const buildS3Key = (userId, userPlanId, folderId, fileName) => {
  const ext = (fileName && fileName.includes('.')) ? fileName.split('.').pop() : 'bin';
  const driveSlug = getDriveSlug(userPlanId);
  const folderSlug = getFolderSlug(folderId);
  const key = `uploads/${userId}/${driveSlug}/${folderSlug}/${uuidv4()}.${ext}`;
  return key;
};

/**
 * Generate presigned URL for upload.
 * Path: userId → drive (default | plan-{id}) → folder (root | f-{id}) → file.
 */
const generateUploadURL = async (fileName, mimeType, userId, userPlanId = null, folderId = null) => {
  try {
    const s3Key = buildS3Key(userId, userPlanId, folderId, fileName);

    const uploadURL = await getSignedUrlV2(
      'putObject',
      { Bucket: BUCKET_NAME, Key: s3Key, ContentType: mimeType },
      3600
    ); // 1 hour
    return {
      uploadURL,
      s3Key,
      url: getObjectPublicUrl(s3Key),
    };
  } catch (error) {
    console.error('Backblaze upload URL generation error:', error);
    throw error;
  }
};

/**
 * Resolve the object key to use for presigned GET. Some legacy rows store a wrong s3Key while
 * `url` still contains the correct path (…/bucket/uploads/…/file). Wrong key → B2 NoSuchKey.
 */
const resolveS3KeyForPresign = ({ s3Key, url }) => {
  const extractFromPathname = (pathname) => {
    if (!pathname) return null;
    let path = String(pathname).replace(/^\/+/, '');
    const bucketPrefix = `${BUCKET_NAME}/`;
    if (path.startsWith(bucketPrefix)) path = path.slice(bucketPrefix.length);
    const uidx = path.indexOf('uploads/');
    if (uidx >= 0) return path.slice(uidx);
    return null;
  };

  const tryFromStoredUrl = () => {
    const u = url != null && String(url).trim();
    if (!u || !/^https?:\/\//i.test(u)) return null;
    try {
      const parsed = new URL(u);
      return extractFromPathname(parsed.pathname);
    } catch (_) {
      return null;
    }
  };

  let k = s3Key != null && s3Key !== '' ? String(s3Key).trim() : '';
  k = k.replace(/^\/+/, '');
  if (k.startsWith(`${BUCKET_NAME}/`)) k = k.slice(BUCKET_NAME.length + 1);

  if (k.startsWith('uploads/')) return k;

  const fromUrl = tryFromStoredUrl();
  if (fromUrl) return fromUrl;

  return k || null;
};

/**
 * Build ordered unique key candidates (DB mistakes, B2 /file/ URLs, path-style URLs).
 */
const collectS3KeyCandidates = (row) => {
  const { s3Key, url } = row || {};
  const candidates = [];
  const add = (k) => {
    if (k == null || k === '') return;
    let s = String(k).trim().replace(/\\/g, '/');
    if (!s) return;
    s = s.replace(/^\/+/, '');
    while (s.startsWith(`${BUCKET_NAME}/`)) {
      s = s.slice(BUCKET_NAME.length + 1);
    }
    if (!candidates.includes(s)) candidates.push(s);
  };

  add(resolveS3KeyForPresign({ s3Key, url }));
  add(s3Key);

  const u = url != null ? String(url).trim() : '';
  if (!u) return candidates;

  if (/^https?:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      const path = parsed.pathname.replace(/^\/+/, '');
      if (path.startsWith(`${BUCKET_NAME}/`)) {
        add(path.slice(BUCKET_NAME.length + 1));
      }
      const uidx = path.indexOf('uploads/');
      if (uidx >= 0) add(path.slice(uidx));
    } catch (_) { /* ignore */ }

    // B2 native file URL: https://fXXX.backblazeb2.com/file/BucketName/object/path
    const fileMatch = u.match(/\/file\/[^/]+\/([^?]+)/);
    if (fileMatch) {
      try {
        add(decodeURIComponent(fileMatch[1]));
      } catch (_) {
        add(fileMatch[1]);
      }
    }
  } else {
    const rel = u.replace(/^\/+/, '');
    const uidx = rel.indexOf('uploads/');
    if (uidx >= 0) add(rel.slice(uidx));
  }

  return candidates;
};

/**
 * Presigned GET that actually matches an object in the bucket.
 * getSignedUrl() does not check the object exists — wrong key → browser shows B2 NoSuchKey XML.
 */
const presignExistingObject = async (row, expiresIn = 3600) => {
  if (!s3 || !BUCKET_NAME) return null;
  const keys = collectS3KeyCandidates(row);
  for (const key of keys) {
    if (!key) continue;
    try {
      await s3.headObject({ Bucket: BUCKET_NAME, Key: key }).promise();
      return await generateDownloadURL(key, expiresIn);
    } catch (e) {
      const code = e.code || e.Code || e.name;
      if (code === 'NotFound' || code === 'NoSuchKey' || code === 404) continue;
      if (code === 'Forbidden' || code === 403) {
        console.error('[B2] headObject forbidden — check bucket name and application key capabilities:', key);
        continue;
      }
    }
  }
  console.warn('[B2] presignExistingObject: no matching object', {
    mediaId: row && row.id,
    bucket: BUCKET_NAME,
    tried: keys,
  });
  return null;
};

// Generate presigned URL for download/view
const generateDownloadURL = async (s3Key, expiresIn = 3600) => {
  const key = typeof s3Key === 'string' ? s3Key.trim() : String(s3Key || '').trim();
  if (!key) {
    const err = new Error('Missing S3 key');
    console.error('Backblaze download URL generation error:', err.message);
    throw err;
  }
  try {
    return await getSignedUrlV2(
      'getObject',
      { Bucket: BUCKET_NAME, Key: key },
      expiresIn
    );
  } catch (error) {
    console.error('Backblaze download URL generation error:', error);
    throw error;
  }
};

// Delete file from S3
const deleteFile = async (s3Key) => {
  try {
    if (!s3) throw new Error('Backblaze S3 client not configured');
    await s3.deleteObject({ Bucket: BUCKET_NAME, Key: s3Key }).promise();
    return { success: true };
  } catch (error) {
    console.error('Backblaze delete error:', error);
    throw error;
  }
};

/**
 * Simple upload: stream file to Backblaze B2 / S3 (no full read into memory).
 * Use for single-file uploads and for merged chunked uploads.
 */
const uploadFileToS3 = async (s3Key, localFilePath, mimeType) => {
  if (!s3) throw new Error('Backblaze S3 client not configured');
  const stream = fs.createReadStream(localFilePath);
  await s3.upload({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    Body: stream,
    ContentType: mimeType || 'application/octet-stream',
  }).promise();
  return getObjectPublicUrl(s3Key);
};

// Upload from memory (no local file write). Useful for direct /api/media/upload.
const uploadBufferToS3 = async (s3Key, buffer, mimeType) => {
  if (!s3) throw new Error('Backblaze S3 client not configured');
  if (!buffer) throw new Error('No file buffer provided');
  if (!Buffer.isBuffer(buffer)) throw new Error('Invalid file buffer');
  await s3.upload({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
  }).promise();
  return getObjectPublicUrl(s3Key);
};

/** Multipart upload (chunks go straight to B2 — no local disk). B2/S3-compatible. */
const createMultipartUpload = async (s3Key, contentType) => {
  if (!s3) throw new Error('Backblaze S3 client not configured');
  const res = await s3.createMultipartUpload({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    ContentType: contentType || 'application/octet-stream',
  }).promise();
  return res.UploadId;
};

const uploadMultipartPart = async (s3Key, awsUploadId, partNumber, body) => {
  if (!s3) throw new Error('Backblaze S3 client not configured');
  const res = await s3.uploadPart({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    UploadId: awsUploadId,
    PartNumber: partNumber,
    Body: body,
  }).promise();
  return { PartNumber: partNumber, ETag: res.ETag };
};

const completeMultipartUpload = async (s3Key, awsUploadId, parts) => {
  if (!s3) throw new Error('Backblaze S3 client not configured');
  const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
  await s3.completeMultipartUpload({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    UploadId: awsUploadId,
    MultipartUpload: { Parts: sorted },
  }).promise();
};

const abortMultipartUpload = async (s3Key, awsUploadId) => {
  if (!s3) return;
  try {
    await s3.abortMultipartUpload({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      UploadId: awsUploadId,
    }).promise();
  } catch (e) {
    console.error('abortMultipartUpload:', e.message);
  }
};

const isS3Configured = () => !!(S3_ENDPOINT && accessKeyId && secretAccessKey && BUCKET_NAME);

/** Safe status for debugging (no secrets). */
function getBackblazeStatus() {
  const configured = isS3Configured();
  return {
    configured,
    endpoint: S3_ENDPOINT || null,
    keyIdLength: accessKeyId ? accessKeyId.length : 0,
    keyIdPrefix: accessKeyId ? accessKeyId.slice(0, 4) + '...' : null,
    secretLength: secretAccessKey ? secretAccessKey.length : 0,
    bucket: BUCKET_NAME || null,
    region: B2_REGION || null,
    hint: !configured ? 'Set S3_ENDPOINT, BACKBLAZE_KEY_ID, BACKBLAZE_APPLICATION_KEY, S3_BUCKET_NAME in .env and restart.' : null,
  };
}

module.exports = {
  generateUploadURL,
  generateDownloadURL,
  resolveS3KeyForPresign,
  collectS3KeyCandidates,
  presignExistingObject,
  deleteFile,
  uploadFileToS3,
  uploadBufferToS3,
  createMultipartUpload,
  uploadMultipartPart,
  completeMultipartUpload,
  abortMultipartUpload,
  isS3Configured,
  getBackblazeStatus,
  BUCKET_NAME,
  getObjectPublicUrl,
  buildS3Key,
};

