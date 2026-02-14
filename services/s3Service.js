const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'marrytube-media';

// Generate presigned URL for upload
const generateUploadURL = async (fileName, mimeType, userId) => {
  try {
    const fileExtension = fileName.split('.').pop();
    const s3Key = `uploads/${userId}/${uuidv4()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: mimeType,
    });

    const uploadURL = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour

    return {
      uploadURL,
      s3Key,
      url: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${s3Key}`,
    };
  } catch (error) {
    console.error('S3 upload URL generation error:', error);
    throw error;
  }
};

// Generate presigned URL for download/view
const generateDownloadURL = async (s3Key, expiresIn = 3600) => {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
    });

    const downloadURL = await getSignedUrl(s3Client, command, { expiresIn });
    return downloadURL;
  } catch (error) {
    console.error('S3 download URL generation error:', error);
    throw error;
  }
};

// Delete file from S3
const deleteFile = async (s3Key) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
    });

    await s3Client.send(command);
    return { success: true };
  } catch (error) {
    console.error('S3 delete error:', error);
    throw error;
  }
};

module.exports = {
  generateUploadURL,
  generateDownloadURL,
  deleteFile,
};

