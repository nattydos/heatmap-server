const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('heatmap.db');
db.run('CREATE TABLE IF NOT EXISTS clicks (x INTEGER, y INTEGER, page TEXT, platform TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)');

app.post('/track', (req, res) => {
  const { x, y, page, platform } = req.body;
  db.run('INSERT INTO clicks (x, y, page, platform) VALUES (?, ?, ?, ?)', [x, y, page, platform], (err) => {
    if (err) console.error(err);
    res.sendStatus(200);
  });
});

app.get('/data', (req, res) => {
  db.all('SELECT x, y FROM clicks WHERE page = ? AND platform = ?', [req.query.page, req.query.platform], (err, rows) => {
    if (err) console.error(err);
    res.json(rows.map(row => ({ x: row.x, y: row.y, value: 1 })));
  });
});

app.listen(process.env.PORT || 8080, () => console.log('Server running on port', process.env.PORT || 8080));
