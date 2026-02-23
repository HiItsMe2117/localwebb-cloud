import { Search, Network, GitBranch, BookOpen, FileSearch, PenTool, Loader2, Check, X } from 'lucide-react';
import type { InvestigationStep } from '../types';

const STEP_CONFIG: Record<string, { icon: typeof Search; color: string }> = {
  query_analysis: { icon: Search, color: '#007AFF' },
  entity_intel: { icon: Network, color: '#AF52DE' },
  graph_traversal: { icon: GitBranch, color: '#5AC8FA' },
  semantic_search: { icon: BookOpen, color: '#FF9F0A' },
  keyword_search: { icon: FileSearch, color: '#30D158' },
  synthesis: { icon: PenTool, color: '#FF453A' },
};

interface InvestigationStepsProps {
  steps: InvestigationStep[];
}

export default function InvestigationSteps({ steps }: InvestigationStepsProps) {
  if (steps.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {steps.map((step) => {
        const config = STEP_CONFIG[step.step] || { icon: Search, color: '#8E8E93' };
        const Icon = config.icon;
        const isRunning = step.status === 'running';
        const isDone = step.status === 'done';
        const isError = step.status === 'error';

        return (
          <div
            key={step.step}
            className="flex items-center gap-2 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-2 text-[13px] transition-all"
            style={{ borderColor: isError ? '#FF453A60' : isRunning ? config.color + '60' : undefined }}
          >
            <div
              className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: isError ? '#FF453A20' : config.color + '20' }}
            >
              {isRunning ? (
                <Loader2 size={14} className="animate-spin" style={{ color: config.color }} />
              ) : isError ? (
                <X size={14} style={{ color: '#FF453A' }} />
              ) : isDone ? (
                <Check size={14} style={{ color: config.color }} />
              ) : (
                <Icon size={14} style={{ color: config.color + '80' }} />
              )}
            </div>
            <div className="flex flex-col min-w-0">
              <span className={`font-medium truncate ${isError ? 'text-[#FF453A]' : isDone ? 'text-[rgba(235,235,245,0.6)]' : 'text-white'}`}>
                {step.label}
              </span>
              {step.detail && (
                <span className={`text-[11px] truncate max-w-[200px] ${isError ? 'text-[#FF453A99]' : 'text-[rgba(235,235,245,0.3)]'}`}>
                  {step.detail}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
