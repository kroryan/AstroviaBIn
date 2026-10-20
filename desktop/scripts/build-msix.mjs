// Builds the Windows MSIX from the Electron Builder output (out/win-unpacked), on Linux, with
// Microsoft's open-source MSIX Packaging SDK ("makemsix", packaging/makemsix.Dockerfile, pinned),
// then signs it with osslsigncode and validates it by unpacking.
//
// Signing: Windows only installs signed MSIX packages. Without a release certificate this script
// creates a self-signed test certificate (CN=AstroviaBin) once, under .cache/msix-cert/ (git-ignored),
// and writes its public part next to the package (AstroviaBin-test-certificate.cer). Users import that
// .cer into "Local Machine → Trusted People" once; it is a test certificate, not a publicly trusted one.
// Set MSIX_PFX and MSIX_PFX_PASSWORD to sign with a real certificate instead (its subject must be the
// manifest's Publisher, MSIX_PUBLISHER).
//
// Usage: node scripts/build-msix.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const pkg = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const out = path.join(desktop, 'out');
const unpacked = path.join(out, 'win-unpacked');
const cache = path.join(desktop, '.cache');
const IMAGE = 'astroviabin-makemsix:25a65f5';
const PUBLISHER = process.env.MSIX_PUBLISHER || 'CN=AstroviaBin';
const version = `${pkg.version.split('-')[0]}.0`; // MSIX needs four numeric parts
const msix = path.join(out, `AstroviaBin-${pkg.version}-x64.msix`);
const user = ['-u', `${process.getuid()}:${process.getgid()}`];

const run = (command, args, options = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  try {
    return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options })?.toString() ?? '';
  } catch (error) {
    // makemsix and osslsigncode report their errors on stdout.
    throw new Error(`${command} ${args[0]} failed (exit ${error.status}):\n${error.stdout?.toString() ?? ''}`);
  }
};

if (!existsSync(path.join(unpacked, 'astroviabin-desktop.exe'))) {
  throw new Error('out/win-unpacked is missing: run "npm run dist:win" (or electron-builder --win) first');
}
try { execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }); } catch {
  run('docker', ['build', '-t', IMAGE, '-f', path.join(desktop, 'packaging', 'makemsix.Dockerfile'), path.join(desktop, 'packaging')], { stdio: 'inherit' });
}

// 1. Package layout: the app files, the manifest and the tile/icon assets.
const stage = path.join(cache, 'msix-stage');
rmSync(stage, { recursive: true, force: true });
cpSync(unpacked, stage, { recursive: true, verbatimSymlinks: true });
const symlinks = execFileSync('find', [stage, '-type', 'l']).toString().trim();
if (symlinks) throw new Error(`MSIX packages cannot contain symbolic links; remove them from the staged build:\n${symlinks}`);
mkdirSync(path.join(stage, 'Assets'), { recursive: true });
for (const file of readdirSync(path.join(desktop, 'assets', 'msix'))) cpSync(path.join(desktop, 'assets', 'msix', file), path.join(stage, 'Assets', file));
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
writeFileSync(path.join(stage, 'AppxManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap desktop rescap">
  <Identity Name="AstroviaBin" Publisher="${escape(PUBLISHER)}" Version="${version}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>AstroviaBin</DisplayName>
    <PublisherDisplayName>AstroviaBin contributors</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <Description>${escape(pkg.description)}</Description>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="AstroviaBin" Executable="astroviabin-desktop.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="AstroviaBin" Description="Private astrophotography library (server in the system tray)"
        BackgroundColor="#05030c" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" />
      </uap:VisualElements>
      <Extensions>
        <!-- "Start AstroviaBin when I log in": MSIX apps start at login through a startup task. -->
        <desktop:Extension Category="windows.startupTask" Executable="astroviabin-desktop.exe" EntryPoint="Windows.FullTrustApplication">
          <desktop:StartupTask TaskId="AstroviaBinStartup" Enabled="true" DisplayName="AstroviaBin" />
        </desktop:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <Capability Name="privateNetworkClientServer" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`);

// 2. Pack.
rmSync(msix, { force: true });
const unsigned = path.join(cache, 'AstroviaBin-unsigned.msix');
rmSync(unsigned, { force: true });
run('docker', ['run', '--rm', ...user, '-v', `${stage}:/stage:ro`, '-v', `${cache}:/work`, IMAGE, 'pack', '-d', '/stage', '-p', '/work/AstroviaBin-unsigned.msix']);

// 3. Sign (osslsigncode supports APPX/MSIX).
const signer = 'astroviabin-osslsigncode:2';
try { execFileSync('docker', ['image', 'inspect', signer], { stdio: 'ignore' }); } catch {
  execFileSync('docker', ['build', '-t', signer, '-'], { input: 'FROM ubuntu:25.10\nRUN apt-get update && apt-get install -y --no-install-recommends osslsigncode openssl ca-certificates && rm -rf /var/lib/apt/lists/*\n', stdio: ['pipe', 'inherit', 'inherit'] });
}
let pfx = process.env.MSIX_PFX;
let password = process.env.MSIX_PFX_PASSWORD || '';
const certDir = path.join(cache, 'msix-cert');
if (!pfx) {
  pfx = path.join(certDir, 'AstroviaBin-test.pfx');
  password = 'astroviabin-test';
  if (!existsSync(pfx)) {
    mkdirSync(certDir, { recursive: true });
    run('docker', ['run', '--rm', ...user, '-v', `${certDir}:/cert`, signer, 'bash', '-c',
      'openssl req -x509 -newkey rsa:3072 -sha256 -days 1825 -nodes -subj "/CN=AstroviaBin" '
      + '-addext "extendedKeyUsage=codeSigning" -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature" '
      + '-keyout /cert/key.pem -out /cert/cert.pem && '
      + `openssl pkcs12 -export -inkey /cert/key.pem -in /cert/cert.pem -out /cert/AstroviaBin-test.pfx -passout pass:${password} && `
      + 'openssl x509 -in /cert/cert.pem -outform DER -out /cert/AstroviaBin-test-certificate.cer']);
  }
  cpSync(path.join(certDir, 'AstroviaBin-test-certificate.cer'), path.join(out, 'AstroviaBin-test-certificate.cer'));
}
const pfxDir = path.dirname(path.resolve(pfx));
run('docker', ['run', '--rm', ...user, '-v', `${cache}:/work`, '-v', `${pfxDir}:/cert:ro`, '-v', `${out}:/out`, signer,
  'osslsigncode', 'sign', '-pkcs12', `/cert/${path.basename(pfx)}`, '-pass', password, '-h', 'sha256',
  '-in', '/work/AstroviaBin-unsigned.msix', '-out', `/out/${path.basename(msix)}`]);

// 4. Validate: the signature verifies and the package unpacks with its manifest and executable.
const verify = run('docker', ['run', '--rm', ...user, '-v', `${out}:/out:ro`, '-v', `${pfxDir}:/cert:ro`, signer,
  'osslsigncode', 'verify', '-CAfile', `/cert/${pfx === path.join(certDir, 'AstroviaBin-test.pfx') ? 'cert.pem' : path.basename(pfx)}`, '-in', `/out/${path.basename(msix)}`]);
if (!/Signature verification: ok/i.test(verify)) throw new Error(`MSIX signature does not verify:\n${verify}`);
const check = path.join(cache, 'msix-check');
rmSync(check, { recursive: true, force: true });
mkdirSync(check, { recursive: true });
run('docker', ['run', '--rm', ...user, '-v', `${out}:/out:ro`, '-v', `${check}:/check`, IMAGE, 'unpack', '-p', `/out/${path.basename(msix)}`, '-d', '/check', '-ss']);
for (const required of ['AppxManifest.xml', 'astroviabin-desktop.exe', path.join('resources', 'server', 'dist', 'index.js'), path.join('resources', 'runtime', 'node.exe')]) {
  if (!existsSync(path.join(check, required))) throw new Error(`MSIX validation failed: ${required} missing after unpacking`);
}
rmSync(check, { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });
rmSync(unsigned, { force: true });
console.log(`MSIX ready: ${msix} (signed${process.env.MSIX_PFX ? '' : ' with the AstroviaBin test certificate'}, validated)`);
