ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','unavailable','cancelled'));
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS outcome JSONB;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS task_runs_active_idx ON task_runs(task_id,status);
