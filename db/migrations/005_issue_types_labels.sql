ALTER TABLE tasks ADD COLUMN IF NOT EXISTS issue_type VARCHAR(50) NOT NULL DEFAULT 'task'
  CHECK (issue_type IN ('epic', 'user_story', 'task', 'bug'));

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS epic_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(issue_type);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epic_id);
