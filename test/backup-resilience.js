// Proves a client abort or a HEAD request on /backup cannot kill the process,
// that a finished download is a complete consistent SQLite snapshot, and that
// HEATMAP_ADMIN_TOKEN is enforced only when it is set.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const SERVER = path.join(__dirname, '..', 'server.js');
const ROW_A = 'session-before-snapshot';
const ROW_B = 'session-after-snapshot';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, method, urlPath, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: Object.assign({}, headers || {}, data ? { 'Content-Length': data.length } : {})
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function abortBackup(port, headers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/backup',
      method: 'GET',
      headers: headers || {}
    }, (res) => {
      const length = Number(res.headers['content-length'] || 0);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        req.destroy();
      });
      res.on('error', () => finish({ status: res.statusCode, received, length }));
      res.on('close', () => finish({ status: res.statusCode, received, length }));
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNRESET') finish({ status: 0, received: 0, length: 0, err: err.code });
      else reject(err);
    });
    req.end();
  });
}

function startServer(port, cwd, token) {
  const env = Object.assign({}, process.env, { PORT: String(port) });
  if (token) env.HEATMAP_ADMIN_TOKEN = token;
  else delete env.HEATMAP_ADMIN_TOKEN;

  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { logs.stdout += chunk; });
  child.stderr.on('data', (chunk) => { logs.stderr += chunk; });
  child.logs = logs;
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(2000).then(() => false)
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function waitUntilUp(port) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 5000) {
    try {
      const res = await request(port, 'GET', '/debug');
      if (res.status === 200 || res.status === 401) return res.status;
      lastError = new Error('status ' + res.status);
    } catch (err) {
      lastError = err;
    }
    await delay(50);
  }
  throw lastError || new Error('server did not start');
}

function postTrack(port, sessionId) {
  return request(port, 'POST', '/track', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      x: 10,
      y: 20,
      page: 'https://shopping.naturaldos.com/advtr-hemp-softgel-news',
      platform: 'shopify',
      type: 'click',
      target: 'buy'
    })
  });
}

function inflateDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(dbPath);
    database.configure('busyTimeout', 5000);
    const blob = 'Z'.repeat(20000);
    database.serialize(() => {
      database.run('BEGIN');
      const stmt = database.prepare(
        'INSERT INTO interactions (sessionId, x, y, page, platform, type, section, duration, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (let i = 0; i < 400; i++) {
        stmt.run('bulk-' + i, 1, 2, 'shopping.naturaldos.com/page', 'shopify', 'scroll', 'hero', 1.5, blob);
      }
      stmt.finalize((err) => {
        if (err) {
          database.close(() => reject(err));
          return;
        }
        database.run('COMMIT', (commitErr) => {
          database.close(() => commitErr ? reject(commitErr) : resolve());
        });
      });
    });
  });
}

function rowsInSnapshot(file, sessionId) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      database.get('PRAGMA integrity_check', (integrityErr, integrity) => {
        if (integrityErr) return database.close(() => reject(integrityErr));
        database.all(
          'SELECT sessionId FROM interactions WHERE sessionId = ?',
          [sessionId],
          (queryErr, rows) => {
            database.close(() => {
              if (queryErr) reject(queryErr);
              else resolve({ integrity: integrity.integrity_check, count: rows.length });
            });
          }
        );
      });
    });
  });
}

function assertStillUp(child, label) {
  assert.strictEqual(child.exitCode, null, label + ': process exited with ' + child.exitCode);
  assert.strictEqual(child.signalCode, null, label + ': process killed by ' + child.signalCode);
  assert.ok(
    !child.logs.stderr.includes('ERR_HTTP_HEADERS_SENT'),
    label + ': headers-sent crash\n' + child.logs.stderr
  );
  assert.ok(
    !child.logs.stderr.includes('Uncaught exception'),
    label + ': uncaught exception\n' + child.logs.stderr
  );
  assert.ok(
    !child.logs.stderr.includes('Unhandled rejection'),
    label + ': unhandled rejection\n' + child.logs.stderr
  );
}

async function main() {
  const timeout = setTimeout(() => {
    console.error('TEST TIMEOUT');
    process.exit(1);
  }, 60000);
  timeout.unref();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap-test-'));
  const port = await freePort();
  let child;

  try {
    child = startServer(port, dir);
    await waitUntilUp(port);

    const tracked = await postTrack(port, ROW_A);
    assert.strictEqual(tracked.status, 200, 'track without token');
    await inflateDatabase(path.join(dir, 'heatmap.db'));

    const aborted = await abortBackup(port);
    assert.strictEqual(aborted.status, 200, 'aborted download status');
    assert.ok(aborted.received > 0, 'abort received no bytes, so it did not interrupt a stream');
    assert.ok(
      aborted.received < aborted.length,
      'abort received the whole file (' + aborted.received + ' of ' + aborted.length + ')'
    );
    await delay(400);
    assertStillUp(child, 'after abort');
    assert.ok(
      child.logs.stderr.includes('Backup download aborted'),
      'abort was not handled in the backup callback:\n' + child.logs.stderr
    );

    const head = await request(port, 'HEAD', '/backup');
    assert.strictEqual(head.status, 200, 'HEAD /backup');
    assert.strictEqual(head.body.length, 0, 'HEAD must not send a body');
    assert.ok(Number(head.headers['content-length']) > 0, 'HEAD content-length');
    assert.strictEqual(
      head.headers['content-disposition'],
      'attachment; filename="heatmap_backup.db"'
    );
    await delay(200);
    assertStillUp(child, 'after HEAD');

    const debug = await request(port, 'GET', '/debug');
    assert.strictEqual(debug.status, 200, 'debug after abort');
    const debugRows = JSON.parse(debug.body.toString());
    assert.ok(debugRows.some((row) => row.sessionId === ROW_A), 'row A still in the live database');

    const data = await request(
      port,
      'GET',
      '/data?page=' + encodeURIComponent('https://shopping.naturaldos.com/advtr-hemp-softgel-news') + '&platform=shopify'
    );
    assert.strictEqual(data.status, 200, '/data after abort');
    const stats = JSON.parse(data.body.toString());
    assert.ok(stats.totalClicks >= 1, 'click survived the aborted backup');

    // Headers are sent only after the snapshot is finished, so a row inserted
    // while the body is still downloading must not appear in the file.
    const full = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/backup' }, (res) => {
        const chunks = [];
        postTrack(port, ROW_B).then((insertRes) => {
          if (insertRes.status !== 200) {
            reject(new Error('row B insert status ' + insertRes.status));
            res.destroy();
            return;
          }
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          }));
          res.on('error', reject);
        }).catch(reject);
      });
      req.on('error', reject);
    });

    assert.strictEqual(full.status, 200, 'full download');
    assert.strictEqual(
      full.body.length,
      Number(full.headers['content-length']),
      'download body shorter than content-length'
    );
    assert.ok(full.body.slice(0, 16).equals(Buffer.from('SQLite format 3\0')), 'snapshot magic');

    const snapshotPath = path.join(dir, 'downloaded.db');
    fs.writeFileSync(snapshotPath, full.body);
    const before = await rowsInSnapshot(snapshotPath, ROW_A);
    const after = await rowsInSnapshot(snapshotPath, ROW_B);
    assert.strictEqual(before.integrity, 'ok', 'snapshot integrity');
    assert.strictEqual(before.count, 1, 'snapshot contains the row committed before the download');
    assert.strictEqual(after.count, 0, 'snapshot excludes a row written while the file was streaming');
    assertStillUp(child, 'after full download');

    const live = await request(port, 'GET', '/debug');
    const liveRows = JSON.parse(live.body.toString());
    assert.ok(liveRows.some((row) => row.sessionId === ROW_B), 'row B was written to the live database');

    await stopServer(child);
    child = null;

    const token = 'test-token-8851';
    const authPort = await freePort();
    child = startServer(authPort, dir, token);
    assert.strictEqual(await waitUntilUp(authPort), 401, 'token-protected server did not come up locked');
    const closed = await request(authPort, 'GET', '/debug');
    assert.strictEqual(closed.status, 401, 'debug without token');
    const closedBackup = await request(authPort, 'GET', '/backup');
    assert.strictEqual(closedBackup.status, 401, 'backup without token');
    assert.ok(
      !closedBackup.body.slice(0, 16).equals(Buffer.from('SQLite format 3\0')),
      'unauthorized backup returned a database file'
    );
    const closedHead = await request(authPort, 'HEAD', '/backup');
    assert.strictEqual(closedHead.status, 401, 'HEAD backup without token');
    assert.strictEqual(closedHead.body.length, 0);

    const wrong = await request(authPort, 'GET', '/backup', {
      headers: { Authorization: 'Bearer wrong-token' }
    });
    assert.strictEqual(wrong.status, 401, 'wrong bearer token');
    const wrongQuery = await request(authPort, 'GET', '/debug?token=nope');
    assert.strictEqual(wrongQuery.status, 401, 'wrong query token');

    const openTrack = await postTrack(authPort, 'session-ingest-open');
    assert.strictEqual(openTrack.status, 200, 'ingest stays open when the admin token is set');

    const bearer = await request(authPort, 'GET', '/debug', {
      headers: { Authorization: 'Bearer ' + token }
    });
    assert.strictEqual(bearer.status, 200, 'debug with bearer token');
    const query = await request(authPort, 'GET', '/backup?token=' + encodeURIComponent(token));
    assert.strictEqual(query.status, 200, 'backup with query token');
    assert.ok(query.body.slice(0, 16).equals(Buffer.from('SQLite format 3\0')), 'authorized backup is a database');
    assert.strictEqual(query.body.length, Number(query.headers['content-length']));

    const authedHead = await request(authPort, 'HEAD', '/backup', {
      headers: { Authorization: 'Bearer ' + token }
    });
    assert.strictEqual(authedHead.status, 200, 'HEAD with bearer token');
    assert.strictEqual(authedHead.body.length, 0);
    assert.ok(Number(authedHead.headers['content-length']) > 0);

    const authedAbort = await abortBackup(authPort, { Authorization: 'Bearer ' + token });
    assert.strictEqual(authedAbort.status, 200);
    assert.ok(authedAbort.received > 0 && authedAbort.received < authedAbort.length);
    await delay(400);
    assertStillUp(child, 'after authenticated abort');

    const stillThere = await request(authPort, 'GET', '/debug', {
      headers: { Authorization: 'Bearer ' + token }
    });
    assert.strictEqual(stillThere.status, 200, 'server answers after authenticated abort');

    console.log('backup resilience checks passed');
  } catch (err) {
    if (child) {
      console.error('--- server stdout ---');
      console.error(child.logs.stdout.slice(-4000));
      console.error('--- server stderr ---');
      console.error(child.logs.stderr.slice(-4000));
    }
    throw err;
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
