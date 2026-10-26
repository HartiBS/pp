require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`DB not ready (${err.code || err.message}), retry ${i + 1}/${retries}...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('Database not reachable after retries');
}

async function migrate() {
  await waitForDb();
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.join(__dirname, '..', '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rows } = await db.query('SELECT 1 FROM migrations WHERE name = $1', [file]);
    if (rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`Running migration: ${file}`);
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      console.error(`Migration failed: ${file}`, err);
      process.exit(1);
    }
  }

  console.log('All migrations executed.');
  process.exit(0);
}

migrate();
