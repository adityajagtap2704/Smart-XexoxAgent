const express = require('express');
const router  = express.Router();
const orderController = require('../controllers/order.controller');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

// ── User routes ──────────────────────────────────────────────────────────────
router.post('/',             orderController.createOrder);
router.get('/my-orders',     orderController.getUserOrders);
router.get('/:id',           orderController.getOrder);
router.post('/:id/extend',   orderController.extendOrderExpiry);
router.post('/:id/rate',     orderController.rateOrder);

// ── Shopkeeper routes ────────────────────────────────────────────────────────
router.get('/shop/orders',   restrictTo('shopkeeper', 'admin'), orderController.getShopOrders);
router.patch('/:id/accept',  restrictTo('shopkeeper'),           orderController.acceptOrder);
router.patch('/:id/reject',  restrictTo('shopkeeper', 'admin'),  orderController.rejectOrder);
router.patch('/:id/status',  restrictTo('shopkeeper'),           orderController.updateOrderStatus);
router.post('/verify-pickup',restrictTo('shopkeeper', 'admin'),  orderController.verifyPickup);
router.get('/:orderId/documents/:docId/url', restrictTo('shopkeeper', 'admin'), orderController.getDocumentUrl);

// ── Print Agent route (NEW) ──────────────────────────────────────────────────
// Called by the Node.js print-agent running on the shop PC after printing
router.patch('/:id/auto-printed', restrictTo('shopkeeper'), orderController.markAutoPrinted);

module.exports = router;
