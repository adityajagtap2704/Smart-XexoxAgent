const cron = require('node-cron');
const Order = require('../models/Order');
const { createNotification } = require('../utils/notifications');
const { emitToUser, emitToShop } = require('../config/socket');
const { deleteFile } = require('../config/aws');
const logger = require('../config/logger');
const moment = require('moment');

/**
 * Check for expiring orders - run every 30 minutes
 * Notify users/shops 1 hour before expiry
 */
const checkExpiringOrders = cron.schedule('*/30 * * * *', async () => {
  try {
    const oneHourFromNow = moment().add(1, 'hour').toDate();
    const now = new Date();

    const expiringOrders = await Order.find({
      status: { $in: ['paid', 'accepted', 'printing', 'ready'] },
      'expiry.expiresAt': { $gte: now, $lte: oneHourFromNow },
      'expiry.extended': false,
    }).select('_id orderNumber user shop expiry');

    for (const order of expiringOrders) {
      const minutesLeft = Math.round((order.expiry.expiresAt - now) / 60000);

      await createNotification({
        recipient: order.user,
        type: 'order_expiring_soon',
        title: '⏰ Order Expiring Soon!',
        message: `Your order #${order.orderNumber} expires in ${minutesLeft} minutes. Collect or extend now!`,
        order: order._id,
        priority: 'high',
      });

      emitToUser(order.user.toString(), 'order:expiring_soon', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        expiresAt: order.expiry.expiresAt,
        minutesLeft,
      });
    }

    if (expiringOrders.length > 0) {
      logger.info(`Expiry alerts sent for ${expiringOrders.length} orders`);
    }
  } catch (err) {
    logger.error('Expiry check cron error:', err);
  }
}, { scheduled: false });

/**
 * Expire overdue orders - run every 15 minutes
 */
const expireOrders = cron.schedule('*/15 * * * *', async () => {
  try {
    const now = new Date();

    const expiredOrders = await Order.find({
      status: { $in: ['paid', 'accepted', 'printing', 'ready'] },
      'expiry.expiresAt': { $lt: now },
    });

    for (const order of expiredOrders) {
      order.status = 'expired';
      order.statusHistory.push({
        status: 'expired',
        note: 'Order expired automatically',
        timestamp: now,
      });
      await order.save();

      // Notify user
      await createNotification({
        recipient: order.user,
        type: 'order_expired',
        title: 'Order Expired',
        message: `Your order #${order.orderNumber} has expired. Contact support for refund queries.`,
        order: order._id,
        priority: 'high',
      });

      emitToUser(order.user.toString(), 'order:expired', {
        orderId: order._id,
        orderNumber: order.orderNumber,
      });

      // Notify shop
      emitToShop(order.shop.toString(), 'order:expired', {
        orderId: order._id,
        orderNumber: order.orderNumber,
      });
    }

    if (expiredOrders.length > 0) {
      logger.info(`Expired ${expiredOrders.length} orders`);
    }
  } catch (err) {
    logger.error('Order expiry cron error:', err);
  }
}, { scheduled: false });

/**
 * Clean up S3 files for expired/cancelled orders older than 7 days - run daily at 2 AM
 */
const cleanupOldFiles = cron.schedule('0 2 * * *', async () => {
  try {
    const sevenDaysAgo = moment().subtract(7, 'days').toDate();

    const oldOrders = await Order.find({
      status: { $in: ['expired', 'cancelled', 'refunded', 'picked_up'] },
      updatedAt: { $lt: sevenDaysAgo },
    }).select('documents');

    let deletedCount = 0;
    for (const order of oldOrders) {
      for (const doc of order.documents) {
        if (doc.s3Key) {
          try {
            await deleteFile(doc.s3Key);
            deletedCount++;
          } catch (err) {
            logger.warn(`Failed to delete S3 file ${doc.s3Key}: ${err.message}`);
          }
        }
      }
    }

    if (deletedCount > 0) {
      logger.info(`Cleaned up ${deletedCount} S3 files from old orders`);
    }
  } catch (err) {
    logger.error('S3 cleanup cron error:', err);
  }
}, { scheduled: false });

/**
 * Start all cron jobs
 */
const startCronJobs = () => {
  checkExpiringOrders.start();
  expireOrders.start();
  cleanupOldFiles.start();
  logger.info('Cron jobs started: expiry alerts (30min), order expiry (15min), S3 cleanup (daily 2am)');
};

const stopCronJobs = () => {
  checkExpiringOrders.stop();
  expireOrders.stop();
  cleanupOldFiles.stop();
};

module.exports = { startCronJobs, stopCronJobs };
