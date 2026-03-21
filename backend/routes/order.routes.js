const express = require('express');
const router  = express.Router();
const orderController = require('../controllers/order.controller');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

// ── IMPORTANT: Specific routes MUST come before /:id wildcard ────────────────

// User routes
router.post('/',               orderController.createOrder);
router.get('/my-orders',       orderController.getUserOrders);
router.post('/verify-pickup',  restrictTo('shopkeeper', 'admin'), orderController.verifyPickup);

// Shopkeeper routes — MUST be before /:id
router.get('/shop/orders',     restrictTo('shopkeeper', 'admin'), orderController.getShopOrders);

// Wildcard /:id routes — MUST come AFTER all specific routes
router.get('/:id',             orderController.getOrder);
router.post('/:id/extend',     orderController.extendOrderExpiry);
router.post('/:id/rate',       orderController.rateOrder);
router.patch('/:id/accept',    restrictTo('shopkeeper'),           orderController.acceptOrder);
router.patch('/:id/reject',    restrictTo('shopkeeper', 'admin'),  orderController.rejectOrder);
router.patch('/:id/status',    restrictTo('shopkeeper'),           orderController.updateOrderStatus);
router.patch('/:id/auto-printed', restrictTo('shopkeeper'),        orderController.markAutoPrinted);
router.get('/:orderId/documents/:docId/url', restrictTo('shopkeeper', 'admin'), orderController.getDocumentUrl);

module.exports = router;