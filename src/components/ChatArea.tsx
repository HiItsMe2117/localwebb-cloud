import { useEffect, useRef } from 'react';
import { Shield, Database, MessageSquare } from 'lucide-react';
import InvestigationSteps from './InvestigationSteps';
import type { ChatMessage } from '../types';
import { getFileUrl } from '../utils/files';

interface ChatAreaProps {
  messages: ChatMessage[];
  onSuggestedQuery: (query: string) => void;
}

const SUGGESTED_QUERIES = [
  'Who are the key individuals connected to this network?',
  'What financial transactions appear suspicious?',
  'Summarize the timeline of events from the documents',
];

export default function ChatArea({ messages, onSuggestedQuery }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const welcomeScreen = (
    <div className="flex-1 overflow-y-auto flex items-center justify-center p-8">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 bg-[#1C1C1E] rounded-full flex items-center justify-center mx-auto mb-6 border border-[rgba(84,84,88,0.65)]">
          <MessageSquare size={32} className="text-[rgba(235,235,245,0.3)]" />
        </div>
        <h2 className="text-[22px] font-bold tracking-tight text-white mb-2">Investigation Chat</h2>
        <p className="text-[rgba(235,235,245,0.6)] text-[15px] max-w-sm mx-auto leading-relaxed mb-8">
          This is your direct line to the AI analysis engine. Start by asking a question below.
        </p>
        <div className="grid grid-cols-1 gap-3">
          {SUGGESTED_QUERIES.slice(0, 3).map((q, i) => (
            <button
              key={i}
              onClick={() => onSuggestedQuery(q)}
              className="text-center text-[15px] text-[rgba(235,235,245,0.6)] hover:text-white bg-[#1C1C1E] hover:bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-2xl px-5 py-3 transition-all active:scale-[0.98]"
            >
              <span>{q}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto bg-black">
      {messages.length === 0 ? welcomeScreen : (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-1.5">
          {messages.map((msg, index) => {
            const isUser = msg.role === 'user';
            const prevMessageIsSameSender = index > 0 && messages[index - 1].role === msg.role;

            return (
              <div
                key={msg.id}
                className={`flex items-end gap-2 ${isUser ? 'justify-end' : 'justify-start'} ${prevMessageIsSameSender ? '' : 'mt-4'}`}
              >
                {!isUser && (
                  <div className={`w-7 h-7 rounded-full bg-[#1C1C1E] flex items-center justify-center border border-[rgba(84,84,88,0.65)] self-end ${prevMessageIsSameSender ? 'opacity-0' : ''}`}>
                    <Shield size={14} className="text-[rgba(235,235,245,0.3)]" />
                  </div>
                )}

                <div
                  className={`px-4 py-2.5 text-[15px] leading-relaxed ${
                    isUser
                      ? 'max-w-[75%] bg-[#007AFF] text-white rounded-[20px] rounded-br-[6px]'
                      : msg.isInvestigation
                        ? 'max-w-[90%] bg-[#1C1C1E] text-[rgba(255,255,255,0.92)] rounded-2xl border border-[rgba(84,84,88,0.65)]'
                        : 'max-w-[75%] bg-[#2C2C2E] text-[rgba(255,255,255,0.92)] rounded-[20px] rounded-bl-[6px]'
                  }`}
                >
                  {/* Investigation step cards */}
                  {msg.isInvestigation && msg.steps && msg.steps.length > 0 && (
                    <InvestigationSteps steps={msg.steps} />
                  )}

                  {msg.content ? (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  ) : (
                    <div className="flex items-center gap-1.5 py-1">
                      <div className="w-2 h-2 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce [animation-delay:-0.3s]" />
                      <div className="w-2 h-2 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce [animation-delay:-0.15s]" />
                      <div className="w-2 h-2 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce" />
                    </div>
                  )}

                  {msg.error && (
                    <div className="mt-2 p-2 bg-[#FF453A]/10 border border-[#FF453A]/20 text-[#FF453A] text-[13px] rounded-xl">
                      {msg.error}
                    </div>
                  )}

                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-[rgba(84,84,88,0.65)] flex flex-col gap-2">
                      <span className="text-[11px] font-semibold text-[rgba(235,235,245,0.6)] flex items-center gap-2">
                        <Database size={12} /> Sources
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.sources.map((source: any, idx: number) => (
                          <a
                            key={idx}
                            href={getFileUrl(source.filename, source.page)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] bg-[#3A3A3C] hover:bg-[#48484A] text-[rgba(235,235,245,0.6)] px-2 py-0.5 rounded-lg cursor-pointer transition-colors hover:underline"
                          >
                            {idx + 1}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Follow-up questions */}
                  {msg.followUpQuestions && msg.followUpQuestions.length > 0 && !msg.isStreaming && (
                    <div className="mt-3 pt-3 border-t border-[rgba(84,84,88,0.65)]">
                      <span className="text-[11px] font-semibold text-[rgba(235,235,245,0.6)] block mb-2">Dig Deeper</span>
                      <div className="flex flex-col gap-1.5">
                        {msg.followUpQuestions.map((q, idx) => (
                          <button
                            key={idx}
                            onClick={() => onSuggestedQuery(q)}
                            className="text-left text-[13px] text-[#007AFF] hover:text-[#0A84FF] bg-[#007AFF]/10 hover:bg-[#007AFF]/20 rounded-xl px-3 py-2 transition-colors"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
