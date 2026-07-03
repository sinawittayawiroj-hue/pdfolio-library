// build-index.mjs — builds the full PDFolio library index for the Free-library panel.
//
// Runs inside GitHub Actions (Node 20+, global fetch). No dependencies, no personal token:
// the Action provides GITHUB_TOKEN automatically. It:
//   1. Enumerates every public repo in the GITenberg org  -> map of Gutenberg id -> repo slug
//   2. Pulls the most-popular English books from Gutendex  -> id, title, author (popularity order)
//   3. Joins them (only books that actually have a GITenberg repo), cleans + de-dupes
//   4. Writes gutenberg-full.json  (popularity-ranked; served to the app via jsDelivr)
//
// The book TEXT is not touched here — the app fetches it from GITenberg@jsDelivr at Add time and
// generates the PDF in the browser. This index only carries {id, t, a, repo}. Cover art is derived
// from the id by the app. Size ~ TOP_N * 90 bytes (5000 -> ~450 KB, gzips to ~150 KB on jsDelivr).
//
// Tunables (env): TOP_N (default 5000). Raise toward ~57000 for the whole catalogue (bigger file).

import { writeFileSync } from 'node:fs';

const TOKEN = process.env.GITHUB_TOKEN;
const TOP_N = parseInt(process.env.TOP_N || '5000', 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function gh(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      headers: {
        Authorization: TOKEN ? `Bearer ${TOKEN}` : undefined,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pdfolio-index-builder',
      },
    });
    if (r.status === 403 || r.status === 429) {
      // rate-limited — wait until reset, then retry
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
      const wait = Math.max(2000, reset - Date.now() + 1000);
      console.log(`Rate limited, waiting ${Math.round(wait / 1000)}s…`);
      await sleep(Math.min(wait, 65000));
      continue;
    }
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${url}`);
    return r;
  }
  throw new Error('GitHub: too many retries on ' + url);
}

// 1) id -> slug for the whole GITenberg org (shortest real slug wins; skip garbage placeholders)
async function buildSlugMap() {
  const map = new Map();
  for (let page = 1; ; page++) {
    const r = await gh(`https://api.github.com/orgs/GITenberg/repos?per_page=100&page=${page}&type=public`);
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const repo of arr) {
      const m = repo.name.match(/_(\d+)$/);
      if (!m) continue;
      const id = m[1];
      const namePart = repo.name.slice(0, -(id.length + 1));
      const alnum = (namePart.match(/[A-Za-z0-9]/g) || []).length;
      if (alnum <= 2) continue; // skip auto-created placeholder repos (all-dashes / single letter)
      if (!map.has(id) || repo.name.length < map.get(id).length) map.set(id, repo.name);
    }
    if (page % 20 === 0) console.log(`…scanned ${page} pages, ${map.size} repos so far`);
    if (arr.length < 100) break;
  }
  console.log(`GITenberg repos with a usable slug: ${map.size}`);
  return map;
}

// 2) Popularity-ordered English books from Gutendex
async function fetchPopular(n) {
  const out = [];
  let url = 'https://gutendex.com/books?languages=en';
  while (url && out.length < n) {
    let j = null;
    for (let attempt = 0; attempt < 4 && !j; attempt++) {
      try {
        const r = await fetch(url);
        if (r.ok) j = await r.json();
      } catch (_) {}
      if (!j) await sleep(2000 * (attempt + 1));
    }
    if (!j) { console.log('Gutendex stopped responding; using what we have'); break; }
    for (const b of (j.results || [])) out.push({ id: String(b.id), t: b.title, a: (b.authors[0] || {}).name || '' });
    if (out.length % 320 === 0) console.log(`…pulled ${out.length} popular titles`);
    url = j.next;
  }
  return out.slice(0, n);
}

const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const cleanAuthor = (a) => {
  if (!a) return '';
  a = a.replace(/\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  const m = a.match(/^([^,]+),\s*([^,]+?)(?:,.*)?$/);
  return (m ? `${m[2].trim()} ${m[1].trim()}` : a).replace(/\s{2,}/g, ' ').trim();
};
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
const JUNK = /world factbook|twentieth century dictionary|modern english biography|human genome|census of population|congressional address|copyright law|chromosome number/i;

async function main() {
  const slugMap = await buildSlugMap();
  const popular = await fetchPopular(TOP_N);
  const seen = new Set();
  const books = [];
  for (const b of popular) {
    const repo = slugMap.get(b.id);
    if (!repo) continue;                 // no GITenberg text -> skip (Add would fail)
    if (JUNK.test(b.t)) continue;
    const a = cleanAuthor(b.a);
    const key = norm(b.t) + '|' + norm(a);
    if (seen.has(key)) continue;         // drop duplicate editions
    seen.add(key);
    books.push({ id: Number(b.id), t: b.t.trim(), a, repo });
  }
  writeFileSync('gutenberg-full.json', JSON.stringify(books));
  console.log(`Wrote gutenberg-full.json — ${books.length} books, ${JSON.stringify(books).length} bytes`);
}

main().catch((e) => { console.error(e); process.exit(1); });
