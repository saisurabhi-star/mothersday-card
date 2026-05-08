const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1129';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function seedDefaults() {
  const questions = [
    ['If Mom had an age based on how she acts, what would it be and why?', 'funny', 'e.g. She acts 25 when music comes on.', 0],
    ['What phrase does Mom say so much you hear it in your sleep?', 'funny', 'e.g. Because I said so!', 1],
    ['What would Mom spend $1000 on if she had to spend it TODAY?', 'funny', 'e.g. Shoes. Definitely shoes.', 2],
    ["What is Mom's go-to excuse to get out of something?", 'funny', "e.g. She says she's tired", 3],
    ['What does Mom care about most?', 'sweet', "e.g. That we're all happy and healthy", 4],
    ["What do you think mom hope's for you most?", 'sweet', 'e.g. She wants me to be a doctor lol', 5],
    ['What is something Mom does that you hope to do someday?', 'sweet', 'e.g. The way she always shows up for people', 6],
    ["What is Mom's guilty pleasure?", 'wildcard', 'e.g. Watching Reels', 7],
    ["What is something Mom tries her best at, even if she knows she is not good at it?", 'wildcard', 'e.g. Parallel parking', 8],
    ['What would Mom do with 24 hours completely alone?', 'wildcard', 'e.g. Sleep the entire time', 9],
  ];
  const moms = [
    "Aasvi's Mom", "Jaasvi & Twisha's Mom", "Navya and Geetu's Mom",
    "Nirav and Neeva's Mom", "Ruhi and Rihaan's Mom", "Shloka and Veda's Mom", "Yuvi and Yashi's Mom"
  ];
  const users = [
    'Aasvi', 'Arun', 'Geetu', 'Jaasvi', 'JP', 'Laxman', 'Navya', 'Neeva',
    'Nirav', 'Pramod', 'Rihaan', 'RK', 'Ruhi', 'Shashank', 'Shloka', 'Twisha', 'Veda', 'Vinay'
  ];

  const qCount = await query('SELECT COUNT(*) as c FROM questions');
  if (parseInt(qCount.rows[0].c) === 0) {
    for (const [text, tag, placeholder, sort_order] of questions) {
      await query('INSERT INTO questions (text,tag,placeholder,sort_order) VALUES ($1,$2,$3,$4)',
        [text, tag, placeholder, sort_order]);
    }
  }

  const momCount = await query('SELECT COUNT(*) as c FROM moms');
  if (parseInt(momCount.rows[0].c) === 0) {
    for (let i = 0; i < moms.length; i++) {
      await query('INSERT INTO moms (name,sort_order) VALUES ($1,$2)', [moms[i], i]);
    }
  }

  const userCount = await query('SELECT COUNT(*) as c FROM users');
  if (parseInt(userCount.rows[0].c) === 0) {
    for (let i = 0; i < users.length; i++) {
      await query('INSERT INTO users (name,sort_order) VALUES ($1,$2)', [users[i], i]);
    }
  }

  await query(`INSERT INTO settings (key,value) VALUES ('submissions_open','true') ON CONFLICT (key) DO NOTHING`);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      tag TEXT DEFAULT 'funny',
      placeholder TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS moms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      respondent_name TEXT NOT NULL,
      mom_id INTEGER REFERENCES moms(id),
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      is_complete BOOLEAN DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS answers (
      id SERIAL PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id),
      answer_text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await seedDefaults();
  console.log('✅ Database initialized');
}

async function getSetting(key) {
  const res = await query('SELECT value FROM settings WHERE key=$1', [key]);
  return res.rows[0]?.value ?? null;
}
async function setSetting(key, value) {
  await query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, String(value)]);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── PUBLIC API ──────────────────────────────────────────

app.get('/api/config', async (req, res) => {
  try {
    const questions = await query('SELECT * FROM questions ORDER BY sort_order, id');
    const moms = await query('SELECT * FROM moms ORDER BY sort_order, name');
    const users = await query('SELECT * FROM users ORDER BY sort_order, name');
    const open = await getSetting('submissions_open');
    res.json({ questions: questions.rows, moms: moms.rows, users: users.rows, submissionsOpen: open === 'true' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/check-user', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = await query(
    'SELECT id FROM cards WHERE LOWER(respondent_name)=LOWER($1) AND is_complete=true',
    [name.trim()]
  );
  res.json({ alreadySubmitted: r.rows.length > 0 });
});

app.post('/api/submit', async (req, res) => {
  const { respondentName, momId, answers } = req.body;
  if (!respondentName || !momId || !answers) return res.status(400).json({ error: 'Missing data' });

  const open = await getSetting('submissions_open');
  if (open !== 'true') return res.status(403).json({ error: 'Submissions are closed' });

  const existing = await query(
    'SELECT id FROM cards WHERE LOWER(respondent_name)=LOWER($1) AND is_complete=true',
    [respondentName.trim()]
  );
  if (existing.rows.length > 0) return res.status(409).json({ error: 'Already submitted' });

  const cardRes = await query(
    'INSERT INTO cards (respondent_name, mom_id, is_complete) VALUES ($1,$2,true) RETURNING id',
    [respondentName.trim(), parseInt(momId)]
  );
  const cardId = cardRes.rows[0].id;

  for (const [qId, text] of Object.entries(answers)) {
    if (text && text.trim()) {
      await query('INSERT INTO answers (card_id, question_id, answer_text) VALUES ($1,$2,$3)',
        [cardId, parseInt(qId), text.trim()]);
    }
  }
  res.json({ success: true });
});

// ── ADMIN API ───────────────────────────────────────────

function requireAdmin(req, res, next) {
  if ((req.headers['x-admin-pin'] || req.query.pin) !== ADMIN_PIN)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/admin/verify', (req, res) => {
  req.body.pin === ADMIN_PIN
    ? res.json({ success: true })
    : res.status(401).json({ error: 'Wrong PIN' });
});

app.get('/api/admin/cards', requireAdmin, async (req, res) => {
  const r = await query(`
    SELECT c.*, m.name as mom_name
    FROM cards c LEFT JOIN moms m ON c.mom_id=m.id
    WHERE c.is_complete=true ORDER BY c.submitted_at DESC
  `);
  res.json(r.rows);
});

// must be registered before /cards/:id to avoid route collision
app.get('/api/admin/cards/by-mom/:momId', requireAdmin, async (req, res) => {
  const cards = await query(`
    SELECT c.*, m.name as mom_name
    FROM cards c LEFT JOIN moms m ON c.mom_id=m.id
    WHERE c.mom_id=$1 AND c.is_complete=true ORDER BY c.submitted_at ASC
  `, [req.params.momId]);

  const result = await Promise.all(cards.rows.map(async card => {
    const ans = await query(`
      SELECT a.*, q.text as question_text, q.tag
      FROM answers a JOIN questions q ON a.question_id=q.id
      WHERE a.card_id=$1 ORDER BY q.sort_order
    `, [card.id]);
    return { ...card, answers: ans.rows };
  }));
  res.json(result);
});

app.get('/api/admin/cards/:id', requireAdmin, async (req, res) => {
  const card = await query(`
    SELECT c.*, m.name as mom_name FROM cards c LEFT JOIN moms m ON c.mom_id=m.id WHERE c.id=$1
  `, [req.params.id]);
  if (!card.rows.length) return res.status(404).json({ error: 'Not found' });
  const ans = await query(`
    SELECT a.*, q.text as question_text, q.tag
    FROM answers a JOIN questions q ON a.question_id=q.id
    WHERE a.card_id=$1 ORDER BY q.sort_order
  `, [req.params.id]);
  res.json({ ...card.rows[0], answers: ans.rows });
});

app.delete('/api/admin/cards/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM cards WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/admin/pending', requireAdmin, async (req, res) => {
  const users = await query('SELECT * FROM users ORDER BY sort_order, name');
  const submitted = await query('SELECT LOWER(respondent_name) as name FROM cards WHERE is_complete=true');
  const names = submitted.rows.map(r => r.name);
  res.json(users.rows.filter(u => !names.includes(u.name.toLowerCase())));
});

app.post('/api/admin/settings/submissions', requireAdmin, async (req, res) => {
  await setSetting('submissions_open', req.body.open);
  res.json({ success: true });
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  await query('DELETE FROM answers');
  await query('DELETE FROM cards');
  res.json({ success: true });
});

// Wipe all seed tables and reload defaults — use when questions/moms/users need refreshing
app.post('/api/admin/reseed', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM answers');
    await query('DELETE FROM cards');
    await query('DELETE FROM questions');
    await query('DELETE FROM moms');
    await query('DELETE FROM users');
    await seedDefaults();
    res.json({ success: true, message: 'Database cleared and reseeded with defaults' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Questions CRUD
app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  const r = await query('SELECT * FROM questions ORDER BY sort_order, id');
  res.json(r.rows);
});
app.post('/api/admin/questions', requireAdmin, async (req, res) => {
  const { text, tag, placeholder, sort_order } = req.body;
  const r = await query(
    'INSERT INTO questions (text,tag,placeholder,sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
    [text, tag || 'funny', placeholder || '', sort_order || 0]
  );
  res.json(r.rows[0]);
});
app.put('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  const { text, tag, placeholder, sort_order } = req.body;
  await query('UPDATE questions SET text=$1,tag=$2,placeholder=$3,sort_order=$4 WHERE id=$5',
    [text, tag || 'funny', placeholder || '', sort_order || 0, req.params.id]);
  res.json({ success: true });
});
app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM questions WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// Moms CRUD
app.get('/api/admin/moms', requireAdmin, async (req, res) => {
  res.json((await query('SELECT * FROM moms ORDER BY sort_order, name')).rows);
});
app.post('/api/admin/moms', requireAdmin, async (req, res) => {
  res.json((await query('INSERT INTO moms (name) VALUES ($1) RETURNING *', [req.body.name])).rows[0]);
});
app.put('/api/admin/moms/:id', requireAdmin, async (req, res) => {
  await query('UPDATE moms SET name=$1 WHERE id=$2', [req.body.name, req.params.id]);
  res.json({ success: true });
});
app.delete('/api/admin/moms/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM moms WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// Users CRUD
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  res.json((await query('SELECT * FROM users ORDER BY sort_order, name')).rows);
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  res.json((await query('INSERT INTO users (name) VALUES ($1) RETURNING *', [req.body.name])).rows[0]);
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => {
  app.listen(PORT, () => console.log(`✅ Mother's Day Card App running on port ${PORT}`));
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});
