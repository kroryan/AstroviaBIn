'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { backupExistingDatabase } = require('./preflight.cjs');

test('preflight creates an integrity-checked backup without changing the live database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astroviabin-preflight-'));
  try {
    const source = path.join(root, 'sidereal.db');
    const database = new Database(source);
    database.exec('CREATE TABLE images (id INTEGER PRIMARY KEY, annotations TEXT); INSERT INTO images(annotations) VALUES (\'M31\'), (\'M42\')');
    database.close();
    const before = fs.readFileSync(source);

    const destination = await backupExistingDatabase({ databaseFile: source, backupDirectory: path.join(root, 'backups') });
    assert.ok(destination && fs.existsSync(destination));
    assert.deepEqual(fs.readFileSync(source), before);
    const backup = new Database(destination, { readonly: true });
    assert.equal(backup.prepare('SELECT count(*) AS count FROM images').get().count, 2);
    assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
    backup.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preflight is a no-op for a clean first start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astroviabin-preflight-'));
  try {
    assert.equal(await backupExistingDatabase({ databaseFile: path.join(root, 'new.db') }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
