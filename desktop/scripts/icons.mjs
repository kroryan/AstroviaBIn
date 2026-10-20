// Generates every icon the desktop packages need from the project logo (apps/client/public/logo.svg).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const sharp = createRequire(path.join(repo, 'package.json'))('sharp');
const assets = path.join(here, '..', 'assets');
const svg = readFileSync(path.join(repo, 'apps', 'client', 'public', 'logo.svg'));
mkdirSync(path.join(assets, 'icons'), { recursive: true });
mkdirSync(path.join(assets, 'msix'), { recursive: true });

const render = (size, padding = 0) => sharp(svg, { density: Math.max(72, size * 4) })
  .resize(size - 2 * padding, size - 2 * padding, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({ top: padding, bottom: padding, left: padding, right: padding, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer();

/** ICO with PNG-compressed images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry); header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2); header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(image => image.data)]);
}

writeFileSync(path.join(assets, 'icon.png'), await render(512));
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) writeFileSync(path.join(assets, 'icons', `${size}x${size}.png`), await render(size));
writeFileSync(path.join(assets, 'icon.ico'), ico(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async size => ({ size, data: await render(size) })))));
// Tray: a little padding so the icon is not clipped by panel themes.
writeFileSync(path.join(assets, 'tray.png'), await render(32, 1));
writeFileSync(path.join(assets, 'tray.ico'), ico(await Promise.all([16, 24, 32].map(async size => ({ size, data: await render(size) })))));
// MSIX visual assets.
for (const [name, size] of [['Square44x44Logo', 44], ['Square150x150Logo', 150], ['StoreLogo', 50], ['Square44x44Logo.targetsize-256', 256]]) {
  writeFileSync(path.join(assets, 'msix', `${name}.png`), await render(size, Math.round(size * 0.08)));
}
const wide = await sharp({ create: { width: 310, height: 150, channels: 4, background: { r: 5, g: 3, b: 12, alpha: 1 } } })
  .composite([{ input: await render(120), gravity: 'center' }]).png().toBuffer();
writeFileSync(path.join(assets, 'msix', 'Wide310x150Logo.png'), wide);
console.log('icons written to', assets);
