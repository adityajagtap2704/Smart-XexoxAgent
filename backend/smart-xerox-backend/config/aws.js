const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET;

// Multer-S3 upload config
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => {
      cb(null, {
        userId: req.user?.id || 'unknown',
        originalName: file.originalname,
        uploadedAt: new Date().toISOString(),
      });
    },
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const fileName = `documents/${req.user?.id}/${uuidv4()}${ext}`;
      cb(null, fileName);
    },
  }),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
    files: 5,
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported. Allowed: PDF, DOC, DOCX, PNG, JPG`), false);
    }
  },
});

// Generate a pre-signed GET URL (expires in 1 hour by default)
const getPresignedUrl = async (key, expiresIn = 3600) => {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn });
};

// Delete a file from S3
const deleteFile = async (key) => {
  const command = new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key });
  return s3Client.send(command);
};

module.exports = { s3Client, upload, getPresignedUrl, deleteFile, BUCKET_NAME };
