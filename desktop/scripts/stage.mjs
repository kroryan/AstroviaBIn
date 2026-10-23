// Prepares everything the desktop package ships besides Electron itself, for one platform:
//   .stage/<linux|win>/server    built server + client, analysis scripts, migrations, runtime node_modules
//   .stage/<linux|win>/runtime   the Node.js binary that runs the server
//   .stage/<linux|win>/sky       offline sky catalogue (stars, deep-sky objects, constellations)
//   .stage/<linux|win>/bin       HOTPANTS programs
//   .stage/linux/python          self-contained CPython with the analysis packages
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
const PYTHON_PACKAGES = ['ccdproc==2.5.1', 'photutils==3.1.1', 'astroscrappy==1.3.0', 'specutils==2.4.0', 'specreduce==1.9.0', 'astroquery==0.4.11', 'astroalign==2.6.2'];
// The numerical stack is pinned too, so the Linux and Windows packages run the same tested code.
const ANALYSIS_PACKAGES = ['numpy==2.5.4', 'scipy==1.18.1', 'astropy==8.0.2', 'matplotlib==3.11.2', ...PYTHON_PACKAGES];
const LINUX_PYTHON = {
  url: `https://github.com/astral-sh/python-build-standalone/releases/download/20260325/cpython-${PYTHON_VERSION}%2B20260325-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
  sha256: 'ad178e36a84de3f845885d0ace5ca6f87fa9502d1f0cf53ba3dd42194277d42e',
};
// The embedded Windows Python ships only vcruntime140*.dll. astroscrappy needs the Visual C++ OpenMP
// runtime (vcomp140.dll) and scikit-image/matplotlib the C++ library (msvcp140.dll), which a clean
// Windows does not have: without them "import astroscrappy" fails with "DLL load failed". These are
// Microsoft's redistributable files (Authenticode-signed by Microsoft), as packaged on PyPI, pinned.
const MSVC_RUNTIME = {
  url: 'https://files.pythonhosted.org/packages/fe/17/7a1eace5a7c6083bd99db861625c08bb37010dfbe90ed7a0194ae0281689/msvc_runtime-14.44.35112-cp313-cp313-win_amd64.whl',
  sha256: 'd4f6cf106aaf235f2a90952f9ec7de49e9946323880d051abf9745a6d4bf60bf',
  data: 'msvc_runtime-14.44.35112.data/data',
  files: ['vcomp140.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'concrt140.dll'],
};
// Staging the Windows package on Windows itself (Git Bash: curl, unzip, sha256sum) needs no Docker: the
// embedded Python downloads its own wheels with this pinned pip. The sky catalogue and HOTPANTS then
// come from .cache/sky and .cache/hotpants-win.
const windowsHost = process.platform === 'win32';
const PIP = {
  url: 'https://files.pythonhosted.org/packages/b7/3f/945ef7ab14dc4f9d7f40288d2df998d1837ee0888ec3659c813487572faa/pip-25.2-py3-none-any.whl',
  sha256: '6d67a2b4e7f14d8b31b8b52648866fa717f45a1eb70e83002f4331d07e953717',
};
const checkScript = path.join(repo, 'tools', 'scripts', 'check_analysis_env.py');
// python: the command (and its arguments) that runs the target CPython version.
const compileBytecode = ([command, ...prefix], directories) => {
  const args = [...prefix, '-m', 'compileall', '-q', '-j', '0', '--invalidation-mode', 'unchecked-hash', ...directories];
  console.log(`$ ${command} ${args.join(' ')}`);
  // A few packages ship templates that are not valid Python; compileall reports them and goes on.
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) console.warn(`compileall exited ${result.status}: some files were not precompiled (they still work).`);
};
const verifySha256 = (file, expected) => {
  // GNU sha256sum prefixes the line with "\" when the path has backslashes (Windows paths).
  const digest = (/[0-9a-f]{64}/.exec(execFileSync('sha256sum', [file]).toString()) || [''])[0];
  if (digest !== expected) throw new Error(`${file}: SHA-256 ${digest} does not match the pinned ${expected}`);
};

const run = (command, args, options = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  // npm is a .cmd script on Windows, which only runs through the shell.
  execFileSync(command, args, { stdio: 'inherit', shell: windowsHost && command === 'npm', ...options });
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
// Standard-star library for spectral classification (spectroscopy.py).
cpSync(path.join(repo, 'tools', 'data'), path.join(server, 'tools', 'data'), { recursive: true });
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
// better-sqlite3 and sharp use their prebuilt binaries; on a Windows host without a compiler npm would
// still try "node-gyp rebuild" for better-sqlite3's binding.gyp, so install scripts are skipped there.
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', ...(platform === 'win' ? ['--os=win32', '--cpu=x64'] : []),
  ...(windowsHost ? ['--ignore-scripts'] : [])], { cwd: server, env: npmEnv });
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
  if (windowsHost) throw new Error(`${skyCache} is empty: copy the sky folder of an AstroviaBin image or package there (Docker is not used on Windows).`);
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
const asUser = windowsHost ? [] : ['-u', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp'];
if (platform === 'linux') {
  // Linux: a self-contained CPython (python-build-standalone, pinned) with every analysis package
  // installed at build time, so the .deb works the same on any distribution and Python version and
  // never needs pip or internet while installing.
  const python = path.join(stage, 'python');
  const archive = download(LINUX_PYTHON.url, path.join(cache, path.basename(decodeURIComponent(LINUX_PYTHON.url))));
  verifySha256(archive, LINUX_PYTHON.sha256);
  mkdirSync(python, { recursive: true });
  run('tar', ['-xzf', archive, '-C', python, '--strip-components=1']);
  // Install inside a matching manylinux userland so binary wheels are chosen exactly as on users' systems.
  run('docker', ['run', '--rm', ...asUser, '-v', `${python}:/opt/python`, 'ubuntu:25.10', '/opt/python/bin/python3', '-m', 'pip', 'install',
    '--no-cache-dir', '--only-binary=:all:', '--no-warn-script-location', ...ANALYSIS_PACKAGES]);
  run(path.join(python, 'bin', 'python3'), ['-c', 'import numpy, scipy, astropy, matplotlib, ccdproc, photutils, astroscrappy, specutils, specreduce, astroquery, astroalign; print("bundled python ok")']);
  // pip and its caches are not needed at runtime.
  for (const entry of readdirSync(path.join(python, 'lib', `python${PYTHON_VERSION.split('.').slice(0, 2).join('.')}`, 'site-packages'))) {
    if (/^pip(-|$)/.test(entry)) rmSync(path.join(python, 'lib', `python${PYTHON_VERSION.split('.').slice(0, 2).join('.')}`, 'site-packages', entry), { recursive: true, force: true });
  }
  execFileSync('find', [python, '-name', '__pycache__', '-type', 'd', '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  // Subpackage test suites (site-packages/<package>/<module>/tests) are never imported at runtime; top-level
  // <package>/tests stay because astropy imports its test runner on import.
  execFileSync('find', [path.join(python, 'lib', `python${PYTHON_VERSION.split('.').slice(0, 2).join('.')}`, 'site-packages'),
    '-mindepth', '3', '-type', 'd', '-name', 'tests', '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  for (const unused of ['test', 'idlelib', 'turtledemo', 'ensurepip']) {
    rmSync(path.join(python, 'lib', `python${PYTHON_VERSION.split('.').slice(0, 2).join('.')}`, unused), { recursive: true, force: true });
  }
  // /opt/AstroviaBin is read-only for users, so Python could never cache its bytecode there and would
  // recompile Astropy, SciPy… on every analysis. Ship it precompiled (hash-based, so file times do not matter).
  compileBytecode([path.join(python, 'bin', 'python3')], [path.join(python, 'lib', `python${PYTHON_VERSION.split('.').slice(0, 2).join('.')}`)]);
  run(path.join(python, 'bin', 'python3'), [checkScript]);
  if (!existsSync(path.join(python, 'bin', 'python'))) execFileSync('ln', ['-s', 'python3', path.join(python, 'bin', 'python')]);
} else {
  // Windows: embedded Python with every analysis package.
  const python = path.join(stage, 'python');
  const embed = download(`https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`, path.join(cache, `python-${PYTHON_VERSION}-embed-amd64.zip`));
  run('unzip', ['-q', '-o', embed, '-d', python]);
  const short = PYTHON_VERSION.split('.').slice(0, 2).join('');
  // Enable site-packages in the embedded distribution.
  writeFileSync(path.join(python, `python${short}._pth`), [`python${short}.zip`, '.', 'Lib\\site-packages', 'import site', ''].join('\r\n'));
  // Keyed by the pinned list, so a changed pin never mixes old and new wheels in one site-packages.
  const pins = execFileSync('sha256sum', { input: ANALYSIS_PACKAGES.join('\n') }).toString().slice(0, 12);
  const wheels = path.join(cache, `wheels-win-cp${short}-${pins}`);
  mkdirSync(wheels, { recursive: true });
  const pipDownload = ['download', '--only-binary=:all:', '--platform', 'win_amd64',
    '--python-version', PYTHON_VERSION.split('.').slice(0, 2).join('.'), '--implementation', 'cp'];
  if (windowsHost) {
    // The embedded Python runs isolated (no script folder or PYTHONPATH on sys.path): import pip from its wheel.
    const pip = download(PIP.url, path.join(cache, path.basename(PIP.url)));
    verifySha256(pip, PIP.sha256);
    run(path.join(python, 'python.exe'), ['-c', `import sys; sys.path.insert(0, sys.argv[1]); from pip._internal.cli.main import main; sys.exit(main(sys.argv[2:]))`,
      pip, ...pipDownload, '--disable-pip-version-check', '-d', wheels, ...ANALYSIS_PACKAGES]);
  } else {
    run('docker', ['run', '--rm', ...asUser, '-v', `${wheels}:/out`, 'python:3.13-slim', 'pip', ...pipDownload, '-d', '/out', ...ANALYSIS_PACKAGES]);
  }
  const site = path.join(python, 'Lib', 'site-packages');
  mkdirSync(site, { recursive: true });
  for (const wheel of readdirSync(wheels).filter(name => name.endsWith('.whl'))) run('unzip', ['-q', '-o', path.join(wheels, wheel), '-d', site]);
  // Visual C++ runtime next to python.exe, where Windows looks first for every extension module's DLLs.
  const msvc = download(MSVC_RUNTIME.url, path.join(cache, path.basename(MSVC_RUNTIME.url)));
  verifySha256(msvc, MSVC_RUNTIME.sha256);
  run('unzip', ['-q', '-o', '-j', msvc, ...MSVC_RUNTIME.files.map(file => `${MSVC_RUNTIME.data}/${file}`), '-d', python]);
  // The embedded distribution never writes bytecode (its ._pth runs Python isolated), so without
  // precompiled .pyc every analysis recompiled Astropy, SciPy… — the first import took minutes.
  // .pyc files only depend on the CPython minor version; hash-based, so file times do not matter.
  if (windowsHost) compileBytecode([path.join(python, 'python.exe')], [site]);
  else compileBytecode(['docker', 'run', '--rm', ...asUser, '-v', `${site}:/site`, `python:${PYTHON_VERSION.split('.').slice(0, 2).join('.')}-slim`, 'python'], ['/site']);
  // Every DLL an extension module imports must be bundled or part of Windows (this check would have
  // caught the missing vcomp140.dll).
  run(windowsHost ? path.join(python, 'python.exe') : 'python3', [checkScript, '--scan-windows-bundle', python]);
  if (windowsHost) run(path.join(python, 'python.exe'), [checkScript]);
}

// 5b. Third-party licenses and sources (docs/LICENSES.md) ---------------------------------------
// Every license text, the complete corresponding source of the copyleft components (HOTPANTS,
// GPL-2.0; SEP, LGPL-3.0-or-later) and the inventory of the bundled Python packages ship in
// resources/licenses, next to the programs they cover.
{
  const licenses = path.join(stage, 'licenses');
  cpSync(path.join(repo, 'licenses', 'third-party'), path.join(licenses, 'third-party'), { recursive: true });
  cpSync(path.join(repo, 'docs', 'LICENSES.md'), path.join(licenses, 'THIRD-PARTY-NOTICES.md'));
  cpSync(path.join(repo, 'LICENSE'), path.join(licenses, 'AstroviaBin-LICENSE.txt'));
  const sources = path.join(licenses, 'sources');
  cpSync(path.join(repo, 'vendor', 'hotpants'), path.join(sources, 'hotpants'), { recursive: true });
  for (const script of ['build-hotpants-linux.sh', 'build-hotpants-win.sh']) cpSync(path.join(here, script), path.join(sources, 'hotpants', script));
  const site = platform === 'linux'
    ? path.join(stage, 'python', 'lib', `python${PYTHON_VERSION.split('.').slice(0, 2).join('.')}`, 'site-packages')
    : path.join(stage, 'python', 'Lib', 'site-packages');
  const sepInfo = readdirSync(site).find(name => /^sep-[\d.]+\.dist-info$/.test(name));
  if (sepInfo) {
    const version = sepInfo.slice(4, -'.dist-info'.length);
    const tarball = download(`https://files.pythonhosted.org/packages/source/s/sep/sep-${version}.tar.gz`, path.join(cache, `sep-${version}.tar.gz`));
    cpSync(tarball, path.join(sources, `sep-${version}.tar.gz`));
  }
  // JavaScript: the server's node_modules and the code compiled into the web client.
  run('node', [path.join(repo, 'tools', 'scripts', 'js-licenses.mjs'), path.join(licenses, 'javascript-packages.md'),
    path.join(licenses, 'javascript-licenses.txt')]);
  const inventory = path.join(repo, 'tools', 'scripts', 'third_party_inventory.py');
  if (platform === 'linux') run(path.join(stage, 'python', 'bin', 'python3'), [inventory, path.join(licenses, 'python-packages.md')]);
  else run(windowsHost ? path.join(stage, 'python', 'python.exe') : 'python3', [inventory, path.join(licenses, 'python-packages.md'), site]);
}

// 6. Headless launcher (astroviabin-server / systemd unit) with the desktop settings logic -------
cpSync(path.join(desktop, 'src', 'config.js'), path.join(server, 'desktop-config.cjs'));
cpSync(path.join(desktop, 'src', 'launch-server.cjs'), path.join(server, 'launch-server.cjs'));
cpSync(path.join(desktop, 'src', 'preflight.cjs'), path.join(server, 'preflight.cjs'));
if (platform === 'linux') cpSync(path.join(desktop, 'packaging', 'astroviabin.service'), path.join(stage, 'astroviabin.service'));

// 7. Icons used at runtime -------------------------------------------------------------------
for (const file of ['icon.png', 'icon.ico', 'tray.png', 'tray.ico']) cpSync(path.join(desktop, 'assets', file), path.join(stage, file));
console.log(`staged ${platform} in ${stage}`);
