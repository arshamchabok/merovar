// Rebuilds index.html from src/index.shell.html.
//
// The map image, the settlement icon library and the 94 settlement records live
// only inside the built index.html — they are ~19 MB of base64 and are copied
// across verbatim, never re-encoded. Any kingdom data already embedded in the
// current index.html is carried over too, so rebuilding never loses borders.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'src', 'index.shell.html');
const TARGET = join(ROOT, 'index.html');

const EMPTY_KINGDOMS =
  '<script id="embeddedKingdomData" type="application/json">{"version":1,"savedAt":0,"kingdoms":[]}</script>';

const lineContaining = (lines, needle, what, required = true) => {
  const line = lines.find((l) => l.includes(needle));
  if (!line && required) throw new Error(`could not find ${what} in index.html`);
  return line;
};

const jsonOf = (line) =>
  JSON.parse(line.replace(/^\s*<script[^>]*>/, '').replace(/<\/script>\s*$/, ''));

if (!existsSync(TARGET)) throw new Error('index.html must exist — payloads are sourced from it');

const current = readFileSync(TARGET, 'utf8').split('\n');
const mapImg = lineContaining(current, '<img id="map"', 'map image');
const iconLibrary = lineContaining(current, 'id="iconLibraryData"', 'icon library');
const settlementData = lineContaining(current, 'id="embeddedSettlementData"', 'settlement data');
const kingdomData = lineContaining(current, 'id="embeddedKingdomData"', 'kingdom data', false);

// Fail before writing rather than emit a broken 19 MB file.
const icons = jsonOf(iconLibrary);
// Either the original bare array, or the {savedAt, settlements} form written by
// "Save Edited HTML" once settlements became editable.
const settlementPayload = jsonOf(settlementData);
const settlements = Array.isArray(settlementPayload)
  ? settlementPayload
  : settlementPayload.settlements;
if (!icons.town || !icons.city || !icons.castle) throw new Error('icon library is incomplete');
if (!Array.isArray(settlements) || settlements.length === 0) throw new Error('no settlement records');
if (!mapImg.includes('src="data:image/png;base64,')) throw new Error('map image is not inline');

let carriedKingdoms = 0;
if (kingdomData) {
  const parsed = jsonOf(kingdomData);
  carriedKingdoms = (Array.isArray(parsed) ? parsed : parsed.kingdoms || []).length;
}

const shell = readFileSync(SHELL, 'utf8');
const doctypeAt = shell.indexOf('<!doctype html>');
if (doctypeAt === -1) throw new Error('shell is missing its doctype');

const html = shell
  .slice(doctypeAt)
  .replace('<!--MEROVAR:MAP_IMG-->', () => mapImg)
  .replace('<!--MEROVAR:ICON_LIBRARY-->', () => iconLibrary)
  .replace('<!--MEROVAR:SETTLEMENT_DATA-->', () => settlementData)
  .replace('<!--MEROVAR:KINGDOM_DATA-->', () => kingdomData || EMPTY_KINGDOMS);

if (html.includes('<!--MEROVAR:')) throw new Error('a payload placeholder was left unfilled');

copyFileSync(TARGET, join(ROOT, 'index.html.bak'));
writeFileSync(TARGET, html);

console.log(`built index.html — ${(html.length / 1048576).toFixed(2)} MB`);
console.log(`  settlements carried over: ${settlements.length}`);
console.log(`  kingdoms carried over:    ${carriedKingdoms}`);
console.log('  previous build saved to index.html.bak');
