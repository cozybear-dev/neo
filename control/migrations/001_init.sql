CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('fast','thorough')),
  objective TEXT NOT NULL,
  allowlist TEXT[] NOT NULL,
  denylist TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_memory (
  task_id UUID PRIMARY KEY REFERENCES tasks(id),
  insights JSONB NOT NULL DEFAULT '[]',
  facts JSONB NOT NULL DEFAULT '[]',
  todos JSONB NOT NULL DEFAULT '[]',
  files JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unverified','confirmed','open','false_positive')),
  host TEXT,
  evidence_paths TEXT[] NOT NULL DEFAULT '{}',
  reproduction TEXT,
  verdict TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
