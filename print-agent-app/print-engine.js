/**
 * Smart Xerox — Print Engine (Fault-Tolerant)
 * ─────────────────────────────────────────────
 * Core logic: Socket.IO connection, PDF download, pdf-to-printer dispatch.
 * NOW with:
 *  • Per-document checkpoint saving (survives power failure)
 *  • Automatic resume on startup from incomplete jobs
 *  • Pause/resume on paper-out or printer errors
 *  • Local state persistence via electron-store
 *
 * Runs inside Electron's main process. No UI code here.
 */

const axios       = require('axios');
const printer     = require('pdf-to-printer');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { io }      = require('socket.io-client');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ─── State ───────────────────────────────────────────────────────────────────
const printedOrders = new Set();
const printingNow   = new Set();
const pausedOrders  = new Map();   // orderId → { order, checkpoint }
const retryCount    = new Map();
const pendingQueue  = [];         // FIFO queue for incoming orders
let   activeOrderId = null;
let   socket        = null;
let   api           = null;
let   localStore    = null;        // electron-store instance (injected from main.js)
let   config        = { apiUrl: '', token: '', printerName: '', socketUrl: '' };
let   eventCallback = () => {};
let   fallbackTimer = null;
let   printerCheckTimer = null;

const MAX_RETRIES = 3;

// ─── Public: Initialize ──────────────────────────────────────────────────────
function init({ apiUrl, token, printerName, onEvent, store }) {
  config.apiUrl      = apiUrl.replace(/\/+$/, '');
  config.token       = token;
  config.printerName = printerName || '';
  config.socketUrl   = apiUrl.replace('/api', '');
  eventCallback      = onEvent || (() => {});
  localStore         = store || null;

  api = axios.create({
    baseURL: config.apiUrl,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });

  api.interceptors.response.use(r => r, err => {
    if (err.response?.status === 401) {
      eventCallback({ type: 'auth_expired', message: 'Session expired. Please re-login.' });
    }
    return Promise.reject(err);
  });

  log('Print engine initialised (fault-tolerant mode)');
}

// ─── Public: Connect Socket ──────────────────────────────────────────────────
function connect() {
  if (socket) socket.disconnect();

  socket = io(config.socketUrl, {
    auth: { token: config.token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 3000,
  });

  socket.on('connect', () => {
    log(`Socket connected: ${socket.id}`);
    socket.emit('join:agent', { token: config.token });
    eventCallback({ type: 'connected', socketId: socket.id });

    // ── On (re)connect, recover any incomplete print jobs ───────────────
    setTimeout(() => recoverIncompleteJobs(), 2000);
  });

  socket.on('disconnect', (reason) => {
    log(`Socket disconnected: ${reason}`);
    eventCallback({ type: 'disconnected', reason });

    // If we were mid-print, save state locally for power-failure recovery
    saveLocalState();
  });

  socket.on('connect_error', (err) => {
    log(`Connection error: ${err.message}`);
    eventCallback({ type: 'error', message: err.message });
  });

  // ── Main event: order accepted ─────────────────────────────────────────────
  socket.on('order:accepted', async (data) => {
    log(`🔔 order:accepted — Order #${data.orderNumber || data.orderId}`);
    if (!data.orderId || printedOrders.has(data.orderId) || pendingQueue.includes(data.orderId) || printingNow.has(data.orderId)) return;
    try {
      const res = await api.get(`/orders/${data.orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (order) enqueueOrder(order);
    } catch (err) {
      log(`Failed to fetch order: ${err.message}`);
    }
  });

  // ── Manual trigger from shopkeeper dashboard ───────────────────────────────
  socket.on('print:trigger', async (data) => {
    log(`🖨️  Manual trigger — Order #${data.orderNumber || data.orderId}`);
    printingNow.delete(data.orderId);
    printedOrders.delete(data.orderId);
    pausedOrders.delete(data.orderId);
    try {
      const res = await api.get(`/orders/${data.orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (order) enqueueOrder(order, true);
    } catch (err) {
      log(`Manual trigger failed: ${err.message}`);
    }
  });

  // ── Resume event from backend (shopkeeper clicked "Resume" after adding paper) ─
  socket.on('print:resume', async (data) => {
    log(`🔄 print:resume — Order #${data.orderNumber || data.orderId}`);
    log(`   Resuming from doc index ${data.currentDocIndex}, page ${data.resumeFromPage}`);

    const orderId = data.orderId?.toString() || data.orderId;
    pausedOrders.delete(orderId);
    printingNow.delete(orderId);
    printedOrders.delete(orderId);

    try {
      const res = await api.get(`/orders/${orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (order) {
        // Resume from checkpoint
        await processOrder(order, {
          resumeFromDocIndex: data.currentDocIndex || 0,
          resumeFromPage:     data.resumeFromPage || 0,
        });
      }
    } catch (err) {
      log(`Resume failed: ${err.message}`);
      eventCallback({ type: 'resume_failed', orderId, error: err.message });
    }
  });

  // ── Start fallback polling (safety check every 5 mins) ───────────────
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = setInterval(fallbackPoll, 300000);

  // ── Start printer status monitoring (every 30 seconds) ────────────────
  if (printerCheckTimer) clearInterval(printerCheckTimer);
  printerCheckTimer = setInterval(checkPrinterStatus, 30000);
  
  return socket;
}

// ─── Public: Disconnect ──────────────────────────────────────────────────────
function disconnect() {
  saveLocalState();
  if (socket) { socket.disconnect(); socket = null; }
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  if (printerCheckTimer) { clearInterval(printerCheckTimer); printerCheckTimer = null; }
  printedOrders.clear();
  printingNow.clear();
  retryCount.clear();
  // Don't clear pausedOrders — they should survive reconnect
  log('Print engine disconnected');
}

// ─── Public: List Printers ───────────────────────────────────────────────────
async function listPrinters() {
  try {
    return await printer.getPrinters();
  } catch {
    return [];
  }
}

// ─── Public: Update Printer ──────────────────────────────────────────────────
function setPrinter(name) {
  config.printerName = name;
  log(`Printer set to: ${name || '(system default)'}`);
}

// ─── Public: Get Status ──────────────────────────────────────────────────────
function getStatus() {
  return {
    connected: socket?.connected || false,
    socketId:  socket?.id || null,
    printer:   config.printerName || '(default)',
    printed:   printedOrders.size,
    active:    printingNow.size,
    paused:    pausedOrders.size,
  };
}

// ─── Public: Get Paused Jobs ─────────────────────────────────────────────────
function getPausedJobs() {
  const jobs = [];
  for (const [orderId, data] of pausedOrders) {
    jobs.push({
      orderId,
      orderNumber:  data.order?.orderNumber || orderId.slice(-6).toUpperCase(),
      printedPages: data.checkpoint?.printedPages || 0,
      totalPages:   data.checkpoint?.totalPages || 0,
      currentDocIndex: data.checkpoint?.currentDocIndex || 0,
      totalDocs:    data.order?.documents?.length || 0,
      pauseReason:  data.checkpoint?.pauseReason || 'unknown',
      pausedAt:     data.checkpoint?.pausedAt || new Date().toISOString(),
    });
  }
  return jobs;
}

// ─── Public: Pause a running print job ───────────────────────────────────────
async function pausePrintJob(orderId, reason = 'manual') {
  const tag = `[Pause ${orderId.slice(-6)}]`;
  log(`${tag} Pausing print job — reason: ${reason}`);

  try {
    await saveCheckpoint(orderId, {
      status:      'paused',
      pauseReason: reason,
    });
  } catch (err) {
    log(`${tag} Checkpoint save failed: ${err.message}`);
  }

  eventCallback({
    type: 'print_paused',
    orderId,
    reason,
    pausedJobs: getPausedJobs(),
  });
}

// ─── Public: Resume a paused print job ───────────────────────────────────────
async function resumePrintJob(orderId) {
  const tag = `[Resume ${orderId.slice(-6)}]`;
  log(`${tag} Attempting to resume print job`);

  const paused = pausedOrders.get(orderId);
  if (!paused) {
    log(`${tag} No paused data found — fetching from backend`);
    try {
      const res = await api.get(`/orders/${orderId}`);
      const order = res.data.data?.order || res.data.order;
      if (order && order.printJob) {
        await processOrder(order, {
          resumeFromDocIndex: order.printJob.currentDocIndex || 0,
          resumeFromPage:     order.printJob.printedPages || 0,
        });
      }
    } catch (err) {
      log(`${tag} Resume failed: ${err.message}`);
      eventCallback({ type: 'resume_failed', orderId, error: err.message });
    }
    return;
  }

  const { order, checkpoint } = paused;
  pausedOrders.delete(orderId);
  printingNow.delete(orderId);

  // Update backend that we're resuming
  try {
    await saveCheckpoint(orderId, {
      status:      'printing',
      pauseReason: null,
    });
  } catch {}

  eventCallback({
    type: 'print_resumed',
    orderId,
    orderNumber: order?.orderNumber,
    fromDocIndex: checkpoint?.currentDocIndex || 0,
    fromPage: checkpoint?.printedPages || 0,
  });

  // Re-fetch the order for fresh data
  try {
    const res = await api.get(`/orders/${orderId}`);
    const freshOrder = res.data.data?.order || res.data.order;
    if (freshOrder) {
      await processOrder(freshOrder, {
        resumeFromDocIndex: checkpoint?.currentDocIndex || 0,
        resumeFromPage:     checkpoint?.printedPages || 0,
      });
    }
  } catch (err) {
    log(`${tag} Resume fetch failed: ${err.message}`);
    eventCallback({ type: 'resume_failed', orderId, error: err.message });
  }
}

// ─── Public: Print Specific Order ──────────────────────────────────────────
async function printOrder(orderId) {
  if (!orderId || !api) return;
  log(`🎯 Manual print request for Order ID: ${orderId}`);
  printingNow.delete(orderId);
  printedOrders.delete(orderId);
  pausedOrders.delete(orderId);
  try {
    const res = await api.get(`/orders/${orderId}`);
    const order = res.data.data?.order || res.data.order;
    if (order) enqueueOrder(order, true);
  } catch (err) {
    log(`Print request failed: ${err.message}`);
  }
}

function enqueueOrder(order, skipQueueCheck = false) {
  const orderId = order._id?.toString() || order.orderId;
  if (!orderId) return;
  if (printedOrders.has(orderId) || printingNow.has(orderId)) return;
  if (!skipQueueCheck && pendingQueue.includes(orderId)) return;

  if (activeOrderId || printingNow.size > 0) {
    log(`🧾 Queueing Order #${order.orderNumber || orderId}`);
    if (!pendingQueue.includes(orderId)) pendingQueue.push(orderId);
    eventCallback({ type: 'print_queued', orderId, orderNumber: order.orderNumber, queueLength: pendingQueue.length });
    return;
  }

  processOrder(order);
}

async function processNextOrder() {
  if (activeOrderId || printingNow.size > 0) return;
  if (pendingQueue.length === 0) return;

  const nextOrderId = pendingQueue.shift();
  log(`▶ Dequeued next order: ${nextOrderId}`);
  try {
    const res = await api.get(`/orders/${nextOrderId}`);
    const nextOrder = res.data.data?.order || res.data.order;
    if (nextOrder) await processOrder(nextOrder);
  } catch (err) {
    log(`Failed to fetch queued order ${nextOrderId}: ${err.message}`);
  }
}

// ─── Internal: Order Processing (with resume support) ────────────────────────
async function processOrder(order, resumeOpts = null) {
  if (!['accepted', 'printing'].includes(order.status)) return;
  if (printedOrders.has(order._id) || printingNow.has(order._id)) return;

  activeOrderId = order._id;
  printingNow.add(order._id);
  const tag = `Order #${order.orderNumber || order._id.slice(-6).toUpperCase()}`;
  const docs = order.documents || [];

  // Calculate total pages across all documents and ranges
  const totalPages = docs.reduce((sum, doc) => {
    if (doc.printingRanges && Array.isArray(doc.printingRanges)) {
      // Sum pages from all ranges
      return sum + doc.printingRanges.reduce((rangeSum, range) => {
        const rangePages = (range.rangeEnd - range.rangeStart + 1) * range.copies;
        return rangeSum + rangePages;
      }, 0);
    } else {
      // Fallback for old format
      return sum + calculateDocPages(doc, doc.detectedPages || 1);
    }
  }, 0);

  // Determine starting point
  const startDocIndex = resumeOpts?.resumeFromDocIndex || 0;
  let cumulativePages = 0;

  // Calculate pages already printed (from completed docs before startDocIndex)
  for (let i = 0; i < startDocIndex && i < docs.length; i++) {
    cumulativePages += calculateDocPages(docs[i], docs[i].detectedPages || 1);
  }

  // Collect summary specs for the UI (from first range)
  const firstDoc = docs[0] || {};
  let specs = {
    fileCount: docs.length,
    totalPages,
    printedPages: cumulativePages,
    currentDocIndex: startDocIndex,
  };

  // Extract first range's specs for display
  if (firstDoc.printingRanges && firstDoc.printingRanges.length > 0) {
    const firstRange = firstDoc.printingRanges[0];
    specs.colorMode = firstRange.colorMode || 'bw';
    specs.sides = firstRange.sides || 'single';
    specs.copies = firstRange.copies || 1;
  } else if (firstDoc.printingOptions) {
    const p = firstDoc.printingOptions;
    specs.colorMode = p.colorMode || p.colorType || 'bw';
    specs.sides = p.sides || (p.doubleSided ? 'double' : 'single');
    specs.copies = p.copies || 1;
  } else {
    specs.colorMode = 'bw';
    specs.sides = 'single';
    specs.copies = 1;
  }
  specs.paperSize = firstDoc.printingOptions?.paperSize || firstDoc.paperSize || 'A4';
  specs.isResuming = startDocIndex > 0;

  if (startDocIndex > 0) {
    log(`${tag} ▶ RESUMING from document ${startDocIndex + 1}/${docs.length} (${cumulativePages}/${totalPages} pages already done)`);
  } else {
    log(`${tag} ▶ Processing (${docs.length} doc(s), ${totalPages} pages) — ${specs.copies} copies, ${specs.colorMode.toUpperCase()}, ${specs.paperSize}`);
  }

  eventCallback({
    type: startDocIndex > 0 ? 'print_recovering' : 'printing',
    orderId: order._id,
    orderNumber: order.orderNumber,
    specs,
  });

  // Save initial checkpoint
  try {
    await saveCheckpoint(order._id, {
      status:          'printing',
      printedPages:    cumulativePages,
      totalPages,
      currentDocIndex: startDocIndex,
      agentId:         socket?.id || 'local',
    });
  } catch (err) {
    log(`${tag} Initial checkpoint failed: ${err.message}`);
  }

  try {
    for (let i = startDocIndex; i < docs.length; i++) {
      const doc = docs[i];
      const docTag = `${tag} [Doc ${i + 1}/${docs.length}]`;
      let attempt = 0, success = false;

      while (attempt < MAX_RETRIES && !success) {
        try {
          await printDocument(order, doc);
          success = true;
        } catch (err) {
          attempt++;
          const errMsg = err.message || '';

          // ── Detect paper-out / printer offline errors ──────────────────
          if (isPaperOutError(errMsg) || isPrinterOfflineError(errMsg)) {
            const reason = isPaperOutError(errMsg) ? 'out_of_paper' : 'printer_error';
            log(`${docTag} ⚠️ ${reason.toUpperCase()}: ${errMsg}`);

            // Save checkpoint — this is where we stopped
            pausedOrders.set(order._id, {
              order,
              checkpoint: {
                printedPages:    cumulativePages,
                totalPages,
                currentDocIndex: i,
                pauseReason:     reason,
                pausedAt:        new Date().toISOString(),
              },
            });

            // Save to backend
            try {
              await saveCheckpoint(order._id, {
                status:          'paused',
                printedPages:    cumulativePages,
                totalPages,
                currentDocIndex: i,
                pauseReason:     reason,
                lastError:       errMsg,
                agentId:         socket?.id || 'local',
              });
            } catch {}

            // Save locally for power-failure survival
            saveLocalState();

            log(`${docTag} ⏸️ PAUSED at doc ${i + 1}, page ${cumulativePages}/${totalPages}`);
            eventCallback({
              type: 'print_paused',
              orderId: order._id,
              orderNumber: order.orderNumber,
              reason,
              printedPages: cumulativePages,
              totalPages,
              currentDocIndex: i,
              totalDocs: docs.length,
              pausedJobs: getPausedJobs(),
            });

            printingNow.delete(order._id);
            return; // Stop processing — will resume on print:resume event
          }

          // Normal retry for transient errors
          log(`${docTag} attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}`);
          if (attempt < MAX_RETRIES) await sleep(3000);
        }
      }

      if (!success) {
        retryCount.set(order._id, (retryCount.get(order._id) || 0) + 1);
        log(`${docTag} ❌ PRINT FAILED after ${MAX_RETRIES} attempts`);

        // Save failure checkpoint
        try {
          await saveCheckpoint(order._id, {
            status:          'failed',
            printedPages:    cumulativePages,
            totalPages,
            currentDocIndex: i,
            lastError:       'Max retries exceeded',
            agentId:         socket?.id || 'local',
          });
        } catch {}

        eventCallback({ type: 'print_failed', orderId: order._id, orderNumber: order.orderNumber });
        printingNow.delete(order._id);
        return;
      }

      // ── Document printed successfully — save checkpoint ────────────────
      const docPages = calculateDocPages(doc, doc.detectedPages || 1);
      cumulativePages += docPages;

      log(`${docTag} ✅ Done (${cumulativePages}/${totalPages} pages total)`);

      try {
        await saveCheckpoint(order._id, {
          status:          'printing',
          printedPages:    cumulativePages,
          totalPages,
          currentDocIndex: i + 1, // Next doc to print
          agentId:         socket?.id || 'local',
        });
      } catch (err) {
        log(`${docTag} Checkpoint save failed: ${err.message}`);
      }

      // Save locally too
      saveLocalState();

      // Update UI with progress
      eventCallback({
        type: 'print_progress',
        orderId: order._id,
        orderNumber: order.orderNumber,
        printedPages: cumulativePages,
        totalPages,
        currentDocIndex: i + 1,
        totalDocs: docs.length,
      });
    }

    // ── All docs printed → mark ready + OTP ──────────────────────────────
    await api.patch(`/orders/${order._id}/auto-printed`);
    printedOrders.add(order._id);
    pausedOrders.delete(order._id);
    retryCount.delete(order._id);

    // Save completed checkpoint
    try {
      await saveCheckpoint(order._id, {
        status:       'completed',
        printedPages: totalPages,
        totalPages,
        currentDocIndex: docs.length,
        agentId:      socket?.id || 'local',
      });
    } catch {}

    // Clear from local store
    clearLocalJob(order._id);

    log(`${tag} 🎉 COMPLETE — ${totalPages} pages printed, marked Ready, OTP sent`);
    eventCallback({
      type: 'print_complete',
      orderId: order._id,
      orderNumber: order.orderNumber,
      specs: { ...specs, printedPages: totalPages },
    });

  } catch (err) {
    log(`${tag} Error: ${err.message}`);

    // Save whatever progress we made
    try {
      await saveCheckpoint(order._id, {
        status:          'failed',
        printedPages:    cumulativePages,
        totalPages,
        lastError:       err.message,
        agentId:         socket?.id || 'local',
      });
    } catch {}

    printedOrders.add(order._id);
  } finally {
    printingNow.delete(order._id);
    activeOrderId = null;
    processNextOrder();
  }
}

// ─── Internal: Document Printing ─────────────────────────────────────────────
async function printDocument(order, doc) {
  const tag = `[#${order.orderNumber || order._id.slice(-6)}]`;

  // Get signed download URL
  const urlRes = await api.get(`/orders/${order._id}/documents/${doc._id}/url`);
  const s3Url  = urlRes.data.data?.downloadUrl;
  if (!s3Url) throw new Error('Backend returned no download URL');

  // Download PDF to memory
  const dlRes = await axios.get(s3Url, { responseType: 'arraybuffer', timeout: 60000 });
  if (!dlRes.data || dlRes.data.byteLength === 0) {
    throw new Error('Downloaded file is empty or missing');
  }
  log(`${tag} Downloaded successfully (${dlRes.data.byteLength} bytes)`);

  // ─── Load original PDF ───────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.load(dlRes.data);
  const totalOriginalPages = pdfDoc.getPageCount();

  // Determine if using new range format or old format
  const usesRanges = doc.printingRanges && Array.isArray(doc.printingRanges) && doc.printingRanges.length > 0;
  
  if (!usesRanges) {
    // Old format: single page range per document
    await printDocumentOldFormat(order, doc, pdfDoc, totalOriginalPages, tag);
  } else {
    // New format: multiple ranges per document
    await printDocumentNewFormat(order, doc, pdfDoc, totalOriginalPages, tag);
  }
}

// ─── Old Format Document Printing ────────────────────────────────────────────
async function printDocumentOldFormat(order, doc, pdfDoc, totalOriginalPages, tag) {
  const p = doc.printingOptions || doc;
  const pageRangeStr = p.pageRange || 'all';
  const pageIndices = parsePageIndices(pageRangeStr, totalOriginalPages);

  if (pageIndices.length === 0) {
    throw new Error(`Invalid page range mapping: ${pageRangeStr} for ${totalOriginalPages} pages`);
  }

  // Create chunk with selected pages
  const chunkDoc = await PDFDocument.create();
  const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
  copiedPages.forEach(page => chunkDoc.addPage(page));

  // Stamp OTP if first doc
  await stampOTPIfFirst(order, doc, chunkDoc, tag);

  // Save and print
  const chunkBytes = await chunkDoc.save();
  const filename = `sx_${order._id}_${doc._id}_print.pdf`;
  const tmpPath  = path.join(os.tmpdir(), filename);
  fs.writeFileSync(tmpPath, chunkBytes);

  const opts = buildPrinterOptions(doc);
  log(`${tag} 🛠️ STRICT PRINT SPECS: ${JSON.stringify(opts)} | Pages extracted: ${pageIndices.length}`);

  await printer.print(tmpPath, opts);
  log(`${tag} ✅ Sent to printer`);

  try { fs.unlinkSync(tmpPath); } catch {}
}

// ─── New Format Document Printing (Range-Based with Enhanced Tracking) ───────
async function printDocumentNewFormat(order, doc, pdfDoc, totalOriginalPages, tag) {
  let firstRangeDone = false;
  const totalRanges = doc.printingRanges?.length || 0;
  let completedRanges = 0;
  
  for (let rangeIndex = 0; rangeIndex < doc.printingRanges.length; rangeIndex++) {
    const range = doc.printingRanges[rangeIndex];
    const rangeTag = `${tag} [Range ${rangeIndex + 1}/${totalRanges}: Pages ${range.rangeStart}-${range.rangeEnd}]`;
    
    // Validate range
    if (range.rangeStart < 1 || range.rangeEnd > totalOriginalPages || range.rangeStart > range.rangeEnd) {
      throw new Error(`Invalid range ${range.rangeStart}-${range.rangeEnd} for ${totalOriginalPages} pages`);
    }

    // Extract pages for this range (1-based to 0-based conversion)
    const pageIndices = [];
    for (let i = range.rangeStart; i <= range.rangeEnd; i++) {
      pageIndices.push(i - 1);
    }

    // Create chunk for this range
    const chunkDoc = await PDFDocument.create();
    const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
    copiedPages.forEach(page => chunkDoc.addPage(page));

    // Stamp OTP on first range of first doc
    if (!firstRangeDone) {
      await stampOTPIfFirst(order, doc, chunkDoc, tag);
      firstRangeDone = true;
    }

    // Save range chunk
    const chunkBytes = await chunkDoc.save();
    const filename = `sx_${order._id}_${doc._id}_range${rangeIndex}_print.pdf`;
    const tmpPath  = path.join(os.tmpdir(), filename);
    fs.writeFileSync(tmpPath, chunkBytes);

    // Build printer options from range-specific settings
    const opts = buildPrinterOptionsFromRange(range);
    if (config.printerName) opts.printer = config.printerName;

    const colorModeDisplay = range.colorMode === 'color' ? '🌈 COLOR' : '⬛ B&W';
    const duplexDisplay = range.sides === 'double' ? '📄 Double-sided' : '📄 Single-sided';
    log(`${rangeTag} 🛠️ SETTINGS: ${colorModeDisplay} | ${duplexDisplay} | ${range.copies} copy(ies) | ${pageIndices.length} page(s)`);

    // Print for each copy with range-specific settings
    for (let copy = 0; copy < range.copies; copy++) {
      opts.copies = 1; // Print one at a time to handle color mode per range
      
      try {
        await printer.print(tmpPath, opts);
      } catch (err) {
        log(`${rangeTag} ❌ Print failed (copy ${copy + 1}/${range.copies}): ${err.message}`);
        throw err;
      }
      
      // Add printer reset between copies and ranges for better color mode switching
      if (copy < range.copies - 1 || rangeIndex < totalRanges - 1) {
        await sleep(200);  // Brief pause for printer to acknowledge job
      }
    }
    
    completedRanges++;
    log(`${rangeTag} ✅ Sent to printer (${range.copies} copy(ies)) [${completedRanges}/${totalRanges} ranges done]`);

    // Emit real-time per-range progress
    eventCallback({
      type: 'print_range_complete',
      orderId: order._id,
      orderNumber: order.orderNumber,
      rangeIndex,
      totalRanges,
      range: {
        start: range.rangeStart,
        end: range.rangeEnd,
        colorMode: range.colorMode,
        sides: range.sides,
        copies: range.copies
      },
      completedRanges
    });

    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ─── Stamp OTP if this is the first document ─────────────────────────────────
async function stampOTPIfFirst(order, doc, chunkDoc, tag) {
  const isFirstDocOfOrder = order.documents?.[0]?._id?.toString() === doc._id?.toString();
  
  if (isFirstDocOfOrder && order.pickup?.pickupCode) {
    const firstPage = chunkDoc.getPages()[0];
    if (!firstPage) return;

    const { width, height } = firstPage.getSize();
    const otpText = `OTP: ${order.pickup.pickupCode}`;
    
    const font = await chunkDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 16;
    const textWidth = font.widthOfTextAtSize(otpText, fontSize);
    
    const padding = 30;
    const x = Math.max(0, width - textWidth - padding);
    const y = padding;

    firstPage.drawRectangle({
      x: x - 4,
      y: y - 4,
      width: textWidth + 8,
      height: fontSize + 8,
      color: rgb(1, 1, 1),
      opacity: 0.8,
    });

    firstPage.drawText(otpText, {
      x,
      y,
      size: fontSize,
      font: font,
      color: rgb(0, 0, 0),
    });
    
    log(`${tag} Stamped OTP ${order.pickup.pickupCode}`);
  }
}

function buildPrinterOptions(doc) {
  const opts = {};
  if (config.printerName) opts.printer = config.printerName;

  const p = doc.printingOptions || doc;
  
  // 1. Copies
  opts.copies = parseInt(p.copies || 1);

  // 2. Monochrome (with dual-flag approach for compatibility)
  const colorMode = (p.colorMode || 'bw').toLowerCase();
  opts.monochrome = (colorMode === 'bw');
  if (colorMode === 'color') {
    opts.color = true;
  } else {
    opts.color = false;
  }

  // 3. Duplex
  const sides = (p.sides || 'single').toLowerCase();
  if (sides === 'double') {
    opts.duplex = 'duplexlongedge';
  } else {
    opts.duplex = 'simplex';
  }

  // 4. Paper Size
  const paperSize = p.paperSize || 'A4';
  if (['A4', 'A3', 'Letter'].includes(paperSize)) {
    opts.paperSize = paperSize;
  }

  // 5. Orientation
  if (p.orientation && p.orientation !== 'auto') {
    opts.orientation = p.orientation;
  }

  // 6. Scaling
  opts.scale = 'fit';

  return opts;
}

// ─── Build printer options from a range object (Production-Ready) ────────────
function buildPrinterOptionsFromRange(range) {
  const opts = {};
  if (config.printerName) opts.printer = config.printerName;

  // Copies per range
  opts.copies = Math.max(1, parseInt(range.copies || 1));

  // ✅ Color mode: Critical for page-specific color control
  const colorMode = (range.colorMode || 'bw').toLowerCase();
  opts.monochrome = (colorMode === 'bw');
  
  // Additional color-related settings for CUPS/Windows print drivers
  if (colorMode === 'color') {
    opts.color = true;        // Force color mode
    opts.monochrome = false;   // Explicitly disable B&W
  } else {
    opts.color = false;        // Disable color
    opts.monochrome = true;    // Enable B&W
  }

  // Sides (single or double) — Critical for page count accuracy
  const sides = (range.sides || 'single').toLowerCase();
  if (sides === 'double') {
    opts.duplex = 'duplexlongedge';
  } else {
    opts.duplex = 'simplex';
  }

  // Default paper settings
  opts.paperSize = 'A4';
  opts.scale = 'fit';
  opts.width = 210;   // A4 width in mm
  opts.height = 297;  // A4 height in mm

  return opts;
}

// ─── Internal: Calculate pages for a document ────────────────────────────────
function calculateDocPages(doc, maxPagesFallback = 1) {
  // New format: sum pages from all ranges
  if (doc.printingRanges && Array.isArray(doc.printingRanges)) {
    return doc.printingRanges.reduce((sum, range) => {
      const pagesInRange = (range.rangeEnd - range.rangeStart + 1) || 1;
      return sum + (pagesInRange * range.copies);
    }, 0);
  }

  // Old format fallback
  const p = doc.printingOptions || doc;
  const pageRangeStr = p.pageRange || 'all';
  const detected = doc.detectedPages || maxPagesFallback;
  const indices = parsePageIndices(pageRangeStr, detected);
  const copies = parseInt(p.copies || 1);
  return indices.length * copies;
}

/**
 * Converts a string like "1, 3-5, 8" into an array of 0-based indices [0, 2, 3, 4, 7]
 */
function parsePageIndices(rangeStr, totalPages) {
  if (!rangeStr || rangeStr.toLowerCase() === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i);
  }

  const indices = new Set();
  const parts = rangeStr.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
        // Limit to totalPages just in case
        const actualEnd = Math.min(end, totalPages);
        for (let i = start; i <= actualEnd; i++) {
          indices.add(i - 1); // 0-based
        }
      }
    } else {
      const single = parseInt(trimmed, 10);
      if (!isNaN(single) && single > 0 && single <= totalPages) {
        indices.add(single - 1); // 0-based
      }
    }
  }

  // Return sorted array
  return Array.from(indices).sort((a, b) => a - b);
}

// ─── Internal: Error Detection ───────────────────────────────────────────────
function isPaperOutError(msg) {
  const lower = (msg || '').toLowerCase();
  return (
    lower.includes('out of paper') ||
    lower.includes('paper out') ||
    lower.includes('paper empty') ||
    lower.includes('no paper') ||
    lower.includes('paper jam') ||
    lower.includes('load paper') ||
    lower.includes('paper tray') ||
    lower.includes('media empty') ||
    lower.includes('tray empty')
  );
}

function isPrinterOfflineError(msg) {
  const lower = (msg || '').toLowerCase();
  return (
    lower.includes('printer offline') ||
    lower.includes('printer not available') ||
    lower.includes('printer not found') ||
    lower.includes('printer is offline') ||
    lower.includes('not ready') ||
    lower.includes('cannot access printer') ||
    lower.includes('spooler') ||
    lower.includes('printer error')
  );
}

// ─── Internal: Checkpoint Saving ─────────────────────────────────────────────
async function saveCheckpoint(orderId, data) {
  if (!api) return;
  try {
    await api.patch(`/orders/${orderId}/print-job`, data);
  } catch (err) {
    log(`Checkpoint save error: ${err.message}`);
    throw err;
  }
}

// ─── Internal: Printer Status Monitoring ─────────────────────────────────────
async function checkPrinterStatus() {
  if (printingNow.size === 0 && pausedOrders.size === 0) return;

  try {
    const printers = await printer.getPrinters();
    const target = config.printerName
      ? printers.find(p => p.name === config.printerName)
      : printers.find(p => p.isDefault);

    if (target) {
      const statusStr = (target.statusNumber !== undefined)
        ? `status=${target.statusNumber}`
        : (target.status || 'unknown');

      // If there are paused jobs and printer seems ready, notify the UI
      if (pausedOrders.size > 0) {
        // Printer status 0 or 'idle' means ready
        const isReady = target.statusNumber === 0 ||
                        target.statusNumber === undefined ||
                        (target.status || '').toLowerCase().includes('idle') ||
                        (target.status || '').toLowerCase().includes('ready');

        if (isReady) {
          eventCallback({
            type: 'printer_ready',
            message: 'Printer appears ready. You can resume paused jobs.',
            pausedJobs: getPausedJobs(),
          });
        }
      }
    }
  } catch {
    // Silent — printer query can fail on some systems
  }
}

// ─── Internal: Startup Recovery ──────────────────────────────────────────────
async function recoverIncompleteJobs() {
  if (!api) return;

  log('🔍 Checking for incomplete print jobs...');

  try {
    // 1. Check backend for incomplete jobs
    const res = await api.get('/orders/incomplete-jobs');
    const incompleteOrders = res.data.data?.orders || [];

    if (incompleteOrders.length === 0) {
      // 2. Also check local store for any jobs that were in progress when power died
      const localJobs = getLocalJobs();
      if (localJobs.length > 0) {
        log(`Found ${localJobs.length} locally saved job(s) — cross-checking with backend`);
        for (const localJob of localJobs) {
          try {
            const orderRes  = await api.get(`/orders/${localJob.orderId}`);
            const order     = orderRes.data.data?.order || orderRes.data.order;
            if (order && ['accepted', 'printing'].includes(order.status)) {
              incompleteOrders.push(order);
            } else {
              clearLocalJob(localJob.orderId);
            }
          } catch {
            clearLocalJob(localJob.orderId);
          }
        }
      }
    }

    if (incompleteOrders.length === 0) {
      log('✅ No incomplete jobs found');
      return;
    }

    log(`⚠️ Found ${incompleteOrders.length} incomplete job(s) — recovering...`);
    eventCallback({
      type:  'recovery_start',
      count: incompleteOrders.length,
      jobs:  incompleteOrders.map(o => ({
        orderId:      o._id,
        orderNumber:  o.orderNumber,
        printedPages: o.printJob?.printedPages || 0,
        totalPages:   o.printJob?.totalPages || 0,
        currentDoc:   o.printJob?.currentDocIndex || 0,
        totalDocs:    o.documents?.length || 0,
        status:       o.printJob?.status || 'unknown',
        pauseReason:  o.printJob?.pauseReason || null,
      })),
    });

    for (const order of incompleteOrders) {
      if (printedOrders.has(order._id) || printingNow.has(order._id)) continue;

      const pj = order.printJob || {};
      
      if (pj.status === 'paused') {
        // Put in paused map — don't auto-resume, let shopkeeper decide
        pausedOrders.set(order._id, {
          order,
          checkpoint: {
            printedPages:    pj.printedPages || 0,
            totalPages:      pj.totalPages || 0,
            currentDocIndex: pj.currentDocIndex || 0,
            pauseReason:     pj.pauseReason || 'power_failure',
            pausedAt:        pj.pausedAt || new Date().toISOString(),
          },
        });

        log(`  ⏸️ Order #${order.orderNumber} — paused at doc ${pj.currentDocIndex || 0}, page ${pj.printedPages || 0}/${pj.totalPages || '?'} (${pj.pauseReason || 'unknown'})`);
        eventCallback({
          type: 'print_paused',
          orderId: order._id,
          orderNumber: order.orderNumber,
          reason: pj.pauseReason || 'power_failure',
          printedPages: pj.printedPages || 0,
          totalPages: pj.totalPages || 0,
          currentDocIndex: pj.currentDocIndex || 0,
          totalDocs: order.documents?.length || 0,
          isRecovered: true,
          pausedJobs: getPausedJobs(),
        });
      } else {
        // Was mid-print when interrupted — auto-resume from checkpoint
        const resumeDoc  = pj.currentDocIndex || 0;
        const resumePage = pj.printedPages || 0;

        log(`  🔄 Order #${order.orderNumber} — auto-resuming from doc ${resumeDoc}, page ${resumePage}`);
        
        // Small delay between jobs
        await sleep(2000);
        
        await processOrder(order, {
          resumeFromDocIndex: resumeDoc,
          resumeFromPage:     resumePage,
        });
      }
    }

    eventCallback({ type: 'recovery_complete', count: incompleteOrders.length });

  } catch (err) {
    log(`Recovery check failed: ${err.message}`);
  }
}

// ─── Internal: Local State Persistence ───────────────────────────────────────
function saveLocalState() {
  if (!localStore) return;
  try {
    const jobs = [];
    for (const [orderId, data] of pausedOrders) {
      jobs.push({
        orderId,
        orderNumber: data.order?.orderNumber,
        checkpoint:  data.checkpoint,
        savedAt:     new Date().toISOString(),
      });
    }
    // Also save any currently printing jobs
    for (const orderId of printingNow) {
      if (!pausedOrders.has(orderId)) {
        jobs.push({
          orderId,
          status:  'was_printing',
          savedAt: new Date().toISOString(),
        });
      }
    }
    localStore.set('incompleteJobs', jobs);
  } catch (err) {
    console.error('Failed to save local state:', err.message);
  }
}

function getLocalJobs() {
  if (!localStore) return [];
  try {
    return localStore.get('incompleteJobs', []);
  } catch {
    return [];
  }
}

function clearLocalJob(orderId) {
  if (!localStore) return;
  try {
    const jobs = localStore.get('incompleteJobs', []);
    const filtered = jobs.filter(j => j.orderId !== orderId);
    localStore.set('incompleteJobs', filtered);
  } catch {}
}

// ─── Fallback Polling ────────────────────────────────────────────────────────
let polling = false;
async function fallbackPoll() {
  if (polling || !api) return;
  polling = true;
  try {
    const res = await api.get('/orders/shop/orders?status=accepted,printing&limit=50');
    const orders = res.data.data?.orders || res.data.orders || [];
    const missed = orders.filter(o =>
      !printedOrders.has(o._id) &&
      !printingNow.has(o._id) &&
      !pausedOrders.has(o._id) &&
      (retryCount.get(o._id) || 0) < MAX_RETRIES
    );
    if (missed.length > 0) {
      log(`Fallback: found ${missed.length} unprinted order(s)`);
      for (const order of missed) await processOrder(order);
    }
  } catch (err) {
    if (err.response?.status !== 401) log(`Poll error: ${err.message}`);
  } finally {
    polling = false;
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────
const logs = [];
function log(msg) {
  const ts  = new Date().toLocaleTimeString();
  const entry = `[${ts}] ${msg}`;
  logs.push(entry);
  if (logs.length > 300) logs.shift();
  console.log(entry);
  eventCallback({ type: 'log', message: entry });
}

function getLogs() {
  return [...logs];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Export ──────────────────────────────────────────────────────────────────
module.exports = {
  init,
  connect,
  disconnect,
  listPrinters,
  setPrinter,
  getStatus,
  getLogs,
  printOrder,
  getPausedJobs,
  pausePrintJob,
  resumePrintJob,
  refresh: fallbackPoll,
};
