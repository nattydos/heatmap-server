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

  // Overall stats
  const overallStats = {};
  db.each('SELECT section, AVG(duration) as avg_duration, percentile_cont(0.5) WITHIN GROUP (ORDER BY duration) as median_duration FROM interactions WHERE page = ? AND platform = ? AND duration IS NOT NULL GROUP BY section', 
    [page, platform], 
    (err, row) => {
      if (err) {
        console.error('Overall stats query error:', err);
        return res.sendStatus(500);
      }
      if (row.section) overallStats[row.section] = { avg: row.avg_duration || 0, median: row.median_duration || 0 };
    }, 
    () => {
      // Non-clickers (users with no click events)
      const nonClickersStats = {};
      db.each(`
        SELECT section, AVG(duration) as avg_duration, percentile_cont(0.5) WITHIN GROUP (ORDER BY duration) as median_duration 
        FROM interactions 
        WHERE page = ? AND platform = ? AND duration IS NOT NULL 
        AND id NOT IN (SELECT id FROM interactions WHERE type = 'click')
        GROUP BY section`, 
        [page, platform], 
        (err, row) => {
          if (err) {
            console.error('Non-clickers stats query error:', err);
            return res.sendStatus(500);
          }
          if (row.section) nonClickersStats[row.section] = { avg: row.avg_duration || 0, median: row.median_duration || 0 };
        }, 
        () => {
          // Clickers (users with at least one click event)
          const clickersStats = {};
          db.each(`
            SELECT section, AVG(duration) as avg_duration, percentile_cont(0.5) WITHIN GROUP (ORDER BY duration) as median_duration 
            FROM interactions 
            WHERE page = ? AND platform = ? AND duration IS NOT NULL 
            AND id IN (SELECT id FROM interactions WHERE type = 'click')
            GROUP BY section`, 
            [page, platform], 
            (err, row) => {
              if (err) {
                console.error('Clickers stats query error:', err);
                return res.sendStatus(500);
              }
              if (row.section) clickersStats[row.section] = { avg: row.avg_duration || 0, median: row.median_duration || 0 };
            }, 
            () => {
              res.json({ overall: overallStats, nonClickers: nonClickersStats, clickers: clickersStats });
            });
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
