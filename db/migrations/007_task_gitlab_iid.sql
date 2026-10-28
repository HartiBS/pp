ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gitlab_iid INTEGER;

CREATE INDEX IF NOT EXISTS idx_tasks_gitlab_iid ON tasks(gitlab_iid);
