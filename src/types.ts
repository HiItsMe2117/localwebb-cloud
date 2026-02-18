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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  timestamp: number;
  isStreaming: boolean;
  error?: string;
}

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
