const Shop = require('../models/Shop');
const User = require('../models/User');
const Order = require('../models/Order');
const { AppError, asyncHandler } = require('../utils/helpers');
const { emitToShop } = require('../config/socket');
const logger = require('../config/logger');

const findMyShop = async (userId) => {
  let shop = await Shop.findOne({ owner: userId });
  if (shop) return shop;

  const user = await User.findById(userId).select('shop');
  if (user?.shop) {
    shop = await Shop.findById(user.shop);
    if (shop) return shop;
  }

  return null;
};

// ─── Get Nearby Shops ─────────────────────────────────────────────────────────
exports.getNearbyShops = asyncHandler(async (req, res) => {
  const { lat, lng, radius = 5000, services } = req.query; // radius in meters

  if (!lat || !lng) throw new AppError('Latitude and longitude are required', 400);

  const filter = {
    isActive: true,
    isVerified: true,
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
        $maxDistance: parseInt(radius),
      },
    },
  };

  if (services) {
    const serviceList = services.split(',');
    serviceList.forEach((s) => { filter[`services.${s.trim()}`] = true; });
  }

  const shops = await Shop.find(filter)
    .select('-bankDetails -upiId')
    .limit(20)
    .lean();

  res.status(200).json({ success: true, results: shops.length, data: { shops } });
});

// ─── Get All Shops (with pagination) ─────────────────────────────────────────
exports.getAllShops = asyncHandler(async (req, res) => {
  const { page = 1, limit = 12, city, search } = req.query;

  // NOTE: Do NOT filter by isActive/isVerified strictly — return all shops
  // so frontend can always find at least one shop even if not fully configured
  const filter = {};
  if (city)   filter['address.city'] = new RegExp(city, 'i');
  if (search)  filter.name           = new RegExp(search, 'i');

  const skip = (page - 1) * limit;
  const [shops, total] = await Promise.all([
    Shop.find(filter)
      .select('-bankDetails -upiId')
      .sort({ createdAt: -1 })   // sort by date — no index needed
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Shop.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: { shops, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) } },
  });
});

// ─── Get Shop by ID ───────────────────────────────────────────────────────────
exports.getShop = asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id)
    .select('-bankDetails -upiId')
    .populate('owner', 'name phone');
  if (!shop) throw new AppError('Shop not found', 404);

  // Ensure bankDetails is not included in the response
  const shopObj = shop.toObject();
  delete shopObj.bankDetails;
  delete shopObj.upiId;

  res.status(200).json({ success: true, data: { shop: shopObj } });
});

// ─── Create Shop (Shopkeeper) ─────────────────────────────────────────────────
exports.createShop = asyncHandler(async (req, res) => {
  const existing = await Shop.findOne({ owner: req.user.id });
  if (existing) throw new AppError('You already have a registered shop', 400);

  const { name, phone, email, address, location, pricing, services, operatingHours, bankDetails, upiId } = req.body;

  const shop = await Shop.create({
    name, phone, email, address, location, pricing, services, operatingHours, bankDetails, upiId,
    owner: req.user.id,
    isVerified: false, // Admin must verify
    isActive: true,
  });

  // Link shop to user
  await User.findByIdAndUpdate(req.user.id, { shop: shop._id });

  res.status(201).json({
    success: true,
    message: 'Shop registered. Pending admin verification.',
    data: { shop },
  });
});

// ─── Update Shop ──────────────────────────────────────────────────────────────
exports.updateShop = asyncHandler(async (req, res) => {
  const shop = await findMyShop(req.user.id);
  if (!shop) throw new AppError('Shop not found', 404);

  const allowedUpdates = ['name', 'phone', 'email', 'address', 'location', 'pricing', 'services', 'operatingHours', 'bankDetails', 'upiId', 'isOpen'];
  const updates = {};
  allowedUpdates.forEach((key) => { if (req.body[key] !== undefined) updates[key] = req.body[key]; });

  Object.assign(shop, updates);
  await shop.save();

  res.status(200).json({ success: true, message: 'Shop updated', data: { shop } });
});

// ─── Get Shop Dashboard Stats ─────────────────────────────────────────────────
exports.getShopDashboard = asyncHandler(async (req, res) => {
  const shop = await findMyShop(req.user.id);
  if (!shop) {
    return res.status(200).json({
      success: true,
      data: {
        shop: null,
        stats: { pendingOrders: 0, todayOrders: 0, totalRevenue: 0, totalOrders: 0 }
      }
    });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [pendingOrders, todayOrders, totalRevenue, totalOrders] = await Promise.all([
    Order.countDocuments({ shop: shop._id, status: { $in: ['paid', 'accepted', 'printing'] } }),
    Order.countDocuments({ shop: shop._id, createdAt: { $gte: today } }),
    Order.aggregate([
      { $match: { shop: shop._id, status: 'picked_up' } },
      { $group: { _id: null, total: { $sum: '$pricing.shopReceivable' } } },
    ]),
    Order.countDocuments({ shop: shop._id }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      shop: { name: shop.name, rating: shop.rating, isOpen: shop.isOpen, isVerified: shop.isVerified },
      stats: {
        pendingOrders,
        todayOrders,
        totalRevenue: totalRevenue[0]?.total || 0,
        totalOrders,
      },
    },
  });
});

// ─── Toggle Shop Open/Close ───────────────────────────────────────────────────
exports.toggleShopStatus = asyncHandler(async (req, res) => {
  const shop = await findMyShop(req.user.id);
  if (!shop) throw new AppError('Shop not found', 404);

  shop.isOpen = !shop.isOpen;
  await shop.save();

  emitToShop(shop._id.toString(), 'shop:status_update', { isOpen: shop.isOpen });

  res.status(200).json({
    success: true,
    message: `Shop is now ${shop.isOpen ? 'open' : 'closed'}`,
    data: { isOpen: shop.isOpen },
  });
});

// ─── Get Shop Reviews ─────────────────────────────────────────────────────────
exports.getShopReviews = asyncHandler(async (req, res) => {
  const Review = require('../models/Review');
  const { page = 1, limit = 10 } = req.query;
  const skip = (page - 1) * limit;

  const reviews = await Review.find({ shop: req.params.id, isVisible: true })
    .populate('user', 'name avatar')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  const total = await Review.countDocuments({ shop: req.params.id, isVisible: true });

  res.status(200).json({
    success: true,
    data: { reviews, pagination: { total, page: Number(page), pages: Math.ceil(total / limit) } },
  });
});

// ─── Get My Shop (simple object, for ShopDashboard header) ──────────────────
exports.getMyShop = asyncHandler(async (req, res) => {
  const shop = await findMyShop(req.user.id);
  if (!shop) {
    return res.status(200).json({ success: true, data: { shop: null } });
  }
  res.status(200).json({ success: true, data: { shop } });
});