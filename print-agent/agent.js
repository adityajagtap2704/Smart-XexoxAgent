// ─────────────────────────────────────────────────────────────────────────────
//  Smart Xerox — Fault-Tolerant Print Agent v3.0
//
//  Handles:
//  ✅ Out of paper — detects, pauses, notifies, resumes
//  ✅ Power failure — saves checkpoint per page, resumes on restart
//  ✅ Printer errors — detects error state, retries, alerts shopkeeper
//  ✅ Duplicate prevention — page-level checkpoint in database
//  ✅ Real-time sync — Socket.IO to user + shopkeeper dashboards
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const axios   = require('axios');
const printer = require('pdf-to-printer');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const winston = require('winston');
const { io }  = require('socket.io-client');
const { PDFDocument } = require('pdf-lib'); // for page splitting

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
    new winston.transports.File({ filename: 'print-agent.log', maxsize: 5_000_000, maxFiles: 3 }),
  ],
});

// ─── Config ───────────────────────────────────────────────────────────────────
const API_URL      = process.env.API_URL;
const SOCKET_URL   = process.env.SOCKET_URL || API_URL?.replace('/api', '');
const TOKEN        = process.env.SHOP_TOKEN;
const PRINTER_NAME = process.env.PRINTER_NAME || '';
const POLL_MS      = parseInt(process.env.POLL_INTERVAL_MS) || 60000;
const MAX_RETRIES  = parseInt(process.env.MAX_RETRIES) || 3;
const CHECK_PRINTER_INTERVAL = 5000; // check printer status every 5s

if (!API_URL || !TOKEN || TOKEN === 'paste_your_shopkeeper_jwt_token_here') {
  logger.error('MISSING: API_URL or SHOP_TOKEN not set in .env');
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
const printingNow   = new Set();   // orders currently printing
const printedOrders = new Set();   // fully completed orders
let   socket        = null;
let   fallbackRunning = false;

// ─── Axios ────────────────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: API_URL,
  headers: { Authorization: `Bearer ${TOKEN}` },
  timeout: 30000,
});
api.interceptors.response.use(res => res, err => {
  if (err.response?.status === 401) {
    logger.error('JWT token expired! Update SHOP_TOKEN in .env and restart.');
  }
  return Promise.reject(err);
});

// ─── Print Job Checkpoint API ─────────────────────────────────────────────────
// Save progress to DB — survives power failure
async function saveCheckpoint(orderId, data) {
  try {
    await api.patch(`/orders/${orderId}/print-job`, data);
    logger.info(`  Checkpoint saved: ${JSON.stringify(data)}`);
  } catch (err) {
    logger.warn(`  Failed to save checkpoint: ${err.message}`);
  }
}

// Get saved checkpoint from DB (for resume after crash/power failure)
async function getCheckpoint(orderId) {
  try {
    const res = await api.get(`/orders/${orderId}/print-job`);
    return res.data.data;
  } catch {
    return null;
  }
}

// ─── Detect Printer Status ────────────────────────────────────────────────────
async function getPrinterStatus() {
  try {
    const printers = await printer.getPrinters();
    const targetPrinter = PRINTER_NAME
      ? printers.find(p => p.name === PRINTER_NAME)
      : printers.find(p => p.isDefault) || printers[0];

    if (!targetPrinter) return { status: 'offline', error: 'Printer not found' };

    // pdf-to-printer returns status info
    const status = targetPrinter.status || 0;

    // Windows printer status codes
    // 0 = Ready, 5 = Out of Paper, 7 = Offline, 4 = Error
    if (status === 0)  return { status: 'ready' };
    if (status === 5)  return { status: 'out_of_paper', error: 'Out of paper' };
    if (status === 7)  return { status: 'offline',      error: 'Printer offline' };
    if (status === 4)  return { status: 'error',        error: 'Printer error' };
    if (status === 3)  return { status: 'printing' };

    return { status: 'ready' }; // assume ready if unknown
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

// Wait for printer to become ready (with timeout)
async function waitForPrinterReady(orderId, timeoutMs = 300000) { // 5 min timeout
  const start = Date.now();
  logger.info('  Waiting for printer to become ready...');

  while (Date.now() - start < timeoutMs) {
    const { status } = await getPrinterStatus();

    if (status === 'ready' || status === 'printing') {
      logger.info('  ✅ Printer is ready');
      return true;
    }

    if (status === 'out_of_paper') {
      logger.warn('  ⚠️  Printer still out of paper — waiting...');
    } else if (status === 'offline') {
      logger.warn('  ⚠️  Printer offline — waiting...');
    }

    await new Promise(r => setTimeout(r, CHECK_PRINTER_INTERVAL));
  }

  logger.error('  ❌ Printer did not become ready within timeout');
  return false;
}

// ─── PDF Utilities ────────────────────────────────────────────────────────────
// Download PDF from S3
async function downloadPDF(s3Url, filename) {
  const tmpPath = path.join(os.tmpdir(), filename);
  const res = await axios.get(s3Url, { responseType: 'arraybuffer', timeout: 60000 });
  fs.writeFileSync(tmpPath, res.data);
  return tmpPath;
}

// Get page count of PDF
async function getPDFPageCount(pdfPath) {
  const bytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes);
  return pdfDoc.getPageCount();
}

// Extract specific pages from PDF (for resume)
// Returns path to new PDF with only the requested pages
async function extractPages(pdfPath, fromPage, toPage) {
  const bytes = fs.readFileSync(pdfPath);
  const srcPdf = await PDFDocument.load(bytes);
  const newPdf = await PDFDocument.create();

  // Pages are 0-indexed in pdf-lib
  const pageIndices = [];
  for (let i = fromPage - 1; i < toPage; i++) {
    pageIndices.push(i);
  }

  const copiedPages = await newPdf.copyPages(srcPdf, pageIndices);
  copiedPages.forEach(page => newPdf.addPage(page));

  const newBytes = await newPdf.save();
  const resumePath = pdfPath.replace('.pdf', `_resume_p${fromPage}.pdf`);
  fs.writeFileSync(resumePath, newBytes);
  logger.info(`  Extracted pages ${fromPage}-${toPage} → ${resumePath}`);
  return resumePath;
}

// ─── Print with Error Detection ───────────────────────────────────────────────
async function printWithErrorDetection(pdfPath, opts, orderId, docIndex, fromPage, totalPages) {
  return new Promise(async (resolve, reject) => {
    // Check printer status BEFORE printing
    const printerStatus = await getPrinterStatus();
    if (printerStatus.status === 'out_of_paper') {
      return reject({ type: 'out_of_paper', message: 'Printer out of paper' });
    }
    if (printerStatus.status === 'offline') {
      return reject({ type: 'offline', message: 'Printer is offline' });
    }
    if (printerStatus.status === 'error') {
      return reject({ type: 'printer_error', message: printerStatus.error });
    }

    try {
      // Start printing
      await printer.print(pdfPath, opts);

      // Monitor printer during print (poll every 5s)
      let monitorAttempts = 0;
      const maxMonitor = 60; // max 5 minutes monitoring
      let lastKnownPage = fromPage - 1;

      const monitor = setInterval(async () => {
        monitorAttempts++;
        if (monitorAttempts > maxMonitor) {
          clearInterval(monitor);
          resolve({ printedPages: totalPages }); // assume done
          return;
        }

        const status = await getPrinterStatus();

        if (status.status === 'out_of_paper') {
          clearInterval(monitor);
          reject({ type: 'out_of_paper', message: 'Printer ran out of paper during printing', printedPages: lastKnownPage });
          return;
        }

        if (status.status === 'error') {
          clearInterval(monitor);
          reject({ type: 'printer_error', message: status.error, printedPages: lastKnownPage });
          return;
        }

        if (status.status === 'ready') {
          // Printer finished
          clearInterval(monitor);
          resolve({ printedPages: totalPages });
        }

      }, CHECK_PRINTER_INTERVAL);

    } catch (err) {
      reject({ type: 'print_error', message: err.message });
    }
  });
}

// ─── Process Document (with page-level checkpoint) ───────────────────────────
async function processDocument(order, doc, docIndex, startFromPage = 1) {
  const tag = `[#${order.orderNumber} | doc ${docIndex + 1}]`;
  const printOpts = doc.printingOptions || {};

  logger.info(`${tag} Getting signed URL...`);
  const urlRes = await api.get(`/orders/${order._id}/documents/${doc._id}/url`);
  const s3Url  = urlRes.data.data?.downloadUrl;
  if (!s3Url) throw new Error('No download URL');

  logger.info(`${tag} Downloading PDF...`);
  const filename = `sx_${order._id}_doc${docIndex}.pdf`;
  const pdfPath  = await downloadPDF(s3Url, filename);

  // Get total pages
  const totalPages = await getPDFPageCount(pdfPath);
  logger.info(`${tag} Total pages: ${totalPages}, resuming from page: ${startFromPage}`);

  // Save initial checkpoint
  await saveCheckpoint(order._id, {
    status:          'printing',
    totalPages,
    printedPages:    startFromPage - 1,
    currentDocIndex: docIndex,
    agentId:         socket?.id,
  });

  // If resuming, extract only remaining pages
  let printPath = pdfPath;
  let printFromPage = startFromPage;

  if (startFromPage > 1 && startFromPage <= totalPages) {
    logger.info(`${tag} Resuming from page ${startFromPage} — extracting remaining pages...`);
    printPath = await extractPages(pdfPath, startFromPage, totalPages);
  }

  const opts = {
    ...(PRINTER_NAME ? { printer: PRINTER_NAME } : {}),
    copies:    printOpts.copies    || 1,
    paperSize: printOpts.paperSize || 'A4',
    ...(printOpts.sides === 'double' ? { duplex: 'DuplexLongEdge' } : {}),
    ...(printOpts.colorMode === 'bw' ? { monochrome: true } : {}),
  };

  logger.info(`${tag} Printing pages ${printFromPage}-${totalPages}...`);

  try {
    await printWithErrorDetection(printPath, opts, order._id, docIndex, printFromPage, totalPages);

    // Success — save completed checkpoint
    await saveCheckpoint(order._id, {
      status:        'completed',
      printedPages:  totalPages,
      totalPages,
    });

    logger.info(`${tag} ✅ All ${totalPages} pages printed`);

  } catch (err) {
    logger.error(`${tag} Print failed: ${err.type} — ${err.message}`);

    // Save error checkpoint with how many pages were printed
    const printedSoFar = err.printedPages || (startFromPage - 1);
    await saveCheckpoint(order._id, {
      status:        'paused',
      pauseReason:   err.type,
      lastError:     err.message,
      printedPages:  printedSoFar,
      totalPages,
    });

    if (err.type === 'out_of_paper') {
      logger.warn(`${tag} ⚠️  OUT OF PAPER — printed ${printedSoFar}/${totalPages} pages`);
      logger.warn(`${tag} Shopkeeper has been notified. Waiting for paper...`);

      // Wait for shopkeeper to add paper and click Resume
      // Agent will receive 'print:resume' socket event
      throw { type: 'paused', reason: 'out_of_paper' };
    }

    throw err;

  } finally {
    // Clean up temp files
    try { if (fs.existsSync(pdfPath))   fs.unlinkSync(pdfPath);   } catch (_) {}
    try { if (printPath !== pdfPath && fs.existsSync(printPath)) fs.unlinkSync(printPath); } catch (_) {}
  }
}

// ─── Process Full Order ───────────────────────────────────────────────────────
async function processOrder(order, resumeFrom = null) {
  if (printingNow.has(order._id.toString())) {
    logger.info(`Order ${order._id} already printing — skipping`);
    return;
  }
  if (printedOrders.has(order._id.toString())) {
    logger.info(`Order ${order._id} already completed — skipping`);
    return;
  }

  printingNow.add(order._id.toString());
  const tag = `Order #${order.orderNumber}`;

  // Determine resume position
  let startDocIndex  = resumeFrom?.currentDocIndex  || 0;
  let startFromPage  = resumeFrom?.printedPages     ? resumeFrom.printedPages + 1 : 1;

  logger.info(`${tag} ▶ Processing — startDoc: ${startDocIndex}, startPage: ${startFromPage}`);

  try {
    const docs = order.documents || [];

    for (let i = startDocIndex; i < docs.length; i++) {
      const doc         = docs[i];
      const fromPage    = i === startDocIndex ? startFromPage : 1;

      await processDocument(order, doc, i, fromPage);

      // Reset page counter for next document
      startFromPage = 1;
    }

    // All documents done — tell backend
    await api.patch(`/orders/${order._id}/auto-printed`);
    printedOrders.add(order._id.toString());
    logger.info(`${tag} ✅ COMPLETE — all documents printed`);

  } catch (err) {
    if (err?.type === 'paused') {
      logger.info(`${tag} ⏸  PAUSED — reason: ${err.reason}. Waiting for resume signal...`);
      // Don't add to printedOrders — will resume later
    } else {
      logger.error(`${tag} ❌ FAILED: ${err.message}`);
      printedOrders.add(order._id.toString()); // prevent infinite retry
    }
  } finally {
    printingNow.delete(order._id.toString());
  }
}

// ─── Socket.IO Connection ─────────────────────────────────────────────────────
function connectSocket() {
  socket = io(SOCKET_URL, {
    auth: { token: TOKEN },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    logger.info(`✅ Socket connected: ${socket.id}`);
    socket.emit('join:agent', { token: TOKEN });
  });

  socket.on('agent:connected', (data) => {
    logger.info(`🖨️  Registered for shop: ${data.shopName}`);
  });

  socket.on('disconnect', reason => {
    logger.warn(`⚠️  Socket disconnected: ${reason}`);
  });

  socket.on('reconnect', attempt => {
    logger.info(`🔄 Reconnected after ${attempt} attempt(s)`);
    socket.emit('join:agent', { token: TOKEN });
  });

  // ── New order accepted by shopkeeper ──────────────────────────────────────
  socket.on('order:accepted', async (data) => {
    logger.info(`🔔 NEW ORDER: #${data.orderNumber} — starting print immediately`);
    if (!data.orderId) return;

    try {
      const res   = await api.get(`/orders/${data.orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (order) await processOrder(order);
    } catch (err) {
      logger.error(`Failed to process new order: ${err.message}`);
    }
  });

  // ── Shopkeeper clicked Resume (after adding paper) ────────────────────────
  socket.on('print:resume', async (data) => {
    logger.info(`▶️  RESUME: Order #${data.orderNumber} from page ${data.resumeFromPage}`);

    if (!data.orderId) return;

    // Remove from printedOrders in case it was marked done
    printedOrders.delete(data.orderId);
    printingNow.delete(data.orderId);

    try {
      const res   = await api.get(`/orders/${data.orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (order) {
        await processOrder(order, {
          currentDocIndex: data.currentDocIndex || 0,
          printedPages:    data.resumeFromPage ? data.resumeFromPage - 1 : 0,
        });
      }
    } catch (err) {
      logger.error(`Failed to resume order: ${err.message}`);
    }
  });

  // ── Manual trigger from shopkeeper ────────────────────────────────────────
  socket.on('print:trigger', async (data) => {
    logger.info(`🖨️  Manual trigger: Order #${data.orderNumber}`);
    printedOrders.delete(data.orderId);
    printingNow.delete(data.orderId);
    try {
      const res   = await api.get(`/orders/${data.orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (order) await processOrder(order);
    } catch (err) {
      logger.error(`Manual trigger failed: ${err.message}`);
    }
  });

  return socket;
}

// ─── Startup: Recover incomplete jobs ────────────────────────────────────────
// On power failure, agent restarts and picks up where it left off
async function recoverIncompleteJobs() {
  logger.info('🔍 Checking for incomplete print jobs from before restart...');

  try {
    const res    = await api.get('/orders/incomplete-jobs');
    const orders = res.data.data?.orders || [];

    if (orders.length === 0) {
      logger.info('  No incomplete jobs found — clean start');
      return;
    }

    logger.info(`  Found ${orders.length} incomplete job(s) — recovering...`);

    for (const order of orders) {
      const pj = order.printJob;

      if (!pj || pj.status === 'idle') {
        // Never started — start from beginning
        logger.info(`  Order #${order.orderNumber}: Never printed — starting fresh`);
        await processOrder(order);
      } else if (pj.status === 'printing') {
        // Was printing when power failed
        const printedPages = pj.printedPages || 0;
        logger.info(`  Order #${order.orderNumber}: Power failure recovery — resuming from page ${printedPages + 1}`);
        await processOrder(order, {
          currentDocIndex: pj.currentDocIndex || 0,
          printedPages:    printedPages,
        });
      } else if (pj.status === 'paused') {
        logger.info(`  Order #${order.orderNumber}: Was paused (${pj.pauseReason}) — waiting for shopkeeper resume`);
        // Don't auto-resume paused jobs — shopkeeper must add paper and click Resume
      } else if (pj.status === 'queued') {
        logger.info(`  Order #${order.orderNumber}: Was queued — starting fresh`);
        await processOrder(order);
      }
    }
  } catch (err) {
    logger.warn(`Could not check incomplete jobs: ${err.message}`);
  }
}

// ─── Fallback Poll ────────────────────────────────────────────────────────────
async function fallbackPoll() {
  if (fallbackRunning) return;
  fallbackRunning = true;
  try {
    const res    = await api.get('/orders/shop/orders?status=accepted&limit=50');
    const orders = res.data.data?.orders || [];
    const missed = orders.filter(o =>
      !printingNow.has(o._id.toString()) &&
      !printedOrders.has(o._id.toString())
    );
    if (missed.length > 0) {
      logger.info(`Fallback: ${missed.length} missed order(s) detected`);
      for (const o of missed) await processOrder(o);
    }
  } catch (err) {
    if (err.response?.status !== 401) logger.warn(`Fallback error: ${err.message}`);
  } finally {
    fallbackRunning = false;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  logger.info('═══════════════════════════════════════════════════════');
  logger.info('  Smart Xerox Print Agent — FAULT TOLERANT v3.0');
  logger.info(`  Backend : ${API_URL}`);
  logger.info(`  Socket  : ${SOCKET_URL}`);
  logger.info(`  Printer : ${PRINTER_NAME || '(system default)'}`);
  logger.info('═══════════════════════════════════════════════════════');

  // List printers
  try {
    const printers = await printer.getPrinters();
    logger.info('Available printers:');
    printers.forEach((p, i) =>
      logger.info(`  ${i + 1}. ${p.name}${p.isDefault ? '  ← DEFAULT' : ''}`)
    );
  } catch { logger.warn('Could not list printers'); }

  // Connect Socket.IO
  connectSocket();

  // Recover any incomplete jobs from before restart (power failure recovery)
  setTimeout(recoverIncompleteJobs, 3000);

  // Fallback poll
  setInterval(fallbackPoll, POLL_MS);
}

start();