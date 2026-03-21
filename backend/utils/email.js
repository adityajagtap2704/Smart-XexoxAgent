const nodemailer = require('nodemailer');
const logger = require('../config/logger');

let transporter;

const getTransporter = () => {
  if (!transporter) {
    // FIX: was createTransporter — correct method is createTransport
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
};

const emailTemplates = {
  otpVerification: ({ name, otp, purpose, expiryMinutes }) => ({
    subject: `Your OTP for ${purpose} - Smart Xerox`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #f97316 0%, #ef4444 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">Smart Xerox</h1>
          <p style="color: rgba(255,255,255,0.9);">Printing Made Easy</p>
        </div>
        <div style="background: white; padding: 30px; border: 1px solid #eee; border-top: none;">
          <h2>Hello, ${name}!</h2>
          <p>Your OTP for <strong>${purpose}</strong> is:</p>
          <div style="background: #f8f9fa; border: 2px dashed #f97316; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 10px; color: #f97316;">${otp}</span>
          </div>
          <p style="color: #dc3545;">⚠️ This OTP expires in <strong>${expiryMinutes} minutes</strong>.</p>
          <p style="color: #6c757d; font-size: 12px;">Never share your OTP with anyone. Smart Xerox team will never ask for it.</p>
        </div>
        <div style="background: #f8f9fa; padding: 15px; border-radius: 0 0 10px 10px; text-align: center;">
          <p style="color: #6c757d; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} Smart Xerox. All rights reserved.</p>
        </div>
      </div>
    `,
  }),

  orderConfirmation: ({ name, orderNumber, pickupCode, total, shopName, expiresAt }) => ({
    subject: `Order Confirmed #${orderNumber} - Smart Xerox`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2>Hello ${name}, your order is confirmed! 🎉</h2>
        <p><strong>Order Number:</strong> ${orderNumber}</p>
        <p><strong>Shop:</strong> ${shopName}</p>
        <p><strong>Amount Paid:</strong> ₹${total}</p>
        <p><strong>Pickup Code:</strong> <span style="font-size: 24px; font-weight: bold; color: #f97316;">${pickupCode}</span></p>
        <p><strong>Valid Until:</strong> ${new Date(expiresAt).toLocaleString('en-IN')}</p>
        <p style="color: #dc3545;">Use your pickup code or QR code to collect documents from the shop.</p>
      </div>
    `,
  }),

  orderReady: ({ name, orderNumber, pickupCode, shopName, shopAddress }) => ({
    subject: `Your Order is Ready for Pickup! ✅ - Smart Xerox`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">✅ Order Ready!</h1>
          <p style="color: rgba(255,255,255,0.9);">Your documents are printed and waiting</p>
        </div>
        <div style="background: white; padding: 30px; border: 1px solid #eee; border-top: none;">
          <h2>Hello ${name}!</h2>
          <p>Your order <strong>#${orderNumber}</strong> is ready for pickup at <strong>${shopName}</strong>.</p>
          ${shopAddress ? `<p style="color: #555;">📍 ${shopAddress}</p>` : ''}
          <div style="background: #f0fff4; border: 2px solid #38a169; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <p style="margin: 0 0 8px 0; font-size: 14px; color: #276749; font-weight: bold;">YOUR PICKUP OTP</p>
            <span style="font-size: 48px; font-weight: bold; letter-spacing: 12px; color: #22543d;">${pickupCode}</span>
            <p style="margin: 8px 0 0 0; font-size: 13px; color: #48bb78;">Show this OTP to the shopkeeper</p>
          </div>
          <p style="color: #dc3545; font-size: 13px;">⚠️ Do not share this OTP with anyone other than the shop counter.</p>
        </div>
        <div style="background: #f8f9fa; padding: 15px; border-radius: 0 0 10px 10px; text-align: center;">
          <p style="color: #6c757d; font-size: 12px; margin: 0;">© ${new Date().getFullYear()} Smart Xerox. All rights reserved.</p>
        </div>
      </div>
    `,
  }),
};

const sendEmail = async ({ to, subject, template, data, html }) => {
  // In development — always log OTP to terminal so you can verify without email
  if (process.env.NODE_ENV !== 'production' && data?.otp) {
    logger.info(`\n========================================`);
    logger.info(`📧 DEV MODE — Email OTP for ${to}`);
    logger.info(`🔐 OTP: ${data.otp}`);
    logger.info(`📋 Purpose: ${data.purpose}`);
    logger.info(`========================================\n`);
  }

  // If SMTP not configured — skip email but don't crash
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.warn(`SMTP not configured — skipping email to ${to}. OTP logged above.`);
    return;
  }

  try {
    const transport = getTransporter();
    const templateContent = template ? emailTemplates[template]?.(data) : { subject, html };

    await transport.sendMail({
      from: process.env.EMAIL_FROM || 'Smart Xerox <noreply@smartxerox.com>',
      to,
      subject: templateContent?.subject || subject,
      html: templateContent?.html || html,
    });

    logger.info(`✅ Email sent to ${to}`);
  } catch (err) {
    logger.error(`❌ Email failed to ${to}: ${err.message}`);
    // Don't throw — let registration succeed even if email fails
    // OTP is already logged above for dev use
  }
};

module.exports = { sendEmail };