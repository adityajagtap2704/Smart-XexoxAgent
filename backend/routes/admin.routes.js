const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect, restrictTo('admin'));

router.get('/dashboard', adminController.getDashboard);
router.get('/analytics', adminController.getAnalytics);
router.get('/revenue', adminController.getRevenueReport);

// Users
router.get('/users', adminController.getAllUsers);
router.patch('/users/:id/toggle-status', adminController.toggleUserStatus);

// Shops
router.get('/shops', adminController.getAllShops);
router.patch('/shops/:id/verify', adminController.verifyShop);
router.patch('/shops/:id/margin', adminController.setShopMargin);

// Orders
router.get('/orders', adminController.getAllOrders);

// Broadcast
router.post('/notifications/broadcast', adminController.broadcastNotification);

module.exports = router;
