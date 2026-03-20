// ─────────────────────────────────────────────────────────────────────────────
//  Smart Xerox — Print Agent
//  File: print-agent/agent.js
//
//  Runs permanently on the shop's Windows PC.
//  Every POLL_INTERVAL_MS it checks the backend for newly accepted orders.
//  When found: downloads PDF from S3 → sends to printer → updates status.
//
//  The user's browser screen updates to "Printing" automatically via Socket.IO
//  the moment this agent calls the /auto-printed endpoint.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const axios   = require('axios');
const printer = require('pdf-to-printer');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const winston = require('winston');

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
      maxsize: 5_000_000,  // 5 MB
      maxFiles: 3,
    }),
  ],
});

// ─── Config validation ────────────────────────────────────────────────────────
const API_URL      = process.env.API_URL;
const TOKEN        = process.env.SHOP_TOKEN;
const PRINTER_NAME = process.env.PRINTER_NAME || '';
const POLL_MS      = parseInt(process.env.POLL_INTERVAL_MS) || 5000;
const MAX_RETRIES  = parseInt(process.env.MAX_RETRIES) || 3;

if (!API_URL) {
  logger.error('MISSING: API_URL is not set in .env file');
  process.exit(1);
}
if (!TOKEN || TOKEN === 'paste_your_shopkeeper_jwt_token_here') {
  logger.error('MISSING: SHOP_TOKEN is not set in .env file');
  logger.error('Get it from: Chrome → F12 → Application → Local Storage → token');
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
const printedOrders = new Set();   // orders already sent to printer this session
const retryCount    = new Map();   // orderId → number of failed print attempts
let   isPolling     = false;       // prevent overlapping polls

// ─── Axios instance ───────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: API_URL,
  headers: { Authorization: `Bearer ${TOKEN}` },
  timeout: 20000,
});

// Handle 401 — token expired
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      logger.error('JWT token expired or invalid!');
      logger.error('Fix: get a fresh token from Chrome DevTools and update SHOP_TOKEN in .env');
      logger.error('Then restart: pm2 restart SmartXerox-PrintAgent');
    }
    return Promise.reject(err);
  }
);

// ─── API calls ────────────────────────────────────────────────────────────────
async function fetchAcceptedOrders() {
  const res = await api.get('/orders/shop/orders?status=accepted&limit=50');
  return res.data.data?.orders || res.data.orders || [];
}

async function getDocumentDownloadUrl(orderId, docId) {
  const res = await api.get(`/orders/${orderId}/documents/${docId}/url`);
  const url = res.data.data?.downloadUrl;
  if (!url) throw new Error('Backend returned no download URL');
  return url;
}

async function markOrderPrinting(orderId) {
  await api.patch(`/orders/${orderId}/auto-printed`);
}

// ─── Download PDF from S3 ─────────────────────────────────────────────────────
async function downloadPDF(s3Url, filename) {
  const tmpPath = path.join(os.tmpdir(), filename);
  const res = await axios.get(s3Url, {
    responseType: 'arraybuffer',
    timeout: 60000,  // 60s for large files
  });
  fs.writeFileSync(tmpPath, res.data);
  logger.info(`  Downloaded to temp: ${tmpPath}`);
  return tmpPath;
}

// ─── Build printer options from order document settings ──────────────────────
function buildPrinterOptions(doc) {
  const opts = {};

  // Printer name
  if (PRINTER_NAME) opts.printer = PRINTER_NAME;

  // Copies (pdf-to-printer handles this natively)
  if (doc.copies && doc.copies > 1) opts.copies = doc.copies;

  // Paper size
  const paperMap = { A4: 'A4', A3: 'A3', Letter: 'Letter' };
  if (doc.paperSize && paperMap[doc.paperSize]) {
    opts.paperSize = paperMap[doc.paperSize];
  }

  // Double-sided / duplex
  if (doc.doubleSided) {
    opts.duplex = 'DuplexLongEdge';
  }

  // B&W / monochrome
  if (doc.colorType === 'bw') {
    opts.monochrome = true;
  }

  return opts;
}

// ─── Print a single document ──────────────────────────────────────────────────
async function printDocument(order, doc) {
  const tag = `[#${order.orderNumber || order._id.slice(-6)} | doc ${doc._id.slice(-4)}]`;

  logger.info(`${tag} Getting S3 signed URL from backend...`);
  const s3Url = await getDocumentDownloadUrl(order._id, doc._id);

  const filename = `smartxerox_${order._id}_${doc._id}.pdf`;
  logger.info(`${tag} Downloading PDF...`);
  const tmpPath = await downloadPDF(s3Url, filename);

  const opts = buildPrinterOptions(doc);
  logger.info(`${tag} Sending to printer with options: ${JSON.stringify(opts)}`);

  await printer.print(tmpPath, opts);
  logger.info(`${tag} Sent to printer successfully`);

  // Clean up temp file
  try { fs.unlinkSync(tmpPath); } catch (_) {}
}

// ─── Process one full order (may have multiple documents) ─────────────────────
async function processOrder(order) {
  const tag = `Order #${order.orderNumber || order._id.slice(-6)}`;
  logger.info(`${tag} — starting (${order.documents.length} doc(s), customer: ${order.user?.name || 'unknown'})`);

  for (const doc of order.documents) {
    let attempt = 0;
    let success = false;

    while (attempt < MAX_RETRIES && !success) {
      try {
        await printDocument(order, doc);
        success = true;
      } catch (err) {
        attempt++;
        logger.warn(`${tag} doc ${doc._id.slice(-4)} — attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          logger.info(`${tag} Retrying in 3 seconds...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    if (!success) {
      // Track consecutive failures
      const fails = (retryCount.get(order._id) || 0) + 1;
      retryCount.set(order._id, fails);

      if (fails >= 3) {
        logger.error(`${tag} — giving up after ${fails} poll cycles of failures. Mark as printed to avoid loop.`);
        printedOrders.add(order._id);
      }

      logger.error(`${tag} — PRINT FAILED for doc ${doc._id.slice(-4)}. Manual intervention needed.`);
      return; // Don't advance status if print failed
    }
  }

  // All docs printed — tell backend to move status to 'printing'
  // This triggers real-time Socket.IO push to user's browser
  try {
    await markOrderPrinting(order._id);
    printedOrders.add(order._id);
    retryCount.delete(order._id);
    logger.info(`${tag} — COMPLETE. Status → printing. User notified in real-time.`);
  } catch (err) {
    logger.error(`${tag} — Printed OK but failed to update status: ${err.message}`);
    // Still mark locally so we don't reprint
    printedOrders.add(order._id);
  }
}

// ─── Main poll loop ───────────────────────────────────────────────────────────
async function poll() {
  if (isPolling) return;
  isPolling = true;

  try {
    const orders = await fetchAcceptedOrders();

    const pending = orders.filter(o =>
      !printedOrders.has(o._id) &&
      (retryCount.get(o._id) || 0) < 3
    );

    if (pending.length > 0) {
      logger.info(`Found ${pending.length} new order(s) to print`);
    }

    // Process sequentially to avoid printer queue conflicts
    for (const order of pending) {
      await processOrder(order);
    }

  } catch (err) {
    if (err.response?.status !== 401) {
      logger.warn(`Poll error: ${err.message}`);
    }
  } finally {
    isPolling = false;
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  logger.info('═══════════════════════════════════════════════');
  logger.info('  Smart Xerox Print Agent — STARTED');
  logger.info(`  Backend: ${API_URL}`);
  logger.info(`  Printer: ${PRINTER_NAME || '(system default)'}`);
  logger.info(`  Poll:    every ${POLL_MS / 1000}s`);
  logger.info('═══════════════════════════════════════════════');

  // List available printers so shopkeeper can verify the name
  try {
    const printers = await printer.getPrinters();
    logger.info('Available printers on this PC:');
    printers.forEach((p, i) => {
      logger.info(`  ${i + 1}. ${p.name}${p.isDefault ? '  ← DEFAULT' : ''}`);
    });
    if (PRINTER_NAME && !printers.find(p => p.name === PRINTER_NAME)) {
      logger.warn(`WARNING: PRINTER_NAME="${PRINTER_NAME}" not found in the list above!`);
      logger.warn('Update PRINTER_NAME in .env to match exactly, then restart.');
    }
  } catch {
    logger.warn('Could not list printers — printing may still work if default is set');
  }

  // Start polling
  setInterval(poll, POLL_MS);
  poll(); // run immediately on start
}

start();
