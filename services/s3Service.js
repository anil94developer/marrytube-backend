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

// Generate presigned URL for download/view
const generateDownloadURL = async (s3Key, expiresIn = 3600) => {
  try {
    return await getSignedUrlV2(
      'getObject',
      { Bucket: BUCKET_NAME, Key: s3Key },
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
  deleteFile,
  uploadFileToS3,
  uploadBufferToS3,
  isS3Configured,
  getBackblazeStatus,
  BUCKET_NAME,
  getObjectPublicUrl,
};

