-- Add bp_paused flag to agent_status so users can pause Bigger Picture auto-synthesis
ALTER TABLE agent_status ADD COLUMN bp_paused BOOLEAN DEFAULT false;
