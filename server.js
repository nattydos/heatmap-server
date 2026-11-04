const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = express();

// The SQLite file lives on App Platform's ephemeral disk. A process exit
// restarts the app and comes back with an empty database, so a single bad
// request must not be allowed to take the process down. Startup failures
// (for example, the listen port is already taken) still exit.
let serverListening = false;

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  if (!serverListening) process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (!serverListening) process.exit(1);
});

app.use(cors());
app.use(express.json());

// Client aborts surface as 'error' events on the request, response, or socket.
// An 'error' event with no listener crashes the process. Keep-alive sockets are
// reused across requests, so the socket listener is attached once.
const guardedStreams = new WeakSet();

function logStreamError(err) {
  console.error('Stream error:', err && (err.code || err.message) || err);
}

function guardStream(stream) {
  if (!stream || guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  stream.on('error', logStreamError);
}

app.use((req, res, next) => {
  guardStream(req);
  guardStream(res);
  guardStream(req.socket);
  next();
});

app.use(express.static('public'));

const db = new sqlite3.Database('heatmap.db', (err) => {
  if (err) console.error('Database connection error:', err);
});

// Ensure the interactions table includes sessionId
db.run('CREATE TABLE IF NOT EXISTS interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, x INTEGER, y INTEGER, page TEXT, platform TEXT, type TEXT, section TEXT, duration REAL, target TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)', (err) => {
  if (err) console.error('Table creation error:', err);
});

// One-time migration: add target column if it doesn't already exist (silent no-op after first run)
db.run('ALTER TABLE interactions ADD COLUMN target TEXT', () => {});

// Function to normalize URL
function normalizeUrl(url) {
  if (!url) return null;
  // Remove protocol, www., trailing slash, and query parameters
  return url
    .replace(/^(https?:\/\/)?/i, '')  // Remove protocol
    .replace(/^www\./i, '')  // Remove www.
    .replace(/\/$/, '')  // Remove trailing slash
    .trim()
    .toLowerCase();
}

// Optional gate for admin-only routes. When HEATMAP_ADMIN_TOKEN is unset (or
// empty), these routes stay open so the existing desktop backup script keeps
// working. When it is set, require Authorization: Bearer <token> or ?token=.
function tokenEquals(provided, expected) {
  if (typeof provided !== 'string') return false;
  const actual = Buffer.from(provided);
  const want = Buffer.from(expected);
  if (actual.length !== want.length) return false;
  return crypto.timingSafeEqual(actual, want);
}

function adminAuthorized(req) {
  const expected = process.env.HEATMAP_ADMIN_TOKEN;
  if (!expected) return true;

  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match && tokenEquals(match[1], expected)) return true;
  }
  if (tokenEquals(req.query.token, expected)) return true;
  return false;
}

function requireAdmin(req, res, next) {
  if (adminAuthorized(req)) return next();
  res.sendStatus(401);
}

function isSqliteBusy(err) {
  if (!err) return false;
  return err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED' ||
    err.errno === sqlite3.BUSY || err.errno === sqlite3.LOCKED;
}

function isClientAbort(err) {
  if (!err) return false;
  return err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' ||
    err.code === 'EPIPE' || err.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

// Copy the live database with the SQLite online backup API so a download
// never streams a file that SQLite is in the middle of writing.
function snapshotDatabase(destPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let backup;
    const copyAll = (attemptsLeft) => {
      // -1 copies every remaining page. BUSY/LOCKED are retried so an
      // in-flight insert does not fail the download.
      backup.step(-1, (stepErr) => {
        if (isSqliteBusy(stepErr) && attemptsLeft > 0) {
          setTimeout(() => copyAll(attemptsLeft - 1), 25);
          return;
        }
        backup.finish(() => {
          if (stepErr) fail(stepErr);
          else succeed();
        });
      });
    };

    try {
      backup = db.backup(destPath, (initErr) => {
        if (initErr) return fail(initErr);
        copyAll(20);
      });
    } catch (err) {
      fail(err);
      return;
    }
    // Init/step failures with a callback are delivered there. This listener
    // covers any 'error' event the binding still emits, which would otherwise
    // crash the process.
    backup.on('error', fail);
  });
}

function removeSnapshot(destPath) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.unlink(destPath + suffix, () => {});
  }
}

function sendBackupError(res, err) {
  console.error('Error generating backup:', err);
  try {
    if (!res.headersSent) res.status(500).send('Error generating backup');
  } catch (sendErr) {
    console.error('Backup error response failed:', sendErr);
  }
}

app.post('/track', (req, res) => {
  const { sessionId, x, y, page, platform, type, section, duration, target } = req.body;
  const normalizedPage = normalizeUrl(page);
  db.run('INSERT INTO interactions (sessionId, x, y, page, platform, type, section, duration, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 
  [sessionId, x, y, normalizedPage, platform, type || null, section || null, duration || null, target || null], 
    (err) => {
      if (err) {
        console.error('Insert error:', err);
        return res.sendStatus(500);
      }
      console.log('Data inserted:', { sessionId, x, y, page: normalizedPage, platform, type, section, duration, target });
      res.sendStatus(200);
    });
});

app.get('/data', (req, res) => {
  res.set('Cache-Control', 'no-store'); // Prevent caching
  const { page, platform } = req.query;
  if (!page || !platform) return res.status(400).json({ error: 'Page and platform are required' });

  const normalizedPage = normalizeUrl(page);
  console.log('→ /data called with:', req.query); // Debug log

  db.all('SELECT * FROM interactions WHERE page = ? AND platform = ? AND (type = "scroll" OR type = "click")', 
    [normalizedPage, platform], 
    (err, allInteractions) => {
      if (err) {
        console.error('Database query error:', err);
        return res.sendStatus(500);
      }

      if (allInteractions.length === 0) {
        console.log('No data found for page:', normalizedPage);
        return res.json({
          totalSessions: 0,
          clickerSessions: 0,
          totalClicks: 0,
          overall: {},
          nonClickers: {},
          clickers: {}
        });
      }

      const sessions = allInteractions.reduce((acc, i) => {
        if (!acc[i.sessionId]) acc[i.sessionId] = [];
        acc[i.sessionId].push(i);
        return acc;
      }, {});

      const totalSessions = Object.keys(sessions).length;
      const clickerSessions = Object.values(sessions).filter(session => session.some(i => i.type === 'click')).length;
      const totalClicks = allInteractions.filter(i => i.type === 'click').length;

      Object.keys(sessions).forEach(sessionId => {
        const hasClick = sessions[sessionId].some(i => i.type === 'click');
        console.log(`Session ${sessionId} classified as ${hasClick ? 'clicker' : 'non-clicker'}`);
      });

      const scrollEvents = allInteractions.filter(i => i.type === 'scroll');
      const clickerScrolls = Object.values(sessions).filter(session => session.some(i => i.type === 'click')).flatMap(session => session.filter(i => i.type === 'scroll'));
      const nonClickerScrolls = Object.values(sessions).filter(session => !session.some(i => i.type === 'click')).flatMap(session => session.filter(i => i.type === 'scroll'));

      function calculateStats(events) {
        const grouped = events.reduce((acc, e) => {
          acc[e.section] = acc[e.section] || [];
          acc[e.section].push(e.duration);
          return acc;
        }, {});
        const stats = {};
        for (const section in grouped) {
          const durations = grouped[section].sort((a, b) => a - b);
          const n = durations.length;
          if (n === 0) continue;
          const median = n % 2 === 1 ? durations[Math.floor(n / 2)] : (durations[n / 2 - 1] + durations[n / 2]) / 2;
          const avg = durations.reduce((sum, d) => sum + d, 0) / n;
          stats[section] = { avg, median };
        }
        return stats;
      }

      const overallStats = calculateStats(scrollEvents);
      const nonClickerStats = calculateStats(nonClickerScrolls);
      const clickerStats = calculateStats(clickerScrolls);

      res.json({
        totalSessions,
        clickerSessions,
        totalClicks,
        overall: overallStats,
        nonClickers: nonClickerStats,
        clickers: clickerStats
      });
    });
});

app.get('/debug', requireAdmin, (req, res) => {
  db.all('SELECT * FROM interactions', (err, rows) => {
    if (err) {
      console.error('Debug query error:', err);
      return res.sendStatus(500);
    }
    res.json(rows);
  });
});

// Consistent snapshot, then send that file. The download callback used to
// call res.status(500).send() for every error, including a client that hung
// up after streaming had started. That throw (ERR_HTTP_HEADERS_SENT) was
// uncaught and killed the process.
app.get('/backup', requireAdmin, (req, res) => {
  const dest = path.join(
    os.tmpdir(),
    `heatmap-backup-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`
  );

  snapshotDatabase(dest).then(() => {
    try {
      res.download(dest, 'heatmap_backup.db', (err) => {
        try {
          removeSnapshot(dest);
          if (!err) return;
          if (isClientAbort(err)) {
            console.error('Backup download aborted:', err.code);
            return;
          }
          console.error('Error sending backup:', err);
          if (!res.headersSent) res.status(500).send('Error generating backup');
        } catch (callbackErr) {
          console.error('Backup callback error:', callbackErr);
        }
      });
    } catch (err) {
      removeSnapshot(dest);
      sendBackupError(res, err);
    }
  }).catch((err) => {
    removeSnapshot(dest);
    sendBackupError(res, err);
  });
});

const port = process.env.PORT || 8080;
const server = app.listen(port, () => {
  serverListening = true;
  console.log('Server running on port', port);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  if (!serverListening) process.exit(1);
});
