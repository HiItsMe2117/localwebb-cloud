import { useState, useRef, useEffect } from 'react';
import {
  ArrowLeft, Check, X, ChevronDown, AlertTriangle, HelpCircle,
  FlaskConical, ArrowUp, Loader2, MessageSquare, Network, FileText, Share2, Globe, Database
} from 'lucide-react';
import type { TheorySession, TheoryEntitySuggestion, Source } from '../types';
import { getFileUrl } from '../utils/files';
import CaseNetworkMap from './CaseNetworkMap';

interface TheoryInvestigationProps {
  session: TheorySession;
  onBack: () => void;
  onSendFollowUp: (message: string, mode: 'files_only' | 'files_web') => void;
  isFollowUpStreaming: boolean;
  onAcceptAsCase: () => void;
  onDismiss: () => void;
  onAddEntity: (entity: TheoryEntitySuggestion) => void;
  readOnly?: boolean;
}

const VERDICT_CONFIG: Record<string, { label: string; color: string; icon: typeof Check }> = {
  supported:           { label: 'Supported',           color: '#30D158', icon: Check },
  partially_supported: { label: 'Partially Supported', color: '#FF9F0A', icon: AlertTriangle },
  inconclusive:        { label: 'Inconclusive',        color: '#8E8E93', icon: HelpCircle },
  contradicted:        { label: 'Contradicted',        color: '#FF453A', icon: X },
};

export default function TheoryInvestigation({
  session,
  onBack,
  onSendFollowUp,
  isFollowUpStreaming,
  onAcceptAsCase,
  onDismiss,
  onAddEntity,
  readOnly = false,
}: TheoryInvestigationProps) {
  const [reportExpanded, setReportExpanded] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [activeTab, setActiveTab] = useState<'investigation' | 'network'>('investigation');
  const [mode, setMode] = useState<'files_only' | 'files_web'>('files_only');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { result, followUpMessages } = session;
  const verdict = result.verdict;
  const config = verdict ? (VERDICT_CONFIG[verdict.verdict] || VERDICT_CONFIG.inconclusive) : VERDICT_CONFIG.inconclusive;
  const VerdictIcon = config.icon;
  const pct = verdict ? Math.round(verdict.confidence * 100) : 0;

  const onGraphEntities = result.entitySuggestions.filter(e => e.on_graph);
  const offGraphEntities = result.entitySuggestions.filter(e => !e.on_graph);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [followUpMessages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [inputValue]);

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text || isFollowUpStreaming) return;
    setInputValue('');
    onSendFollowUp(text, mode);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="shrink-0 px-5 pt-4 pb-3 bg-black border-b border-[rgba(84,84,88,0.65)]">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="w-8 h-8 rounded-full bg-[#2C2C2E] flex items-center justify-center hover:bg-[#3A3A3C] transition-colors"
          >
            <ArrowLeft size={16} className="text-[rgba(235,235,245,0.6)]" />
          </button>
          <div className="flex items-center gap-2">
            <FlaskConical size={16} className="text-[#AF52DE]" />
            <h1 className="text-[17px] font-semibold text-white">Theory Investigation</h1>
          </div>
        </div>
      </header>

      {/* Tab bar — only show when inside a case */}
      {session.attachedCaseId && (
        <div className="shrink-0 flex bg-black border-b border-[rgba(84,84,88,0.65)]">
          <button
            onClick={() => setActiveTab('investigation')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold transition-colors relative ${
              activeTab === 'investigation'
                ? 'text-[#AF52DE]'
                : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
            }`}
          >
            <FileText size={14} />
            Investigation
            {activeTab === 'investigation' && (
              <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#AF52DE] rounded-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('network')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold transition-colors relative ${
              activeTab === 'network'
                ? 'text-[#AF52DE]'
                : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
            }`}
          >
            <Share2 size={14} />
            Network Map
            {activeTab === 'network' && (
              <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#AF52DE] rounded-full" />
            )}
          </button>
        </div>
      )}

      {/* Network Map tab */}
      {activeTab === 'network' && session.attachedCaseId ? (
        <CaseNetworkMap caseId={session.attachedCaseId} readOnly={readOnly} />
      ) : (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-4 space-y-4">
          {/* Theory + Verdict Summary */}
          <div className="bg-[#1C1C1E] border border-[#AF52DE]/30 rounded-2xl p-4 space-y-3">
            <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed">
              <span className="text-[#AF52DE] font-semibold">Theory:</span> {session.theory}
            </p>

            {verdict && (
              <>
                <div className="flex items-center gap-3">
                  <span
                    className="flex items-center gap-1 text-[13px] font-bold px-2.5 py-0.5 rounded-full"
                    style={{ backgroundColor: config.color + '20', color: config.color }}
                  >
                    <VerdictIcon size={12} />
                    {config.label}
                  </span>
                  <span className="text-[11px] font-mono" style={{ color: config.color }}>{pct}%</span>
                  <div className="flex items-center gap-4 ml-auto">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-[#30D158] font-medium">{verdict.supporting_count}</span>
                      <span className="text-[10px] text-[rgba(235,235,245,0.3)]">supporting</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-[#FF453A] font-medium">{verdict.contradicting_count}</span>
                      <span className="text-[10px] text-[rgba(235,235,245,0.3)]">contradicting</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Entity Suggestions */}
          {result.entitySuggestions.length > 0 && (
            <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4 space-y-3">
              <h3 className="text-[13px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider flex items-center gap-2">
                <Network size={12} />
                Entity Suggestions
              </h3>

              {onGraphEntities.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {onGraphEntities.map((ent) => (
                    <button
                      key={ent.name}
                      onClick={() => onAddEntity(ent)}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-full bg-[#30D158]/15 text-[#30D158] border border-[#30D158]/20 hover:bg-[#30D158]/25 transition-colors"
                      title={`On graph · ${ent.edge_count} connections · ${ent.type}`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[#30D158]" />
                      {ent.name}
                      {ent.edge_count > 0 && (
                        <span className="text-[10px] text-[#30D158]/60">{ent.edge_count}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {offGraphEntities.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {offGraphEntities.map((ent) => (
                    <span
                      key={ent.name}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-full bg-[#FF9F0A]/10 text-[#FF9F0A] border border-[#FF9F0A]/20"
                      title="Discovered in documents — not yet in knowledge graph"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[#FF9F0A]/60" />
                      {ent.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Claims */}
          {verdict && verdict.claims.length > 0 && (
            <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4 space-y-2.5">
              <h3 className="text-[13px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider">
                Claims
              </h3>
              {verdict.claims.map((claim, i) => {
                const claimConfig = VERDICT_CONFIG[claim.finding] || VERDICT_CONFIG.inconclusive;
                return (
                  <div key={i} className="flex items-start gap-2 text-[12px]">
                    <span className="w-5 text-right text-[rgba(235,235,245,0.3)] shrink-0 mt-0.5">{i + 1}.</span>
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
                      style={{ backgroundColor: claimConfig.color }}
                    />
                    <span className="text-[rgba(235,235,245,0.6)] flex-1 leading-relaxed">{claim.text}</span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                      style={{ backgroundColor: claimConfig.color + '15', color: claimConfig.color }}
                    >
                      {claimConfig.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Full Report (collapsible) */}
          {result.reportText && (
            <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl overflow-hidden">
              <button
                onClick={() => setReportExpanded(!reportExpanded)}
                className="w-full flex items-center gap-2 px-4 py-3 text-[13px] text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)] transition-colors"
              >
                <ChevronDown size={12} className={`transition-transform ${reportExpanded ? 'rotate-180' : ''}`} />
                {reportExpanded ? 'Hide Full Report' : 'Show Full Report'}
                {result.sources.length > 0 && (
                  <span className="text-[10px] text-[rgba(235,235,245,0.2)] ml-auto">
                    {result.sources.length} sources
                  </span>
                )}
              </button>
              {reportExpanded && (
                <div className="px-4 pb-4 border-t border-[rgba(84,84,88,0.35)]">
                  <div className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed whitespace-pre-wrap max-h-[500px] overflow-y-auto mt-3">
                    {result.reportText}
                  </div>
                  {result.sources.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-[rgba(84,84,88,0.35)]">
                      <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] mb-1.5 block flex items-center gap-1.5">
                        <Database size={10} /> Document Sources
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {result.sources.map((source: Source, idx: number) => (
                          <a
                            key={idx}
                            href={getFileUrl(source.filename, source.page)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`${source.filename} (p. ${source.page})`}
                            className="text-[10px] bg-[#2C2C2E] hover:bg-[#3A3A3C] text-[rgba(235,235,245,0.5)] px-1.5 py-0.5 rounded transition-colors cursor-pointer hover:underline"
                          >
                            {idx + 1}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.webSources && result.webSources.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-[rgba(84,84,88,0.35)]">
                      <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] mb-1.5 block flex items-center gap-1.5">
                        <Globe size={10} /> Web Sources
                      </span>
                      <div className="flex flex-col gap-1">
                        {result.webSources.map((source, idx) => (
                          <a
                            key={idx}
                            href={source.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-[#0A84FF] hover:underline flex items-center gap-2 truncate"
                          >
                            <span className="shrink-0 text-[10px] bg-[#0A84FF]/10 px-1.5 py-0.5 rounded text-[#0A84FF] font-mono">{idx + 1}</span>
                            <span className="truncate">{source.title || source.domain}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Follow-up Conversation */}
          {followUpMessages.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-[13px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider flex items-center gap-2">
                <MessageSquare size={12} />
                Follow-up
              </h3>
              {followUpMessages.map((msg) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={msg.id}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`px-3 py-2 text-[13px] leading-relaxed ${
                        isUser
                          ? 'max-w-[85%] bg-[#007AFF] text-white rounded-[18px] rounded-br-[4px]'
                          : 'max-w-[95%] bg-[#2C2C2E] text-[rgba(255,255,255,0.92)] rounded-[18px] rounded-bl-[4px] border border-[rgba(84,84,88,0.65)]'
                      }`}
                    >
                      {msg.content ? (
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                      ) : msg.isStreaming ? (
                        <div className="flex items-center gap-1.5 py-1">
                          <div className="w-1.5 h-1.5 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce [animation-delay:-0.3s]" />
                          <div className="w-1.5 h-1.5 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce [animation-delay:-0.15s]" />
                          <div className="w-1.5 h-1.5 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce" />
                        </div>
                      ) : null}

                      {msg.sources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-[rgba(84,84,88,0.35)] flex flex-wrap gap-1">
                          {msg.sources.map((source, idx) => (
                            <a
                              key={idx}
                              href={getFileUrl(source.filename, source.page)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`${source.filename} (p. ${source.page})`}
                              className="text-[10px] bg-[#3A3A3C] hover:bg-[#48484A] text-[rgba(235,235,245,0.5)] px-1.5 py-0.5 rounded transition-colors cursor-pointer hover:underline"
                            >
                              {idx + 1}
                            </a>
                          ))}
                        </div>
                      )}

                      {msg.webSources && msg.webSources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-[rgba(84,84,88,0.35)] flex flex-col gap-1">
                          {msg.webSources.map((source, idx) => (
                            <a
                              key={idx}
                              href={source.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-[#0A84FF] hover:underline flex items-center gap-2 truncate"
                            >
                              <span className="shrink-0 text-[10px] bg-[#0A84FF]/10 px-1.5 py-0.5 rounded text-[#0A84FF] font-mono">{idx + 1}</span>
                              <span className="truncate">{source.title || source.domain}</span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Suggested follow-up questions */}
          {!isFollowUpStreaming && verdict && verdict.suggested_questions.length > 0 && followUpMessages.length === 0 && (
            <div className="space-y-2">
              <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-medium">Suggested follow-ups</span>
              <div className="flex flex-wrap gap-2">
                {verdict.suggested_questions.slice(0, 4).map((q, i) => (
                  <button
                    key={i}
                    onClick={() => onSendFollowUp(q, mode)}
                    className="text-[12px] text-[rgba(235,235,245,0.5)] bg-[#2C2C2E] hover:bg-[#3A3A3C] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-2 transition-colors text-left leading-relaxed"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
      )}

      {/* Bottom input + actions */}
      <div className="shrink-0 border-t border-[rgba(84,84,88,0.65)] bg-black">
        {/* Mode Toggle */}
        {!readOnly && (
          <div className="flex justify-center pt-3">
            <div className="inline-flex bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-lg p-0.5">
              <button
                onClick={() => setMode('files_only')}
                className={`flex items-center gap-1 px-3 py-0.5 rounded-md text-[10px] font-medium transition-all ${
                  mode === 'files_only'
                    ? 'bg-[#3A3A3C] text-white shadow-sm'
                    : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                }`}
              >
                <Database size={10} />
                Files Only
              </button>
              <button
                onClick={() => setMode('files_web')}
                className={`flex items-center gap-1 px-3 py-0.5 rounded-md text-[10px] font-medium transition-all ${
                  mode === 'files_web'
                    ? 'bg-[#AF52DE]/20 text-[#AF52DE] shadow-sm'
                    : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                }`}
              >
                <Globe size={10} />
                Files + Web
              </button>
            </div>
          </div>
        )}

        {/* Input area */}
        {!readOnly && (
          <div className="px-4 pt-2 pb-2">
            <div className="relative flex items-end gap-2 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-2xl px-3 py-1.5 focus-within:border-[#AF52DE]/40 transition-all">
              <textarea
                ref={textareaRef}
                rows={1}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a follow-up question..."
                className="flex-1 bg-transparent text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] resize-none focus:outline-none min-h-[28px] max-h-[120px] py-1"
              />
              <button
                onClick={handleSend}
                disabled={!inputValue.trim() || isFollowUpStreaming}
                className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                  inputValue.trim() && !isFollowUpStreaming
                    ? 'bg-[#AF52DE] text-white active:scale-90'
                    : 'bg-[#3A3A3C] text-[rgba(235,235,245,0.2)]'
                }`}
              >
                {isFollowUpStreaming ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}
              </button>
            </div>
          </div>
        )}

        {/* Action buttons */}
        {!readOnly && (
          <div className="flex items-center gap-2 px-4 pb-3">
            <button
              onClick={onAcceptAsCase}
              className="flex-1 flex items-center justify-center gap-2 bg-[#30D158]/20 hover:bg-[#30D158]/30 border border-[#30D158]/30 text-[#30D158] px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors"
            >
              <Check size={14} />
              {session.attachedCaseId ? 'Save to Case' : 'Accept as Case'}
            </button>
            <button
              onClick={onDismiss}
              className="flex items-center justify-center gap-2 bg-[#2C2C2E] hover:bg-[#3A3A3C] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.5)] px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
            >
              <X size={14} />
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
