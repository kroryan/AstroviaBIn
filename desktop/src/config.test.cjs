'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const config = require('./config.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astroviabin-setup-'));
  const resources = { python: 'python3', hotpants: path.join(root, 'bin') };
  const app = { getPath: () => path.join(root, 'settings') };
  const values = config.defaults(resources);
  Object.assign(values, {
    databaseFile: path.join(root, 'data', 'sidereal.db'),
    photosDir: path.join(root, 'media', 'photos'),
    fitsUploadsDir: path.join(root, 'media', 'fits', 'uploads'),
    fitsLibraryDir: path.join(root, 'media', 'fits', 'library'),
    fitsDerivedDir: path.join(root, 'media', 'fits', 'derived'),
    fitsAnalysisDir: path.join(root, 'media', 'fits', 'analysis'),
    cacheDir: path.join(root, 'data', 'cache'),
    sidecarsDir: path.join(root, 'data', 'sidecars'),
    backupsDir: path.join(root, 'data', 'backups'),
    logsDir: path.join(root, 'data', 'logs'),
    adminUser: 'admin', adminPassword: 'test-password',
  });
  return { root, resources, app, values };
}

test('clean first-run settings are atomic, private, and idempotent', () => {
  const { root, resources, app, values } = fixture();
  try {
    assert.deepEqual(config.validateStorage(values, { create: true }), {});
    config.save(app, values, null);
    const first = fs.readFileSync(config.configPath(app));
    assert.equal(fs.statSync(config.configPath(app)).mode & 0o777, 0o600);
    assert.equal(config.load(app, resources, null).configured, true);
    config.save(app, values, null);
    assert.equal(config.load(app, resources, null).values.databaseFile, values.databaseFile);
    assert.ok(first.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an existing database and media are reused without being modified by setup', () => {
  const { root, app, values } = fixture();
  try {
    fs.mkdirSync(path.dirname(values.databaseFile), { recursive: true });
    fs.mkdirSync(values.photosDir, { recursive: true });
    const photo = path.join(values.photosDir, 'existing.fit');
    fs.writeFileSync(photo, 'original pixels');
    const database = new Database(values.databaseFile);
    database.exec('CREATE TABLE annotations (id INTEGER PRIMARY KEY, payload TEXT); INSERT INTO annotations(payload) VALUES (\'kept\')');
    database.close();
    const before = fs.readFileSync(values.databaseFile);

    assert.equal(config.checkDatabase(values.databaseFile).exists, true);
    assert.deepEqual(config.validateStorage(values, { create: true }), {});
    config.save(app, values, null);

    assert.deepEqual(fs.readFileSync(values.databaseFile), before);
    assert.equal(fs.readFileSync(photo, 'utf8'), 'original pixels');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid database and missing storage fail closed', () => {
  const { root, values } = fixture();
  try {
    fs.mkdirSync(path.dirname(values.databaseFile), { recursive: true });
    fs.writeFileSync(values.databaseFile, 'not sqlite');
    assert.equal(config.checkDatabase(values.databaseFile).ok, false);
    assert.equal(config.checkFolder(path.join(root, 'missing'), { create: false }).ok, false);
    assert.ok(config.validateStorage(values, { create: false }).databaseFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
