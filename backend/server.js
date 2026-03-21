// ============================================
// SMART XEROX PRINTING PLATFORM - SERVER
// ============================================

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');           // NEW — XSS protection
const hpp = require('hpp');                  // NEW — HTTP parameter pollution
const cookieParser = require('cookie-parser'); // NEW — read cookies
require('dotenv').config();

const { initSocket } = require('./config/socket');
const { connectDB } = require('./config/database');
const logger = require('./config/logger');
const errorHandler = require('./middleware/errorHandler');
const { startCronJobs } = require('./jobs/cronJobs');

// Route Imports
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const shopRoutes = require('./routes/shop.routes');
const orderRoutes = require('./routes/order.routes');
const paymentRoutes = require('./routes/payment.routes');
const uploadRoutes = require('./routes/upload.routes');
const adminRoutes = require('./routes/admin.routes');
const notificationRoutes = require('./routes/notification.routes');

const app = express();
const server = http.createServer(app);

// ─── Socket.IO Init ──────────────────────────────────────────────────────────
const io = initSocket(server);
app.set('io', io);

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://checkout.razorpay.com"],
      frameSrc: ["'self'", "https://api.razorpay.com"],
      connectSrc: ["'self'", "https://api.razorpay.com"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(mongoSanitize());   // Prevent MongoDB injection
app.use(xss());             // NEW — Prevent XSS attacks
app.use(hpp());             // NEW — Prevent HTTP parameter pollution
app.use(compression());
app.use(cookieParser());    // NEW — Parse cookies

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-razorpay-signature'],
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Global limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 200,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth routes — strict
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});

// OTP requests — very strict
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many OTP requests. Try again in 15 minutes.' },
});

// Upload — prevent abuse
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 20,
  message: { success: false, message: 'Upload limit reached. Try again in an hour.' },
});

// Order creation — prevent spam
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many orders placed. Try again in an hour.' },
});

app.use('/api', globalLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/auth/send-otp', otpLimiter);
app.use('/api/auth/verify-otp', otpLimiter);
app.use('/api/upload', uploadLimiter);
app.use('/api/orders', orderLimiter);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// Razorpay webhook needs raw body — must be BEFORE express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Logging ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  }));
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Smart Xerox API is running',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/shops', shopRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
    logger.info('✅ MongoDB Connected');

    server.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
    });

    startCronJobs();
    logger.info('⏰ Cron jobs started');

  } catch (error) {
    logger.error('❌ Server startup error:', error);
    process.exit(1);
  }
};

startServer();

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close();
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Promise Rejection:', err);
  server.close(() => process.exit(1));
});

module.exports = { app, server };