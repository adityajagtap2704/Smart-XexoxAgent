const { upload, getPresignedUrl } = require('../config/aws');
const { AppError, asyncHandler } = require('../utils/helpers');
const { countPDFPages } = require('../utils/pdfUtils');
const logger = require('../config/logger');

// ─── Upload Document to S3 ────────────────────────────────────────────────────
exports.uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('No file uploaded', 400);

  const file = req.file;
  const s3Key = file.key;
  const s3Url = file.location;

  // Try to count pages for PDF
  let detectedPages = 0;
  if (file.mimetype === 'application/pdf') {
    try {
      detectedPages = await countPDFPages(file);
    } catch (err) {
      logger.warn(`Page count failed for ${file.originalname}: ${err.message}`);
    }
  }

  res.status(200).json({
    success: true,
    message: 'File uploaded successfully',
    data: {
      originalName: file.originalname,
      s3Key,
      s3Url,
      fileSize: file.size,
      mimeType: file.mimetype,
      detectedPages,
      disclaimer: detectedPages > 0
        ? 'Page count is auto-detected. Final printed page count may vary due to formatting differences.'
        : null,
    },
  });
});

// ─── Upload Multiple Documents ────────────────────────────────────────────────
exports.uploadMultipleDocuments = asyncHandler(async (req, res) => {
  if (!req.files || req.files.length === 0) throw new AppError('No files uploaded', 400);

  const uploadedFiles = await Promise.all(
    req.files.map(async (file) => {
      let detectedPages = 0;
      if (file.mimetype === 'application/pdf') {
        try {
          detectedPages = await countPDFPages(file);
        } catch (err) {
          logger.warn(`Page count failed for ${file.originalname}: ${err.message}`);
        }
      }
      return {
        originalName: file.originalname,
        s3Key: file.key,
        s3Url: file.location,
        fileSize: file.size,
        mimeType: file.mimetype,
        detectedPages,
      };
    })
  );

  res.status(200).json({
    success: true,
    message: `${uploadedFiles.length} file(s) uploaded successfully`,
    data: {
      files: uploadedFiles,
      disclaimer: 'Page counts are auto-detected and may vary slightly from actual printed pages.',
    },
  });
});

// ─── Get Presigned URL for Download ──────────────────────────────────────────
exports.getDownloadUrl = asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) throw new AppError('S3 key is required', 400);

  const url = await getPresignedUrl(key, 900); // 15-minute expiry

  res.status(200).json({
    success: true,
    data: { url, expiresIn: 900 },
  });
});

// Multer upload middleware exports
exports.uploadSingle = upload.single('document');
exports.uploadMultiple = upload.array('documents', 5);
