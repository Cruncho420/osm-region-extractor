#!/usr/bin/env node
/**
 * PURPOSE: Download one upstream OSM PBF without ever exposing a partial/error response as data.
 * RESPONSIBILITY: HTTP retries, atomic destination replacement, and structural PBF validation.
 * DEPENDENCIES: curl and osmium-tool.
 * CONSUMERS: extract-single.ts and download-pbf.test.mjs.
 */

import { renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_SECONDS = 15;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

export function downloadPbf(url, destination, env = process.env) {
  const partial = `${destination}.partial`;
  const retries = positiveInteger(env.PBF_DOWNLOAD_RETRIES, DEFAULT_RETRIES);
  const retryDelay = positiveInteger(env.PBF_RETRY_DELAY_SECONDS, DEFAULT_RETRY_DELAY_SECONDS);
  const osmium = env.OSMIUM_BIN || 'osmium';

  rmSync(partial, { force: true });
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      rmSync(partial, { force: true });
      run('curl', [
        '--fail-with-body',
        '--location',
        '--show-error',
        '--output', partial,
        url,
      ]);

      // Extended fileinfo scans the complete stream. Header-only fileinfo accepts
      // realistic tail truncation, which is the corruption this guard must catch.
      run(osmium, ['fileinfo', '--extended', '--input-format', 'pbf', '--no-progress', partial]);
      renameSync(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      rmSync(partial, { force: true });
      if (attempt <= retries) {
        console.error(`PBF attempt ${attempt}/${retries + 1} rejected; retrying in ${retryDelay}s.`);
        if (retryDelay > 0) run('sleep', [String(retryDelay)]);
      }
    }
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
