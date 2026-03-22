// ─────────────────────────────────────────────────────────────────────────────
//  Smart Xerox — Print Agent (REAL-TIME VERSION)
//  File: print-agent/agent.js
//
//  UPGRADE: Replaced polling with Socket.IO real-time events.
//  Agent connects to backend via Socket.IO and listens for 'order:accepted'
//  events. When received — downloads PDF → prints → updates status instantly.
//
//  Polling is kept as FALLBACK only (runs every 60s) to catch any missed events.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const axios   = require('axios');
const printer = require('pdf-to-printer');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const winston = require('winston');
const { io }  = require('socket.io-client');

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'print-agent.log',
      maxsize: 5_000_000,
      maxFiles: 3,
    }),
  ],
});

// ─── Config ───────────────────────────────────────────────────────────────────
const API_URL      = process.env.API_URL;           // e.g. http://localhost:5000/api
const SOCKET_URL   = process.env.SOCKET_URL || API_URL?.replace('/api', ''); // e.g. http://localhost:5000
const TOKEN        = process.env.SHOP_TOKEN;
const PRINTER_NAME = process.env.PRINTER_NAME || '';
const POLL_MS      = parseInt(process.env.POLL_INTERVAL_MS) || 60000; // fallback every 60s
const MAX_RETRIES  = parseInt(process.env.MAX_RETRIES) || 3;

if (!API_URL || !TOKEN || TOKEN === 'paste_your_shopkeeper_jwt_token_here') {
  logger.error('MISSING: API_URL or SHOP_TOKEN not set in .env');
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
const printedOrders   = new Set();  // prevent duplicate prints
const printingNow     = new Set();  // orders currently being processed
const retryCount      = new Map();  // orderId → failed attempts
let   fallbackPolling = false;

// ─── Axios ────────────────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: API_URL,
  headers: { Authorization: `Bearer ${TOKEN}` },
  timeout: 20000,
});

api.interceptors.response.use(res => res, err => {
  if (err.response?.status === 401) {
    logger.error('JWT token expired! Update SHOP_TOKEN in .env and restart.');
  }
  return Promise.reject(err);
});

// ─── Socket.IO Connection ─────────────────────────────────────────────────────
function connectSocket() {
  const socket = io(SOCKET_URL, {
    auth: { token: TOKEN },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    logger.info(`✅ Socket connected: ${socket.id}`);

    // Join the shop's room to receive shop-specific events
    socket.emit('join:agent', { token: TOKEN });
    logger.info('📡 Joined shop agent room');
  });

  socket.on('disconnect', (reason) => {
    logger.warn(`⚠️  Socket disconnected: ${reason}. Reconnecting...`);
  });

  socket.on('reconnect', (attempt) => {
    logger.info(`🔄 Socket reconnected after ${attempt} attempt(s)`);
  });

  socket.on('connect_error', (err) => {
    logger.warn(`Socket connect error: ${err.message}. Will retry...`);
  });

  // ── MAIN EVENT: order accepted by shopkeeper ──────────────────────────────
  socket.on('order:accepted', async (data) => {
    logger.info(`🔔 REAL-TIME: order:accepted received — Order #${data.orderNumber || data.orderId}`);

    if (!data.orderId) {
      logger.warn('Received order:accepted with no orderId — skipping');
      return;
    }

    if (printedOrders.has(data.orderId) || printingNow.has(data.orderId)) {
      logger.info(`Order ${data.orderId} already printed or in progress — skipping`);
      return;
    }

    // Fetch full order details from backend
    try {
      const res = await api.get(`/orders/${data.orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (!order) {
        logger.warn(`Could not fetch order ${data.orderId}`);
        return;
      }
      await processOrder(order);
    } catch (err) {
      logger.error(`Failed to fetch order ${data.orderId}: ${err.message}`);
    }
  });

  // ── Listen for manual trigger from shopkeeper dashboard ──────────────────
  socket.on('print:trigger', async (data) => {
    logger.info(`🖨️  Manual print trigger for Order #${data.orderNumber || data.orderId}`);
    if (printedOrders.has(data.orderId) || printingNow.has(data.orderId)) return;
    try {
      const res = await api.get(`/orders/${data.orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (order) await processOrder(order);
    } catch (err) {
      logger.error(`Failed to process manual trigger: ${err.message}`);
    }
  });

  return socket;
}

// ─── API Calls ────────────────────────────────────────────────────────────────
async function getDocumentDownloadUrl(orderId, docId) {
  const res = await api.get(`/orders/${orderId}/documents/${docId}/url`);
  const url = res.data.data?.downloadUrl;
  if (!url) throw new Error('Backend returned no download URL');
  return url;
}

async function markOrderPrinting(orderId) {
  await api.patch(`/orders/${orderId}/auto-printed`);
}

// ─── Download PDF ─────────────────────────────────────────────────────────────
async function downloadPDF(s3Url, filename) {
  const tmpPath = path.join(os.tmpdir(), filename);
  const res = await axios.get(s3Url, { responseType: 'arraybuffer', timeout: 60000 });
  fs.writeFileSync(tmpPath, res.data);
  logger.info(`  Downloaded → ${tmpPath}`);
  return tmpPath;
}

// ─── Build Printer Options ────────────────────────────────────────────────────
function buildPrinterOptions(doc) {
  const opts = {};
  if (PRINTER_NAME) opts.printer = PRINTER_NAME;

  // Support both old field names and new printingOptions structure
  const printOpts = doc.printingOptions || doc;
  const copies    = printOpts.copies    || doc.copies    || 1;
  const colorMode = printOpts.colorMode || doc.colorType || 'bw';
  const sides     = printOpts.sides     || (doc.doubleSided ? 'double' : 'single');
  const paperSize = printOpts.paperSize || doc.paperSize || 'A4';

  if (copies > 1) opts.copies = copies;

  const paperMap = { A4: 'A4', A3: 'A3', Letter: 'Letter' };
  if (paperMap[paperSize]) opts.paperSize = paperMap[paperSize];

  if (sides === 'double') opts.duplex = 'DuplexLongEdge';
  if (colorMode === 'bw') opts.monochrome = true;

  return opts;
}

// ─── Print Single Document ────────────────────────────────────────────────────
async function printDocument(order, doc) {
  const tag = `[#${order.orderNumber || order._id.slice(-6)} | doc ${doc._id.slice(-4)}]`;

  logger.info(`${tag} Getting signed URL...`);
  const s3Url = await getDocumentDownloadUrl(order._id, doc._id);

  logger.info(`${tag} Downloading PDF...`);
  const filename = `sx_${order._id}_${doc._id}.pdf`;
  const tmpPath  = await downloadPDF(s3Url, filename);

  const opts = buildPrinterOptions(doc);
  logger.info(`${tag} Printing with options: ${JSON.stringify(opts)}`);
  await printer.print(tmpPath, opts);
  logger.info(`${tag} ✅ Sent to printer`);

  try { fs.unlinkSync(tmpPath); } catch (_) {}
}

// ─── Process Full Order ───────────────────────────────────────────────────────
async function processOrder(order) {
  if (order.status !== 'accepted') {
    logger.info(`Order ${order._id} status is '${order.status}' — skipping (not accepted)`);
    return;
  }

  if (printedOrders.has(order._id) || printingNow.has(order._id)) {
    logger.info(`Order ${order._id} already handled — skipping`);
    return;
  }

  printingNow.add(order._id);
  const tag = `Order #${order.orderNumber || order._id.slice(-6)}`;
  logger.info(`${tag} ▶ Processing (${order.documents?.length || 0} doc(s))`);

  try {
    for (const doc of (order.documents || [])) {
      let attempt = 0;
      let success = false;

      while (attempt < MAX_RETRIES && !success) {
        try {
          await printDocument(order, doc);
          success = true;
        } catch (err) {
          attempt++;
          logger.warn(`${tag} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
          if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 3000));
        }
      }

      if (!success) {
        const fails = (retryCount.get(order._id) || 0) + 1;
        retryCount.set(order._id, fails);
        logger.error(`${tag} ❌ PRINT FAILED after ${MAX_RETRIES} attempts`);
        printingNow.delete(order._id);
        return;
      }
    }

    // All docs printed — update backend status → triggers Socket.IO to user
    await markOrderPrinting(order._id);
    printedOrders.add(order._id);
    retryCount.delete(order._id);
    logger.info(`${tag} ✅ COMPLETE — status → printing, user notified in real-time`);

  } catch (err) {
    logger.error(`${tag} Unexpected error: ${err.message}`);
    printedOrders.add(order._id); // prevent infinite retry
  } finally {
    printingNow.delete(order._id);
  }
}

// ─── Fallback Polling (safety net for missed socket events) ──────────────────
async function fallbackPoll() {
  if (fallbackPolling) return;
  fallbackPolling = true;

  try {
    logger.info('🔄 Fallback poll — checking for missed accepted orders...');
    const res = await api.get('/orders/shop/orders?status=accepted&limit=50');
    const orders = res.data.data?.orders || res.data.orders || [];

    const missed = orders.filter(o =>
      !printedOrders.has(o._id) &&
      !printingNow.has(o._id) &&
      (retryCount.get(o._id) || 0) < MAX_RETRIES
    );

    if (missed.length > 0) {
      logger.info(`Fallback: found ${missed.length} unprinted accepted order(s)`);
      for (const order of missed) await processOrder(order);
    }

  } catch (err) {
    if (err.response?.status !== 401) logger.warn(`Fallback poll error: ${err.message}`);
  } finally {
    fallbackPolling = false;
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  logger.info('═══════════════════════════════════════════════════');
  logger.info('  Smart Xerox Print Agent — REAL-TIME MODE');
  logger.info(`  Backend : ${API_URL}`);
  logger.info(`  Socket  : ${SOCKET_URL}`);
  logger.info(`  Printer : ${PRINTER_NAME || '(system default)'}`);
  logger.info(`  Fallback: every ${POLL_MS / 1000}s`);
  logger.info('═══════════════════════════════════════════════════');

  // List printers
  try {
    const printers = await printer.getPrinters();
    logger.info('Available printers:');
    printers.forEach((p, i) =>
      logger.info(`  ${i + 1}. ${p.name}${p.isDefault ? '  ← DEFAULT' : ''}`)
    );
    if (PRINTER_NAME && !printers.find(p => p.name === PRINTER_NAME)) {
      logger.warn(`⚠️  PRINTER_NAME="${PRINTER_NAME}" not found! Update .env`);
    }
  } catch {
    logger.warn('Could not list printers');
  }

  // Connect Socket.IO for real-time events
  connectSocket();

  // Fallback poll (every 60s) to catch any missed socket events
  setInterval(fallbackPoll, POLL_MS);

  // Run fallback immediately on start to pick up any pending orders
  setTimeout(fallbackPoll, 3000);
}

start();