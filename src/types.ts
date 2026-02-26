export interface Source {
  filename: string;
  page: number | string;
  score: number | null;
}

export interface Community {
  id: number;
  color: string;
  members: string[];
  size: number;
}

export interface InvestigationStep {
  step: string;
  label: string;
  status: 'running' | 'done' | 'skipped' | 'error';
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  timestamp: number;
  isStreaming: boolean;
  error?: string;
  isInvestigation?: boolean;
  steps?: InvestigationStep[];
  followUpQuestions?: string[];
}

export interface ScanFinding {
  title: string;
  category: string;
  summary: string;
  confidence: number;
  entity_ids: string[];
  suggested_questions: string[];
  sources?: { filename: string; page: number | string }[];
}

export interface Case {
  id: string;
  title: string;
  category: string;
  summary: string;
  status: 'proposed' | 'active' | 'closed';
  confidence: number;
  entities: string[];
  suggested_questions: string[];
  created_at: string;
  updated_at: string;
}

export interface CaseEvidence {
  id: string;
  case_id: string;
  type: 'investigation' | 'note' | 'fact_check';
  content: string;
  sources: { filename: string; page: number | string; score: number }[] | null;
  created_at: string;
}

export const CASE_CATEGORIES: Record<string, { label: string; color: string }> = {
  money_laundering: { label: 'Money Laundering', color: '#FF9F0A' },
  fraud:            { label: 'Fraud',            color: '#FF453A' },
  trafficking:      { label: 'Trafficking',      color: '#AF52DE' },
  tax_evasion:      { label: 'Tax Evasion',      color: '#30D158' },
  obstruction:      { label: 'Obstruction',      color: '#5AC8FA' },
  other:            { label: 'Other',            color: '#8E8E93' },
};

export const DOC_TYPES = [
  { value: '', label: 'All Documents' },
  { value: 'flight_log', label: 'Flight Logs' },
  { value: 'deposition', label: 'Depositions' },
  { value: 'financial_record', label: 'Financial Records' },
  { value: 'correspondence', label: 'Correspondence' },
  { value: 'legal_filing', label: 'Legal Filings' },
  { value: 'report', label: 'Reports' },
  { value: 'other', label: 'Other' },
];
