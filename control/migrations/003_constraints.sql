ALTER TABLE tasks ADD CONSTRAINT tasks_status_valid CHECK(status IN ('pending','running','completed','cancelled')) NOT VALID;
ALTER TABLE tasks ADD CONSTRAINT tasks_objective_valid CHECK(length(trim(objective)) BETWEEN 1 AND 16384) NOT VALID;
ALTER TABLE task_memory ADD CONSTRAINT memory_arrays_valid CHECK(jsonb_typeof(insights)='array' AND jsonb_typeof(facts)='array' AND jsonb_typeof(todos)='array' AND jsonb_typeof(files)='array') NOT VALID;
ALTER TABLE issues ADD CONSTRAINT issue_title_valid CHECK(length(trim(title)) BETWEEN 1 AND 16384) NOT VALID;
ALTER TABLE issues ADD CONSTRAINT issue_severity_valid CHECK(severity IN ('info','low','medium','high','critical')) NOT VALID;
ALTER TABLE issues ADD CONSTRAINT issue_task_required CHECK(task_id IS NOT NULL) NOT VALID;
CREATE INDEX IF NOT EXISTS issues_task_filters_idx ON issues(task_id,status,severity,created_at DESC);
