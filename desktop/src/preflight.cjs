'use strict';

// Runs before the application imports its database module (and therefore before migrations).
// Existing SQLite databases are checked and backed up with SQLite's online backup API. Source
// databases and media are never moved, renamed, truncated, or deleted here.
const fs = require('node:fs');
const path = require('node:path');

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

async function backupExistingDatabase({
  databaseFile = process.env.SQLITE_DB_PATH,
  backupDirectory = process.env.ASTROVIABIN_BACKUP_DIR,
  keep = Number(process.env.ASTROVIABIN_PRESTART_BACKUP_KEEP || 7),
  now = new Date(),
} = {}) {
  if (!databaseFile || databaseFile === ':memory:' || !fs.existsSync(databaseFile)) return null;
  const source = path.resolve(databaseFile);
  const directory = path.resolve(backupDirectory || path.join(path.dirname(source), 'backups'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const Database = require('better-sqlite3');
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite quick_check failed: ${integrity}`);
    const destination = path.join(directory, `pre-start-${timestamp(now)}.db`);
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
      await database.backup(temporary);
      const check = new Database(temporary, { readonly: true, fileMustExist: true });
      try {
        const copiedIntegrity = check.pragma('quick_check', { simple: true });
        if (copiedIntegrity !== 'ok') throw new Error(`backup quick_check failed: ${copiedIntegrity}`);
      } finally {
        check.close();
      }
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);

      const old = fs.readdirSync(directory)
        .filter(name => /^pre-start-.*\.db$/.test(name))
        .sort()
        .reverse()
        .slice(Math.max(1, Number.isFinite(keep) ? keep : 7));
      for (const name of old) fs.rmSync(path.join(directory, name), { force: true });
      return destination;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  } finally {
    database.close();
  }
}

async function main() {
  const backup = await backupExistingDatabase();
  if (backup) process.stdout.write(`Verified pre-migration SQLite backup: ${backup}\n`);
  else process.stdout.write('No existing SQLite database; clean first start.\n');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`AstroviaBin preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { backupExistingDatabase, timestamp };
