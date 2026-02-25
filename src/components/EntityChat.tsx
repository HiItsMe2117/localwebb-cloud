import { useState, useRef, useEffect } from 'react';
import { Shield, Database, MessageSquare, Loader2, ArrowUp } from 'lucide-react';
import type { ChatMessage, Source } from '../types';
import InvestigationSteps from './InvestigationSteps';
import { getFileUrl } from '../utils/files';

interface EntityChatProps {
  entityId: string;
  entityName: string;
}

export default function EntityChat({ entityId, entityName }: EntityChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [inputValue]);

  const sendQuery = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      sources: [],
      timestamp: Date.now(),
      isStreaming: false,
    };

    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      sources: [],
      timestamp: Date.now(),
      isStreaming: true,
      isInvestigation: true,
      steps: [],
      followUpQuestions: [],
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInputValue('');
    setIsStreaming(true);

    try {
      const res = await fetch('/api/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          query: text,
          entity_id: entityId 
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let finalSources: any[] = [];
      let followUps: string[] = [];
      const stepsMap = new Map<string, any>();

      const processLines = (lines: string[]) => {
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            const eventType = data.type;

            if (eventType === 'step_status') {
              stepsMap.set(data.step, { step: data.step, label: data.label, status: data.status, detail: data.detail });
              const steps = Array.from(stepsMap.values());
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, steps } : m
              ));
            } else if (eventType === 'text' || (!eventType && data.text)) {
              fullText += data.text;
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: fullText } : m
              ));
            } else if (eventType === 'sources' || (!eventType && data.sources)) {
              finalSources = data.sources;
            } else if (eventType === 'follow_ups') {
              followUps = data.follow_ups || [];
            } else if (data.error) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, error: data.error, isStreaming: false } : m
              ));
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        processLines(lines);
      }

      if (buffer.trim()) {
        processLines(buffer.split('\n'));
      }

      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, isStreaming: false, sources: finalSources, content: fullText || m.content, followUpQuestions: followUps }
          : m
      ));
    } catch (err: any) {
      console.error(err);
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, error: `Analysis failed: ${err.message}`, isStreaming: false } : m
      ));
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputValue.trim() && !isStreaming) sendQuery(inputValue.trim());
    }
  };

  return (
    <div className="flex flex-col h-[500px] bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl overflow-hidden mt-4">
      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 bg-[#2C2C2E] rounded-full flex items-center justify-center mb-4">
              <MessageSquare size={24} className="text-[rgba(235,235,245,0.3)]" />
            </div>
            <h4 className="text-[17px] font-semibold text-white mb-1">Chat about {entityName}</h4>
            <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed">
              Ask specific questions about this entity's connections and document mentions.
            </p>
            <div className="grid grid-cols-1 gap-2 mt-6 w-full">
              {[
                `Who is ${entityName} connected to?`,
                `What are the key allegations involving ${entityName}?`,
                `Summarize all mentions of ${entityName}`
              ].map((q, i) => (
                <button
                  key={i}
                  onClick={() => sendQuery(q)}
                  className="text-[13px] text-[rgba(235,235,245,0.6)] hover:text-white bg-[#2C2C2E] hover:bg-[#3A3A3C] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 transition-all text-left"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isUser = msg.role === 'user';
            const prevMessageIsSameSender = index > 0 && messages[index - 1].role === msg.role;

            return (
              <div
                key={msg.id}
                className={`flex items-end gap-2 ${isUser ? 'justify-end' : 'justify-start'} ${prevMessageIsSameSender ? '' : 'mt-2'}`}
              >
                {!isUser && (
                  <div className={`w-6 h-6 rounded-full bg-[#2C2C2E] flex items-center justify-center border border-[rgba(84,84,88,0.65)] shrink-0 self-end ${prevMessageIsSameSender ? 'opacity-0' : ''}`}>
                    <Shield size={12} className="text-[rgba(235,235,245,0.3)]" />
                  </div>
                )}

                <div
                  className={`px-3 py-2 text-[14px] leading-relaxed ${
                    isUser
                      ? 'max-w-[85%] bg-[#007AFF] text-white rounded-[18px] rounded-br-[4px]'
                      : msg.isInvestigation
                        ? 'max-w-[95%] bg-[#2C2C2E] text-[rgba(255,255,255,0.92)] rounded-2xl border border-[rgba(84,84,88,0.65)]'
                        : 'max-w-[85%] bg-[#2C2C2E] text-[rgba(255,255,255,0.92)] rounded-[18px] rounded-bl-[4px]'
                  }`}
                >
                  {msg.isInvestigation && msg.steps && msg.steps.length > 0 && (
                    <div className="mb-2">
                      <InvestigationSteps steps={msg.steps} />
                    </div>
                  )}

                  {msg.content ? (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  ) : (
                    <div className="flex items-center gap-1.5 py-1">
                      <div className="w-1.5 h-1.5 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce [animation-delay:-0.3s]" />
                      <div className="w-1.5 h-1.5 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce [animation-delay:-0.15s]" />
                      <div className="w-1.5 h-1.5 bg-[rgba(235,235,245,0.3)] rounded-full animate-bounce" />
                    </div>
                  )}

                  {msg.error && (
                    <div className="mt-2 p-2 bg-[#FF453A]/10 border border-[#FF453A]/20 text-[#FF453A] text-[12px] rounded-lg">
                      {msg.error}
                    </div>
                  )}

                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-[rgba(84,84,88,0.65)] flex flex-col gap-1.5">
                      <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.4)] flex items-center gap-1.5">
                        <Database size={10} /> Sources
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {msg.sources.map((source: Source, idx: number) => (
                          <a
                            key={idx}
                            href={getFileUrl(source.filename, source.page)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`${source.filename} (p. ${source.page})`}
                            className="text-[10px] bg-[#3A3A3C] hover:bg-[#48484A] text-[rgba(235,235,245,0.6)] px-1.5 py-0.5 rounded transition-colors cursor-pointer hover:underline"
                          >
                            {idx + 1}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 bg-[#1C1C1E] border-t border-[rgba(84,84,88,0.65)]">
        <div className="relative flex items-end gap-2 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-2xl px-3 py-1.5 focus-within:border-[#007AFF]/40 transition-all">
          <textarea
            ref={textareaRef}
            rows={1}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Ask about ${entityName}...`}
            className="flex-1 bg-transparent text-[14px] text-white placeholder:text-[rgba(235,235,245,0.2)] resize-none focus:outline-none min-h-[28px] max-h-[120px] py-1"
          />
          <button
            onClick={() => sendQuery(inputValue.trim())}
            disabled={!inputValue.trim() || isStreaming}
            className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all ${
              inputValue.trim() && !isStreaming
                ? 'bg-[#007AFF] text-white active:scale-90'
                : 'bg-[#3A3A3C] text-[rgba(235,235,245,0.2)]'
            }`}
          >
            {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
