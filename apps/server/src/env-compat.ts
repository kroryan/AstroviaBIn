/**
 * AstroviaBin was previously named Sidereal. Accept the old SIDEREAL_* environment variables as
 * aliases for ASTROVIABIN_* so existing deployments keep working after the rename. Imported first
 * by every entry point, before any module reads its configuration.
 */
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('SIDEREAL_') || value === undefined) continue;
  const current = `ASTROVIABIN_${key.slice('SIDEREAL_'.length)}`;
  if (process.env[current] === undefined) process.env[current] = value;
}

export {};
