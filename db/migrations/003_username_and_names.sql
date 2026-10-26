ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);

UPDATE users
SET first_name = split_part(name, ' ', 1),
    last_name = NULLIF(trim(substr(name, position(' ' in name) + 1)), ''),
    username = lower(regexp_replace(email, '@.*$', ''))
WHERE username IS NULL;

UPDATE users u
SET username = u.username || u.id
WHERE EXISTS (SELECT 1 FROM users u2 WHERE u2.id <> u.id AND u2.username = u.username);

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
