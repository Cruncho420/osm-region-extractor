#!/usr/bin/env node
/**
 * PURPOSE: Download one upstream OSM PBF without ever exposing a partial/error response as data.
 * RESPONSIBILITY: HTTP retries with backoff, Geofabrik's cookie challenge, atomic destination
 *   replacement, structural PBF validation and the upstream .md5 checksum.
 * DEPENDENCIES: curl and osmium-tool.
 * CONSUMERS: extract-single.ts, region-slices-pilot.yml and download-pbf.test.mjs.
 *
 * THE 2026-10-01 MONTHLY FAILURE (197 of 236 jobs): Geofabrik answered GitHub runners with a
 * cookie challenge — a ~270-byte 307 back to the same URL that sets a cookie. curl ran with no
 * cookie engine, so it never sent the cookie back and looped until `(47) Maximum (50)
 * redirects followed`, on every retry. A cookie jar (persisted across attempts) answers the
 * challenge; --max-redirs 10 makes any future loop fail in seconds instead of 50 hops.
 */

import { closeSync, openSync, readFileSync, readSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_SECONDS = 15;
const DEFAULT_RETRY_MAX_SECONDS = 240;
const USER_AGENT = 'osm-region-extractor (+https://github.com/Cruncho420/osm-region-extractor)';

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}

function curl(url, output, cookieJar) {
  // --cookie + --cookie-jar on the same file: send what earlier hops/attempts were given, save
  // what this one is given. -w prints the final URL so the checksum is read for the SAME dated
  // file a `-latest` redirect landed on, not for whatever `-latest` points at a minute later.
  return run('curl', [
    '--fail-with-body', '--location', '--max-redirs', '10', '--show-error', '--silent',
    '--user-agent', USER_AGENT,
    '--cookie', cookieJar, '--cookie-jar', cookieJar,
    '--write-out', '%{url_effective} %{num_redirects}',
    '--output', output,
    url,
  ]).trim();
}

function md5Of(path) {
  const hash = createHash('md5');
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Geofabrik publishes `<file>.md5` ("<hex>  <name>") beside every extract. Missing = rejected. */
function verifyMd5(partial, effectiveUrl, cookieJar) {
  const md5File = `${partial}.md5`;
  try {
    curl(`${effectiveUrl}.md5`, md5File, cookieJar);
    const expected = readFileSync(md5File, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(expected ?? '')) throw new Error(`no md5 in ${effectiveUrl}.md5`);
    const actual = md5Of(partial);
    if (actual !== expected) throw new Error(`md5 mismatch: got ${actual}, ${effectiveUrl}.md5 says ${expected}`);
  } finally {
    rmSync(md5File, { force: true });
  }
}

export function downloadPbf(url, destination, env = process.env) {
  const partial = `${destination}.partial`;
  const cookieJar = `${destination}.cookies`;
  const retries = nonNegativeInteger(env.PBF_DOWNLOAD_RETRIES, DEFAULT_RETRIES);
  const retryDelay = nonNegativeInteger(env.PBF_RETRY_DELAY_SECONDS, DEFAULT_RETRY_DELAY_SECONDS);
  const retryMax = nonNegativeInteger(env.PBF_RETRY_MAX_SECONDS, DEFAULT_RETRY_MAX_SECONDS);
  const osmium = env.OSMIUM_BIN || 'osmium';

  rmSync(cookieJar, { force: true });
  let lastError;
  try {
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      try {
        rmSync(partial, { force: true });
        const [effectiveUrl, redirects] = curl(url, partial, cookieJar).split(' ');
        console.error(`PBF attempt ${attempt}: ${effectiveUrl} after ${redirects} redirect(s)`);

        // Extended fileinfo scans the complete stream. Header-only fileinfo accepts
        // realistic tail truncation, which is the corruption this guard must catch.
        run(osmium, ['fileinfo', '--extended', '--input-format', 'pbf', '--no-progress', partial]);
        verifyMd5(partial, effectiveUrl, cookieJar);
        renameSync(partial, destination);
        return;
      } catch (error) {
        lastError = error;
        rmSync(partial, { force: true });
        if (attempt <= retries) {
          // Exponential backoff: a throttled or mid-update upstream needs minutes, not 15 s.
          const delay = Math.min(retryDelay * 2 ** (attempt - 1), retryMax);
          console.error(`PBF attempt ${attempt}/${retries + 1} rejected (${error instanceof Error ? error.message : error}); retrying in ${delay}s.`);
          if (delay > 0) run('sleep', [String(delay)]);
        }
      }
    }
  } finally {
    rmSync(cookieJar, { force: true });
  }
  throw new Error(`all ${retries + 1} PBF download attempts failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [, , url, destination] = process.argv;
  if (!url || !destination) {
    console.error('Usage: node download-pbf.mjs <url> <destination>');
    process.exit(2);
  }
  try {
    downloadPbf(url, destination);
  } catch (error) {
    console.error(`PBF download rejected: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
