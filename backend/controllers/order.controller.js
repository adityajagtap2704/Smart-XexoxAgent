const Order = require('../models/Order');
const Shop = require('../models/Shop');
const User = require('../models/User');
const Payment = require('../models/Payment');
const { AppError, asyncHandler } = require('../utils/helpers');
const { createRazorpayOrder } = require('../config/razorpay');
const { generateQRCode } = require('../utils/qrcode');
const { emitToUser, emitToShop, emitToAdmin, emitToAgent } = require('../config/socket');
const { createNotification } = require('../utils/notifications');
const { calculateOrderPrice } = require('../utils/pricing');
const { getPresignedUrl } = require('../config/aws');
const { sendEmail } = require('../utils/email');
const logger = require('../config/logger');
const moment = require('moment');

// ─── Create Order ─────────────────────────────────────────────────────────────
exports.createOrder = asyncHandler(async (req, res) => {
  const { shopId, documents, additionalServices, specialInstructions } = req.body;

  const shop = await Shop.findById(shopId);
  if (!shop) throw new AppError('Shop not found', 404);
  if (!shop.isActive || !shop.isVerified) throw new AppError('Shop is not available', 400);
  if (!shop.isOpen) throw new AppError('Shop is currently closed', 400);

  if (!documents || documents.length === 0) {
    throw new AppError('At least one document is required', 400);
  }

  const { subtotal, documentPrices, additionalCharge, total, shopReceivable, platformMargin } =
    calculateOrderPrice(documents, shop, additionalServices);

  const orderDocuments = documents.map((doc, i) => ({
    ...doc,
    price: documentPrices[i],
  }));

  const receipt = `order_${Date.now()}`;
  const razorpayOrder = await createRazorpayOrder({
    amount: total,
    currency: 'INR',
    receipt,
    notes: { shopId, userId: req.user.id },
  });

  const order = await Order.create({
    user: req.user.id,
    shop: shopId,
    documents: orderDocuments,
    additionalServices: additionalServices || {},
    specialInstructions,
    pricing: {
      subtotal,
      platformMargin,
      additionalServicesCharge: additionalCharge,
      total,
      shopReceivable,
    },
    status: 'pending_payment',
    payment: {
      razorpayOrderId: razorpayOrder.id,
      status: 'pending',
    },
    statusHistory: [{ status: 'pending_payment', note: 'Order created, awaiting payment' }],
  });

  await Payment.create({
    order: order._id,
    user: req.user.id,
    shop: shopId,
    razorpayOrderId: razorpayOrder.id,
    amount: total,
    shopReceivable,
    platformRevenue: platformMargin,
    currency: 'INR',
    receipt,
  });

  res.status(201).json({
    success: true,
    message: 'Order created successfully',
    data: {
      order,
      razorpay: {
        orderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        key: process.env.RAZORPAY_KEY_ID,
      },
    },
  });
});

// ─── Get User Orders ──────────────────────────────────────────────────────────
exports.getUserOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const filter = { user: req.user.id };
  if (status) filter.status = status;

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('shop', 'name address phone rating')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Order.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: {
      orders,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    },
  });
});

// ─── Get Single Order ─────────────────────────────────────────────────────────
exports.getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('user', 'name email phone')
    .populate('shop', 'name address phone email');

  if (!order) throw new AppError('Order not found', 404);

  const isOwner = order.user._id.toString() === req.user.id;
  const isShopOwner = req.user.role === 'shopkeeper';
  const isAdmin = req.user.role === 'admin';

  if (!isOwner && !isShopOwner && !isAdmin) {
    throw new AppError('Access denied', 403);
  }

  if (isOwner || isAdmin) {
    for (const doc of order.documents) {
      if (doc.s3Key) {
        doc.downloadUrl = await getPresignedUrl(doc.s3Key, 900);
      }
    }
  }

  res.status(200).json({ success: true, data: { order } });
});

// ─── Get Shop Orders ──────────────────────────────────────────────────────────
exports.getShopOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 50, date } = req.query;

  const shop = await Shop.findOne({ owner: req.user.id });
  if (!shop) throw new AppError('Shop not found for this account', 404);

  const filter = { shop: shop._id };
  if (status) filter.status = status;
  if (date) {
    const startOfDay = moment(date).startOf('day').toDate();
    const endOfDay = moment(date).endOf('day').toDate();
    filter.createdAt = { $gte: startOfDay, $lte: endOfDay };
  }
  if (!filter.status) {
    filter.status = { $nin: ['pending_payment'] };
  }

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('user', 'name phone email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Order.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: {
      orders,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    },
  });
});

// ─── Accept Order ─────────────────────────────────────────────────────────────
exports.acceptOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).populate('shop').populate('user', 'name email');
  if (!order) throw new AppError('Order not found', 404);
  if (order.shop.owner.toString() !== req.user.id) throw new AppError('Access denied', 403);
  if (order.status !== 'paid') throw new AppError('Order cannot be accepted in current state', 400);

  order.addStatusHistory('accepted', 'Order accepted by shopkeeper', req.user.id);
  order.expiry.expiresAt = moment().add(parseInt(process.env.ORDER_EXPIRY_HOURS) || 12, 'hours').toDate();
  await order.save();

  await createNotification({
    recipient: order.user._id,
    type: 'order_accepted',
    title: 'Order Accepted! 🎉',
    message: `Your order #${order.orderNumber} has been accepted. Ready soon!`,
    order: order._id,
  });
  emitToUser(order.user._id.toString(), 'order:status_update', { orderId: order._id, status: 'accepted', orderNumber: order.orderNumber });

  // ── REAL-TIME: Notify print agent to start printing immediately ──────────
  emitToAgent(order.shop._id.toString(), 'order:accepted', {
    orderId:     order._id,
    orderNumber: order.orderNumber,
    shopId:      order.shop._id,
    documents:   order.documents,
    user:        { name: order.user.name, email: order.user.email },
  });

  res.status(200).json({ success: true, message: 'Order accepted', data: { order } });
});

// ─── Reject Order ─────────────────────────────────────────────────────────────
exports.rejectOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const order = await Order.findById(req.params.id).populate('shop').populate('user', 'name email');
  if (!order) throw new AppError('Order not found', 404);
  if (order.shop.owner.toString() !== req.user.id) throw new AppError('Access denied', 403);
  if (!['paid'].includes(order.status)) throw new AppError('Cannot reject order in current state', 400);

  order.addStatusHistory('rejected', reason || 'Rejected by shopkeeper', req.user.id);
  order.rejectionReason = reason;
  await order.save();

  await createNotification({
    recipient: order.user._id,
    type: 'order_rejected',
    title: 'Order Rejected',
    message: `Your order #${order.orderNumber} was rejected. Reason: ${reason || 'Not specified'}. Refund will be processed.`,
    order: order._id,
  });
  emitToUser(order.user._id.toString(), 'order:status_update', { orderId: order._id, status: 'rejected', reason });

  res.status(200).json({ success: true, message: 'Order rejected', data: { order } });
});

// ─── Update Order Status (printing → ready) ───────────────────────────────────
exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  const validTransitions = {
    accepted: ['printing'],
    printing: ['ready'],
  };

  const order = await Order.findById(req.params.id)
    .populate('shop')
    .populate('user', 'name email phone');
  if (!order) throw new AppError('Order not found', 404);
  if (order.shop.owner.toString() !== req.user.id) throw new AppError('Access denied', 403);

  const allowed = validTransitions[order.status];
  if (!allowed || !allowed.includes(status)) {
    throw new AppError(`Cannot transition from ${order.status} to ${status}`, 400);
  }

  order.addStatusHistory(status, note, req.user.id);
  await order.save();

  const notifData = {
    printing: {
      title: 'Printing Started 🖨️',
      message: `Your order #${order.orderNumber} is being printed!`,
      type: 'order_printing',
    },
    ready: {
      title: 'Order Ready for Pickup! ✅',
      message: `Your order #${order.orderNumber} is ready. Use OTP ${order.pickup?.pickupCode} to collect it.`,
      type: 'order_ready',
    },
  };

  if (notifData[status]) {
    await createNotification({ recipient: order.user._id, ...notifData[status], order: order._id });
  }

  // FIX: When order is ready, send email with OTP to user
  if (status === 'ready' && order.user?.email && order.pickup?.pickupCode) {
    try {
      await sendEmail({
        to: order.user.email,
        template: 'orderReady',
        data: {
          name: order.user.name,
          orderNumber: order.orderNumber,
          pickupCode: order.pickup.pickupCode,
          shopName: order.shop.name,
          shopAddress: order.shop.address || '',
        },
      });
    } catch (err) {
      // Log but don't fail the request if email fails
      logger.error(`Failed to send ready email for order ${order.orderNumber}: ${err.message}`);
    }
  }

  emitToUser(order.user._id.toString(), 'order:status_update', {
    orderId: order._id,
    status,
    orderNumber: order.orderNumber,
    pickupCode: status === 'ready' ? order.pickup?.pickupCode : undefined,
  });

  res.status(200).json({ success: true, message: `Order status updated to ${status}`, data: { order } });
});

// ─── Verify OTP / Pickup Code (shopkeeper verifies customer OTP) ──────────────
exports.verifyPickup = asyncHandler(async (req, res) => {
  // FIX: accept orderId from body (frontend sends it this way)
  const { orderId, pickupCode, qrData } = req.body;

  const order = await Order.findById(orderId)
    .populate('shop')
    .populate('user', 'name email');
  if (!order) throw new AppError('Order not found', 404);
  if (order.shop.owner.toString() !== req.user.id) throw new AppError('Access denied', 403);
  if (order.status !== 'ready') throw new AppError('Order is not ready for pickup', 400);

  const validCode = pickupCode && order.pickup.pickupCode === pickupCode;
  const validQR = qrData && order.pickup.qrCodeData === qrData;

  if (!validCode && !validQR) {
    throw new AppError('Invalid OTP or QR code. Please check with customer.', 400);
  }

  order.addStatusHistory('picked_up', 'Order picked up by customer — OTP verified', req.user.id);
  order.pickup.verifiedAt = new Date();
  order.pickup.verifiedBy = req.user.id;
  await order.save();

  // Update shop and user stats
  await Shop.findByIdAndUpdate(order.shop._id, {
    $inc: { totalOrders: 1, totalRevenue: order.pricing.shopReceivable },
  });
  await User.findByIdAndUpdate(order.user._id, {
    $inc: { totalOrders: 1, totalSpent: order.pricing.total },
  });

  await createNotification({
    recipient: order.user._id,
    type: 'order_picked_up',
    title: 'Order Collected! 🎊',
    message: `Your order #${order.orderNumber} has been collected. Thank you!`,
    order: order._id,
  });
  emitToUser(order.user._id.toString(), 'order:status_update', { orderId: order._id, status: 'picked_up' });
  // Also notify shop room so dashboard auto-moves order to history
  emitToShop(order.shop._id.toString(), 'order:status_update', { orderId: order._id, status: 'picked_up' });

  res.status(200).json({ success: true, message: 'Pickup verified. Order complete!', data: { order } });
});

// ─── Extend Order Expiry ──────────────────────────────────────────────────────
exports.extendOrderExpiry = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  if (order.expiry.extended) throw new AppError('Order expiry already extended once', 400);
  if (!['paid', 'accepted', 'printing', 'ready'].includes(order.status)) {
    throw new AppError('Cannot extend order in current state', 400);
  }

  const extensionHours = parseInt(process.env.ORDER_EXTENSION_HOURS) || 12;
  order.expiry.expiresAt = moment(order.expiry.expiresAt).add(extensionHours, 'hours').toDate();
  order.expiry.extended = true;
  order.expiry.extendedAt = new Date();
  order.expiry.extendedBy = req.user.id;
  await order.save({ validateBeforeSave: false });

  emitToShop(order.shop.toString(), 'order:extended', { orderId: order._id, newExpiry: order.expiry.expiresAt });

  res.status(200).json({ success: true, message: `Order extended by ${extensionHours} hours`, data: { order } });
});

// ─── Rate Order ───────────────────────────────────────────────────────────────
exports.rateOrder = asyncHandler(async (req, res) => {
  const { rating, review } = req.body;
  const order = await Order.findOne({ _id: req.params.id, user: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  if (order.status !== 'picked_up') throw new AppError('Can only rate completed orders', 400);
  if (order.rating?.score) throw new AppError('Already rated this order', 400);

  order.rating = { score: rating, review, ratedAt: new Date() };
  await order.save();

  const Review = require('../models/Review');
  await Review.create({ user: req.user.id, shop: order.shop, order: order._id, rating, review });

  res.status(200).json({ success: true, message: 'Thank you for your rating!', data: { order } });
});

// ─── Get Document Download URL ────────────────────────────────────────────────
exports.getDocumentUrl = asyncHandler(async (req, res) => {
  const { orderId, docId } = req.params;
  const order = await Order.findById(orderId).populate('shop');
  if (!order) throw new AppError('Order not found', 404);

  const isShopOwner = order.shop.owner.toString() === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isShopOwner && !isAdmin) throw new AppError('Access denied', 403);

  if (!['accepted', 'printing', 'ready'].includes(order.status)) {
    throw new AppError('Document not available in current order state', 400);
  }

  const doc = order.documents.id(docId);
  if (!doc) throw new AppError('Document not found', 404);

  const url = await getPresignedUrl(doc.s3Key, 900);

  doc.downloadedByShop = true;
  doc.downloadedAt = new Date();
  await order.save();

  res.status(200).json({ success: true, data: { downloadUrl: url, expiresIn: 900 } });
});

// ─── Mark Auto Printed (called by print agent after printing) ─────────────────
// This is the NEW endpoint that the Node.js print agent calls after
// it successfully prints the document on the shop's PC.
// It auto-advances the order status from accepted → printing,
// which fires a real-time Socket.IO event to the user's browser.
exports.markAutoPrinted = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('shop')
    .populate('user', 'name email');

  if (!order) throw new AppError('Order not found', 404);
  if (order.shop.owner.toString() !== req.user.id) throw new AppError('Access denied', 403);

  // Idempotent — if already past accepted, just return success
  if (order.status !== 'accepted') {
    return res.status(200).json({ success: true, message: `Order already in ${order.status} state` });
  }

  order.addStatusHistory('printing', 'Document auto-printed by shop print agent', req.user.id);
  await order.save();

  // Notify user in real-time — status badge updates instantly without page refresh
  await createNotification({
    recipient: order.user._id,
    type: 'order_printing',
    title: 'Printing Started 🖨️',
    message: `Your order #${order.orderNumber} is being printed now!`,
    order: order._id,
  });

  emitToUser(order.user._id.toString(), 'order:status_update', {
    orderId: order._id,
    status: 'printing',
    orderNumber: order.orderNumber,
  });

  logger.info(`Order ${order.orderNumber} auto-printed by shop agent`);
  res.status(200).json({ success: true, message: 'Status updated to printing', data: { order } });
});

// ─── Mark Auto Printed (called by print-agent after printing) ─────────────────
exports.markAutoPrinted = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('shop')
    .populate('user', 'name email');

  if (!order) throw new AppError('Order not found', 404);
  if (order.shop.owner.toString() !== req.user.id) throw new AppError('Access denied', 403);

  // Idempotent — if already printing or beyond, just return success
  if (order.status !== 'accepted') {
    return res.status(200).json({ success: true, message: 'Order already past accepted state', data: { order } });
  }

  order.addStatusHistory('printing', 'Auto-printed by print agent', req.user.id);
  await order.save();

  // Push real-time update to user — their screen changes to "Printing" instantly
  await createNotification({
    recipient: order.user._id,
    type: 'order_printing',
    title: 'Printing Started 🖨️',
    message: `Your order #${order.orderNumber} is now being printed!`,
    order: order._id,
  });

  emitToUser(order.user._id.toString(), 'order:status_update', {
    orderId: order._id,
    status: 'printing',
    orderNumber: order.orderNumber,
  });

  logger.info(`Order ${order.orderNumber} auto-printed by agent, status → printing`);
  res.status(200).json({ success: true, message: 'Status updated to printing', data: { order } });
});


// ─── Update Print Job Progress (called by Print Agent) ───────────────────────
// Agent calls this to save checkpoint after each page — survives power failure
exports.updatePrintJob = asyncHandler(async (req, res) => {
  const { status, printedPages, totalPages, currentDocIndex, pauseReason, lastError, agentId } = req.body;

  const order = await Order.findById(req.params.id).populate('shop').populate('user', 'name');
  if (!order) throw new AppError('Order not found', 404);

  // Update print job checkpoint
  if (!order.printJob) order.printJob = {};
  if (status)           order.printJob.status        = status;
  if (printedPages !== undefined) order.printJob.printedPages  = printedPages;
  if (totalPages   !== undefined) order.printJob.totalPages    = totalPages;
  if (currentDocIndex !== undefined) order.printJob.currentDocIndex = currentDocIndex;
  if (pauseReason)      order.printJob.pauseReason   = pauseReason;
  if (lastError)        order.printJob.lastError      = lastError;
  if (agentId)          order.printJob.agentId        = agentId;

  if (status === 'printing' && !order.printJob.startedAt) {
    order.printJob.startedAt = new Date();
  }
  if (status === 'paused') {
    order.printJob.pausedAt = new Date();
  }
  if (status === 'completed') {
    order.printJob.completedAt = new Date();
  }

  await order.save({ validateBeforeSave: false });

  // Notify shopkeeper dashboard in real-time
  const shopId = order.shop._id?.toString() || order.shop.toString();

  if (status === 'paused' && pauseReason === 'out_of_paper') {
    // Alert shopkeeper — printer needs paper
    emitToShop(shopId, 'print:out_of_paper', {
      orderId:      order._id,
      orderNumber:  order.orderNumber,
      printedPages: order.printJob.printedPages,
      totalPages:   order.printJob.totalPages,
      message:      `Printer out of paper! Printed ${order.printJob.printedPages}/${order.printJob.totalPages} pages.`,
    });

    // Create notification for shopkeeper
    await createNotification({
      recipient: order.shop.owner || req.user.id,
      type:      'system',
      title:     '🖨️ Printer Out of Paper!',
      message:   `Order #${order.orderNumber}: Printed ${order.printJob.printedPages}/${order.printJob.totalPages} pages. Add paper and resume.`,
      order:     order._id,
      priority:  'high',
    });
  }

  if (status === 'paused' && pauseReason === 'printer_error') {
    emitToShop(shopId, 'print:error', {
      orderId:     order._id,
      orderNumber: order.orderNumber,
      error:       lastError,
      message:     `Printer error: ${lastError}`,
    });
  }

  if (status === 'completed') {
    emitToShop(shopId, 'print:completed', {
      orderId:     order._id,
      orderNumber: order.orderNumber,
      message:     'All pages printed successfully.',
    });
  }

  res.status(200).json({ success: true, data: { printJob: order.printJob } });
});

// ─── Get Print Job Status (called by Agent on resume/restart) ─────────────────
// Agent calls this on startup to find any incomplete jobs to resume
exports.getPrintJobStatus = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found', 404);

  res.status(200).json({
    success: true,
    data: {
      orderId:        order._id,
      orderStatus:    order.status,
      printJob:       order.printJob || { status: 'idle', printedPages: 0 },
      documents:      order.documents,
    },
  });
});

// ─── Resume Print Job (shopkeeper clicks Resume after adding paper) ───────────
exports.resumePrintJob = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).populate('shop');
  if (!order) throw new AppError('Order not found', 404);
  if (order.shop.owner.toString() !== req.user.id) throw new AppError('Access denied', 403);

  if (order.printJob?.status !== 'paused') {
    throw new AppError('Print job is not paused', 400);
  }

  order.printJob.status      = 'queued';
  order.printJob.pauseReason = null;
  order.printJob.pausedAt    = null;
  await order.save({ validateBeforeSave: false });

  // Tell print agent to resume
  const shopId = order.shop._id.toString();
  emitToAgent(shopId, 'print:resume', {
    orderId:          order._id,
    orderNumber:      order.orderNumber,
    resumeFromPage:   order.printJob.printedPages,
    currentDocIndex:  order.printJob.currentDocIndex,
    documents:        order.documents,
  });

  logger.info(`Print job resumed for order ${order.orderNumber} from page ${order.printJob.printedPages}`);

  res.status(200).json({
    success: true,
    message: `Resuming from page ${order.printJob.printedPages + 1}`,
    data:    { printJob: order.printJob },
  });
});

// ─── Get Incomplete Print Jobs (agent calls on startup) ──────────────────────
exports.getIncompletePrintJobs = asyncHandler(async (req, res) => {
  // Find shop for this shopkeeper
  const shop = await require('../models/Shop').findOne({ owner: req.user.id });
  if (!shop) throw new AppError('Shop not found', 404);

  const incompletJobs = await Order.find({
    shop: shop._id,
    status: { $in: ['accepted', 'printing'] },
    $or: [
      { 'printJob.status': { $in: ['queued', 'printing', 'paused'] } },
      { 'printJob.status': { $exists: false } },
    ],
  }).select('_id orderNumber status printJob documents user').populate('user', 'name');

  res.status(200).json({
    success: true,
    data: { orders: incompletJobs },
  });
});

// ─── Retry Payment — reopen Razorpay for pending_payment orders ───────────────
exports.retryPayment = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.user.id });
  if (!order) throw new AppError('Order not found', 404);

  if (order.status !== 'pending_payment') {
    throw new AppError('This order has already been paid or cancelled', 400);
  }

  if (!order.payment?.razorpayOrderId) {
    throw new AppError('Payment details missing. Please place a new order.', 400);
  }

  res.status(200).json({
    success: true,
    data: {
      order,
      razorpay: {
        orderId:  order.payment.razorpayOrderId,
        amount:   Math.round(order.pricing.total * 100),
        currency: 'INR',
        key:      process.env.RAZORPAY_KEY_ID,
      },
    },
  });
});