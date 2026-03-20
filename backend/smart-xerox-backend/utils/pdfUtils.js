const pdfParse = require('pdf-parse');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('../config/logger');

/**
 * Count pages in a PDF that was just uploaded via multer-s3
 * For S3 files, we count from the raw buffer if available
 */
const countPDFPages = async (file) => {
  try {
    // If file buffer is available (memory storage)
    if (file.buffer) {
      const data = await pdfParse(file.buffer);
      return data.numpages;
    }

    // For S3 uploads, we download temporarily to count pages
    // In production you might want to store this during upload using memory + S3 dual approach
    const s3Client = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const command = new GetObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: file.key,
    });

    const response = await s3Client.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const data = await pdfParse(buffer);
    return data.numpages;
  } catch (err) {
    logger.warn(`PDF page count failed: ${err.message}`);
    return 0; // Return 0 if counting fails (not critical)
  }
};

/**
 * Parse page range string like "1-5,7,10-12" into array of page numbers
 */
const parsePageRange = (pageRange, totalPages) => {
  if (!pageRange || pageRange === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages = new Set();
  const parts = pageRange.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(Number);
      for (let i = start; i <= Math.min(end, totalPages); i++) pages.add(i);
    } else {
      const num = parseInt(trimmed);
      if (num >= 1 && num <= totalPages) pages.add(num);
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
};

/**
 * Calculate actual pages to print based on page range
 */
const getPrintablePageCount = (detectedPages, pageRange) => {
  if (!pageRange || pageRange === 'all') return detectedPages;
  const pages = parsePageRange(pageRange, detectedPages);
  return pages.length;
};

module.exports = { countPDFPages, parsePageRange, getPrintablePageCount };
