const mongoose = require('mongoose');
const crypto = require('crypto');

const documentSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  s3Key: { type: String, required: true },
  s3Url: { type: String, required: true },
  fileSize: Number,
  mimeType: String,
  detectedPages: { type: Number, default: 0 },
  printingOptions: {
    copies: { type: Number, default: 1, min: 1, max: 100 },
    colorMode: { type: String, enum: ['bw', 'color'], default: 'bw' },
    sides: { type: String, enum: ['single', 'double'], default: 'single' },
    paperSize: { type: String, enum: ['A4', 'A3', 'Letter'], default: 'A4' },
    pageRange: { type: String, default: 'all' }, // e.g., 'all' or '1-5,7,10-12'
    orientation: { type: String, enum: ['portrait', 'landscape', 'auto'], default: 'auto' },
  },
  price: { type: Number, default: 0 },
  downloadedByShop: { type: Boolean, default: false },
  downloadedAt: Date,
}, { _id: true });

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
    },
    documents: [documentSchema],
    additionalServices: {
      binding: { type: Boolean, default: false },
      lamination: { type: Boolean, default: false },
      urgentPrinting: { type: Boolean, default: false },
    },
    specialInstructions: { type: String, maxlength: 500 },
    pricing: {
      subtotal: { type: Number, required: true },
      platformMargin: { type: Number, default: 0 },
      additionalServicesCharge: { type: Number, default: 0 },
      total: { type: Number, required: true },
      shopReceivable: { type: Number, required: true }, // total - platform margin
    },
    status: {
      type: String,
      enum: ['pending_payment', 'paid', 'accepted', 'rejected', 'printing', 'ready', 'picked_up', 'expired', 'cancelled', 'refunded'],
      default: 'pending_payment',
    },
    statusHistory: [
      {
        status: String,
        timestamp: { type: Date, default: Date.now },
        note: String,
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    payment: {
      razorpayOrderId: String,
      razorpayPaymentId: String,
      razorpaySignature: String,
      status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
      paidAt: Date,
      method: String,
    },
    pickup: {
      qrCode: { type: String }, // base64 QR code image
      qrCodeData: { type: String }, // data embedded in QR
      pickupCode: { type: String }, // 6-digit numeric code
      verifiedAt: Date,
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    expiry: {
      expiresAt: { type: Date },
      extended: { type: Boolean, default: false },
      extendedAt: Date,
      extendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    rejectionReason: String,
    shopNote: String, // Note from shopkeeper to user
    rating: {
      score: { type: Number, min: 1, max: 5 },
      review: String,
      ratedAt: Date,
    },
    refund: {
      amount: Number,
      razorpayRefundId: String,
      reason: String,
      processedAt: Date,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ shop: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ 'expiry.expiresAt': 1 });
orderSchema.index({ 'payment.razorpayOrderId': 1 });

// Auto-generate order number before save
orderSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  this.orderNumber = `SX-${timestamp}-${random}`;
  next();
});

// Virtual: is expired
orderSchema.virtual('isExpired').get(function () {
  if (!this.expiry?.expiresAt) return false;
  return new Date() > this.expiry.expiresAt;
});

// Add status to history
orderSchema.methods.addStatusHistory = function (status, note, userId) {
  this.statusHistory.push({ status, note, updatedBy: userId, timestamp: new Date() });
  this.status = status;
};

module.exports = mongoose.model('Order', orderSchema);
