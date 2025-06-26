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

  const stats = { overall: {}, nonClickers: {}, clickers: {} };

  // Overall stats (all sections with duration > 0)
  db.all(`
    SELECT section, 
           AVG(duration) as avg_duration, 
           (SELECT duration FROM interactions WHERE page = ? AND platform = ? AND duration > 0 AND section = i.section ORDER BY duration LIMIT 1 OFFSET (SELECT COUNT(*) FROM interactions WHERE page = ? AND platform = ? AND duration > 0 AND section = i.section) / 2) as median_duration
    FROM interactions i 
    WHERE i.page = ? AND i.platform = ? AND i.duration > 0 
    GROUP BY i.section`, 
    [page, platform, page, platform, page, platform], 
    (err, rows) => {
      if (err) {
        console.error('Overall stats query error:', err);
        return res.sendStatus(500);
      }
      rows.forEach(row => {
        if (row.section) stats.overall[row.section] = { avg: row.avg_duration || 0, median: row.median_duration || 0 };
      });

      // Non-clickers (no click events within a 5-minute window of any scroll)
      db.all(`
        SELECT i.section, 
               AVG(i.duration) as avg_duration, 
               (SELECT duration FROM interactions WHERE page = ? AND platform = ? AND duration > 0 AND section = i.section AND NOT EXISTS (
                 SELECT 1 FROM interactions c WHERE c.page = i.page AND c.platform = i.platform AND c.type = 'click' 
                 AND ABS(strftime('%s', c.timestamp) - strftime('%s', i.timestamp)) < 300
               ) ORDER BY duration LIMIT 1 OFFSET (SELECT COUNT(*) FROM interactions WHERE page = ? AND platform = ? AND duration > 0 AND section = i.section AND NOT EXISTS (
                 SELECT 1 FROM interactions c WHERE c.page = i.page AND c.platform = i.platform AND c.type = 'click' 
                 AND ABS(strftime('%s', c.timestamp) - strftime('%s', i.timestamp)) < 300
               )) / 2) as median_duration
        FROM interactions i 
        WHERE i.page = ? AND i.platform = ? AND i.duration > 0 AND i.type = 'scroll'
        AND NOT EXISTS (
          SELECT 1 FROM interactions c 
          WHERE c.page = i.page AND c.platform = i.platform AND c.type = 'click'
          AND ABS(strftime('%s', c.timestamp) - strftime('%s', i.timestamp)) < 300
        )
        GROUP BY i.section`, 
        [page, platform, page, platform, page, platform], 
        (err, rows) => {
          if (err) {
            console.error('Non-clickers stats query error:', err);
            return res.sendStatus(500);
          }
          rows.forEach(row => {
            if (row.section) stats.nonClickers[row.section] = { avg: row.avg_duration || 0, median: row.median_duration || 0 };
          });

          // Clickers (at least one click within a 5-minute window of any scroll)
          db.all(`
            SELECT i.section, 
                   AVG(i.duration) as avg_duration, 
                   (SELECT duration FROM interactions WHERE page = ? AND platform = ? AND duration > 0 AND section = i.section AND EXISTS (
                     SELECT 1 FROM interactions c WHERE c.page = i.page AND c.platform = i.platform AND c.type = 'click' 
                     AND ABS(strftime('%s', c.timestamp) - strftime('%s', i.timestamp)) < 300
                   ) ORDER BY duration LIMIT 1 OFFSET (SELECT COUNT(*) FROM interactions WHERE page = ? AND platform = ? AND duration > 0 AND section = i.section AND EXISTS (
                     SELECT 1 FROM interactions c WHERE c.page = i.page AND c.platform = i.platform AND c.type = 'click' 
                     AND ABS(strftime('%s', c.timestamp) - strftime('%s', i.timestamp)) < 300
                   )) / 2) as median_duration
            FROM interactions i 
            WHERE i.page = ? AND i.platform = ? AND i.duration > 0 AND i.type = 'scroll'
            AND EXISTS (
              SELECT 1 FROM interactions c 
              WHERE c.page = i.page AND c.platform = i.platform AND c.type = 'click'
              AND ABS(strftime('%s', c.timestamp) - strftime('%s', i.timestamp)) < 300
            )
            GROUP BY i.section`, 
            [page, platform, page, platform, page, platform], 
            (err, rows) => {
              if (err) {
                console.error('Clickers stats query error:', err);
                return res.sendStatus(500);
              }
              rows.forEach(row => {
                if (row.section) stats.clickers[row.section] = { avg: row.avg_duration || 0, median: row.median_duration || 0 };
              });
              res.json(stats);
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
