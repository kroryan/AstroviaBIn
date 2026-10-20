// Prepares everything the desktop package ships besides Electron itself, for one platform:
//   .stage/<linux|win>/server    built server + client, analysis scripts, migrations, runtime node_modules
//   .stage/<linux|win>/runtime   the Node.js binary that runs the server
//   .stage/<linux|win>/sky       offline sky catalogue (stars, deep-sky objects, constellations)
//   .stage/<linux|win>/bin       HOTPANTS programs
//   .stage/linux/wheels          Python wheels installed by the .deb into its virtual environment
//   .stage/win/python            embedded Python with the analysis packages
// Usage: node scripts/stage.mjs <linux|win> [--no-build]
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.argv[2];
if (!['linux', 'win'].includes(platform)) throw new Error('usage: stage.mjs <linux|win> [--no-build]');
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const cache = path.join(desktop, '.cache');
const stage = path.join(desktop, '.stage', platform);
const NODE_VERSION = process.version.replace(/^v/, ''); // the ABI of the native modules installed below
const PYTHON_VERSION = '3.13.12';
const PYTHON_PACKAGES = ['ccdproc==2.5.1', 'photutils==3.1.1', 'astroscrappy==1.3.0'];

const run = (command, args, options = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
};
const download = (url, target) => {
  if (existsSync(target)) return target;
  mkdirSync(path.dirname(target), { recursive: true });
  run('curl', ['-fL', '--retry', '3', '-o', `${target}.part`, url]);
  run('mv', [`${target}.part`, target]);
  return target;
};

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. Server and web client ------------------------------------------------------------------
if (!process.argv.includes('--no-build')) run('npm', ['run', 'build'], { cwd: repo });
const server = path.join(stage, 'server');
cpSync(path.join(repo, 'dist'), path.join(server, 'dist'), { recursive: true });
cpSync(path.join(repo, 'tools', 'migrations'), path.join(server, 'tools', 'migrations'), { recursive: true });
mkdirSync(path.join(server, 'tools', 'scripts'), { recursive: true });
for (const file of readdirSync(path.join(repo, 'tools', 'scripts'))) {
  if (file.endsWith('.py') && !file.startsWith('test_')) cpSync(path.join(repo, 'tools', 'scripts', file), path.join(server, 'tools', 'scripts', file));
}
for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) cpSync(path.join(repo, file), path.join(server, file));

// Runtime packages only (the server bundle imports these; the client is pre-built).
const rootPackage = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const runtime = ['@hono/node-server', 'better-sqlite3', 'drizzle-orm', 'drizzle-zod', 'hono', 'node-cron', 'pg', 'sharp', 'ws', 'zod'];
const dependencies = Object.fromEntries(runtime.map(name => [name, JSON.parse(readFileSync(path.join(repo, 'node_modules', name, 'package.json'), 'utf8')).version]));
writeFileSync(path.join(server, 'package.json'), JSON.stringify({
  name: 'astroviabin-server', version: rootPackage.version, private: true, type: rootPackage.type, license: rootPackage.license, dependencies,
}, null, 2));
const npmEnv = platform === 'win'
  ? { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64', npm_config_target: NODE_VERSION, npm_config_runtime: 'node' }
  : process.env;
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', ...(platform === 'win' ? ['--os=win32', '--cpu=x64'] : [])], { cwd: server, env: npmEnv });
if (platform === 'win') {
  // better-sqlite3 ships prebuilt binaries for every platform (prebuilds/<platform>-<arch>.node).
  if (!existsSync(path.join(server, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'))) throw new Error('better-sqlite3 has no win32-x64 binary');
  if (!existsSync(path.join(server, 'node_modules', '@img', 'sharp-win32-x64'))) throw new Error('sharp for Windows was not installed');
  for (const name of readdirSync(path.join(server, 'node_modules', '@img'))) {
    if (/linux|darwin|wasm/.test(name)) rmSync(path.join(server, 'node_modules', '@img', name), { recursive: true, force: true });
  }
}

// Drop what is never loaded at runtime: native sources, the WebAssembly fallback of sharp, typings, docs.
const prune = (target) => rmSync(target, { recursive: true, force: true });
prune(path.join(server, 'node_modules', 'better-sqlite3', 'deps'));
prune(path.join(server, 'node_modules', 'better-sqlite3', 'src'));
prune(path.join(server, 'node_modules', '@img', 'sharp-wasm32'));
const keepPrebuild = platform === 'win' ? 'win32-x64.node' : 'linux-x64.node';
for (const file of readdirSync(path.join(server, 'node_modules', 'better-sqlite3', 'prebuilds'))) {
  if (file !== keepPrebuild) prune(path.join(server, 'node_modules', 'better-sqlite3', 'prebuilds', file));
}
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    // .bin holds CLI symlinks the server never runs (and MSIX cannot package symlinks).
    if (entry.isSymbolicLink() || (entry.isDirectory() && entry.name === '.bin')) prune(target);
    else if (entry.isDirectory()) walk(target);
    else if (/\.(d\.ts|d\.mts|d\.cts|map|md|markdown)$/i.test(entry.name) && !/^license/i.test(entry.name)) prune(target);
  }
};
walk(path.join(server, 'node_modules'));

// 2. Node.js runtime ------------------------------------------------------------------------
mkdirSync(path.join(stage, 'runtime'), { recursive: true });
if (platform === 'linux') {
  const archive = download(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`, path.join(cache, `node-v${NODE_VERSION}-linux-x64.tar.xz`));
  run('tar', ['-xJf', archive, '-C', path.join(stage, 'runtime'), '--strip-components=2', `node-v${NODE_VERSION}-linux-x64/bin/node`]);
  run('tar', ['-xJf', archive, '-C', path.join(stage, 'runtime'), '--strip-components=1', `node-v${NODE_VERSION}-linux-x64/LICENSE`]);
} else {
  const archive = download(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`, path.join(cache, `node-v${NODE_VERSION}-win-x64.zip`));
  run('unzip', ['-q', '-j', '-o', archive, `node-v${NODE_VERSION}-win-x64/node.exe`, `node-v${NODE_VERSION}-win-x64/LICENSE`, '-d', path.join(stage, 'runtime')]);
}

// 3. Offline sky catalogue --------------------------------------------------------------------
// Built at Docker image build time (tools/scripts/build_sky_catalog.py); reuse the built bundle.
const skyCache = path.join(cache, 'sky');
if (!existsSync(path.join(skyCache, 'stars.json.gz'))) {
  const image = process.env.ASTROVIABIN_IMAGE || 'astroviabin:local';
  mkdirSync(cache, { recursive: true });
  const container = execFileSync('docker', ['create', image]).toString().trim();
  try { run('docker', ['cp', `${container}:/usr/share/astroviabin/sky`, skyCache]); } finally { execFileSync('docker', ['rm', container]); }
}
cpSync(skyCache, path.join(stage, 'sky'), { recursive: true });

// 4. HOTPANTS ---------------------------------------------------------------------------------
const bin = path.join(stage, 'bin');
mkdirSync(bin, { recursive: true });
const hotpantsCache = path.join(cache, `hotpants-${platform}`);
if (!existsSync(path.join(hotpantsCache, platform === 'win' ? 'hotpants.exe' : 'hotpants'))) {
  mkdirSync(hotpantsCache, { recursive: true });
  const script = platform === 'linux' ? 'build-hotpants-linux.sh' : 'build-hotpants-win.sh';
  const result = spawnSync('docker', ['run', '--rm', '-v', `${path.join(repo, 'vendor', 'hotpants')}:/src:ro`, '-v', `${hotpantsCache}:/out`,
    '-v', `${path.join(here, script)}:/build.sh:ro`, platform === 'linux' ? 'ubuntu:25.10' : 'ubuntu:25.10', 'bash', '/build.sh'], { stdio: 'inherit' });
  if (result.status !== 0) console.warn(`WARNING: HOTPANTS could not be built for ${platform}; transient search will be unavailable in this package.`);
}
if (existsSync(hotpantsCache)) cpSync(hotpantsCache, bin, { recursive: true });

// 5. Python -----------------------------------------------------------------------------------
// Downloads run as the current user so the staged files stay removable.
const asUser = ['-u', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp'];
if (platform === 'linux') {
  // The .deb uses Debian's numerical stack and installs CCDProc/Photutils/AstroScrappy plus their
  // missing pure/binary-wheel dependencies into its venv.
  const wheels = path.join(stage, 'wheels');
  mkdirSync(wheels, { recursive: true });
  run('docker', ['run', '--rm', ...asUser, '-v', `${wheels}:/out`, 'python:3.13-slim', 'pip', 'download', '--only-binary=:all:', '-d', '/out', ...PYTHON_PACKAGES]);
} else {
  // Windows: embedded Python with every analysis package.
  const python = path.join(stage, 'python');
  const embed = download(`https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`, path.join(cache, `python-${PYTHON_VERSION}-embed-amd64.zip`));
  run('unzip', ['-q', '-o', embed, '-d', python]);
  const short = PYTHON_VERSION.split('.').slice(0, 2).join('');
  // Enable site-packages in the embedded distribution.
  writeFileSync(path.join(python, `python${short}._pth`), [`python${short}.zip`, '.', 'Lib\\site-packages', 'import site', ''].join('\r\n'));
  const wheels = path.join(cache, `wheels-win-cp${short}`);
  mkdirSync(wheels, { recursive: true });
  run('docker', ['run', '--rm', ...asUser, '-v', `${wheels}:/out`, 'python:3.13-slim', 'pip', 'download', '--only-binary=:all:', '--platform', 'win_amd64',
    '--python-version', PYTHON_VERSION.split('.').slice(0, 2).join('.'), '--implementation', 'cp', '-d', '/out',
    'numpy', 'scipy', 'astropy', 'matplotlib', ...PYTHON_PACKAGES]);
  const site = path.join(python, 'Lib', 'site-packages');
  mkdirSync(site, { recursive: true });
  for (const wheel of readdirSync(wheels).filter(name => name.endsWith('.whl'))) run('unzip', ['-q', '-o', path.join(wheels, wheel), '-d', site]);
}

// 6. Headless launcher (astroviabin-server / systemd unit) with the desktop settings logic -------
cpSync(path.join(desktop, 'src', 'config.js'), path.join(server, 'desktop-config.cjs'));
cpSync(path.join(desktop, 'src', 'launch-server.cjs'), path.join(server, 'launch-server.cjs'));
cpSync(path.join(desktop, 'src', 'preflight.cjs'), path.join(server, 'preflight.cjs'));
if (platform === 'linux') cpSync(path.join(desktop, 'packaging', 'astroviabin.service'), path.join(stage, 'astroviabin.service'));

// 7. Icons used at runtime -------------------------------------------------------------------
for (const file of ['icon.png', 'icon.ico', 'tray.png', 'tray.ico']) cpSync(path.join(desktop, 'assets', file), path.join(stage, file));
console.log(`staged ${platform} in ${stage}`);
