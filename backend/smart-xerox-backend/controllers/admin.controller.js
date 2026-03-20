const User = require('../models/User');
const Shop = require('../models/Shop');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const { AppError, asyncHandler } = require('../utils/helpers');
const { emitToAdmin, emitToShop } = require('../config/socket');
const { createNotification } = require('../utils/notifications');
const logger = require('../config/logger');
const moment = require('moment');

// ─── Dashboard Overview ───────────────────────────────────────────────────────
exports.getDashboard = asyncHandler(async (req, res) => {
  const today = moment().startOf('day').toDate();
  const thisMonth = moment().startOf('month').toDate();

  const [
    totalUsers, totalShops, totalOrders, activeOrders,
    todayOrders, monthRevenue, pendingVerification,
    recentOrders
  ] = await Promise.all([
    User.countDocuments({ role: 'user' }),
    Shop.countDocuments({ isActive: true }),
    Order.countDocuments(),
    Order.countDocuments({ status: { $in: ['paid', 'accepted', 'printing', 'ready'] } }),
    Order.countDocuments({ createdAt: { $gte: today } }),
    Payment.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: thisMonth } } },
      { $group: { _id: null, total: { $sum: '$platformRevenue' } } },
    ]),
    Shop.countDocuments({ isVerified: false, isActive: true }),
    Order.find().sort({ createdAt: -1 }).limit(10)
      .populate('user', 'name email')
      .populate('shop', 'name')
      .lean(),
  ]);

  res.status(200).json({
    success: true,
    data: {
      stats: {
        totalUsers,
        totalShops,
        totalOrders,
        activeOrders,
        todayOrders,
        monthPlatformRevenue: monthRevenue[0]?.total || 0,
        pendingVerification,
      },
      recentOrders,
    },
  });
});

// ─── Get All Users ─────────────────────────────────────────────────────────────
exports.getAllUsers = asyncHandler(async (req, res) => {
  const { role, page = 1, limit = 20, search, isActive } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (isActive !== undefined) filter.isActive = isActive === 'true';
  if (search) filter.$or = [
    { name: new RegExp(search, 'i') },
    { email: new RegExp(search, 'i') },
    { phone: new RegExp(search, 'i') },
  ];

  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: { users, pagination: { total, page: Number(page), pages: Math.ceil(total / limit) } },
  });
});

// ─── Deactivate / Activate User ───────────────────────────────────────────────
exports.toggleUserStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found', 404);
  if (user.role === 'admin') throw new AppError('Cannot deactivate admin', 403);

  user.isActive = !user.isActive;
  await user.save({ validateBeforeSave: false });

  res.status(200).json({
    success: true,
    message: `User ${user.isActive ? 'activated' : 'deactivated'}`,
    data: { userId: user._id, isActive: user.isActive },
  });
});

// ─── Get All Shops ────────────────────────────────────────────────────────────
exports.getAllShops = asyncHandler(async (req, res) => {
  const { isVerified, isActive, page = 1, limit = 20, search } = req.query;
  const filter = {};
  if (isVerified !== undefined) filter.isVerified = isVerified === 'true';
  if (isActive !== undefined) filter.isActive = isActive === 'true';
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { 'address.city': new RegExp(search, 'i') }];

  const skip = (page - 1) * limit;
  const [shops, total] = await Promise.all([
    Shop.find(filter).populate('owner', 'name email phone').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Shop.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: { shops, pagination: { total, page: Number(page), pages: Math.ceil(total / limit) } },
  });
});

// ─── Verify Shop ──────────────────────────────────────────────────────────────
exports.verifyShop = asyncHandler(async (req, res) => {
  const { approve, reason } = req.body;
  const shop = await Shop.findById(req.params.id).populate('owner');
  if (!shop) throw new AppError('Shop not found', 404);

  shop.isVerified = approve;
  if (!approve) shop.isActive = false;
  await shop.save();

  await createNotification({
    recipient: shop.owner._id,
    type: 'shop_verified',
    title: approve ? 'Shop Verified! 🎉' : 'Shop Verification Failed',
    message: approve
      ? `Your shop "${shop.name}" has been verified. You can now receive orders!`
      : `Shop verification failed. Reason: ${reason || 'Please contact support.'}`,
  });

  res.status(200).json({
    success: true,
    message: `Shop ${approve ? 'verified' : 'rejected'}`,
    data: { shop },
  });
});

// ─── Set Platform Margin for Shop ─────────────────────────────────────────────
exports.setShopMargin = asyncHandler(async (req, res) => {
  const { margin } = req.body;
  if (margin < 0 || margin > 100) throw new AppError('Margin must be between 0 and 100', 400);

  const shop = await Shop.findByIdAndUpdate(req.params.id, { platformMargin: margin }, { new: true });
  if (!shop) throw new AppError('Shop not found', 404);

  res.status(200).json({ success: true, message: `Platform margin set to ${margin}%`, data: { shop } });
});

// ─── Get All Orders ───────────────────────────────────────────────────────────
exports.getAllOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20, from, to, shopId } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (shopId) filter.shop = shopId;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('user', 'name email phone')
      .populate('shop', 'name address')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Order.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: { orders, pagination: { total, page: Number(page), pages: Math.ceil(total / limit) } },
  });
});

// ─── Revenue Report ───────────────────────────────────────────────────────────
exports.getRevenueReport = asyncHandler(async (req, res) => {
  const { from, to, groupBy = 'day' } = req.query;
  const dateFilter = {};
  if (from) dateFilter.$gte = new Date(from);
  if (to) dateFilter.$lte = new Date(to);

  const groupFormats = { day: '%Y-%m-%d', week: '%Y-W%V', month: '%Y-%m' };
  const dateFormat = groupFormats[groupBy] || groupFormats.day;

  const revenue = await Payment.aggregate([
    { $match: { status: 'paid', ...(Object.keys(dateFilter).length ? { paidAt: dateFilter } : {}) } },
    {
      $group: {
        _id: { $dateToString: { format: dateFormat, date: '$paidAt' } },
        totalRevenue: { $sum: '$amount' },
        platformRevenue: { $sum: '$platformRevenue' },
        shopRevenue: { $sum: '$shopReceivable' },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const totals = await Payment.aggregate([
    { $match: { status: 'paid' } },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$amount' },
        platformRevenue: { $sum: '$platformRevenue' },
        shopRevenue: { $sum: '$shopReceivable' },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  res.status(200).json({ success: true, data: { revenue, totals: totals[0] || {} } });
});

// ─── Broadcast Notification ───────────────────────────────────────────────────
exports.broadcastNotification = asyncHandler(async (req, res) => {
  const { title, message, targetRole, targetUserIds } = req.body;

  let recipients = [];
  if (targetUserIds && targetUserIds.length > 0) {
    recipients = targetUserIds;
  } else if (targetRole) {
    const users = await User.find({ role: targetRole, isActive: true }).select('_id');
    recipients = users.map((u) => u._id);
  } else {
    const users = await User.find({ isActive: true }).select('_id');
    recipients = users.map((u) => u._id);
  }

  // Bulk create notifications
  const notifications = recipients.map((userId) => ({
    recipient: userId,
    type: 'system',
    title,
    message,
    priority: 'high',
  }));
  await Notification.insertMany(notifications);

  // Emit to connected clients
  emitToAdmin('broadcast:notification', { title, message });

  res.status(200).json({
    success: true,
    message: `Notification broadcast to ${recipients.length} users`,
    data: { sentTo: recipients.length },
  });
});

// ─── Get Platform Analytics ───────────────────────────────────────────────────
exports.getAnalytics = asyncHandler(async (req, res) => {
  const [ordersByStatus, topShops, orderTrend] = await Promise.all([
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Shop.find({ isActive: true, isVerified: true }).sort({ totalOrders: -1 }).limit(10).select('name totalOrders totalRevenue rating'),
    Order.aggregate([
      { $match: { status: { $ne: 'pending_payment' } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
      { $limit: 30 },
    ]),
  ]);

  res.status(200).json({ success: true, data: { ordersByStatus, topShops, orderTrend: orderTrend.reverse() } });
});
