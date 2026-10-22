'use strict';
/**
 * AstroviaBin desktop: a system tray app that runs the AstroviaBin server.
 *
 * First launch opens the setup window; the server starts only after the settings are saved.
 * Afterwards the app lives in the tray: start/stop/restart the server, open the web interface,
 * change settings, open data folders and logs.
 */
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, safeStorage, shell, Notification } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');

const isWindows = process.platform === 'win32';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching AstroviaBin again (menu, desktop icon) shows the app instead of starting a second copy.
  app.on('second-instance', () => {
    if (state.status === 'running') openApp();
    else if (state.configured) openSettings();
    else openSetup();
  });
}

// ---------------------------------------------------------------------------------------------
// Bundled resources

function resources() {
  if (!app.isPackaged) {
    // Development: run the server from the repository with the system's Node and Python.
    const repo = path.resolve(__dirname, '..', '..');
    return {
      server: repo, node: 'node', sky: path.join(repo, 'data', 'sky'),
      python: process.env.ASTROVIABIN_ANALYSIS_PYTHON || 'python3', hotpants: '', icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      ppxf: process.env.ASTROVIABIN_PPXF_DIR || path.join(repo, '.venv-science', 'lib', 'python3.13', 'site-packages'),
      licenses: path.join(repo, 'licenses'),
      preflight: path.join(__dirname, 'preflight.cjs'),
    };
  }
  const base = process.resourcesPath;
  const pythonCandidates = isWindows
    ? [path.join(base, 'python', 'python.exe')]
    : [path.join(base, 'python', 'bin', 'python3'), '/opt/AstroviaBin/python/bin/python'];
  return {
    server: path.join(base, 'server'),
    node: path.join(base, 'runtime', isWindows ? 'node.exe' : 'node'),
    sky: path.join(base, 'sky'),
    python: pythonCandidates.find(candidate => fs.existsSync(candidate)) || pythonCandidates[0],
    ppxf: path.join(base, 'optional-ppxf'),
    licenses: path.join(base, 'licenses'),
    hotpants: path.join(base, 'bin'),
    icon: path.join(base, 'icon.png'),
    preflight: path.join(base, 'server', 'preflight.cjs'),
  };
}

const RES = resources();

function ppxfMarker() {
  return ['ppxf-9.5.2.dist-info', 'capfit-2.7.1.dist-info']
    .every(name => fs.existsSync(path.join(RES.ppxf, name, 'METADATA')));
}

function ensurePpxf() {
  if (!app.isPackaged || ppxfMarker()) return Promise.resolve();
  const installer = path.join(RES.server, 'tools', 'scripts', 'install_ppxf.py');
  setStatus('starting', 'Installing the astronomy runtime from PyPI…');
  return new Promise((resolve, reject) => {
    execFile(RES.python, [installer, RES.ppxf], { timeout: 180_000, windowsHide: true }, (error, stdout, stderr) => {
      if (stdout) log(stdout);
      if (stderr) log(stderr);
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// State

const state = {
  configured: false,
  values: {},
  status: 'stopped', // stopped | starting | running | stopping | error
  message: '',
  child: null,
  restarts: 0,
  quitting: false,
  stopRequested: false,
};

let tray = null;
let setupWindow = null;
let logStream = null;

function loadConfig() {
  const loaded = config.load(app, RES, safeStorage);
  state.configured = loaded.configured;
  state.values = loaded.values;
}

function url() {
  return `http://localhost:${state.values.port}`;
}

/** The addresses other devices use when AstroviaBin is shared on the local network. */
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: RES.icon }).show();
}

// ---------------------------------------------------------------------------------------------
// Logs

function logFile() {
  return path.join(state.values.logsDir, 'server.log');
}

function openLog() {
  fs.mkdirSync(state.values.logsDir, { recursive: true });
  const file = logFile();
  try {
    // Keep the log readable: rotate at 10 MB, keeping one previous file.
    if (fs.existsSync(file) && fs.statSync(file).size > 10 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch { /* rotation is best effort */ }
  logStream = fs.createWriteStream(file, { flags: 'a' });
  logStream.write(`\n===== ${new Date().toISOString()} AstroviaBin desktop ${app.getVersion()} starting the server =====\n`);
}

function log(line) {
  if (logStream) logStream.write(line.endsWith('\n') ? line : `${line}\n`);
}

// ---------------------------------------------------------------------------------------------
// Server process

function portInUse(port, host) {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once('error', error => resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES'))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, host === '0.0.0.0' ? undefined : host);
  });
}

function healthy(port) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

function runPreflight(env) {
  return new Promise((resolve, reject) => {
    execFile(RES.node, [RES.preflight], {
      cwd: RES.server, env: { ...process.env, ...env }, timeout: 10 * 60_000, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (stdout) log(stdout);
      if (stderr) log(stderr);
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve();
    });
  });
}

function ensureFolders(values) {
  for (const id of ['photosDir', 'fitsUploadsDir', 'fitsLibraryDir', 'fitsDerivedDir', 'fitsAnalysisDir', 'cacheDir', 'sidecarsDir', 'backupsDir', 'logsDir']) {
    fs.mkdirSync(values[id], { recursive: true });
  }
  fs.mkdirSync(path.dirname(values.databaseFile), { recursive: true });
  if (values.extraIndexDir) fs.mkdirSync(values.extraIndexDir, { recursive: true });
}

async function startServer() {
  if (state.child || state.status === 'starting') return;
  state.stopRequested = false;
  setStatus('starting', 'Starting the server…');
  try {
    await ensurePpxf();
  } catch (error) {
    setStatus('error', `The scientific runtime could not be downloaded. Check internet access and choose Start server to retry: ${error.message}`);
    notify('AstroviaBin needs its scientific runtime', state.message);
    return;
  }
  try {
    ensureFolders(state.values);
  } catch (error) {
    setStatus('error', `A storage folder cannot be created: ${error.message}`);
    notify('AstroviaBin could not start', state.message);
    return;
  }
  if (await portInUse(Number(state.values.port), state.values.host)) {
    if (await healthy(Number(state.values.port))) {
      // Already served, e.g. by the astroviabin.service systemd unit: use it instead of starting a second one.
      state.external = true;
      setStatus('running', `Running at ${url()} (managed by the AstroviaBin system service)`);
      if (state.values.openBrowserOnStart && !state.openedOnce && !process.argv.includes('--hidden')) {
        state.openedOnce = true;
        openApp();
      }
      return;
    }
    setStatus('error', `Port ${state.values.port} is already in use (another AstroviaBin or program). Change the port in Settings or stop the other program.`);
    notify('AstroviaBin could not start', state.message);
    return;
  }
  state.external = false;
  openLog();
  const env = { ...process.env, ...config.serverEnvironment(state.values, RES) };
  log(`server: ${RES.server}\nnode: ${RES.node}\ndatabase: ${state.values.databaseFile}`);
  try {
    await runPreflight(env);
  } catch (error) {
    setStatus('error', `Database safety check or backup failed; the server was not started: ${error.message}`);
    notify('AstroviaBin did not touch your database', state.message);
    return;
  }
  const child = spawn(RES.node, [path.join(RES.server, 'dist', 'index.js')], {
    cwd: RES.server,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Own process group on Linux, so stopping it also stops the plate-solving worker it starts.
    detached: !isWindows,
  });
  state.child = child;
  child.stdout.on('data', chunk => log(String(chunk)));
  child.stderr.on('data', chunk => log(String(chunk)));
  child.on('error', error => {
    log(`failed to start: ${error.message}`);
    setStatus('error', `The server could not be started: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    log(`server exited (code ${code}, signal ${signal})`);
    state.child = null;
    if (state.stopRequested || state.quitting) {
      setStatus('stopped', 'Server stopped.');
      return;
    }
    // Unexpected exit: restart with a growing delay, give up after five tries.
    state.restarts += 1;
    if (state.restarts <= 5) {
      setStatus('error', `The server stopped unexpectedly (exit ${code ?? signal}); restarting…`);
      setTimeout(() => { if (!state.child && !state.stopRequested) startServer(); }, Math.min(30_000, 1000 * 2 ** state.restarts));
    } else {
      setStatus('error', 'The server keeps stopping. Open the logs folder from the tray menu to see why.');
      notify('AstroviaBin stopped', state.message);
    }
  });

  // Wait for the health endpoint (migrations on a large database can take a while).
  const started = Date.now();
  while (state.child === child && Date.now() - started < 180_000) {
    if (await healthy(Number(state.values.port))) {
      state.restarts = 0;
      setStatus('running', `Running at ${url()}`);
      if (state.values.openBrowserOnStart && !state.openedOnce && !process.argv.includes('--hidden')) {
        state.openedOnce = true;
        openApp();
      }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (state.child === child && state.status === 'starting') {
    setStatus('error', 'The server did not answer within 3 minutes. Open the logs folder from the tray menu.');
  }
}

function stopServer() {
  return new Promise(resolve => {
    const child = state.child;
    if (!child) { resolve(); return; }
    state.stopRequested = true;
    setStatus('stopping', 'Stopping the server…');
    const timer = setTimeout(() => {
      // Still running after 15 s: force it (and its worker) to stop.
      if (isWindows) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => undefined);
      else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 15_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (isWindows) {
      // No POSIX signals on Windows: end the server and its worker together.
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => undefined);
    } else {
      // SIGTERM to the process group: the server shuts its worker down gracefully.
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }
  });
}

async function restartServer() {
  if (state.external) {
    // The astroviabin.service systemd unit (Linux) serves AstroviaBin: restart it with the saved settings.
    if (isWindows) return;
    // Never start a second server here: wait for the service itself to answer (two servers must not
    // share one database).
    setStatus('starting', 'Restarting the AstroviaBin system service…');
    const failed = await new Promise(resolve => execFile('systemctl', ['--user', 'restart', 'astroviabin.service'], resolve));
    if (failed) { setStatus('error', `The system service could not be restarted: ${failed.message}`); return; }
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      if (await healthy(Number(state.values.port))) {
        setStatus('running', `Running at ${url()} (managed by the AstroviaBin system service)`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    setStatus('error', 'The AstroviaBin system service did not come back; see "journalctl --user -u astroviabin.service".');
    return;
  }
  await stopServer();
  state.restarts = 0;
  await startServer();
}

function stopExternalServer() {
  setStatus('stopping', 'Stopping the AstroviaBin system service…');
  execFile('systemctl', ['--user', 'stop', 'astroviabin.service'], error => {
    state.external = false;
    setStatus(error ? 'error' : 'stopped', error ? `The system service could not be stopped: ${error.message}` : 'Stopped');
  });
}

/** "Only this computer" (127.0.0.1) or "every device on my local network" (0.0.0.0); restarts the server. */
async function setSharing(host) {
  if (state.values.host === host) return;
  state.values.host = host;
  config.save(app, state.values, safeStorage);
  refreshTray();
  if (state.child || state.external) {
    if (state.external && isWindows) return;
    await restartServer();
    const shared = host !== '127.0.0.1';
    notify('AstroviaBin', shared
      ? `Shared on your local network: ${lanAddresses().map(address => `http://${address}:${state.values.port}`).join(', ') || 'no network address found'}`
      : 'Only this computer can open AstroviaBin now.');
  }
}

// ---------------------------------------------------------------------------------------------
// AstroviaBin window (the web interface in its own app window)

let appWindow = null;
const windowStateFile = () => path.join(config.configDirectory(app), 'window-state.json');

function sameOrigin(target) {
  try { return new URL(target).origin === new URL(url()).origin; } catch { return false; }
}

/** Links to other sites (Aladin, SIMBAD, TNS…) open in the web browser; AstroviaBin pages stay in the app. */
function keepInApp(contents) {
  contents.setWindowOpenHandler(({ url: target }) => {
    if (sameOrigin(target)) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        autoHideMenuBar: true, icon: RES.icon, backgroundColor: '#05030c',
        webPreferences: { partition: 'persist:astroviabin', contextIsolation: true, sandbox: true, plugins: true },
      } };
    }
    if (/^(https?|mailto):/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, target) => {
    if (sameOrigin(target)) return;
    event.preventDefault();
    if (/^(https?|mailto):/i.test(target)) shell.openExternal(target);
  });
  contents.on('did-create-window', child => keepInApp(child.webContents));
}

function openApp() {
  if (state.status !== 'running') { openSettings(); return; }
  if (state.values.openIn === 'browser') { shell.openExternal(url()); return; }
  if (appWindow && !appWindow.isDestroyed()) {
    if (appWindow.isMinimized()) appWindow.restore();
    appWindow.show();
    appWindow.focus();
    return;
  }
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8')); } catch { /* first window */ }
  appWindow = new BrowserWindow({
    width: saved.width || 1400, height: saved.height || 900, x: saved.x, y: saved.y,
    minWidth: 640, minHeight: 480, title: 'AstroviaBin', icon: RES.icon, backgroundColor: '#05030c',
    autoHideMenuBar: true, show: false,
    // A persistent session keeps you signed in between launches; the page gets no Node access.
    webPreferences: { partition: 'persist:astroviabin', contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: true },
  });
  appWindow.setMenu(Menu.buildFromTemplate([
    { label: 'AstroviaBin', submenu: [
      { label: 'Open in web browser', click: () => shell.openExternal(appWindow.webContents.getURL() || url()) },
      { label: 'Copy page address', click: () => require('electron').clipboard.writeText(appWindow.webContents.getURL() || url()) },
      { type: 'separator' },
      { label: 'Server settings…', click: () => openSettings() },
      { type: 'separator' },
      { role: 'close', label: 'Close window (the server keeps running)' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Back', accelerator: 'Alt+Left', click: () => appWindow.webContents.navigationHistory.canGoBack() && appWindow.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => appWindow.webContents.navigationHistory.canGoForward() && appWindow.webContents.navigationHistory.goForward() },
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
  ]));
  if (saved.maximized) appWindow.maximize();
  keepInApp(appWindow.webContents);
  appWindow.once('ready-to-show', () => appWindow.show());
  // While the server restarts the page cannot load: try again until it is back.
  appWindow.webContents.on('did-fail-load', (_event, code, _description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (!appWindow.isVisible()) appWindow.show();
    setTimeout(() => { if (appWindow && !appWindow.isDestroyed()) appWindow.loadURL(sameOrigin(failedUrl) ? failedUrl : url()); }, 2000);
  });
  appWindow.on('close', () => {
    try {
      const bounds = appWindow.getNormalBounds();
      fs.writeFileSync(windowStateFile(), JSON.stringify({ ...bounds, maximized: appWindow.isMaximized() }));
    } catch { /* not important */ }
  });
  appWindow.on('closed', () => { appWindow = null; });
  appWindow.loadURL(url());
}

// ---------------------------------------------------------------------------------------------
// Login item

function setLaunchAtLogin(enabled) {
  if (process.platform === 'linux') {
    const autostartDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
    const file = path.join(autostartDir, 'astroviabin.desktop');
    if (enabled && app.isPackaged) {
      fs.mkdirSync(autostartDir, { recursive: true });
      fs.writeFileSync(file, [
        '[Desktop Entry]', 'Type=Application', 'Name=AstroviaBin', 'Comment=AstroviaBin server (system tray)',
        `Exec="${process.execPath}" --hidden`, `Icon=astroviabin`, 'X-GNOME-Autostart-enabled=true', 'Terminal=false', '',
      ].join('\n'));
    } else if (!enabled) {
      fs.rmSync(file, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'], name: 'AstroviaBin' });
  }
}

// ---------------------------------------------------------------------------------------------
// Tray

const STATUS_LABEL = {
  stopped: 'Server stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…', error: 'Problem',
};

function setStatus(status, message) {
  state.status = status;
  state.message = message;
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('server-status', { status, message });
  refreshTray();
}

function folderItem(label, folder) {
  return { label, enabled: Boolean(folder), click: () => { fs.mkdirSync(folder, { recursive: true }); shell.openPath(folder); } };
}

function refreshTray() {
  if (!tray) return;
  const running = state.status === 'running';
  const busy = state.status === 'starting' || state.status === 'stopping';
  const values = state.values;
  tray.setToolTip(`AstroviaBin — ${STATUS_LABEL[state.status]}${running ? ` (${url()})` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `AstroviaBin — ${STATUS_LABEL[state.status]}`, enabled: false },
    { label: state.message || ' ', enabled: false },
    { type: 'separator' },
    { label: 'Open AstroviaBin', enabled: running, click: () => openApp() },
    { label: 'Open in web browser', enabled: running, click: () => shell.openExternal(url()) },
    { label: 'Copy address', enabled: running, click: () => require('electron').clipboard.writeText(url()) },
    { label: 'Share AstroviaBin with', submenu: [
      { label: 'Only this computer', type: 'radio', checked: values.host === '127.0.0.1', click: () => setSharing('127.0.0.1') },
      { label: 'Every device on my local network', type: 'radio', checked: values.host !== '127.0.0.1', click: () => setSharing('0.0.0.0') },
      { type: 'separator' },
      ...(values.host !== '127.0.0.1' && lanAddresses().length
        ? lanAddresses().map(address => ({ label: `Copy http://${address}:${values.port}`, enabled: running,
          click: () => require('electron').clipboard.writeText(`http://${address}:${values.port}`) }))
        : [{ label: values.host === '127.0.0.1' ? 'Other devices cannot connect' : 'No network address found', enabled: false }]),
    ] },
    { type: 'separator' },
    { label: 'Start server', enabled: !state.child && !busy && state.configured, click: () => { state.restarts = 0; startServer(); } },
    { label: 'Stop server', enabled: (Boolean(state.child) || (state.external && !isWindows)) && !busy,
      click: () => (state.external ? stopExternalServer() : stopServer()) },
    { label: 'Restart server', enabled: (Boolean(state.child) || (state.external && !isWindows)) && !busy, click: () => restartServer() },
    { type: 'separator' },
    { label: 'Settings…', click: () => openSettings() },
    { label: 'Open folder', submenu: [
      folderItem('Photos', values.photosDir),
      folderItem('Uploaded FITS', values.fitsUploadsDir),
      folderItem('FITS library', values.fitsLibraryDir),
      folderItem('Stacks and processed FITS', values.fitsDerivedDir),
      folderItem('HOTPANTS analyses', values.fitsAnalysisDir),
      { type: 'separator' },
      folderItem('Database folder', values.databaseFile ? path.dirname(values.databaseFile) : ''),
      folderItem('Database backups', values.backupsDir),
      folderItem('Logs', values.logsDir),
    ] },
    { label: 'Open server log', enabled: Boolean(values.logsDir), click: () => shell.openPath(logFile()) },
    { label: 'Start AstroviaBin when I log in', type: 'checkbox', checked: Boolean(values.launchAtLogin), click: item => {
      state.values.launchAtLogin = item.checked;
      config.save(app, state.values, safeStorage);
      setLaunchAtLogin(item.checked);
    } },
    { type: 'separator' },
    { label: 'About AstroviaBin', click: () => dialog.showMessageBox({
      type: 'info', title: 'About AstroviaBin', icon: nativeImage.createFromPath(RES.icon),
      message: `AstroviaBin ${app.getVersion()}`,
      detail: 'A private, self-hosted library for astrophotography: photos and FITS, local plate solving, annotations, stacking and transient search.\n\nhttps://github.com/kroryan/AstroviaBIn',
    }) },
    { label: 'Quit AstroviaBin (stops the server)', click: () => app.quit() },
  ]));
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'assets'), isWindows ? 'tray.ico' : 'tray.png'));
  tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(RES.icon).resize({ width: 22, height: 22 }) : image);
  tray.on('click', () => { if (state.status === 'running') openApp(); else openSettings(); });
  refreshTray();
}

// ---------------------------------------------------------------------------------------------
// Setup / settings window

function openWindow(mode) {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 1040, height: 780, minWidth: 760, minHeight: 560, show: false,
    title: mode === 'setup' ? 'AstroviaBin setup' : 'AstroviaBin settings',
    backgroundColor: '#05030c', icon: RES.icon, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  setupWindow.removeMenu();
  setupWindow.loadFile(path.join(__dirname, 'setup', 'index.html'), { query: { mode } });
  setupWindow.once('ready-to-show', () => setupWindow.show());
  setupWindow.on('closed', () => {
    setupWindow = null;
    // Closing the first-run setup without saving leaves nothing running.
    if (!state.configured) app.quit();
  });
  // Links in the help text open in the browser, never inside the window.
  setupWindow.webContents.setWindowOpenHandler(({ url: target }) => { shell.openExternal(target); return { action: 'deny' }; });
}

function openSetup() { openWindow('setup'); }
function openSettings() { openWindow(state.configured ? 'settings' : 'setup'); }

function which(program) {
  return new Promise(resolve => {
    if (!program) return resolve(null);
    if (path.isAbsolute(program)) return resolve(fs.existsSync(program) ? program : null);
    execFile(isWindows ? 'where' : 'which', [program], (error, stdout) => resolve(error ? null : stdout.split(/\r?\n/)[0].trim()));
  });
}

function runCheck(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => resolve({ ok: !error, output: (stdout || stderr || (error && error.message) || '').trim() }));
  });
}

ipcMain.handle('state', () => ({
  mode: state.configured ? 'settings' : 'setup',
  schema: config.schema(RES),
  values: state.values,
  platform: process.platform,
  version: app.getVersion(),
  status: { status: state.status, message: state.message },
  passwordProtection: safeStorage.isEncryptionAvailable() ? 'encrypted with your system keyring' : 'stored in your private settings file',
}));

ipcMain.handle('pick', async (_event, { kind, current, title }) => {
  const result = await dialog.showOpenDialog(setupWindow, {
    title, defaultPath: current || os.homedir(),
    properties: kind === 'dir' ? ['openDirectory', 'createDirectory'] : ['openFile', 'promptToCreate'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('check', async (_event, values) => {
  const results = {};
  for (const id of ['photosDir', 'fitsUploadsDir', 'fitsLibraryDir', 'fitsDerivedDir', 'fitsAnalysisDir', 'cacheDir', 'sidecarsDir', 'backupsDir', 'logsDir']) {
    if (values[id]) results[id] = config.checkFolder(values[id]);
  }
  if (values.databaseFile) {
    results.databaseFile = config.checkDatabase(values.databaseFile);
  }
  if (values.plateSolvingEnabled) {
    const solver = await which(values.solveField);
    results.solveField = solver ? { ok: true, message: `Found: ${solver}` } : { ok: false, message: 'solve-field was not found. Install Astrometry.net or set the full path.' };
    if (values.indexDir) {
      const files = fs.existsSync(values.indexDir) ? fs.readdirSync(values.indexDir).filter(name => /^index-.*\.fits$/i.test(name)).length : 0;
      results.indexDir = files ? { ok: true, message: `${files} index files found.` } : { ok: false, message: 'No index-*.fits files here: wide-field solving will not work.' };
    }
  }
  if (values.pythonPath) {
    const python = await runCheck(values.pythonPath, ['-c', 'import numpy, scipy, astropy, ccdproc, photutils, astroscrappy, specutils, specreduce, astroquery, matplotlib; print("numpy", numpy.__version__, "astropy", astropy.__version__, "ccdproc", ccdproc.__version__)']);
    results.pythonPath = python.ok ? { ok: true, message: `Ready (${python.output}).` } : { ok: false, message: `Missing analysis packages: ${python.output.split('\n').pop()}` };
  }
  if (values.hotpantsDir) {
    const binary = path.join(values.hotpantsDir, isWindows ? 'hotpants.exe' : 'hotpants');
    results.hotpantsDir = fs.existsSync(binary) ? { ok: true, message: 'HOTPANTS found.' } : { ok: false, message: 'hotpants was not found in this folder: transient search will be unavailable.' };
  }
  const port = Number(values.port);
  if (port && !(state.child && Number(state.values.port) === port)) {
    results.port = (await portInUse(port, values.host)) ? { ok: false, message: `Port ${port} is in use by another program.` } : { ok: true, message: 'Free.' };
  }
  return results;
});

ipcMain.handle('save', async (_event, values) => {
  const problems = { ...config.validate(values, RES), ...config.validateStorage(values, { create: true }) };
  if (Object.keys(problems).length) return { ok: false, problems };
  const wasConfigured = state.configured;
  const previous = state.values;
  config.save(app, values, safeStorage);
  loadConfig();
  setLaunchAtLogin(state.values.launchAtLogin);
  refreshTray();
  if (!wasConfigured) {
    state.openedOnce = false;
    startServer();
  } else if (state.child && JSON.stringify(config.serverEnvironment(previous, RES)) !== JSON.stringify(config.serverEnvironment(state.values, RES))) {
    restartServer();
  } else if (!state.child) {
    startServer();
  }
  return { ok: true };
});

ipcMain.handle('close', () => { if (setupWindow) setupWindow.close(); });
ipcMain.handle('open-external', (_event, target) => shell.openExternal(target));

// ---------------------------------------------------------------------------------------------
// Lifecycle

app.whenReady().then(() => {
  if (isWindows) app.setAppUserModelId('io.github.kroryan.astroviabin');
  // MSIX's installation directory is read-only. Its first launch completes the same
  // direct PyPI installation in the app's private runtime folder.
  if (isWindows && process.windowsStore) RES.ppxf = path.join(app.getPath('userData'), 'runtime', 'ppxf');
  loadConfig();
  createTray();
  if (!state.configured) {
    openSetup();
  } else {
    startServer();
    if (!process.argv.includes('--hidden') && state.values.openBrowserOnStart === false) openSettings();
  }
});

// The app lives in the tray: closing windows does not quit it.
app.on('window-all-closed', () => { /* keep running */ });

app.on('before-quit', event => {
  if (state.quitting) return;
  state.quitting = true;
  if (state.child) {
    event.preventDefault();
    stopServer().finally(() => app.quit());
  }
});
