const Order = require('../models/Order');
const Payment = require('../models/Payment');
const { AppError, asyncHandler } = require('../utils/helpers');
const { verifyWebhookSignature, verifyPaymentSignature, razorpay } = require('../config/razorpay');
const { generateQRCode } = require('../utils/qrcode');
const { emitToUser, emitToShop, emitToAdmin } = require('../config/socket');
const { createNotification } = require('../utils/notifications');
const logger = require('../config/logger');
const moment = require('moment');

// ─── Verify Payment After Client-Side ─────────────────────────────────────────
exports.verifyPayment = asyncHandler(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  // Verify signature
  const isValid = verifyPaymentSignature({ orderId: razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature });
  if (!isValid) {
    logger.warn(`Invalid payment signature for order: ${razorpayOrderId}`);
    throw new AppError('Payment verification failed. Invalid signature.', 400);
  }

  const order = await Order.findOne({ 'payment.razorpayOrderId': razorpayOrderId }).populate('shop');
  if (!order) throw new AppError('Order not found', 404);
  if (order.status !== 'pending_payment') throw new AppError('Order already processed', 400);

  // Update order
  order.payment.razorpayPaymentId = razorpayPaymentId;
  order.payment.razorpaySignature = razorpaySignature;
  order.payment.status = 'paid';
  order.payment.paidAt = new Date();
  order.status = 'paid';
  order.statusHistory.push({ status: 'paid', note: 'Payment verified', timestamp: new Date() });

  // Generate QR code & pickup code
  const pickupCode = Math.floor(100000 + Math.random() * 900000).toString();
  const qrData = JSON.stringify({ orderId: order._id, orderNumber: order.orderNumber, pickupCode });
  const qrCodeImage = await generateQRCode(qrData);

  order.pickup.pickupCode = pickupCode;
  order.pickup.qrCodeData = qrData;
  order.pickup.qrCode = qrCodeImage;
  order.expiry.expiresAt = moment().add(parseInt(process.env.ORDER_EXPIRY_HOURS) || 12, 'hours').toDate();

  await order.save();

  // Update payment record
  await Payment.findOneAndUpdate(
    { razorpayOrderId },
    {
      razorpayPaymentId,
      razorpaySignature,
      status: 'paid',
      paidAt: new Date(),
      webhookVerified: false, // Will be confirmed via webhook
    }
  );

  // Notify user
  await createNotification({
    recipient: order.user,
    type: 'payment_success',
    title: 'Payment Successful! 💳',
    message: `Payment of ₹${order.pricing.total} received. Order #${order.orderNumber} placed. Pickup code: ${pickupCode}`,
    order: order._id,
  });
  emitToUser(order.user.toString(), 'payment:success', {
    orderId: order._id,
    orderNumber: order.orderNumber,
    pickupCode,
    qrCode: qrCodeImage,
  });

  // Notify shop
  await createNotification({
    recipient: order.shop.owner,
    type: 'new_order_shop',
    title: 'New Order Received! 📋',
    message: `New order #${order.orderNumber} received. ${order.documents.length} document(s) to print.`,
    order: order._id,
  });
  emitToShop(order.shop._id.toString(), 'order:new', {
    orderId: order._id,
    orderNumber: order.orderNumber,
    documentCount: order.documents.length,
    total: order.pricing.total,
  });

  emitToAdmin('order:new', { orderId: order._id, shopId: order.shop._id, amount: order.pricing.total });

  res.status(200).json({
    success: true,
    message: 'Payment verified successfully',
    data: {
      order: { _id: order._id, orderNumber: order.orderNumber, status: order.status },
      pickup: { qrCode: qrCodeImage, pickupCode, expiresAt: order.expiry.expiresAt },
    },
  });
});

// ─── Razorpay Webhook ─────────────────────────────────────────────────────────
exports.razorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body;

  if (!verifyWebhookSignature(rawBody, signature)) {
    logger.warn('Webhook signature mismatch');
    return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
  }

  const event = JSON.parse(rawBody.toString());
  logger.info(`Razorpay Webhook: ${event.event}`);

  const { payload } = event;

  switch (event.event) {
    case 'payment.captured': {
      const payment = payload.payment.entity;
      await Payment.findOneAndUpdate(
        { razorpayOrderId: payment.order_id },
        {
          razorpayPaymentId: payment.id,
          status: 'paid',
          method: payment.method,
          bank: payment.bank,
          wallet: payment.wallet,
          vpa: payment.vpa,
          email: payment.email,
          contact: payment.contact,
          webhookVerified: true,
          paidAt: new Date(payment.created_at * 1000),
        }
      );
      break;
    }

    case 'payment.failed': {
      const payment = payload.payment.entity;
      await Payment.findOneAndUpdate(
        { razorpayOrderId: payment.order_id },
        {
          status: 'failed',
          failedAt: new Date(),
          error: {
            code: payment.error_code,
            description: payment.error_description,
            source: payment.error_source,
            step: payment.error_step,
            reason: payment.error_reason,
          },
        }
      );

      const order = await Order.findOne({ 'payment.razorpayOrderId': payment.order_id });
      if (order && order.status === 'pending_payment') {
        await createNotification({
          recipient: order.user,
          type: 'payment_failed',
          title: 'Payment Failed',
          message: `Payment for order #${order.orderNumber} failed. Please try again.`,
          order: order._id,
        });
        emitToUser(order.user.toString(), 'payment:failed', { orderId: order._id });
      }
      break;
    }

    case 'refund.processed': {
      const refund = payload.refund.entity;
      await Payment.findOneAndUpdate(
        { razorpayPaymentId: refund.payment_id },
        {
          status: 'refunded',
          'refund.razorpayRefundId': refund.id,
          'refund.amount': refund.amount / 100,
          'refund.status': 'processed',
          'refund.processedAt': new Date(),
        }
      );
      break;
    }

    default:
      logger.info(`Unhandled webhook event: ${event.event}`);
  }

  res.status(200).json({ success: true, message: 'Webhook processed' });
});

// ─── Get Payment Details ──────────────────────────────────────────────────────
exports.getPaymentDetails = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ order: req.params.orderId })
    .populate('order', 'orderNumber status')
    .populate('user', 'name email')
    .populate('shop', 'name');

  if (!payment) throw new AppError('Payment not found', 404);

  const isOwner = payment.user._id.toString() === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) throw new AppError('Access denied', 403);

  res.status(200).json({ success: true, data: { payment } });
});

// ─── Initiate Refund ──────────────────────────────────────────────────────────
exports.initiateRefund = asyncHandler(async (req, res) => {
  const { orderId, reason } = req.body;

  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404);

  const isOwner = order.user.toString() === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) throw new AppError('Access denied', 403);

  if (!['rejected', 'cancelled', 'expired'].includes(order.status)) {
    throw new AppError('Refund not applicable for this order status', 400);
  }
  if (order.payment.status !== 'paid') throw new AppError('No payment to refund', 400);

  const payment = await Payment.findOne({ order: orderId });
  if (!payment || !payment.razorpayPaymentId) throw new AppError('Payment record not found', 404);

  // Razorpay refund
  const refund = await razorpay.payments.refund(payment.razorpayPaymentId, {
    amount: Math.round(order.pricing.total * 100),
    notes: { reason, orderId: orderId.toString() },
  });

  order.payment.status = 'refunded';
  order.refund = { amount: order.pricing.total, razorpayRefundId: refund.id, reason, processedAt: new Date() };
  await order.save();

  await createNotification({
    recipient: order.user,
    type: 'payment_refunded',
    title: 'Refund Initiated 💰',
    message: `Refund of ₹${order.pricing.total} initiated for order #${order.orderNumber}. Will reflect in 5-7 days.`,
    order: order._id,
  });

  res.status(200).json({ success: true, message: 'Refund initiated successfully', data: { refundId: refund.id } });
});
