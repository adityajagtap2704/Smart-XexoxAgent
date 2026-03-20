const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { sendEmail } = require('../utils/email');
const { AppError, asyncHandler } = require('../utils/helpers');
const logger = require('../config/logger');

// ─── Token Helpers ────────────────────────────────────────────────────────────
const signToken = (id, role) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

const signRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN });

const sendTokens = async (user, statusCode, res, message = 'Success') => {
  const token = signToken(user._id, user.role);
  const refreshToken = signRefreshToken(user._id);

  user.refreshToken = refreshToken;
  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });

  user.password = undefined;
  user.otp = undefined;

  res.status(statusCode).json({
    success: true,
    message,
    data: { token, refreshToken, user },
  });
};

// ─── Register ─────────────────────────────────────────────────────────────────
exports.register = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role } = req.body;

  const existingUser = await User.findOne({ $or: [{ email }, { phone }] });
  if (existingUser) {
    const field = existingUser.email === email ? 'email' : 'phone';
    throw new AppError(`User with this ${field} already exists`, 409);
  }

  // Only allow user/shopkeeper role during registration (admin via seeding)
  const allowedRoles = ['user', 'shopkeeper'];
  const userRole = allowedRoles.includes(role) ? role : 'user';

  const user = new User({ name, email, phone, password, role: userRole });
  const otp = user.generateOTP('email_verify');
  await user.save();

  // Send OTP email
  try {
    await sendEmail({
      to: email,
      subject: 'Verify Your Email - Smart Xerox',
      template: 'otpVerification',
      data: { name, otp, purpose: 'email verification', expiryMinutes: process.env.OTP_EXPIRY_MINUTES || 5 },
    });
  } catch (err) {
    logger.warn(`OTP email failed for ${email}: ${err.message}`);
  }

  res.status(201).json({
    success: true,
    message: 'Registration successful. Please verify your email with the OTP sent.',
    data: { email, userId: user._id },
  });
});

// ─── Verify Email OTP ─────────────────────────────────────────────────────────
exports.verifyEmail = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  const user = await User.findOne({ email }).select('+otp.code +otp.expiresAt +otp.purpose +otp.attempts');
  if (!user) throw new AppError('User not found', 404);

  const result = user.verifyOTP(otp, 'email_verify');
  if (!result.valid) throw new AppError(result.message, 400);

  user.isEmailVerified = true;
  await user.save({ validateBeforeSave: false });

  await sendTokens(user, 200, res, 'Email verified successfully');
});

// ─── Login ────────────────────────────────────────────────────────────────────
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new AppError('Email and password are required', 400);

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }
  if (!user.isActive) throw new AppError('Account has been deactivated. Contact support.', 403);

  await sendTokens(user, 200, res, 'Login successful');
});

// ─── Send Login OTP (phone-based) ─────────────────────────────────────────────
exports.sendLoginOTP = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  const user = await User.findOne({ phone });
  if (!user) throw new AppError('No account found with this phone number', 404);
  if (!user.isActive) throw new AppError('Account deactivated', 403);

  const otp = user.generateOTP('login');
  await user.save({ validateBeforeSave: false });

  // In production, integrate with SMS provider. For now, log OTP (dev) or email.
  if (process.env.NODE_ENV === 'development') {
    logger.info(`🔐 OTP for ${phone}: ${otp}`);
  }

  // Optionally email OTP
  if (user.email) {
    try {
      await sendEmail({
        to: user.email,
        subject: 'Login OTP - Smart Xerox',
        template: 'otpVerification',
        data: { name: user.name, otp, purpose: 'login', expiryMinutes: process.env.OTP_EXPIRY_MINUTES || 5 },
      });
    } catch (err) {
      logger.warn(`OTP email failed: ${err.message}`);
    }
  }

  res.status(200).json({ success: true, message: 'OTP sent successfully', data: { phone } });
});

// ─── Verify Login OTP ─────────────────────────────────────────────────────────
exports.verifyLoginOTP = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body;

  const user = await User.findOne({ phone }).select('+otp.code +otp.expiresAt +otp.purpose +otp.attempts');
  if (!user) throw new AppError('User not found', 404);

  const result = user.verifyOTP(otp, 'login');
  if (!result.valid) throw new AppError(result.message, 400);

  user.isPhoneVerified = true;
  await user.save({ validateBeforeSave: false });

  await sendTokens(user, 200, res, 'OTP login successful');
});

// ─── Refresh Token ────────────────────────────────────────────────────────────
exports.refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new AppError('Refresh token required', 400);

  const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  const user = await User.findById(decoded.id).select('+refreshToken');
  if (!user || user.refreshToken !== refreshToken) {
    throw new AppError('Invalid refresh token', 401);
  }

  const newToken = signToken(user._id, user.role);
  const newRefreshToken = signRefreshToken(user._id);
  user.refreshToken = newRefreshToken;
  await user.save({ validateBeforeSave: false });

  res.status(200).json({
    success: true,
    data: { token: newToken, refreshToken: newRefreshToken },
  });
});

// ─── Forgot Password ──────────────────────────────────────────────────────────
exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) throw new AppError('No account with that email', 404);

  const otp = user.generateOTP('password_reset');
  await user.save({ validateBeforeSave: false });

  try {
    await sendEmail({
      to: email,
      subject: 'Password Reset OTP - Smart Xerox',
      template: 'otpVerification',
      data: { name: user.name, otp, purpose: 'password reset', expiryMinutes: 5 },
    });
  } catch (err) {
    user.otp = undefined;
    await user.save({ validateBeforeSave: false });
    throw new AppError('Failed to send reset email. Try again.', 500);
  }

  res.status(200).json({ success: true, message: 'Password reset OTP sent to your email.' });
});

// ─── Reset Password ───────────────────────────────────────────────────────────
exports.resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;

  const user = await User.findOne({ email }).select('+otp.code +otp.expiresAt +otp.purpose +otp.attempts');
  if (!user) throw new AppError('User not found', 404);

  const result = user.verifyOTP(otp, 'password_reset');
  if (!result.valid) throw new AppError(result.message, 400);

  user.password = newPassword;
  user.passwordChangedAt = new Date();
  await user.save();

  res.status(200).json({ success: true, message: 'Password reset successfully. Please login.' });
});

// ─── Logout ───────────────────────────────────────────────────────────────────
exports.logout = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user.id, { $unset: { refreshToken: 1 } });
  res.status(200).json({ success: true, message: 'Logged out successfully' });
});

// ─── Get Current User ─────────────────────────────────────────────────────────
exports.getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).populate('shop', 'name isActive isVerified');
  res.status(200).json({ success: true, data: { user } });
});

// ─── Change Password ──────────────────────────────────────────────────────────
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user.id).select('+password');

  if (!(await user.comparePassword(currentPassword))) {
    throw new AppError('Current password is incorrect', 401);
  }

  user.password = newPassword;
  await user.save();

  res.status(200).json({ success: true, message: 'Password changed successfully' });
});
