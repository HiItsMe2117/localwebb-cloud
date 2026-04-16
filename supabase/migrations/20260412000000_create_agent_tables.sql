-- Autonomous investigation agent tables + hierarchical cases

-- 1. Hierarchical cases: add parent_case_id, depth, operational_question
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS parent_case_id UUID REFERENCES cases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS depth INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS operational_question TEXT;

CREATE INDEX IF NOT EXISTS idx_cases_parent ON cases (parent_case_id);

-- 2. Agent task queue
CREATE TABLE agent_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,          -- investigate_entity, test_theory, explore_connection,
                                 -- validate_existing, expand_branch, user_directive
    description TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,  -- 1=highest
    status TEXT NOT NULL DEFAULT 'queued', -- queued, in_progress, completed, failed
    parent_task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
    case_id UUID REFERENCES cases(id) ON DELETE SET NULL,
    result_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_agent_tasks_status ON agent_tasks (status);
CREATE INDEX idx_agent_tasks_priority ON agent_tasks (priority ASC, created_at ASC);
CREATE INDEX idx_agent_tasks_case ON agent_tasks (case_id);

-- 3. Agent memory (prevents re-investigating the same things)
CREATE TABLE agent_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_type TEXT NOT NULL,   -- investigated_entity, tested_theory, searched_query,
                                 -- explored_connection, validated_edge
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,  -- for fast duplicate detection
    outcome TEXT,
    case_id UUID REFERENCES cases(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_agent_memory_hash ON agent_memory (memory_type, content_hash);
CREATE INDEX idx_agent_memory_type ON agent_memory (memory_type);

-- 4. Agent activity log (feeds mission control UI)
CREATE TABLE agent_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action TEXT NOT NULL,        -- started_task, completed_task, found_connection,
                                 -- created_case, added_entity, tested_theory,
                                 -- opened_lead, error
    description TEXT NOT NULL,
    task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
    case_id UUID REFERENCES cases(id) ON DELETE SET NULL,
    entity_ids TEXT[],
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agent_activity_created ON agent_activity (created_at DESC);
CREATE INDEX idx_agent_activity_action ON agent_activity (action);
CREATE INDEX idx_agent_activity_case ON agent_activity (case_id);

-- 5. Agent status (singleton row for current agent state)
CREATE TABLE agent_status (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
    is_running BOOLEAN DEFAULT false,
    current_task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
    tasks_completed INTEGER DEFAULT 0,
    theories_tested INTEGER DEFAULT 0,
    entities_added INTEGER DEFAULT 0,
    cases_created INTEGER DEFAULT 0,
    last_heartbeat TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    paused_at TIMESTAMPTZ
);

INSERT INTO agent_status (id) VALUES (1);
