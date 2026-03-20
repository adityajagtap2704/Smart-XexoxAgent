const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { protect, restrictTo } = require('../middleware/auth');

// Webhook - no auth (raw body already handled in server.js)
router.post('/webhook', paymentController.razorpayWebhook);

router.use(protect);
router.post('/verify', paymentController.verifyPayment);
router.get('/order/:orderId', paymentController.getPaymentDetails);
router.post('/refund', restrictTo('user', 'admin'), paymentController.initiateRefund);

module.exports = router;
