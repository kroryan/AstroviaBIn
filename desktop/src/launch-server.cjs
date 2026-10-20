'use strict';
/**
 * Headless AstroviaBin server ("astroviabin-server", the astroviabin.service systemd unit): runs the
 * server with the same settings as the desktop app, without the tray. Used on machines managed
 * remotely (no desktop session) or by a service manager.
 *
 * Settings: the desktop settings file (written by the setup window). Environment variables override
 * any setting; the administrator password must come from the environment when the settings file
 * keeps it encrypted in the desktop keyring (ASTROVIABIN_ADMIN_PASSWORD, e.g. via
 * ~/.config/AstroviaBin/server.env for the systemd unit).
 *
 * Usage: astroviabin-server [--config <settings.json>] [--print-env]
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./desktop-config.cjs');

const isWindows = process.platform === 'win32';
const resourcesDir = path.resolve(__dirname, '..');
const resources = {
  server: __dirname,
  sky: path.join(resourcesDir, 'sky'),
  hotpants: path.join(resourcesDir, 'bin'),
  python: [path.join(resourcesDir, 'python', isWindows ? 'python.exe' : path.join('bin', 'python3')), '/opt/AstroviaBin/python/bin/python']
    .find(candidate => fs.existsSync(candidate)) || '',
};

const argument = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const settingsFile = argument('--config');
const app = settingsFile ? { getPath: () => path.dirname(path.resolve(settingsFile)) } : null;
const { configured, values } = config.load(app, resources, null);
if (!configured) {
  console.error(`AstroviaBin is not configured yet (no settings at ${config.configPath(app)}). Run "astroviabin-desktop" once to open the setup window, or pass --config.`);
  process.exit(78);
}
const env = config.serverEnvironment(values, resources);
// Explicit environment variables win over the settings file.
for (const key of Object.keys(env)) if (process.env[key] !== undefined && key !== 'PATH') env[key] = process.env[key];
if (!env.ASTROVIABIN_ADMIN_PASSWORD) {
  console.error('The administrator password is encrypted in the desktop keyring. Set ASTROVIABIN_ADMIN_PASSWORD (for the systemd unit: ~/.config/AstroviaBin/server.env).');
  process.exit(78);
}
if (process.argv.includes('--print-env')) {
  for (const [key, value] of Object.entries(env)) console.log(`${key}=${/PASSWORD|SECRET|TOKEN/.test(key) ? '***' : value}`);
  process.exit(0);
}
for (const id of ['photosDir', 'fitsUploadsDir', 'fitsLibraryDir', 'fitsDerivedDir', 'fitsAnalysisDir', 'cacheDir', 'sidecarsDir', 'backupsDir']) {
  fs.mkdirSync(values[id], { recursive: true });
}
fs.mkdirSync(path.dirname(values.databaseFile), { recursive: true });
Object.assign(process.env, env);
process.chdir(resources.server);
require('./preflight.cjs').backupExistingDatabase().then(backup => {
  if (backup) console.log(`Verified pre-migration SQLite backup: ${backup}`);
  return import(require('node:url').pathToFileURL(path.join(resources.server, 'dist', 'index.js')).href);
}).catch(error => {
  console.error(`AstroviaBin did not start because its database safety check or backup failed: ${error.message}`);
  process.exit(1);
});
