/**
 * PURPOSE: Lock the BUG-819 HTTP-and-content contract at the OSM download boundary.
 * RESPONSIBILITY: Prove invalid responses never replace a destination and transient errors retry.
 * DEPENDENCIES: Node test runner, curl, and osmium-tool.
 * CONSUMERS: npm test and Scripts Tests GitHub workflow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'download-pbf-test-'));
const opl = join(root, 'valid.opl');
const validPbf = join(root, 'valid.osm.pbf');
writeFileSync(opl, 'n1 v1 dV c0 t i0 u T x13.0 y55.0\n');
const fixtureBuild = spawnSync('osmium', ['cat', opl, '-f', 'pbf', '-o', validPbf], { encoding: 'utf8' });
assert.equal(fixtureBuild.status, 0, fixtureBuild.stderr);
const validBytes = readFileSync(validPbf);

const hits = new Map();
const server = createServer((request, response) => {
  const path = request.url ?? '/';
  const count = (hits.get(path) ?? 0) + 1;
  hits.set(path, count);
  if (path === '/valid') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(validBytes);
  } else if (path === '/eventual' && count >= 3) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(validBytes);
  } else if (path === '/html') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html>upstream busy</html>');
  } else if (path === '/empty') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end();
  } else if (path === '/truncated') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(validBytes.subarray(0, Math.floor(validBytes.length * 0.7)));
  } else {
    const status = Number(path.slice(1)) || 500;
    response.writeHead(status, { 'Content-Type': 'text/plain', 'Retry-After': '0' });
    response.end(`HTTP ${status}`);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const downloader = process.env.PBF_DOWNLOADER_PATH
  ? new URL(`file://${process.env.PBF_DOWNLOADER_PATH}`)
  : new URL('./download-pbf.mjs', import.meta.url);

function run(path, destination = join(root, `${path.slice(1)}.pbf`), retries = 0) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [downloader.pathname, `${baseUrl}${path}`, destination], {
      env: {
        ...process.env,
        PBF_DOWNLOAD_RETRIES: String(retries),
        PBF_RETRY_DELAY_SECONDS: '0',
        PBF_RETRY_MAX_SECONDS: '10',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

test.after(() => server.close());

test('accepts a structurally valid PBF', async () => {
  const destination = join(root, 'accepted.pbf');
  const result = await run('/valid', destination);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(destination), validBytes);
});

for (const path of ['/404', '/429', '/500', '/html', '/empty', '/truncated']) {
  test(`rejects ${path.slice(1)} without replacing the last good file`, async () => {
    const destination = join(root, `preserved-${path.slice(1)}.pbf`);
    writeFileSync(destination, validBytes);
    const result = await run(path, destination);
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(destination), validBytes);
  });
}

test('retries transient HTTP failures and accepts the eventual valid PBF', async () => {
  const result = await run('/eventual', undefined, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hits.get('/eventual'), 3);
});

test('retries invalid HTTP-200 content as a complete attempt', async () => {
  hits.set('/invalid-eventual', 0);
  const invalidServerHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (request.url === '/invalid-eventual') {
      const count = (hits.get('/invalid-eventual') ?? 0) + 1;
      hits.set('/invalid-eventual', count);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(count >= 3 ? validBytes : '<html>busy</html>');
      return;
    }
    invalidServerHandler(request, response);
  });
  const result = await run('/invalid-eventual', undefined, 2);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hits.get('/invalid-eventual'), 3);
});

test('exhausts the bounded retry budget', async () => {
  hits.set('/503', 0);
  const result = await run('/503', undefined, 2);
  assert.notEqual(result.status, 0);
  assert.equal(hits.get('/503'), 3);
});
