-- Issue #74: Parent/Child-Relationen zwischen Tasks

CREATE TABLE IF NOT EXISTS task_relations (
  id SERIAL PRIMARY KEY,
  parent_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation_type VARCHAR(20) NOT NULL DEFAULT 'parent_child'
    CHECK (relation_type IN ('parent_child', 'relates_to')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (parent_task_id, child_task_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_task_relations_parent ON task_relations(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_relations_child ON task_relations(child_task_id);
