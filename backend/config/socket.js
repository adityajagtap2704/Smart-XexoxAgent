const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('./logger');

let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173'],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Auth middleware for socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} | User: ${socket.userId}`);

    // Join personal room
    socket.join(`user:${socket.userId}`);

    // Shop join for shopkeepers
    socket.on('join:shop', (shopId) => {
      if (socket.userRole === 'shopkeeper' || socket.userRole === 'admin') {
        socket.join(`shop:${shopId}`);
        logger.info(`Socket ${socket.id} joined shop room: ${shopId}`);
      }
    });

    // Admin room
    if (socket.userRole === 'admin') {
      socket.join('admin:room');
    }

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} | Reason: ${reason}`);
    });

    socket.on('error', (err) => {
      logger.error(`Socket error for ${socket.id}:`, err);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
};

// Event emitter helpers
const emitToUser = (userId, event, data) => {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
};

const emitToShop = (shopId, event, data) => {
  if (!io) return;
  io.to(`shop:${shopId}`).emit(event, data);
};

const emitToAdmin = (event, data) => {
  if (!io) return;
  io.to('admin:room').emit(event, data);
};

module.exports = { initSocket, getIO, emitToUser, emitToShop, emitToAdmin };
