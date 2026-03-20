const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const createRazorpayOrder = async ({ amount, currency = 'INR', receipt, notes = {} }) => {
  // Amount must be in paise (1 INR = 100 paise)
  return razorpay.orders.create({
    amount: Math.round(amount * 100),
    currency,
    receipt,
    notes,
  });
};

const verifyWebhookSignature = (rawBody, signature) => {
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return expectedSignature === signature;
};

const verifyPaymentSignature = ({ orderId, paymentId, signature }) => {
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expectedSignature === signature;
};

const fetchPayment = async (paymentId) => razorpay.payments.fetch(paymentId);
const fetchOrder = async (orderId) => razorpay.orders.fetch(orderId);

module.exports = {
  razorpay,
  createRazorpayOrder,
  verifyWebhookSignature,
  verifyPaymentSignature,
  fetchPayment,
  fetchOrder,
};
