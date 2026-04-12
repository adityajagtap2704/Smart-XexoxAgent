const { Server } = require('socket.io');
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const Shop   = require('../models/Shop');
const logger = require('./logger');

let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: [
        process.env.FRONTEND_URL,
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:5000',
      ],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Auth middleware ────────────────────────────────────────────────────────
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.split(' ')[1];

    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId   = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    logger.info(`Socket connected: ${socket.id} | User: ${socket.userId} | Role: ${socket.userRole}`);

    // Everyone joins their personal room
    socket.join(`user:${socket.userId}`);

    // Shopkeeper joins their shop room
    if (socket.userRole === 'shopkeeper') {
      try {
        const shop = await Shop.findOne({ owner: socket.userId }).select('_id name');
        if (shop) {
          socket.join(`shop:${shop._id}`);
          socket.shopId = shop._id.toString();
          logger.info(`Shopkeeper ${socket.userId} auto-joined shop:${shop._id} (${shop.name})`);
        }
      } catch (err) {
        logger.warn(`Could not auto-join shop room: ${err.message}`);
      }
    }

    // Admin room
    if (socket.userRole === 'admin') {
      socket.join('admin:room');
    }

    // ── Shop manual join (fallback) ───────────────────────────────────────
    socket.on('join:shop', (shopId) => {
      if (!shopId) return;
      socket.join(`shop:${shopId}`);
      logger.info(`Socket ${socket.id} joined shop:${shopId}`);
    });

    // ── User join order room ──────────────────────────────────────────────
    // User clicks on an order to watch real-time updates
    socket.on('join-order', (orderId) => {
      if (!orderId) return;
      const room = `order:${orderId}`;
      socket.join(room);
      logger.info(`Socket ${socket.id} joined order room: ${room}`);
    });

    // ── Print Agent join ───────────────────────────────────────────────────
    // Agent calls this after connecting with shopkeeper JWT
    socket.on('join:agent', async ({ token }) => {
      if (socket.userRole !== 'shopkeeper') return;
      try {
        const shop = await Shop.findOne({ owner: socket.userId }).select('_id name');
        if (shop) {
          const agentRoom = `agent:${shop._id}`;
          socket.join(agentRoom);
          socket.shopId  = shop._id.toString();
          socket.isAgent = true;
          logger.info(`🖨️  Print Agent connected for shop: ${shop.name} (${shop._id})`);

          // Confirm to agent
          socket.emit('agent:connected', {
            shopId:   shop._id,
            shopName: shop.name,
            message:  'Print agent registered. Listening for order:accepted events.',
          });
        }
      } catch (err) {
        logger.warn(`Agent join error: ${err.message}`);
      }
    });

    socket.on('disconnect', (reason) => {
      if (socket.isAgent) {
        logger.info(`🖨️  Print Agent disconnected: ${socket.id} | Reason: ${reason}`);
      } else {
        logger.info(`Socket disconnected: ${socket.id} | Reason: ${reason}`);
      }
    });

    socket.on('error', (err) => {
      logger.error(`Socket error ${socket.id}: ${err.message}`);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
};

// ── Event emitter helpers ──────────────────────────────────────────────────────

// To a specific user (browser tab)
const emitToUser = (userId, event, data) => {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
};

// To shopkeeper dashboard
const emitToShop = (shopId, event, data) => {
  if (!io) return;
  io.to(`shop:${shopId}`).emit(event, data);
};

// To print agent running on shop PC
const emitToAgent = (shopId, event, data) => {
  if (!io) return;
  io.to(`agent:${shopId}`).emit(event, data);
  logger.info(`📡 Emitted ${event} to agent:${shopId}`);
};

// To admin panel
const emitToAdmin = (event, data) => {
  if (!io) return;
  io.to('admin:room').emit(event, data);
};

module.exports = { initSocket, getIO, emitToUser, emitToShop, emitToAgent, emitToAdmin };