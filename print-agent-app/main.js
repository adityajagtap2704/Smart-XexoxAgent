/**
 * Smart Xerox Print Agent — Electron Main Process
 * Manages: window, tray icon, IPC handlers, auto-launch, print engine.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path        = require('path');
const Store       = require('electron-store');
const AutoLaunch  = require('auto-launch');
const axios       = require('axios');
const engine      = require('./print-engine');

// ─── CONFIGURE THESE ONCE before building the installer ───────────────────
const API_URL      = 'http://localhost:5000/api';
const FRONTEND_URL = 'http://localhost:3000';   // Matches vite.config.js port

// ─── Register custom protocol (smartxerox://) ─────────────────────────────
if (process.defaultApp) {
  // Dev mode — register with argv
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('smartxerox', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('smartxerox');
}

// ─── Persistent Store (encrypted) ────────────────────────────────────────────
const store = new Store({
  encryptionKey: 'smartxerox-agent-v1',
  schema: {
    apiUrl:         { type: 'string',  default: '' },
    token:          { type: 'string',  default: '' },
    refreshToken:   { type: 'string',  default: '' },
    userEmail:      { type: 'string',  default: '' },
    userName:       { type: 'string',  default: '' },
    shopName:       { type: 'string',  default: '' },
    printerName:    { type: 'string',  default: '' },
    incompleteJobs: { type: 'array',   default: [] },
  },
});

let mainWindow = null;
let tray       = null;

// ─── Auto Launch on Windows Boot ─────────────────────────────────────────────
const autoLauncher = new AutoLaunch({
  name: 'Smart Xerox Print Agent',
  isHidden: true,
});

// ─── Create Main Window ──────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    resizable: false,
    maximizable: false,
    title: 'Smart Xerox Print Agent',
    icon: getTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ─── System Tray ─────────────────────────────────────────────────────────────
function createTray() {
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Smart Xerox Print Agent');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Status',   click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Reconnect',     click: () => { engine.disconnect(); startEngine(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

function getTrayIcon() {
  // Simple programmatic icon — green circle for "printer"
  const size = 32;
  const canvas = nativeImage.createEmpty();
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const fs = require('fs');
    if (fs.existsSync(iconPath)) {
      return nativeImage.createFromPath(iconPath);
    }
  } catch {}
  // Fallback: use default Electron icon
  return nativeImage.createEmpty();
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// Login with shopkeeper credentials
ipcMain.handle('login', async (_event, { email, password }) => {
  try {
    const cleanUrl = API_URL.replace(/\/+$/, '');
    const res = await axios.post(`${cleanUrl}/auth/login`, { email, password });
    const { token, refreshToken, user } = res.data.data;

    if (user.role !== 'shopkeeper') {
      return { success: false, error: 'Only shopkeeper accounts can use the Print Agent.' };
    }

    // Fetch shop info
    let shopName = '';
    try {
      const shopRes = await axios.get(`${cleanUrl}/shops/my-shop/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      shopName = shopRes.data.data?.shop?.name || shopRes.data.data?.name || '';
    } catch {}

    // Persist credentials
    store.set('apiUrl', cleanUrl);
    store.set('token', token);
    store.set('refreshToken', refreshToken);
    store.set('userEmail', user.email);
    store.set('userName', user.name);
    store.set('shopName', shopName);

    // Enable auto-launch
    try { await autoLauncher.enable(); } catch {}

    return { success: true, user: { name: user.name, email: user.email, shopName } };
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Login failed';
    return { success: false, error: msg };
  }
});

// Get saved session
ipcMain.handle('getSession', () => {
  const token = store.get('token');
  if (!token) return null;
  return {
    apiUrl:      store.get('apiUrl'),
    userEmail:   store.get('userEmail'),
    userName:    store.get('userName'),
    shopName:    store.get('shopName'),
    printerName: store.get('printerName'),
  };
});

// Logout
ipcMain.handle('logout', () => {
  engine.disconnect();
  store.clear();
  return true;
});

// List available printers
ipcMain.handle('getPrinters', async () => {
  return await engine.listPrinters();
});

// Select printer
ipcMain.handle('selectPrinter', (_event, printerName) => {
  store.set('printerName', printerName);
  engine.setPrinter(printerName);
  return true;
});

// Connect the print engine
ipcMain.handle('connectEngine', () => {
  startEngine();
  return true;
});

// Refresh (manual poll)
ipcMain.handle('refreshEngine', () => {
  engine.refresh();
  return true;
});

// Disconnect
ipcMain.handle('disconnectEngine', () => {
  engine.disconnect();
  return true;
});

// Get live status
ipcMain.handle('getStatus', () => {
  return engine.getStatus();
});

// Get logs
ipcMain.handle('getLogs', () => {
  return engine.getLogs();
});

// ── Fault-Tolerant Print Handlers ──────────────────────────────────────────

// Pause a running print job
ipcMain.handle('pausePrintJob', (_event, orderId) => {
  engine.pausePrintJob(orderId, 'manual');
  return true;
});

// Resume a paused print job
ipcMain.handle('resumePrintJob', (_event, orderId) => {
  engine.resumePrintJob(orderId);
  return true;
});

// Get all paused/incomplete jobs
ipcMain.handle('getPausedJobs', () => {
  return engine.getPausedJobs();
});

// ─── Start Print Engine ──────────────────────────────────────────────────────
function startEngine() {
  const apiUrl      = API_URL;
  const token       = store.get('token');
  const printerName = store.get('printerName');

  if (!token) return;

  engine.init({
    apiUrl,
    token,
    printerName,
    store,  // Pass electron-store for local state persistence
    onEvent: (event) => {
      // Forward all engine events to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine-event', event);
      }

      // Handle auth expiry — auto re-login
      if (event.type === 'auth_expired') {
        handleTokenRefresh();
      }

      // ── Auto-redirect back to browser when printing is done ──
      if (event.type === 'print_complete') {
        setTimeout(() => {
          shell.openExternal(`${FRONTEND_URL}/shop`);
        }, 1500);
      }

      // ── Show window on recovery or pause (important alerts) ──
      if (event.type === 'recovery_start' || event.type === 'print_paused') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
  });

  engine.connect();
}

// ─── Token Refresh ───────────────────────────────────────────────────────────
async function handleTokenRefresh() {
  const apiUrl       = API_URL;
  const refreshToken = store.get('refreshToken');
  if (!refreshToken) return;

  try {
    const res = await axios.post(`${apiUrl}/auth/refresh-token`, { refreshToken });
    const { token: newToken, refreshToken: newRefresh } = res.data.data;
    store.set('token', newToken);
    store.set('refreshToken', newRefresh);

    // Restart engine with new token
    engine.disconnect();
    startEngine();
  } catch {
    // Refresh failed — user must re-login
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine-event', {
        type: 'auth_expired',
        message: 'Session expired. Please re-login.',
      });
      mainWindow.show();
    }
  }
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    // Deep link from second instance (Windows)
    const deepLink = argv.find(a => a.startsWith('smartxerox://'));
    if (deepLink) handleDeepLink(deepLink);
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    // Auto-connect if we have a saved session
    const token = store.get('token');
    if (token) {
      setTimeout(startEngine, 1000);
    }

    // Check if launched via deep link (Windows)
    const deepLink = process.argv.find(a => a.startsWith('smartxerox://'));
    if (deepLink) setTimeout(() => handleDeepLink(deepLink), 1500);
  });

  app.on('window-all-closed', (e) => {
    // Don't quit — keep running in tray
    e?.preventDefault?.();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    engine.disconnect();
  });

  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
  });

  // macOS deep link
  app.on('open-url', (_event, url) => {
    handleDeepLink(url);
  });
}

// ─── Deep Link Handler ──────────────────────────────────────────────────
// ─── Deep Link Handler ──────────────────────────────────────────────────
// Handles:
// 1. smartxerox://print/ORDER_ID (trigger print)
// 2. smartxerox://autologin?token=...&email=...&name=...&shopName=...
function handleDeepLink(url) {
  try {
    const parsed = new URL(url);

    // ── Auto Login Flow ──
    if (parsed.host === 'autologin' || parsed.pathname?.startsWith('/autologin')) {
      const token        = parsed.searchParams.get('token');
      const refreshToken = parsed.searchParams.get('refreshToken') || '';
      const email        = parsed.searchParams.get('email');
      const name         = parsed.searchParams.get('name');
      const shopName     = parsed.searchParams.get('shopName') || '';

      if (token && email) {
        // Save to store
        store.set('token', token);
        store.set('refreshToken', refreshToken);
        store.set('userEmail', email);
        store.set('userName', name);
        store.set('shopName', shopName);

        // Turn on auto launch
        try { autoLauncher.enable(); } catch {}

        // Connect engine
        engine.disconnect();
        startEngine();

        // Bring to front
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }

        // Tell UI it logged in successfully
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('engine-event', {
            type: 'auto_login_success',
          });
        }
        return;
      }
    }

    // ── Print Flow ──
    if (parsed.host === 'print' || parsed.pathname?.startsWith('/print')) {
      const orderId = parsed.pathname?.replace(/^\/+/, '') || parsed.host;
      const id = parsed.searchParams?.get('id') || orderId.replace('print/', '').replace('print', '');
      
      if (id && id.length > 5) {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('engine-event', {
            type: 'deep_link_print',
            orderId: id,
            message: `Print job received from browser for order ${id.slice(-6).toUpperCase()}`,
          });
        }

        engine.printOrder(id);
      }
    }
  } catch (err) {
    console.error('Deep link parse error:', err.message);
  }
}
