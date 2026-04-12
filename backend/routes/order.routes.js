const express = require('express');
const router  = express.Router();
const orderController = require('../controllers/order.controller');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

// ── Named routes MUST come before /:id wildcards ──────────────────────────────

// User routes
router.post('/',               orderController.createOrder);
router.get('/my-orders',       orderController.getUserOrders);
router.post('/verify-pickup',  restrictTo('shopkeeper', 'admin'), orderController.verifyPickup);

// Shopkeeper routes
router.get('/shop/orders',     restrictTo('shopkeeper', 'admin'), orderController.getShopOrders);

// Print Agent routes — named, before /:id
router.get('/incomplete-jobs', restrictTo('shopkeeper'),          orderController.getIncompletePrintJobs);

// Pay Now retry
router.post('/retry/:id',      orderController.retryPayment);

// ── Wildcard /:id routes — MUST be LAST ──────────────────────────────────────
router.get('/:id/retry-payment',  orderController.retryPayment);
router.get('/:id/print-job',      restrictTo('shopkeeper'),       orderController.getPrintJobStatus);
router.patch('/:id/print-job',    orderController.updatePrintJob);        // called by agent
router.post('/:id/resume-print',  restrictTo('shopkeeper'),       orderController.resumePrintJob);
router.post('/:id/trigger-print', restrictTo('shopkeeper'),       orderController.triggerHardwarePrint);
router.get('/:id',                orderController.getOrder);
router.post('/:id/extend',        orderController.extendOrderExpiry);
router.post('/:id/rate',          orderController.rateOrder);
router.patch('/:id/accept',       restrictTo('shopkeeper'),          orderController.acceptOrder);
router.patch('/:id/reject',       restrictTo('shopkeeper', 'admin'), orderController.rejectOrder);
router.patch('/:id/status',       restrictTo('shopkeeper'),          orderController.updateOrderStatus);
router.patch('/:id/auto-printed', restrictTo('shopkeeper'),          orderController.markAutoPrinted);
router.get('/:orderId/documents/:docId/url', restrictTo('shopkeeper', 'admin'), orderController.getDocumentUrl);

module.exports = router;