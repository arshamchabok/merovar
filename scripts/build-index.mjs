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
let settlementData = lineContaining(current, 'id="embeddedSettlementData"', 'settlement data');
let kingdomData = lineContaining(current, 'id="embeddedKingdomData"', 'kingdom data', false);

// --import <merovar-map.html> adopts the settlements and kingdoms from a map
// saved out of the editor. The artwork is never taken from there — only data.
const importAt = process.argv.indexOf('--import');
if (importAt !== -1) {
  const source = process.argv[importAt + 1];
  if (!source || !existsSync(source)) throw new Error(`--import needs a readable file, got: ${source}`);
  const other = readFileSync(source, 'utf8');
  // Indexed slicing: a lazy regex across ~20 MB backtracks catastrophically.
  const carve = (id) => {
    const at = other.indexOf(`id="${id}"`);
    if (at === -1) throw new Error(`no <script id="${id}"> in ${source}`);
    const start = other.indexOf('>', at) + 1;
    const end = other.indexOf('</scr' + 'ipt>', start);
    return { json: other.slice(start, end), tag: `<script id="${id}" type="application/json">` };
  };
  const s = carve('embeddedSettlementData');
  const k = carve('embeddedKingdomData');
  const count = (raw, key) => {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : parsed[key]).length;
  };
  console.log(`importing ${count(s.json, 'settlements')} settlements and ${count(k.json, 'kingdoms')} kingdoms from ${source}`);
  settlementData = `${s.tag}${s.json}</scr` + `ipt>`;
  kingdomData = `${k.tag}${k.json}</scr` + `ipt>`;
}

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
