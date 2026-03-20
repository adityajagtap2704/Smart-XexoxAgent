const mongoose = require('mongoose');
const logger = require('./logger');

const connectDB = async () => {
  const options = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 2,
    heartbeatFrequencyMS: 10000,
    retryWrites: true,
    w: 'majority',
  };

  await mongoose.connect(process.env.MONGODB_URI, options);

  mongoose.connection.on('connected', () => logger.info('Mongoose connected to DB'));
  mongoose.connection.on('error', (err) => logger.error('Mongoose connection error:', err));
  mongoose.connection.on('disconnected', () => {
    logger.warn('Mongoose disconnected. Reconnecting...');
    setTimeout(connectDB, 5000);
  });
};

module.exports = { connectDB };
