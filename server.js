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
      res.sendStatus(200);
    });
});

app.get('/data', (req, res) => {
  const { page, platform } = req.query;
  db.all('SELECT x, y, type, section, duration FROM interactions WHERE page = ? AND platform = ?', [page, platform], (err, rows) => {
    if (err) {
      console.error('Query error:', err);
      return res.sendStatus(500);
    }
    const data = rows.map(row => ({
      x: row.x,
      y: row.y,
      value: row.type === 'scroll' ? (row.duration || 0) * 10 : 1 // Scale scroll duration for heatmap
    }));
    res.json(data);
  });
});

app.listen(process.env.PORT || 8080, () => console.log('Server running on port', process.env.PORT || 8080));

app.get('/debug', (req, res) => {
  db.all('SELECT * FROM interactions', (err, rows) => {
    if (err) {
      console.error('Debug query error:', err);
      return res.sendStatus(500);
    }
    res.json(rows);
  });
});
