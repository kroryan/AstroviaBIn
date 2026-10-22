'use strict';
/**
 * Desktop configuration: one schema drives the setup window, validation, and the environment
 * passed to the AstroviaBin server. Stored as JSON in the user's config folder.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWindows = process.platform === 'win32';

/**
 * Where the settings file lives: Electron's userData folder (~/.config/AstroviaBin on Linux,
 * %APPDATA%\\AstroviaBin on Windows). The headless server computes the same folder without Electron.
 */
function configDirectory(app) {
  if (app && typeof app.getPath === 'function') return app.getPath('userData');
  return isWindows
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AstroviaBin')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'AstroviaBin');
}

function configPath(app) {
  return path.join(configDirectory(app), 'astroviabin-desktop.json');
}

function defaultDataRoot() {
  return isWindows
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AstroviaBin')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'AstroviaBin');
}

function defaultMediaRoot() {
  return path.join(os.homedir(), 'Pictures', 'AstroviaBin');
}

/**
 * The settings, grouped in the order the setup window shows them. `env` maps a setting to the
 * server environment variable it controls; `restart` settings need a server restart.
 */
function schema(resources) {
  const data = defaultDataRoot();
  const media = defaultMediaRoot();
  return [
    {
      id: 'server', title: 'Server', description: 'How the AstroviaBin web interface is reached.',
      settings: [
        { id: 'host', label: 'Who can open AstroviaBin', type: 'select', default: '127.0.0.1',
          options: [
            { value: '127.0.0.1', label: 'Only this computer (recommended)' },
            { value: '0.0.0.0', label: 'Every device on my local network' },
          ],
          help: 'With "local network", phones, tablets and other computers on your network can open AstroviaBin at http://<this-computer>:<port>. Everyone still needs to sign in. Do not expose this port to the internet.' },
        { id: 'port', label: 'Port', type: 'number', default: 5000, min: 1024, max: 65535,
          help: 'The address becomes http://localhost:<port>. Change it only if another program already uses 5000.' },
        { id: 'openIn', label: 'Open AstroviaBin in', type: 'select', default: 'window',
          options: [
            { value: 'window', label: 'Its own app window (recommended)' },
            { value: 'browser', label: 'My web browser' },
          ],
          help: 'The app window is AstroviaBin on its own, without browser tabs, and keeps you signed in. Links to other sites (SIMBAD, Aladin…) open in your browser. "Open in web browser" in the tray menu is always available.' },
        { id: 'openBrowserOnStart', label: 'Open AstroviaBin when the server starts', type: 'bool', default: true,
          help: 'Not when it starts in the background at login. You can always open it from the tray icon menu.' },
        { id: 'launchAtLogin', label: 'Start AstroviaBin when I log in', type: 'bool', default: true,
          help: 'Starts the tray icon and the server in the background after you log in.' },
      ],
    },
    {
      id: 'account', title: 'Administrator account', description: 'Signing in is always required, even on this computer.',
      settings: [
        { id: 'adminUser', label: 'Administrator user name', type: 'text', default: 'admin', required: true,
          help: 'Used to sign in. Add more users (editors, viewers) later in Admin settings.' },
        { id: 'adminPassword', label: 'Administrator password', type: 'password', default: '', required: true, minLength: 8,
          help: 'At least 8 characters. It is stored only in this computer\'s AstroviaBin settings file, readable by your user account only.' },
      ],
    },
    {
      id: 'storage', title: 'Storage', description: 'Where everything lives. The database and your images can be on different drives — keep the database on a fast local disk, and put photos and FITS wherever you have space (an external drive or NAS works). Existing folders are used as they are; nothing is moved or deleted.',
      settings: [
        { id: 'databaseFile', label: 'Database file', type: 'file', default: path.join(data, 'astroviabin.db'), required: true,
          help: 'The SQLite database with your gallery, albums, plate solutions and settings. Its folder also holds daily database backups, the session key and cached catalogue lookups. To keep using an existing AstroviaBin/Sidereal database, choose its file (astroviabin.db or sidereal.db).' },
        { id: 'photosDir', label: 'Photos (uploaded images)', type: 'dir', default: path.join(media, 'Photos'), required: true, env: 'LIBRARY_STORAGE_DIR',
          help: 'Original JPEG/PNG/TIFF… files you upload are stored here.' },
        { id: 'fitsUploadsDir', label: 'Uploaded FITS', type: 'dir', default: path.join(media, 'FITS', 'uploads'), required: true, env: 'FITS_UPLOAD_DIR',
          help: 'FITS files you upload through AstroviaBin.' },
        { id: 'fitsLibraryDir', label: 'FITS library to scan', type: 'dir', default: path.join(media, 'FITS', 'library'), required: true, env: 'FITS_LIBRARY_DIR',
          help: 'A folder of FITS you already have (for example your capture folder). "Scan FITS" indexes it without copying or changing the files.' },
        { id: 'fitsDerivedDir', label: 'Stacks and processed FITS', type: 'dir', default: path.join(media, 'FITS', 'derivatives'), required: true, env: 'FITS_DERIVATIVES_DIR',
          help: 'Stacks and processed FITS created by AstroviaBin.' },
        { id: 'fitsAnalysisDir', label: 'HOTPANTS analyses', type: 'dir', default: path.join(media, 'FITS', 'analysis'), required: true, env: 'FITS_ANALYSIS_DIR',
          help: 'Difference images, candidate stamps and PDF reports of transient searches.' },
        { id: 'cacheDir', label: 'Cache (thumbnails, zoom tiles, previews)', type: 'dir', default: path.join(data, 'cache'), required: true,
          help: 'Rebuildable files. Fast disk recommended; it is trimmed automatically (size limit below).' },
        { id: 'sidecarsDir', label: 'XMP sidecars', type: 'dir', default: path.join(media, 'Sidecars'), required: true, env: 'XMP_SIDECAR_PATH',
          help: 'XMP files with plate-solve metadata for Lightroom, darktable and other photo tools (enable them in Admin settings).' },
        { id: 'backupsDir', label: 'Database backups', type: 'dir', default: path.join(data, 'backups'), required: true, env: 'ASTROVIABIN_BACKUP_DIR',
          help: 'A copy of the database is made every day; the newest 14 are kept. Another drive is safer.' },
        { id: 'logsDir', label: 'Logs', type: 'dir', default: path.join(data, 'logs'), required: true,
          help: 'Server logs, for troubleshooting (tray menu → Open logs folder).' },
      ],
    },
    {
      id: 'solving', title: 'Plate solving', description: 'Plate solving finds where in the sky each image points, so AstroviaBin can annotate stars and objects, group images by field and compare FITS. It runs privately on this computer with Astrometry.net.',
      settings: [
        { id: 'plateSolvingEnabled', label: 'Enable local plate solving', type: 'bool', default: !isWindows,
          help: isWindows
            ? 'Astrometry.net has no native Windows build. Enable this only if you installed solve-field yourself (for example in WSL or with the ANSVR/Cygwin package) and set its path below.'
            : 'Requires Astrometry.net (installed with this package as a dependency).' },
        { id: 'solveField', label: 'solve-field program', type: 'file', default: isWindows ? '' : 'solve-field', env: 'ASTROMETRY_SOLVE_FIELD',
          help: 'The Astrometry.net solver. "solve-field" uses the one on the system PATH.' },
        { id: 'indexDir', label: 'Astrometry.net index folder', type: 'dir', default: isWindows ? '' : '/usr/share/astrometry', env: 'ASTROMETRY_INDEX_DIR',
          help: 'Index files installed with Astrometry.net (wide fields, about 0.3° and larger).' },
        { id: 'extraIndexDir', label: 'Extra index folder (narrow fields)', type: 'dir', default: path.join(data, 'astrometry-index'), env: 'ASTROMETRY_EXTRA_INDEX_DIRS',
          help: 'Optional extra index files (for example 2MASS 4203–4207 for fields under 20′). AstroviaBin can download them from Admin settings.' },
        { id: 'solveTimeoutMinutes', label: 'Time limit per image (minutes)', type: 'number', default: 15, min: 1, max: 240,
          help: 'Hard images (sparse or very wide fields) are given up after this time.' },
      ],
    },
    {
      id: 'analysis', title: 'Analysis tools', description: 'FITS stacking/calibration, star extraction and HOTPANTS transient search use the scientific Python stack and HOTPANTS. Change these only to use your own installation.',
      settings: [
        { id: 'pythonPath', label: 'Python with the analysis packages', type: 'file', default: resources.python || '', env: 'ASTROVIABIN_ANALYSIS_PYTHON',
          help: 'Needs numpy, scipy, astropy, ccdproc, photutils, astroscrappy and matplotlib. Leave the default to use the one installed with AstroviaBin.' },
        { id: 'hotpantsDir', label: 'HOTPANTS programs folder', type: 'dir', default: resources.hotpants || '', env: 'HOTPANTS_BIN_DIR',
          help: 'Folder with hotpants, extractkern-ones and maskim. Leave the default to use the bundled ones.' },
      ],
    },
    {
      id: 'online', title: 'Online services and limits', description: 'Optional internet lookups and safety limits.',
      settings: [
        { id: 'onlineCatalogs', label: 'Use online catalogues (Gaia DR3, SIMBAD, VizieR, SkyBoT)', type: 'bool', default: true,
          help: 'Deeper annotations and candidate verification. Only sky coordinates are sent, never your images. Results are cached on this computer.' },
        { id: 'maxUploadGB', label: 'Largest upload (GB)', type: 'number', default: 20, min: 1, max: 1000,
          help: 'Maximum size of one uploaded file.' },
        { id: 'fitsMaxProcessGB', label: 'Largest FITS to process (GB)', type: 'number', default: 1, min: 0.25, max: 64, step: 0.25,
          help: 'Stacking and processing load whole FITS into memory; keep this below your free RAM.' },
        { id: 'cacheMaxGB', label: 'Cache size limit (GB)', type: 'number', default: 10, min: 1, max: 1000,
          help: 'Older thumbnails and tiles are removed above this size.' },
      ],
    },
  ];
}

function defaults(resources) {
  const values = {};
  for (const group of schema(resources)) for (const setting of group.settings) values[setting.id] = setting.default;
  return values;
}

const MIN_FREE_BYTES = 64 * 1024 * 1024;

function availableBytes(folder) {
  try {
    const stats = fs.statfsSync(folder);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/**
 * The administrator password is encrypted with the operating system's credential store when one
 * is available (Electron safeStorage: GNOME Keyring/KWallet on Linux, DPAPI on Windows); otherwise
 * it is kept in the settings file, which only the user's account can read.
 */
function load(app, resources, safeStorage) {
  try {
    const stored = JSON.parse(fs.readFileSync(configPath(app), 'utf8'));
    const values = { ...defaults(resources), ...stored.values };
    if (stored.values.adminPasswordEncrypted) {
      // Only the desktop app can decrypt it; the headless server takes the password from its environment.
      values.adminPassword = safeStorage ? safeStorage.decryptString(Buffer.from(stored.values.adminPasswordEncrypted, 'base64')) : '';
    }
    delete values.adminPasswordEncrypted;
    return { configured: Boolean(stored.configured), values };
  } catch {
    return { configured: false, values: defaults(resources) };
  }
}

function save(app, values, safeStorage) {
  fs.mkdirSync(configDirectory(app), { recursive: true });
  const stored = { ...values };
  if (safeStorage && safeStorage.isEncryptionAvailable() && values.adminPassword) {
    stored.adminPasswordEncrypted = safeStorage.encryptString(values.adminPassword).toString('base64');
    delete stored.adminPassword;
  }
  const file = configPath(app);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ configured: true, savedAt: new Date().toISOString(), values: stored }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Problems with a set of values, as { id: message }. Creates missing folders it is asked to check. */
function validate(values, resources) {
  const problems = {};
  for (const group of schema(resources)) {
    for (const setting of group.settings) {
      const value = values[setting.id];
      if (setting.required && (value === '' || value === undefined || value === null)) problems[setting.id] = 'Required.';
      if (setting.type === 'number' && value !== undefined && value !== '') {
        const number = Number(value);
        if (!Number.isFinite(number) || (setting.min !== undefined && number < setting.min) || (setting.max !== undefined && number > setting.max)) {
          problems[setting.id] = `Enter a number from ${setting.min} to ${setting.max}.`;
        }
      }
      if (setting.minLength && String(value || '').length < setting.minLength) problems[setting.id] = `At least ${setting.minLength} characters.`;
    }
  }
  if (values.plateSolvingEnabled && !values.solveField) problems.solveField = 'Set the solve-field program, or disable plate solving.';
  return problems;
}

/** Folder checks for the setup window: exists or can be created, and is writable. */
function checkFolder(folder, { create = true, minFreeBytes = MIN_FREE_BYTES } = {}) {
  try {
    if (create) fs.mkdirSync(folder, { recursive: true });
    if (!fs.existsSync(folder)) return { ok: false, message: 'Folder does not exist.' };
    if (!fs.statSync(folder).isDirectory()) return { ok: false, message: 'This path is not a folder.' };
    const probe = path.join(folder, `.astroviabin-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    const free = availableBytes(folder);
    if (free !== null && free < minFreeBytes) return { ok: false, message: `Only ${formatBytes(free)} is free; at least ${formatBytes(minFreeBytes)} is required.` };
    return { ok: true, message: free === null ? 'Writable.' : `Writable · ${formatBytes(free)} free.` };
  } catch (error) {
    return { ok: false, message: error.code === 'EACCES' || error.code === 'EPERM' ? 'No permission to write here.' : error.message };
  }
}

function checkDatabase(databaseFile, options = {}) {
  const folder = checkFolder(path.dirname(databaseFile), options);
  if (!folder.ok) return folder;
  if (!fs.existsSync(databaseFile)) return { ok: true, exists: false, message: `A new database will be created here · ${folder.message}` };
  try {
    const stats = fs.statSync(databaseFile);
    if (!stats.isFile()) return { ok: false, message: 'The database path is not a regular file.' };
    const descriptor = fs.openSync(databaseFile, 'r+');
    try {
      const header = Buffer.alloc(16);
      const length = fs.readSync(descriptor, header, 0, header.length, 0);
      if (length !== 16 || header.toString('utf8') !== 'SQLite format 3\u0000') {
        return { ok: false, message: 'The existing file is not a valid SQLite database. It will not be overwritten.' };
      }
    } finally {
      fs.closeSync(descriptor);
    }
    return { ok: true, exists: true, message: `Existing SQLite database found (${(stats.size / 1024 ** 2).toFixed(1)} MB). It will be backed up and upgraded in place; it will not be recreated.` };
  } catch (error) {
    return { ok: false, message: error.code === 'EACCES' || error.code === 'EPERM' ? 'The database is not readable and writable by this user.' : error.message };
  }
}

function validateStorage(values, { create = false } = {}) {
  const problems = {};
  if (values.databaseFile) {
    const result = checkDatabase(values.databaseFile, { create });
    if (!result.ok) problems.databaseFile = result.message;
  }
  for (const id of ['photosDir', 'fitsUploadsDir', 'fitsLibraryDir', 'fitsDerivedDir', 'fitsAnalysisDir', 'cacheDir', 'sidecarsDir', 'backupsDir', 'logsDir']) {
    if (!values[id]) continue;
    const result = checkFolder(values[id], { create });
    if (!result.ok) problems[id] = result.message;
  }
  return problems;
}

/** Environment for the server process. */
function serverEnvironment(values, resources) {
  const env = {
    NODE_ENV: 'production',
    HOST: values.host,
    PORT: String(values.port),
    SQLITE_DB_PATH: values.databaseFile,
    ASTROVIABIN_ADMIN_USER: values.adminUser,
    ASTROVIABIN_ADMIN_PASSWORD: values.adminPassword,
    THUMBNAIL_CACHE_DIR: path.join(values.cacheDir, 'thumbnails'),
    TILE_CACHE_DIR: path.join(values.cacheDir, 'deep-zoom'),
    FITS_CACHE_DIR: path.join(values.cacheDir, 'fits'),
    ENABLE_PLATE_SOLVING: values.plateSolvingEnabled ? 'true' : 'false',
    ASTROMETRY_TIMEOUT_MS: String(Math.round(Number(values.solveTimeoutMinutes) * 60_000)),
    ASTROVIABIN_ONLINE_CATALOGS: values.onlineCatalogs ? 'true' : 'false',
    ASTROVIABIN_MAX_UPLOAD_BYTES: String(Math.round(Number(values.maxUploadGB) * 1024 ** 3)),
    FITS_MAX_PROCESS_BYTES: String(Math.round(Number(values.fitsMaxProcessGB) * 1024 ** 3)),
    ASTROVIABIN_CACHE_MAX_BYTES: String(Math.round(Number(values.cacheMaxGB) * 1024 ** 3)),
    ASTROVIABIN_SKY_DATA_DIR: resources.sky,
  };
  if (resources.ppxf) env.ASTROVIABIN_PPXF_DIR = resources.ppxf;
  // Third-party license texts and sources shipped with the installers (Admin → About links).
  if (resources.licenses) env.ASTROVIABIN_LICENSES_DIR = resources.licenses;
  for (const group of schema(resources)) {
    for (const setting of group.settings) {
      if (setting.env && values[setting.id] !== '' && values[setting.id] !== undefined) env[setting.env] = String(values[setting.id]);
    }
  }
  // A Python path saved by an older install (or on another machine) that no longer exists would make
  // stacking and analyses fail; use the bundled Python instead.
  if (resources.python && path.isAbsolute(String(values.pythonPath || '')) && !fs.existsSync(values.pythonPath)) {
    env.ASTROVIABIN_ANALYSIS_PYTHON = resources.python;
  }
  if (values.hotpantsDir) env.HOTPANTS_BIN = path.join(values.hotpantsDir, isWindows ? 'hotpants.exe' : 'hotpants');
  // Bundled programs first on PATH, so the analysis scripts find hotpants and solve-field.
  const extraPath = [values.hotpantsDir, values.solveField && path.isAbsolute(values.solveField) ? path.dirname(values.solveField) : ''].filter(Boolean);
  env.PATH = [...extraPath, process.env.PATH || ''].join(path.delimiter);
  return env;
}

module.exports = { schema, defaults, load, save, validate, validateStorage, checkFolder, checkDatabase, serverEnvironment, configPath, configDirectory, isWindows };
