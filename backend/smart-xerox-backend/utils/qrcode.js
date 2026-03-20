const QRCode = require('qrcode');
const logger = require('../config/logger');

/**
 * Generate QR code as base64 data URL
 * @param {string} data - Data to encode in QR
 * @returns {Promise<string>} - Base64 data URL
 */
const generateQRCode = async (data) => {
  try {
    const qrCodeDataUrl = await QRCode.toDataURL(data, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' },
      width: 300,
    });
    return qrCodeDataUrl;
  } catch (error) {
    logger.error('QR code generation failed:', error);
    throw new Error('Failed to generate QR code');
  }
};

/**
 * Generate QR code as SVG string
 */
const generateQRCodeSVG = async (data) => {
  return QRCode.toString(data, { type: 'svg', errorCorrectionLevel: 'H' });
};

/**
 * Generate 6-digit numeric pickup code
 */
const generatePickupCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

module.exports = { generateQRCode, generateQRCodeSVG, generatePickupCode };
