const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('heatmap.db', (err) => {
  if (err) console.error('Database connection error:', err);
});

db.run('CREATE TABLE IF NOT EXISTS interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, x INTEGER, y INTEGER, page TEXT, platform TEXT, type TEXT, section TEXT, duration REAL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)', (err) => {
  if (err) console.error('Table creation error:', err);
});

app.post('/track', (req, res) => {
  const { x, y, page, platform, type, section, duration } = req.body;
  db.run('INSERT INTO interactions (x, y, page, platform, type, section, duration) VALUES (?, ?, ?, ?, ?, ?, ?)', 
    [x, y, page, platform, type, section || null, duration || null], 
    (err) => {
      if (err) {
        console.error('Insert error:', err);
        return res.sendStatus(500);
      }
      console.log('Data inserted:', { x, y, page, platform, type, section, duration });
      res.sendStatus(200);
    });
});

app.get('/data', (req, res) => {
  const { page, platform } = req.query;
  if (!page || !platform) return res.status(400).json({ error: 'Page and platform are required' });

  db.all('SELECT * FROM interactions WHERE page = ? AND platform = ? AND ((type = "scroll" AND duration > 0) OR type = "click")', 
    [page, platform], 
    (err, allInteractions) => {
      if (err) {
        console.error('Database query error:', err);
        return res.sendStatus(500);
      }

      // Separate scroll and click events
      const scrollEvents = allInteractions.filter(i => i.type === 'scroll');
      const clickEvents = allInteractions.filter(i => i.type === 'click')
        .map(c => new Date(c.timestamp).getTime() / 1000); // Convert to Unix seconds

      // Function to determine if a scroll event is associated with a clicker
      function isClicker(scroll) {
        const scrollTime = new Date(scroll.timestamp).getTime() / 1000;
        return clickEvents.some(clickTime => Math.abs(clickTime - scrollTime) < 300); // 5-minute window
      }

      const clickerScrolls = scrollEvents.filter(isClicker);
      const nonClickerScrolls = scrollEvents.filter(s => !isClicker(s));

      // Function to calculate average and median for a set of events
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
          if (n === 0) continue; // Skip empty sections
          const median = n % 2 === 1 ? durations[Math.floor(n / 2)] : (durations[n / 2 - 1] + durations[n / 2]) / 2;
          const avg = durations.reduce((sum, d) => sum + d, 0) / n;
          stats[section] = { avg, median };
        }
        return stats;
      }

      // Calculate stats for all categories
      const overallStats = calculateStats(scrollEvents);
      const nonClickerStats = calculateStats(nonClickerScrolls);
      const clickerStats = calculateStats(clickerScrolls);

      // Send response
      res.json({
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

app.listen(process.env.PORT || 8080, () => console.log('Server running on port', process.env.PORT || 8080));
