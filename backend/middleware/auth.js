const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { AppError, asyncHandler } = require('../utils/helpers');

exports.protect = asyncHandler(async (req, res, next) => {
  let token;

  // NEW — First try to read from HttpOnly cookie
  if (req.cookies?.jwt && req.cookies.jwt !== 'loggedout') {
    token = req.cookies.jwt;
  }
  // Fallback — read from Authorization header (for mobile apps / API clients)
  else if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) throw new AppError('Authentication required. Please log in.', 401);

  const decoded = jwt.verify(token, process.env.JWT_SECRET);

  const user = await User.findById(decoded.id).select('+passwordChangedAt');
  if (!user) throw new AppError('User no longer exists', 401);
  if (!user.isActive) throw new AppError('Account deactivated. Contact support.', 403);

  if (user.changedPasswordAfter(decoded.iat)) {
    throw new AppError('Password recently changed. Please log in again.', 401);
  }

  req.user = { id: user._id.toString(), role: user.role, email: user.email };
  next();
});

exports.restrictTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    throw new AppError('You do not have permission to perform this action', 403);
  }
  next();
};

exports.optionalAuth = asyncHandler(async (req, res, next) => {
  let token;

  // NEW — Also check cookie for optional auth
  if (req.cookies?.jwt && req.cookies.jwt !== 'loggedout') {
    token = req.cookies.jwt;
  } else if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (user && user.isActive) {
        req.user = { id: user._id.toString(), role: user.role };
      }
    } catch (err) {
      // Ignore auth errors for optional auth
    }
  }
  next();
});