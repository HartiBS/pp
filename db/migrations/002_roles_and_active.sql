ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT 'entwickler'
  CHECK (role IN ('admin', 'projektmanager', 'entwickler', 'beobachter'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE users
SET role = 'admin'
WHERE id = (SELECT MIN(id) FROM users);
