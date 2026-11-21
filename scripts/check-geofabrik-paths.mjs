#!/usr/bin/env node
/**
 * check-geofabrik-paths.mjs — every Geofabrik address the extraction depends on answers 200 (after redirects).
 *
 * WHY: in Nov 2026 Geofabrik moved every extract into its own folder (europe/austria/austria-latest.osm.pbf). The old
 * address of a whole country still redirects correctly, but the old address of a part of a country redirects to a
 * wrong place and answers 404 (europe/germany/baden-wuerttemberg-latest.osm.pbf -> germany/baden-wuerttemberg/...), so
 * a monthly run would fail region by region hours in. This check runs first and fails the run in minutes, naming every
 * address that does not answer.
 * WHAT: HEAD requests only (nothing is downloaded), one at a time with a pause, a generic client name; a refused
 * connection is retried, and an address with no answer is rechecked once at the end (see runChecks). Checks, per region of scripts/regions.json: the -latest .osm.pbf, its .poly and, with
 * --osm-date YYMMDD, the dated .osm.pbf the build downloads; plus every .poly of scripts/region-slices.json and
 * scripts/release-trial-packs.json.
 * Usage: node scripts/check-geofabrik-paths.mjs [--osm-date YYMMDD] [--only-regions] [--region <id>] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://download.geofabrik.de';
const UA = 'osm-region-extractor-path-check/1.0';
const PAUSE_MS = Number(process.env.PATH_CHECK_PAUSE_MS ?? 300);
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const osmDate = flag('--osm-date');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function addressesFor(geofabrikPath, date) {
  if (!/-latest\.osm\.pbf$/.test(geofabrikPath)) return [];
  const stem = geofabrikPath.replace(/-latest\.osm\.pbf$/, '');
  return [`${stem}-latest.osm.pbf`, `${stem}.poly`, ...(date ? [`${stem}-${date}.osm.pbf`] : [])];
}

async function head(path, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/${path}`, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(20_000) });
      return { status: res.status, final: res.url };
    } catch (err) {
      const why = String(err?.cause?.code ?? err?.name ?? err);
      // A refused connection is retried (Geofabrik refuses bursts now and then). No answer in 20 s is not:
      // a moved dated address hangs instead of 404ing, and retrying each one would turn a minute-long
      // check into hours.
      if (attempt === tries || why === 'TimeoutError') return { status: 0, final: why };
      await sleep(10_000 * attempt);
    }
  }
  return { status: 0, final: 'unreachable' };
}

/**
 * The decision. Any HTTP answer other than 200 (404, 410, ...) fails at once: the address is wrong. "No answer"
 * (timeout, refused) is collected and rechecked once at the end, one try each, because Geofabrik drops a few
 * requests now and then (3 of 828 on 21 Nov, all 200 on recheck). More than `maxNoAnswer` of them means Geofabrik
 * itself is not answering: stop at once, so a mass hang ends in minutes, not hours.
 * Returns { failed, notAnswering } — notAnswering is true when the only failures are "no answer".
 */
export async function runChecks(checks, headFn, { maxNoAnswer = 30, pause = 0, onProgress } = {}) {
  const failed = [];
  const noAnswer = [];
  for (const [i, c] of checks.entries()) {
    onProgress?.(i, checks.length, failed.length + noAnswer.length);
    const r = await headFn(c.path, 3);
    if (r.status === 0) noAnswer.push({ ...c, ...r });
    else if (r.status !== 200) failed.push({ ...c, ...r });
    if (noAnswer.length > maxNoAnswer) return { failed: [...failed, ...noAnswer], notAnswering: true, stoppedEarly: true };
    if (pause && i + 1 < checks.length) await sleep(pause);
  }
  for (const c of noAnswer) {
    const r = await headFn(c.path, 1);
    if (r.status !== 200) failed.push({ ...c, ...r });
    if (pause) await sleep(pause);
  }
  return { failed, notAnswering: failed.length > 0 && failed.every((f) => f.status === 0), stoppedEarly: false };
}

async function main() {
  const only = flag('--region');
  const regions = JSON.parse(readFileSync(join(HERE, 'regions.json'), 'utf8')).regions.filter((r) => !only || r.id === only);
  if (only && regions.length === 0) { console.log(`::error::region ${only} is not in scripts/regions.json`); process.exit(1); }
  const checks = regions.flatMap((r) => addressesFor(r.geofabrikPath, osmDate).map((path) => ({ id: r.id, path })));
  if (!args.includes('--only-regions') && !only) {
    const slices = JSON.parse(readFileSync(join(HERE, 'region-slices.json'), 'utf8'));
    const polys = new Set();
    JSON.stringify(slices, (k, v) => {
      if ((k === 'sources' || k === 'union') && Array.isArray(v)) v.forEach((p) => polys.add(p));
      if ((k === 'pbf' || k === 'within') && typeof v === 'string') polys.add(v);
      return v;
    });
    // `ne:` sources are Natural Earth outlines, not Geofabrik addresses
    for (const p of polys) if (!p.startsWith('ne:')) checks.push({ id: `slice:${p}`, path: `${p}.poly` });
    for (const t of JSON.parse(readFileSync(join(HERE, 'release-trial-packs.json'), 'utf8'))) {
      if (typeof t.poly === 'string' && t.poly.startsWith(BASE)) checks.push({ id: `trial:${t.id}`, path: t.poly.slice(BASE.length + 1) });
    }
  }
  if (args.includes('--progress')) console.error(`checking ${checks.length} addresses`);
  const onProgress = args.includes('--progress')
    ? (i, n, bad) => { if (i % 50 === 0) console.error(`${i} of ${n}, ${bad} not 200 so far`); } : undefined;
  const { failed, notAnswering, stoppedEarly } = await runChecks(checks, head, { pause: PAUSE_MS, onProgress });
  const failedRegions = new Set(failed.filter((f) => !f.id.includes(':')).map((f) => f.id));
  console.log(`Geofabrik addresses: ${checks.length - failed.length} of ${checks.length} answer 200; regions with a failing address: ${failedRegions.size} of ${regions.length}`);
  for (const f of failed) console.log(`  ${f.status || 'no answer'}  ${f.id}  ${f.path}  ->  ${f.final}`);
  if (flag('--json')) writeFileSync(flag('--json'), JSON.stringify({ checked: checks.length, failed, failedRegions: [...failedRegions] }, null, 1));
  if (notAnswering) {
    console.log(`::error::Geofabrik not answering${stoppedEarly ? ' (stopped after more than 30 addresses gave no answer)' : ''}: no address answered wrongly; rerun later. The lists need no change.`);
    process.exit(1);
  }
  if (failed.length) {
    console.log('::error::Geofabrik does not serve some region addresses (above). Fix scripts/regions.json (and the slice/trial lists) before extracting.');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
