require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
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
