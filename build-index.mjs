// build-index.mjs — builds the full PDFolio library index for the Free-library panel.
//
// Runs inside GitHub Actions (Node 20+, global fetch). No dependencies, no personal token:
// the Action provides GITHUB_TOKEN automatically.
//
// Design goal: RELIABILITY. It depends only on GitHub's own API (rock-solid with the provided
// token) — NOT on Gutendex or gutenberg.org, which rate-limit cloud IPs and were producing an
// empty index. It:
//   1. Enumerates every public repo in the GITenberg org  -> id -> repo slug  (these are exactly
//      the books whose text is fetchable from GITenberg@jsDelivr, so Add always works)
//   2. Derives a readable title from each slug             -> "Pride-and-Prejudice_1342" => "Pride and Prejudice"
//   3. Orders by id ascending (low ids ≈ the classic canon) and keeps the first MAX_BOOKS
//   4. Writes gutenberg-full.json  ({id, t, a:'', repo})  — served to the app via jsDelivr
//
// Nice titles + authors for the well-known books come from the app's bundled list
// (gutenberg-library.json, ~115 hand-verified) which the app merges OVER this index client-side,
// so slug-derived titles only ever show for the long tail (search-only) books.
//
// The book TEXT is never downloaded here — the app fetches it from GITenberg@jsDelivr at Add time
// and builds the PDF in the browser. This index only carries the id/title/repo needed for search.
//
// Tunables (env): MAX_BOOKS (default 20000). Set to 60000 to include the entire catalogue.

import { writeFileSync } from 'node:fs';

const TOKEN = process.env.GITHUB_TOKEN;
const MAX_BOOKS = parseInt(process.env.MAX_BOOKS || '20000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try {
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'pdfolio-index-builder' };
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      r = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
    } catch (e) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
      const wait = Math.min(Math.max(2000, reset - Date.now() + 1000), 65000);
      console.log(`Rate limited, waiting ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${url}`);
    return r;
  }
  throw new Error('GitHub: too many retries on ' + url);
}

// id -> slug for the whole GITenberg org (shortest real slug wins; skip garbage placeholder repos)
async function buildSlugMap() {
  const map = new Map();
  for (let page = 1; ; page++) {
    const r = await gh(`https://api.github.com/orgs/GITenberg/repos?per_page=100&page=${page}&type=public&sort=full_name`);
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
    if (page % 25 === 0) console.log(`…scanned ${page} pages, ${map.size} books so far`);
    if (arr.length < 100) break;
  }
  console.log(`GITenberg books with a usable slug: ${map.size}`);
  return map;
}

// "A-Room-with-a-View_2641" -> "A Room with a View"
function titleFromSlug(slug) {
  let s = slug.replace(/_\d+$/, '');
  s = s.replace(/---/g, ' \u2014 ').replace(/--/g, ': ').replace(/-/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\bs '/g, "s'").replace(/(\w) s\b/g, "$1's"); // rough possessive/contraction repair
  return s;
}

async function main() {
  const slugMap = await buildSlugMap();
  const books = [...slugMap.entries()]
    .map(([id, repo]) => ({ id: Number(id), repo }))
    .filter((b) => b.id > 0)
    .sort((a, b) => a.id - b.id)          // low ids ≈ the classic canon first
    .slice(0, MAX_BOOKS)
    .map((b) => ({ id: b.id, t: titleFromSlug(b.repo), a: '', repo: b.repo }));

  if (books.length === 0) {
    // Never commit an empty index — fail loudly so the old good file stays in place.
    throw new Error('Refusing to write empty index (GitHub enumeration returned nothing).');
  }
  writeFileSync('gutenberg-full.json', JSON.stringify(books));
  console.log(`Wrote gutenberg-full.json — ${books.length} books, ${JSON.stringify(books).length} bytes`);
}

main().catch((e) => { console.error(e); process.exit(1); });
