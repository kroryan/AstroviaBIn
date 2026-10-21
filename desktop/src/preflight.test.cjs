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

test('preflight recovers a hot journal left by a power cut instead of refusing to start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astroviabin-preflight-'));
  try {
    const source = path.join(root, 'sidereal.db');
    const database = new Database(source);
    database.exec("CREATE TABLE images (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO images(name) VALUES ('M31'), ('M42')");
    database.close();
    // A writer that dies in the middle of a transaction (as in a power cut) leaves a hot journal.
    const { spawnSync } = require('node:child_process');
    const crash = spawnSync(process.execPath, ['-e', `
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db = new Database(${JSON.stringify(source)});
      db.pragma('cache_size = 1');
      db.exec('BEGIN');
      for (let i = 0; i < 2000; i++) db.prepare("INSERT INTO images(name) VALUES ('half-written row padding padding padding')").run();
      process.kill(process.pid, 'SIGKILL');
    `]);
    assert.equal(crash.signal, 'SIGKILL');
    assert.ok(fs.statSync(`${source}-journal`).size > 0, 'the crash left a hot journal');

    const destination = await backupExistingDatabase({ databaseFile: source, backupDirectory: path.join(root, 'backups') });
    assert.ok(destination);
    const recovered = new Database(source, { readonly: true });
    assert.equal(recovered.prepare('SELECT count(*) AS count FROM images').get().count, 2, 'the unfinished transaction is rolled back');
    assert.equal(recovered.pragma('quick_check', { simple: true }), 'ok');
    recovered.close();
    assert.ok(!fs.existsSync(`${source}-journal`) || fs.statSync(`${source}-journal`).size === 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
