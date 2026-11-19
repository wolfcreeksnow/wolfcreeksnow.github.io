// Writes the app icons (PNG) from icons/icons.json. GitHub's web editor can't upload
// binary files, so the icons live in the repo as base64 text and are unpacked here.
import { readFile, writeFile } from 'node:fs/promises';
const dir = new URL('../icons/', import.meta.url);
const icons = JSON.parse(await readFile(new URL('icons.json', dir), 'utf8'));
for (const [name, b64] of Object.entries(icons)) {
  const buf = Buffer.from(b64, 'base64');
  let same = false;
  try { same = (await readFile(new URL(name, dir))).equals(buf); } catch {}
  if (!same) { await writeFile(new URL(name, dir), buf); console.log('wrote icons/' + name); }
}
