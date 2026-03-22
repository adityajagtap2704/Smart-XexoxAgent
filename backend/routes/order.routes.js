const express = require('express');
const router  = express.Router();
const orderController = require('../controllers/order.controller');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

// ── All named/specific routes BEFORE any /:param wildcards ────────────────────
router.post('/',               orderController.createOrder);
router.get('/my-orders',       orderController.getUserOrders);
router.post('/verify-pickup',  restrictTo('shopkeeper', 'admin'), orderController.verifyPickup);
router.get('/shop/orders',     restrictTo('shopkeeper', 'admin'), orderController.getShopOrders);
router.post('/retry/:id',      orderController.retryPayment);     // ← POST, unique prefix, no conflict

// ── Wildcard /:id routes AFTER all named routes ───────────────────────────────
router.get('/:id',             orderController.getOrder);
router.post('/:id/extend',     orderController.extendOrderExpiry);
router.post('/:id/rate',       orderController.rateOrder);
router.patch('/:id/accept',    restrictTo('shopkeeper'),          orderController.acceptOrder);
router.patch('/:id/reject',    restrictTo('shopkeeper', 'admin'), orderController.rejectOrder);
router.patch('/:id/status',    restrictTo('shopkeeper'),          orderController.updateOrderStatus);
router.patch('/:id/auto-printed', restrictTo('shopkeeper'),       orderController.markAutoPrinted);
router.get('/:orderId/documents/:docId/url', restrictTo('shopkeeper', 'admin'), orderController.getDocumentUrl);

module.exports = router;