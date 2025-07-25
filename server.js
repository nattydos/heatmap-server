const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('heatmap.db', (err) => {
  if (err) console.error('Database connection error:', err);
});

// Ensure the interactions table includes sessionId
db.run('CREATE TABLE IF NOT EXISTS interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, x INTEGER, y INTEGER, page TEXT, platform TEXT, type TEXT, section TEXT, duration REAL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)', (err) => {
  if (err) console.error('Table creation error:', err);
});

// Function to normalize URL
function normalizeUrl(url) {
  if (!url) return null;
  // Remove protocol, www., trailing slash, and query parameters
  return url
    .replace(/^(https?:\/\/)?/i, '')  // Remove protocol
    .replace(/^www\./i, '')  // Remove www.
    .replace(/\?.*$/, '')  // Remove query parameters
    .replace(/\/$/, '')  // Remove trailing slash
    .trim()
    .toLowerCase();
}

app.post('/track', (req, res) => {
  const { sessionId, x, y, page, platform, type, section, duration, target } = req.body;
  const normalizedPage = normalizeUrl(page);
  db.run('INSERT INTO interactions (sessionId, x, y, page, platform, type, section, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
    [sessionId, x, y, normalizedPage, platform, type || null, section || null, duration || null], 
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

app.get('/debug', (req, res) => {
  db.all('SELECT * FROM interactions', (err, rows) => {
    if (err) {
      console.error('Debug query error:', err);
      return res.sendStatus(500);
    }
    res.json(rows);
  });
});

// Add backup endpoint
app.get('/backup', (req, res) => {
  const dbPath = 'heatmap.db';
  fs.access(dbPath, fs.constants.F_OK, (err) => {
    if (err) {
      console.error('Database file not found:', err);
      return res.status(404).send('Database file not found');
    }
    res.download(dbPath, 'heatmap_backup.db', (err) => {
      if (err) {
        console.error('Error sending backup:', err);
        res.status(500).send('Error generating backup');
      }
    });
  });
});

app.listen(process.env.PORT || 8080, () => console.log('Server running on port', process.env.PORT || 8080));
