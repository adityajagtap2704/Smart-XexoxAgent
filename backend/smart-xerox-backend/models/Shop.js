const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Shop name is required'],
      trim: true,
      maxlength: [100, 'Shop name cannot exceed 100 characters'],
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    phone: {
      type: String,
      required: [true, 'Shop phone is required'],
      match: [/^[6-9]\d{9}$/, 'Invalid phone number'],
    },
    email: { type: String, lowercase: true, trim: true },
    address: {
      street: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
      landmark: String,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },
    pricing: {
      bw: {
        singleSided: { type: Number, required: true, default: 2 },
        doubleSided: { type: Number, required: true, default: 3 },
      },
      color: {
        singleSided: { type: Number, required: true, default: 10 },
        doubleSided: { type: Number, required: true, default: 15 },
      },
      bindingPerDocument: { type: Number, default: 20 },
      laminationPerPage: { type: Number, default: 10 },
    },
    platformMargin: {
      type: Number,
      default: 0, // Percentage added by admin
    },
    operatingHours: {
      monday: { open: String, close: String, closed: { type: Boolean, default: false } },
      tuesday: { open: String, close: String, closed: { type: Boolean, default: false } },
      wednesday: { open: String, close: String, closed: { type: Boolean, default: false } },
      thursday: { open: String, close: String, closed: { type: Boolean, default: false } },
      friday: { open: String, close: String, closed: { type: Boolean, default: false } },
      saturday: { open: String, close: String, closed: { type: Boolean, default: false } },
      sunday: { open: String, close: String, closed: { type: Boolean, default: true } },
    },
    services: {
      xerox: { type: Boolean, default: true },
      printing: { type: Boolean, default: true },
      scanning: { type: Boolean, default: false },
      binding: { type: Boolean, default: false },
      lamination: { type: Boolean, default: false },
      stationery: { type: Boolean, default: false },
    },
    images: [String],
    rating: { type: Number, default: 0, min: 0, max: 5 },
    totalRatings: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },
    isOpen: { type: Boolean, default: true },
    pendingOrdersCount: { type: Number, default: 0 },
    bankDetails: {
      accountNumber: { type: String, select: false },
      ifscCode: { type: String, select: false },
      accountHolderName: { type: String, select: false },
      bankName: String,
    },
    upiId: { type: String, select: false },
    notifications: {
      newOrder: { type: Boolean, default: true },
      orderExpiry: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Geospatial index for nearby shop search
shopSchema.index({ location: '2dsphere' });
shopSchema.index({ isActive: 1, isVerified: 1 });
shopSchema.index({ owner: 1 });

// Virtual: full address
shopSchema.virtual('fullAddress').get(function () {
  const a = this.address;
  return `${a.street}, ${a.city}, ${a.state} - ${a.pincode}`;
});

// Calculate effective price (with platform margin)
shopSchema.methods.getEffectivePrice = function (type, side) {
  const basePrice = this.pricing[type][side];
  const marginAmount = (basePrice * this.platformMargin) / 100;
  return Math.ceil(basePrice + marginAmount);
};

module.exports = mongoose.model('Shop', shopSchema);
