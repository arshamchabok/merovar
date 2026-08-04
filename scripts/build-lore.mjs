// Builds data/lore.json by joining the map's own settlement and kingdom data to
// the prose in chronicle-of-the-known-world.md.
//
// The map is the source of truth. Where the chronicle disagrees about a name or
// a figure, the map's value is kept and the disagreement is logged.
//
//   node scripts/build-lore.mjs [--map <file>] [--allow-orphans]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const MAP_FILE = resolve(option('--map', join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'merovar-map.html')));
const CHRONICLE = join(ROOT, 'chronicle-of-the-known-world.md');
const OUT = join(ROOT, 'data', 'lore.json');

// Kingdom name (as it appears in the map data) -> continent.
const CONTINENTS = new Map([
  ['the kingdom of crownvale', 'Merovar'],
  ['sablereach', 'Merovar'],
  ['norwood', 'Merovar'],
  ['kadresh', 'Kadresh'],
  ['the greenmarch', 'Amberfold'],
  ['amberley', 'Amberfold'],
  ['kingdom of high alden', 'The Aldermarch'],
  ['vennmark', 'The Aldermarch'],
  ['silver isles', 'The Silver Isles'],
  ['tater isles', 'The Tatters'],
]);

const conflicts = [];
const note = (kind, detail) => conflicts.push({ kind, detail });

/* ------------------------------------------------------------ map payloads */

// Indexed slicing rather than a regex: the file is ~20 MB and a lazy
// [\s\S]*? across it backtracks catastrophically.
function readBlock(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at === -1) throw new Error(`no <script id="${id}"> in the map file`);
  const start = html.indexOf('>', at) + 1;
  const end = html.indexOf('</scr' + 'ipt>', start);
  if (end === -1) throw new Error(`unterminated <script id="${id}">`);
  return JSON.parse(html.slice(start, end));
}

if (!existsSync(MAP_FILE)) {
  console.error(`Map file not found: ${MAP_FILE}\nPass --map <path to merovar-map.html>`);
  process.exit(2);
}
const html = readFileSync(MAP_FILE, 'utf8');
const settlementPayload = readBlock(html, 'embeddedSettlementData');
const kingdomPayload = readBlock(html, 'embeddedKingdomData');
const settlements = Array.isArray(settlementPayload) ? settlementPayload : settlementPayload.settlements;
const kingdoms = Array.isArray(kingdomPayload) ? kingdomPayload : kingdomPayload.kingdoms;

/* ------------------------------------------------------------- chronicle */

const chronicle = readFileSync(CHRONICLE, 'utf8');

// Names are compared with case, punctuation and dash style removed, because the
// chronicle shouts its headings and the map does not.
const key = (value) => (value || '')
  .normalize('NFKD')
  .replace(/[‐-―]/g, '-')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const houseKey = (value) => key(value).replace(/^(the\s+)?house\s+/, '').replace(/^clan\s+/, '');
const number = (value) => (value == null ? null : Number(String(value).replace(/[^0-9]/g, '')) || null);

const DASH = '[\\u2010-\\u2015-]';
const HEADING_CITY = new RegExp(`^###\\s+([A-Z][A-Z'’\\- ]+?)(?:\\s*${DASH}.*)?$`);
const STATS_LINE = new RegExp(`^\\*\\*(?:the\\s+)?(.+?)\\s*[·|]\\s*([\\d,]+)\\s*souls?\\s*[·|,]\\s*([\\d,]+)\\s*swords?\\*\\*$`, 'i');
// **NAME** *(castle)* — *House X* — 20,000 souls, 6,000 swords
// The type marker is optional and any field may be wrapped in one or two stars.
const INLINE_ENTRY = new RegExp(
  `^\\*\\*([^*]+?)\\*\\*\\s*(?:\\*+\\([^)]*\\)\\*+\\s*)?${DASH}` +
  `\\s*\\*{0,2}([^*]+?)\\*{0,2}\\s*${DASH}` +
  `\\s*\\*{0,2}([\\d,]+)\\*{0,2}\\s*souls?,?\\s*\\*{0,2}([\\d,]+)\\*{0,2}\\s*swords?`, 'i');
const SECTION_HEADING = /^###\s+(the\s+(castles|towns)\s+of\b|house\b)/i;
// | Goldmeadow | Loftus | 100,000 | 11,000 |
const TABLE_ROW = /^\|\s*([A-Za-z][^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*$/;
// **Of Silverpool and House Silvertongue.**  — prose attached to a table town
const OF_BLOCK = /^\*\*Of\s+(.+?)(?:\s+and\s+(?:the\s+)?(?:House|Clan)\s+[^*]+?)?\.?\*\*\s*(.*)$/i;

// **Words:** *X* · **Banner:** Y   |   **Words:** *X*   |   **Banner:** Y
const WORDS_RE = /\*\*Words:\*\*\s*\*?([^*·|]+?)\*?\s*(?:[·|]\s*\*\*Banner|$)/i;
const BANNER_RE = /\*\*Banner:\*\*\s*(.+?)\s*$/i;

function parseChronicle(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const realms = [];
  let current = null;
  let realm = null;

  const closeEntry = () => {
    if (!current) return;
    current.story = current.body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    delete current.body;
    entries.push(current);
    current = null;
  };
  const closeRealm = () => {
    if (!realm) return;
    realm.intro = realm.body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    delete realm.body;
    realms.push(realm);
    realm = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // A realm heading: ## THE KINGDOM OF CROWNVALE
    const realmHeading = /^##\s+(?!#)(.+?)\s*$/.exec(line);
    if (realmHeading) {
      closeEntry();
      closeRealm();
      realm = {
        name: realmHeading[1].trim(), body: [], house: null,
        population: null, soldiers: null, words: null, banner: null,
      };
      continue;
    }
    // A book heading closes the previous realm but starts none.
    if (/^#\s+(?!#)/.test(line)) { closeEntry(); closeRealm(); continue; }

    if (SECTION_HEADING.test(line)) {
      // "### House Brenn · Seat at Crownford · 2,883,000 souls · 309,900 swords"
      const seat = /^###\s+(?:\*\*)?(.+?)\s*[·|]\s*Seat at\s+(.+?)\s*[·|]\s*([\d,]+)\s*souls?\s*[·|]\s*([\d,]+)\s*swords?/i.exec(line);
      if (seat && realm) {
        realm.house = seat[1].trim();
        realm.seat = seat[2].trim();
        realm.population = number(seat[3]);
        realm.soldiers = number(seat[4]);
      }
      closeEntry();
      continue;
    }

    // Format A: a city, with its figures on the following bold line.
    const cityHeading = HEADING_CITY.exec(line);
    if (cityHeading) {
      closeEntry();
      const name = cityHeading[1].trim();
      let stats = null;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        const found = STATS_LINE.exec(lines[j].trim());
        if (found) { stats = found; i = j; break; }
        if (lines[j].trim() && !/^\*\*/.test(lines[j])) break;
      }
      current = {
        name,
        house: stats ? stats[1].trim() : null,
        population: stats ? number(stats[2]) : null,
        soldiers: stats ? number(stats[3]) : null,
        words: null,
        banner: null,
        realm: realm ? realm.name : null,
        body: [],
      };
      continue;
    }

    // Format C: the town roster. Figures only — the prose, if any, arrives
    // later in an "Of <town> and House <x>" block.
    const row = TABLE_ROW.exec(line);
    if (row && !/^-+$/.test(row[2]) && !/^(house|souls|swords)$/i.test(row[2])) {
      closeEntry();
      const name = row[1].trim();
      if (!/^(town|city|castle|holding)$/i.test(name)) {
        const entry = {
          name,
          house: row[2].trim(),
          population: number(row[3]),
          soldiers: number(row[4]),
          words: null,
          banner: null,
          realm: realm ? realm.name : null,
          body: [],
        };
        entry.story = '';
        delete entry.body;
        entries.push(entry);
      }
      continue;
    }

    // Prose for a town already listed in a roster table.
    const of = OF_BLOCK.exec(line);
    if (of) {
      closeEntry();
      const wanted = key(of[1]);
      const existing = entries.find(e => key(e.name) === wanted);
      if (existing) {
        current = existing;
        current.body = [];
        entries.splice(entries.indexOf(existing), 1);
      } else {
        current = {
          name: of[1].trim(), house: null, population: null, soldiers: null,
          words: null, banner: null, realm: realm ? realm.name : null, body: [],
        };
      }
      if (of[2]) current.body.push(of[2]);
      continue;
    }

    // Format B: a castle or town, all on one line.
    const inline = INLINE_ENTRY.exec(line);
    if (inline) {
      closeEntry();
      current = {
        name: inline[1].trim(),
        house: inline[2].trim(),
        population: number(inline[3]),
        soldiers: number(inline[4]),
        words: null,
        banner: null,
        realm: realm ? realm.name : null,
        body: [],
      };
      continue;
    }

    // Words and banner belong in their own fields, not in the prose.
    if (/\*\*Words:\*\*|\*\*Banner:\*\*/i.test(line)) {
      const target = current || realm;
      if (target) {
        const words = WORDS_RE.exec(line);
        const banner = BANNER_RE.exec(line);
        if (words && 'words' in target) target.words = words[1].trim().replace(/[*_]/g, '');
        if (banner && 'banner' in target) target.banner = banner[1].trim().replace(/\*\*/g, '');
      }
      continue;
    }

    if (/^-{3,}$/.test(line.trim())) { closeEntry(); continue; }

    if (current) current.body.push(line);
    else if (realm) realm.body.push(line);
  }
  closeEntry();
  closeRealm();
  return { entries, realms };
}

const { entries, realms } = parseChronicle(chronicle);

/* ------------------------------------------------------- point in polygon */

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
const ringsOf = (kingdom) => (Array.isArray(kingdom.parts) && kingdom.parts.length ? kingdom.parts : [kingdom.points || []]);
const areaOf = (ring) => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return Math.abs(sum / 2);
};

function kingdomFor(settlement) {
  const hits = kingdoms.filter(k => ringsOf(k).some(ring => ring.length >= 3 && inRing(settlement.x, settlement.y, ring)));
  if (hits.length <= 1) return hits[0] || null;
  // Overlapping borders: the tighter one wins, which is the enclave.
  note('overlap', `${settlement.name || settlement.id} falls inside ${hits.length} realms: ${hits.map(h => h.name).join(', ')}`);
  return hits.slice().sort((a, b) =>
    Math.min(...ringsOf(a).map(areaOf)) - Math.min(...ringsOf(b).map(areaOf)))[0];
}

/* --------------------------------------------------------------- matching */

const byName = new Map();
const byHouse = new Map();
for (const entry of entries) {
  const nameKey = key(entry.name);
  if (nameKey && !byName.has(nameKey)) byName.set(nameKey, entry);
  const hk = houseKey(entry.house);
  if (hk && !byHouse.has(hk)) byHouse.set(hk, entry);
}

// Several eastern powers are cities on the map but whole sections in the
// chronicle. Their section prose is the settlement's story.
const bySection = new Map();
for (const r of realms) {
  const shortened = key(r.name)
    .replace(/^the\s+/, '')
    .replace(/^(kingdom|empire|city)\s+of\s+/, '')
    .replace(/\s+city$/, '');
  for (const candidate of [key(r.name), shortened]) {
    if (candidate && !bySection.has(candidate)) bySection.set(candidate, r);
  }
}

const used = new Set();
function matchEntry(settlement) {
  const nameKey = key(settlement.name);
  const byNameHit = byName.get(nameKey);
  if (byNameHit) return { entry: byNameHit, how: 'name' };

  const shortened = nameKey
    .replace(/^the\s+/, '')
    .replace(/^(kingdom|empire|city)\s+of\s+/, '')
    .replace(/\s+city$/, '');
  let section = bySection.get(nameKey) || bySection.get(shortened);
  // "Vero Kharada" and "Vera Kharada" are two circuits of one section.
  if (!section) {
    for (const [candidate, r] of bySection) {
      if (candidate.length > 4 && (nameKey.endsWith(` ${candidate}`) || nameKey.startsWith(`${candidate} `))) {
        section = r;
        break;
      }
    }
  }
  if (section) return { entry: { ...section, story: section.intro }, how: 'section' };

  const byHouseHit = byHouse.get(houseKey(settlement.rulingHouse));
  if (byHouseHit) return { entry: byHouseHit, how: 'house' };
  return { entry: null, how: 'none' };
}

/* ----------------------------------------------------------------- output */

const kingdomById = new Map(kingdoms.map(k => [k.id, k]));
const settlementsOut = [];
const orphans = [];
const unmatched = [];

for (const settlement of settlements) {
  const realm = kingdomFor(settlement);
  if (!realm) orphans.push(settlement);

  const { entry, how } = matchEntry(settlement);
  if (!entry) unmatched.push(settlement);
  if (entry) {
    used.add(entry);
    // The map wins on names and figures; disagreements are recorded, not applied.
    if (how === 'name' && entry.house && houseKey(entry.house) !== houseKey(settlement.rulingHouse)) {
      note('house', `${settlement.name}: map says "${settlement.rulingHouse}", chronicle says "${entry.house}"`);
    }
    for (const field of ['population', 'soldiers']) {
      if (entry[field] != null && settlement[field] != null && entry[field] !== settlement[field]) {
        note(field, `${settlement.name}: map says ${settlement[field].toLocaleString('en-GB')}, chronicle says ${entry[field].toLocaleString('en-GB')}`);
      }
    }
  }

  settlementsOut.push({
    id: settlement.id,
    name: settlement.name || '',
    type: settlement.type,
    x: Number(settlement.x.toFixed(2)),
    y: Number(settlement.y.toFixed(2)),
    kingdomId: realm ? realm.id : null,
    continent: realm ? (CONTINENTS.get(key(realm.name)) || null) : null,
    house: settlement.rulingHouse || '',
    population: settlement.population ?? null,
    soldiers: settlement.soldiers ?? null,
    words: entry?.words || '',
    banner: entry?.banner || '',
    story: entry?.story || '',
    matchedBy: how,
  });
}

const realmByKey = new Map(realms.map(r => [key(r.name), r]));
const kingdomsOut = kingdoms.map(kingdom => {
  const mine = settlementsOut.filter(s => s.kingdomId === kingdom.id);
  const continent = CONTINENTS.get(key(kingdom.name)) || null;
  if (!continent) note('continent', `no continent mapped for realm "${kingdom.name}"`);
  const prose = realmByKey.get(key(kingdom.name))
    || realms.find(r => houseKey(r.house) && houseKey(r.house) === houseKey(kingdom.rulingHouse))
    || null;

  const population = mine.reduce((sum, s) => sum + (s.population || 0), 0);
  const soldiers = mine.reduce((sum, s) => sum + (s.soldiers || 0), 0);
  if (prose?.population && prose.population !== population) {
    note('realm-population', `${kingdom.name}: settlements total ${population.toLocaleString('en-GB')}, chronicle says ${prose.population.toLocaleString('en-GB')}`);
  }

  return {
    id: kingdom.id,
    name: kingdom.name || '',
    continent,
    rulingHouse: kingdom.rulingHouse || '',
    capitalId: kingdom.capitalId || '',
    population,
    soldiers,
    intro: prose?.intro || '',
    settlementIds: mine.map(s => s.id),
  };
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  map: { width: 3840, height: 1645, coordinateOrigin: 'top-left' },
  kingdoms: kingdomsOut,
  settlements: settlementsOut,
}, null, 2));

/* ----------------------------------------------------------------- report */

const withStory = settlementsOut.filter(s => s.story).length;
const withWords = settlementsOut.filter(s => s.words).length;
const withBanner = settlementsOut.filter(s => s.banner).length;
const byNameCount = settlementsOut.filter(s => s.matchedBy === "name").length;
const bySectionCount = settlementsOut.filter(s => s.matchedBy === "section").length;
const byHouseCount = settlementsOut.filter(s => s.matchedBy === 'house').length;

const pct = (n) => `${((n / settlements.length) * 100).toFixed(0)}%`;
console.log('\n=== COVERAGE ===================================================');
console.log(`settlements on the map      ${settlements.length}`);
const matchedEntries = entries.filter(e => used.has(e));
console.log(`chronicle entries parsed    ${entries.length}  (${matchedEntries.length} matched, ${entries.length - matchedEntries.length} unused)`);
console.log(`matched by name             ${byNameCount}`);
console.log(`matched by section          ${bySectionCount}`);
console.log(`matched by ruling house     ${byHouseCount}`);
console.log(`with a story                ${withStory.toString().padEnd(4)} ${pct(withStory)}`);
console.log(`with words                  ${withWords.toString().padEnd(4)} ${pct(withWords)}`);
console.log(`with a banner               ${withBanner.toString().padEnd(4)} ${pct(withBanner)}`);
console.log(`assigned to a realm         ${settlements.length - orphans.length}/${settlements.length}`);

console.log('\n=== REALMS =====================================================');
for (const k of kingdomsOut) {
  console.log(`${(k.name || '(unnamed)').padEnd(26)} ${(k.continent || '??').padEnd(16)} ${String(k.settlementIds.length).padStart(3)} holdings  ${k.population.toLocaleString('en-GB').padStart(11)} souls  ${k.intro ? 'intro' : 'NO INTRO'}`);
}

if (unmatched.length) {
  console.log(`\n=== UNMATCHED SETTLEMENTS (${unmatched.length}) ===========================`);
  for (const s of unmatched) {
    console.log(`  ${(s.name || '(unnamed)').padEnd(22)} ${s.type.padEnd(7)} ${(s.rulingHouse || '-').padEnd(20)} at ${Math.round(s.x)},${Math.round(s.y)}`);
  }
}

const unused = entries.filter(e => !used.has(e));
if (unused.length) {
  console.log(`\n=== CHRONICLE ENTRIES WITH NO SETTLEMENT (${unused.length}) ==============`);
  for (const e of unused) console.log(`  ${e.name.padEnd(24)} ${(e.house || '-').padEnd(22)} in ${e.realm || '?'}`);
}

if (conflicts.length) {
  const grouped = conflicts.reduce((acc, c) => ((acc[c.kind] ||= []).push(c.detail), acc), {});
  console.log(`\n=== CONFLICTS — map data kept, chronicle needs fixing (${conflicts.length}) ===`);
  for (const [kind, items] of Object.entries(grouped)) {
    console.log(`\n  [${kind}] ${items.length}`);
    for (const item of items.slice(0, 12)) console.log(`    ${item}`);
    if (items.length > 12) console.log(`    …and ${items.length - 12} more`);
  }
}

console.log(`\nwrote ${OUT.replace(ROOT, '.')}  (${(JSON.stringify(settlementsOut).length / 1024).toFixed(0)} KB of settlements)`);

if (orphans.length) {
  console.error(`\nFAILED: ${orphans.length} settlement(s) are not inside any kingdom border:`);
  for (const s of orphans) console.error(`  ${(s.name || s.id).padEnd(22)} ${s.type.padEnd(7)} at ${Math.round(s.x)},${Math.round(s.y)}`);
  if (!flag('--allow-orphans')) {
    console.error('\nRe-run with --allow-orphans to write the file anyway.');
    process.exit(1);
  }
}
