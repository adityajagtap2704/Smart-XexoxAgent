/**
 * Smart Xerox Print Agent — Renderer (UI Logic)
 * Communicates with main process via window.agent (preload bridge).
 *
 * NOW with:
 *  • Paused job display with Resume buttons
 *  • Progress bars on active print jobs
 *  • Recovery banner on startup
 *  • Printer-ready notifications
 */

// ─── DOM Elements ────────────────────────────────────────────────────────────
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const loginScreen     = $('#loginScreen');
const setupScreen     = $('#setupScreen');
const dashboardScreen = $('#dashboardScreen');

// Login
const loginForm  = $('#loginForm');
const emailIn    = $('#email');
const passwordIn = $('#password');
const loginBtn   = $('#loginBtn');
const loginError = $('#loginError');

// Setup
const printerSelect = $('#printerSelect');
const connectBtn    = $('#connectBtn');
const welcomeText   = $('#welcomeText');

// Dashboard
const statusDot         = $('#statusDot');
const statusLabel       = $('#statusLabel');
const shopNameLbl       = $('#shopNameLabel');
const printerLbl        = $('#printerLabel');
const logoutBtn         = $('#logoutBtn');
const refreshBtn        = $('#refreshBtn');
const clearLogBtn       = $('#clearLogBtn');
const printedCount      = $('#printedCount');
const activeCount       = $('#activeCount');
const failedCount       = $('#failedCount');
const pausedCount       = $('#pausedCount');
const pausedStatCard    = $('#pausedStatCard');
const logContainer      = $('#logContainer');
const recoveryBanner    = $('#recoveryBanner');
const recoveryMessage   = $('#recoveryMessage');
const dismissRecovery   = $('#dismissRecovery');
const pausedJobsSection = $('#pausedJobsSection');
const pausedJobsContainer = $('#pausedJobsContainer');

// ─── State ───────────────────────────────────────────────────────────────────
let currentScreen  = 'login';
let failCount      = 0;
let statusInterval = null;

// ─── Screen Navigation ──────────────────────────────────────────────────────
function showScreen(name) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  if (name === 'login')     loginScreen.classList.add('active');
  if (name === 'setup')     setupScreen.classList.add('active');
  if (name === 'dashboard') dashboardScreen.classList.add('active');
  currentScreen = name;
}

// ─── Init: Check Saved Session ───────────────────────────────────────────────
async function init() {
  const session = await window.agent.getSession();

  if (session && session.userName) {
    if (session.printerName) {
      shopNameLbl.textContent = session.shopName || 'Your Shop';
      printerLbl.textContent  = `Printer: ${session.printerName}`;
      showScreen('dashboard');
      await window.agent.connectEngine();
      startStatusPolling();
    } else {
      welcomeText.textContent = `Welcome, ${session.userName || 'Shopkeeper'}!`;
      showScreen('setup');
      await loadPrinters();
    }
  } else {
    showScreen('login');
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');

  const email    = emailIn.value.trim();
  const password = passwordIn.value;

  if (!email || !password) return;

  setLoading(loginBtn, true);

  const result = await window.agent.login({ email, password });

  setLoading(loginBtn, false);

  if (result.success) {
    welcomeText.textContent = `Welcome, ${result.user.name}!`;
    showScreen('setup');
    await loadPrinters();
  } else {
    loginError.textContent = result.error;
    loginError.classList.remove('hidden');
  }
});

// ─── Printer Selection ───────────────────────────────────────────────────────
async function loadPrinters() {
  printerSelect.innerHTML = '<option value="">Loading printers...</option>';

  const printers = await window.agent.getPrinters();

  if (!printers || printers.length === 0) {
    printerSelect.innerHTML = '<option value="">(system default printer)</option>';
    return;
  }

  printerSelect.innerHTML = '';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '— Use System Default —';
  printerSelect.appendChild(defaultOpt);

  printers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name + (p.isDefault ? '  ★ Default' : '');
    printerSelect.appendChild(opt);
  });
}

connectBtn.addEventListener('click', async () => {
  const printerName = printerSelect.value;
  await window.agent.selectPrinter(printerName);

  const session = await window.agent.getSession();
  shopNameLbl.textContent = session?.shopName || 'Your Shop';
  printerLbl.textContent  = `Printer: ${printerName || 'System Default'}`;

  setLoading(connectBtn, true);
  await window.agent.connectEngine();
  setLoading(connectBtn, false);

  showScreen('dashboard');
  startStatusPolling();
});

// ─── Dashboard ───────────────────────────────────────────────────────────────
function startStatusPolling() {
  if (statusInterval) clearInterval(statusInterval);
  updateStatus();
  statusInterval = setInterval(updateStatus, 3000);
}

async function updateStatus() {
  const s = await window.agent.getStatus();
  if (!s) return;

  // Status dot
  statusDot.className = 'status-dot ' + (s.connected ? 'connected' : 'disconnected');
  statusLabel.textContent = s.connected ? 'Connected — Listening' : 'Disconnected';

  // Stats
  printedCount.textContent = s.printed || 0;
  activeCount.textContent  = s.active  || 0;
  failedCount.textContent  = failCount;

  // Paused count
  const paused = s.paused || 0;
  pausedCount.textContent = paused;
  pausedStatCard.style.display = paused > 0 ? '' : 'none';
}

// ─── Recovery Banner ─────────────────────────────────────────────────────────
dismissRecovery.addEventListener('click', () => {
  recoveryBanner.classList.add('hidden');
});

function showRecoveryBanner(message) {
  recoveryMessage.textContent = message;
  recoveryBanner.classList.remove('hidden');
}

function hideRecoveryBanner() {
  recoveryBanner.classList.add('hidden');
}

// ─── Paused Jobs Display ─────────────────────────────────────────────────────
function updatePausedJobsUI(pausedJobs) {
  if (!pausedJobs || pausedJobs.length === 0) {
    pausedJobsSection.classList.add('hidden');
    pausedJobsContainer.innerHTML = '';
    return;
  }

  pausedJobsSection.classList.remove('hidden');
  pausedJobsContainer.innerHTML = '';

  for (const job of pausedJobs) {
    const el = document.createElement('div');
    el.className = 'paused-job-item';
    el.id = `paused-${job.orderId}`;

    const pct = job.totalPages > 0
      ? Math.round((job.printedPages / job.totalPages) * 100)
      : 0;

    const reasonLabel = {
      'out_of_paper':   '📄 Out of Paper',
      'printer_error':  '⚠️ Printer Error',
      'power_failure':  '⚡ Power Interrupted',
      'manual':         '✋ Manually Paused',
    }[job.pauseReason] || `⏸️ ${job.pauseReason}`;

    el.innerHTML = `
      <div class="paused-job-header">
        <span class="paused-job-number">#${job.orderNumber}</span>
        <span class="paused-job-reason">${reasonLabel}</span>
      </div>
      <div class="paused-job-progress">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${pct}%"></div>
        </div>
        <span class="progress-label">${job.printedPages}/${job.totalPages} pages · Doc ${job.currentDocIndex}/${job.totalDocs}</span>
      </div>
      <button class="btn-resume" data-order-id="${job.orderId}">
        ▶ Resume Printing
      </button>
    `;

    // Resume button handler
    const resumeBtn = el.querySelector('.btn-resume');
    resumeBtn.addEventListener('click', async () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = '⏳ Resuming...';
      await window.agent.resumePrintJob(job.orderId);
    });

    pausedJobsContainer.appendChild(el);
  }
}

// ─── Engine Events ───────────────────────────────────────────────────────────
window.agent.onEvent((event) => {
  switch (event.type) {
    case 'connected':
      addLog(`✅ Connected to server (${event.socketId})`, 'success');
      updateStatus();
      break;

    case 'disconnected':
      addLog(`⚠️ Disconnected: ${event.reason}`, 'warning');
      updateStatus();
      break;

    case 'error':
      if (event.message?.toLowerCase().includes('websocket error')) return;
      addLog(`❌ Error: ${event.message}`, 'error');
      break;

    case 'print_queued':
      updateJobCard(event.orderId, event.orderNumber, 'queued');
      addLog(`🧾 Order #${event.orderNumber || event.orderId?.slice(-6)} queued (${event.queueLength || 0} waiting)`, 'info');
      updateStatus();
      break;

    case 'printing':
      updateJobCard(event.orderId, event.orderNumber, 'printing', event.specs);
      updateStatus();
      break;

    // ── New: Progress updates during printing ──────────────────────────
    case 'print_progress':
      updateJobCardProgress(event.orderId, event.orderNumber, event.printedPages, event.totalPages, event.currentDocIndex, event.totalDocs);
      break;

    // ── New: Print recovering (resuming from checkpoint) ───────────────
    case 'print_recovering':
      updateJobCard(event.orderId, event.orderNumber, 'recovering', event.specs);
      addLog(`🔄 Resuming #${event.orderNumber} from page ${event.specs?.printedPages || 0}`, 'info');
      updateStatus();
      break;

    case 'print_complete':
      updateJobCard(event.orderId, event.orderNumber, 'complete', event.specs);
      // Remove from paused if it was there
      removePausedJob(event.orderId);
      updateStatus();
      break;

    case 'print_failed':
      failCount++;
      updateJobCard(event.orderId, event.orderNumber, 'failed');
      updateStatus();
      break;

    // ── New: Print paused (paper out / printer error / manual) ─────────
    case 'print_paused':
      updateJobCard(event.orderId, event.orderNumber, 'paused', {
        printedPages: event.printedPages,
        totalPages:   event.totalPages,
        pauseReason:  event.reason,
      });
      if (event.pausedJobs) {
        updatePausedJobsUI(event.pausedJobs);
      }
      addLog(`⏸️ #${event.orderNumber || event.orderId.slice(-6)} paused — ${formatPauseReason(event.reason)} (${event.printedPages}/${event.totalPages} pages)`, 'warning');
      updateStatus();
      break;

    // ── New: Print resumed ─────────────────────────────────────────────
    case 'print_resumed':
      removePausedJob(event.orderId);
      addLog(`▶️ #${event.orderNumber} resuming from doc ${(event.fromDocIndex || 0) + 1}, page ${event.fromPage || 0}`, 'success');
      updateStatus();
      break;

    case 'resume_failed':
      addLog(`❌ Resume failed for ${event.orderId?.slice(-6)}: ${event.error}`, 'error');
      break;

    // ── New: Recovery events ───────────────────────────────────────────
    case 'recovery_start':
      showRecoveryBanner(`Found ${event.count} incomplete job(s) — recovering...`);
      addLog(`🔍 Found ${event.count} incomplete job(s) to recover`, 'info');
      break;

    case 'recovery_complete':
      showRecoveryBanner(`Recovery complete — ${event.count} job(s) processed`);
      setTimeout(hideRecoveryBanner, 5000);
      break;

    // ── New: Printer appears ready (can resume) ────────────────────────
    case 'printer_ready':
      if (event.pausedJobs && event.pausedJobs.length > 0) {
        updatePausedJobsUI(event.pausedJobs);
        addLog(`🟢 Printer ready — ${event.pausedJobs.length} paused job(s) can be resumed`, 'success');
      }
      break;

    case 'deep_link_print':
      updateStatus();
      break;

    case 'auth_expired':
      if (event.message?.includes('re-login')) {
        showScreen('login');
        if (statusInterval) clearInterval(statusInterval);
      }
      break;

    case 'auto_login_success':
      // The main process just caught an autologin deep link and saved the token.
      // Re-initialize to bypass login screen and jump to setup/dashboard.
      init();
      break;

    case 'log':
      console.log(event.message);
      break;
  }
});

// ─── Job Cards ───────────────────────────────────────────────────────────────
function updateJobCard(orderId, orderNumber, status, specs) {
  // Remove "waiting" placeholder
  const empty = logContainer.querySelector('.log-empty');
  if (empty) empty.remove();

  let card = document.getElementById(`job-${orderId}`);
  if (!card) {
    card = document.createElement('div');
    card.id = `job-${orderId}`;
    card.className = 'job-item';
    logContainer.prepend(card);
  }

  const statusText = {
    'queued':     'Queued ⏳',
    'printing':   'Printing...',
    'complete':   'Completed ✅',
    'failed':     'Failed ❌',
    'paused':     'Paused ⏸️',
    'recovering': 'Recovering 🔄',
  }[status] || status;

  // Progress bar for active/paused jobs
  let progressHtml = '';
  if (specs && (specs.printedPages !== undefined) && specs.totalPages) {
    const pct = Math.round((specs.printedPages / specs.totalPages) * 100);
    progressHtml = `
      <div class="job-progress">
        <div class="progress-bar">
          <div class="progress-fill ${status === 'paused' ? 'paused' : ''}" style="width: ${pct}%"></div>
        </div>
        <span class="progress-label">${specs.printedPages}/${specs.totalPages} pages</span>
      </div>
    `;
  }

  // Pause reason
  let reasonHtml = '';
  if (status === 'paused' && specs?.pauseReason) {
    reasonHtml = `<div class="pause-reason">${formatPauseReason(specs.pauseReason)}</div>`;
  }

  // Specs badges
  let specsHtml = '';
  if (specs && specs.copies) {
    specsHtml = `
      <div class="job-specs">
        <span class="badge primary">${specs.copies} ${specs.copies > 1 ? 'Copies' : 'Copy'}</span>
        <span class="badge success">${specs.paperSize || 'A4'}</span>
        <span class="badge">${(specs.colorMode || 'bw') === 'bw' ? 'B&W' : 'Color'}</span>
        <span class="badge">${(specs.sides || 'single') === 'double' ? 'Front+Back' : 'One Side'}</span>
        ${specs.isResuming ? '<span class="badge warning">Resumed</span>' : ''}
      </div>
    `;
  }

  card.className = `job-item job-${status}`;
  card.innerHTML = `
    <div class="job-header">
      <span class="job-number">#${orderNumber || orderId.slice(-6).toUpperCase()}</span>
      <span class="job-status ${status}">${statusText}</span>
    </div>
    ${progressHtml}
    ${reasonHtml}
    ${specsHtml}
  `;

  logContainer.scrollTop = 0;
}

function updateJobCardProgress(orderId, orderNumber, printedPages, totalPages, currentDocIndex, totalDocs) {
  let card = document.getElementById(`job-${orderId}`);
  if (!card) {
    // Create a minimal card if it doesn't exist
    updateJobCard(orderId, orderNumber, 'printing', { printedPages, totalPages });
    return;
  }

  // Update the progress bar
  const progressFill = card.querySelector('.progress-fill');
  const progressLabel = card.querySelector('.progress-label');

  if (progressFill && progressLabel) {
    const pct = totalPages > 0 ? Math.round((printedPages / totalPages) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = `${printedPages}/${totalPages} pages · Doc ${currentDocIndex}/${totalDocs}`;
  } else {
    // No progress bar yet — add one
    const progressDiv = document.createElement('div');
    progressDiv.className = 'job-progress';
    const pct = totalPages > 0 ? Math.round((printedPages / totalPages) * 100) : 0;
    progressDiv.innerHTML = `
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      <span class="progress-label">${printedPages}/${totalPages} pages · Doc ${currentDocIndex}/${totalDocs}</span>
    `;
    const header = card.querySelector('.job-header');
    if (header) header.after(progressDiv);
  }
}

function removePausedJob(orderId) {
  const pausedEl = document.getElementById(`paused-${orderId}`);
  if (pausedEl) pausedEl.remove();

  // Hide section if no more paused jobs
  if (pausedJobsContainer.children.length === 0) {
    pausedJobsSection.classList.add('hidden');
  }
}

function addLog(message, type = 'info') {
  // Visual log entry in the log container — only for important messages
  const empty = logContainer.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  logContainer.prepend(entry);

  // Keep max 50 log entries
  while (logContainer.children.length > 50) {
    logContainer.lastChild.remove();
  }
}

function formatPauseReason(reason) {
  return {
    'out_of_paper':   '📄 Out of Paper — Add paper to printer',
    'printer_error':  '⚠️ Printer Error — Check printer status',
    'power_failure':  '⚡ Power was interrupted',
    'manual':         '✋ Manually paused',
  }[reason] || `⏸️ ${reason || 'Unknown reason'}`;
}

clearLogBtn.addEventListener('click', () => {
  logContainer.innerHTML = `
    <div class="log-empty">
      <div class="log-empty-icon">🖨️</div>
      <p>Ready to print! Just click "Print" on the Smart Xerox website.</p>
    </div>
  `;
  failCount = 0;
  failedCount.textContent = '0';
});

// Refresh (Manual poll)
refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('rotate-anim');
  await window.agent.refresh();
  // Also refresh paused jobs display
  const paused = await window.agent.getPausedJobs();
  updatePausedJobsUI(paused);
  setTimeout(() => refreshBtn.classList.remove('rotate-anim'), 800);
});

// ─── Logout ──────────────────────────────────────────────────────────────────
logoutBtn.addEventListener('click', async () => {
  await window.agent.disconnectEngine();
  await window.agent.logout();
  if (statusInterval) clearInterval(statusInterval);
  logContainer.innerHTML = `
    <div class="log-empty">
      <div class="log-empty-icon">🖨️</div>
      <p>Ready to print! Just click "Print" on the Smart Xerox website.</p>
    </div>
  `;
  failCount = 0;
  pausedJobsSection.classList.add('hidden');
  recoveryBanner.classList.add('hidden');
  showScreen('login');
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setLoading(btn, loading) {
  const text = btn.querySelector('.btn-text');
  const load = btn.querySelector('.btn-loading');
  if (loading) {
    text?.classList.add('hidden');
    load?.classList.remove('hidden');
    btn.disabled = true;
  } else {
    text?.classList.remove('hidden');
    load?.classList.add('hidden');
    btn.disabled = false;
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────
init();
