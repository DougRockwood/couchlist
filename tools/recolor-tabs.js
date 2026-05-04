#!/usr/bin/env node
/* One-shot migration: wipe and recompute every list's tab_color using
   the new owner-seeded, avoid-existing picker.

   Why this exists: before today the picker mixed member colors with
   random jitter and nothing else. Two lists for the same user could
   land on neighboring hues (Doug's two tabs were both purple). This
   re-runs the decision for every list that already had a color so
   the new logic gets to spread them out.

   Run once after deploying the new picker:  node tools/recolor-tabs.js */

const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'couchlist.db'));

/* ---- color helpers — kept in sync with server.js's pickListColor.
   Inlined here so this script can run standalone without booting the
   whole server. ---- */

function parseColor (str) {
  if (typeof str !== 'string') return null;
  const hexM = /^#([0-9a-f]{6})$/i.exec(str);
  if (hexM) {
    const n = parseInt(hexM[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hslM = /^hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)$/.exec(str);
  if (hslM) return hslToRgb(+hslM[1], +hslM[2] / 100, +hslM[3] / 100);
  return null;
}

function rgbToHsl (rgb) {
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r)      h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb (h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1)      { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else             { r1 = c; b1 = x; }
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function hslToHex (h, s, l) {
  const [r, g, b] = hslToRgb(h, s, l);
  const to2 = v => v.toString(16).padStart(2, '0');
  return '#' + to2(r) + to2(g) + to2(b);
}

function pickListColor (memberColors, existingTabColors, ownerColor) {
  const ownerRgb = ownerColor ? parseColor(ownerColor) : null;
  const ownerHsl = ownerRgb ? rgbToHsl(ownerRgb) : null;
  const memberHsls = (memberColors || []).map(parseColor).filter(Boolean).map(rgbToHsl);

  let seedH, seedS, seedL;
  if (ownerHsl) {
    [seedH, seedS, seedL] = ownerHsl;
  } else if (memberHsls.length) {
    const sumX = memberHsls.reduce((a, [h]) => a + Math.cos(h * Math.PI / 180), 0);
    const sumY = memberHsls.reduce((a, [h]) => a + Math.sin(h * Math.PI / 180), 0);
    seedH = Math.atan2(sumY, sumX) * 180 / Math.PI;
    if (seedH < 0) seedH += 360;
    seedS = memberHsls.reduce((a, [, sat]) => a + sat, 0) / memberHsls.length;
    seedL = memberHsls.reduce((a, [, , lt]) => a + lt, 0) / memberHsls.length;
  } else {
    seedH = Math.random() * 360; seedS = 0.65; seedL = 0.65;
  }

  const existingHues = (existingTabColors || []).map(parseColor).filter(Boolean).map(rgbToHsl).map(([h]) => h);
  const angDist = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

  let h;
  if (existingHues.length === 0) {
    h = (seedH + (Math.random() - 0.5) * 30 + 360) % 360;
  } else {
    let best = seedH, bestScore = -Infinity;
    for (let off = 0; off < 360; off += 10) {
      const cand = (seedH + off) % 360;
      const minToExisting = existingHues.reduce((m, eh) => Math.min(m, angDist(cand, eh)), 360);
      const score = minToExisting - 0.25 * angDist(cand, seedH);
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    h = (best + (Math.random() - 0.5) * 8 + 360) % 360;
  }

  const s = Math.min(0.85, Math.max(0.55, seedS + (Math.random() - 0.5) * 0.10));
  const l = Math.min(0.72, Math.max(0.55, seedL + (Math.random() - 0.5) * 0.05));
  return hslToHex(h, s, l);
}

/* ---- migration ---- */

/* Only re-derive lists that already have a tab color. Untouched ones
   stay NULL so the runtime lazy-fill picks them up on first view, with
   the same logic. */
const lists = db.prepare(
  'SELECT id, owner_visitor_id, tab_color, created '
  + 'FROM lists WHERE tab_color IS NOT NULL '
  + 'ORDER BY created, id'
).all();

console.log(`recoloring ${lists.length} list(s)`);

/* Process per-user so each user's view gets distinct colors. We bucket
   lists by their "primary user" — owner if known, otherwise the
   slot-1 member as the best stand-in for who created the list. */
const memberRows = db.prepare(
  'SELECT lv.list_id, lv.slot, v.id AS visitor_id, v.color '
  + 'FROM list_visitors lv JOIN visitors v ON v.id = lv.visitor_id '
  + 'ORDER BY lv.list_id, lv.slot'
).all();
const membersByList = new Map();
for (const r of memberRows) {
  if (!membersByList.has(r.list_id)) membersByList.set(r.list_id, []);
  membersByList.get(r.list_id).push(r);
}

const visitorColor = id => {
  const v = db.prepare('SELECT color FROM visitors WHERE id = ?').get(id);
  return v ? v.color : null;
};

/* Wipe so the picker sees a clean slate while it works. */
db.prepare('UPDATE lists SET tab_color = NULL WHERE tab_color IS NOT NULL').run();

/* For each list, accumulate all already-decided tab_colors GLOBALLY so
   every list ends distinct from every other. Stronger than per-user
   distinctness but with only a handful of lists it's effectively the
   same and avoids juggling per-user buckets. */
const usedTabColors = [];
const setTabColor = db.prepare('UPDATE lists SET tab_color = ? WHERE id = ?');

for (const l of lists) {
  const members = membersByList.get(l.id) || [];
  const memberColors = members.map(m => m.color).filter(Boolean);
  const seed = (l.owner_visitor_id && visitorColor(l.owner_visitor_id))
    || (members[0] && members[0].color)
    || null;
  const newColor = pickListColor(memberColors, usedTabColors, seed);
  setTabColor.run(newColor, l.id);
  usedTabColors.push(newColor);
  console.log(`  ${l.id}  ${l.tab_color} → ${newColor}  seed=${seed || '(none)'}`);
}

console.log('done');
