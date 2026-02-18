import { useEffect, useRef } from 'react';
import { Search, ChevronRight, Shield, Clock, Database } from 'lucide-react';
import type { ChatMessage } from '../types';

interface ChatAreaProps {
  messages: ChatMessage[];
  onSuggestedQuery: (query: string) => void;
}

const SUGGESTED_QUERIES = [
  'Who are the key individuals connected to this network?',
  'What financial transactions appear suspicious?',
  'Show connections between organizations and locations',
  'Summarize the timeline of events from the documents',
];

export default function ChatArea({ messages, onSuggestedQuery }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto flex items-center justify-center p-8">
        <div className="max-w-xl w-full text-center space-y-10">
          <div className="flex flex-col items-center">
            <div className="w-16 h-16 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl flex items-center justify-center shadow-2xl shadow-blue-500/20 mb-6 border border-white/10">
              <Shield size={32} className="text-white" />
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-white mb-3">Investigation Engine</h2>
            <p className="text-zinc-500 text-sm max-w-sm mx-auto leading-relaxed">
              Explore your documents through the lens of GraphRAG. Analyze connections, track timelines, and uncover hidden patterns.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <span className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-2">Suggested Investigations</span>
            {SUGGESTED_QUERIES.map((q, i) => (
              <button
                key={i}
                onClick={() => onSuggestedQuery(q)}
                className="group text-left text-sm text-zinc-400 hover:text-white bg-zinc-900/50 hover:bg-zinc-800 border border-zinc-800/50 hover:border-zinc-700 rounded-xl px-5 py-3.5 transition-all flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <Search size={16} className="text-zinc-600 group-hover:text-blue-400 shrink-0" />
                  <span>{q}</span>
                </div>
                <ChevronRight size={14} className="text-zinc-700 group-hover:text-zinc-400" />
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8 space-y-8">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex flex-col gap-3 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className="flex items-center gap-2 mb-1">
               {msg.role === 'assistant' && (
                 <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center border border-white/10">
                   <Shield size={12} className="text-white" />
                 </div>
               )}
               <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                 {msg.role === 'user' ? 'Lead Investigator' : 'Intelligence Agent'}
               </span>
               <span className="text-[10px] text-zinc-700 flex items-center gap-1 font-mono">
                 <Clock size={10} /> {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
               </span>
            </div>

            <div 
              className={`max-w-[85%] px-5 py-4 rounded-2xl text-sm leading-relaxed shadow-sm ${
                msg.role === 'user' 
                  ? 'bg-blue-600 text-white rounded-tr-none' 
                  : 'bg-zinc-900 text-zinc-200 border border-zinc-800/50 rounded-tl-none'
              }`}
            >
              {msg.content ? (
                <div className="whitespace-pre-wrap">{msg.content}</div>
              ) : (
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                  <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                  <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" />
                </div>
              )}

              {msg.error && (
                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg">
                  {msg.error}
                </div>
              )}

              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-4 pt-4 border-t border-zinc-800 flex flex-col gap-2">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                    <Database size={10} /> Verified Sources
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {msg.sources.map((_: any, idx: number) => (
                      <span 
                        key={idx} 
                        className="text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-400 px-2.5 py-1 rounded-md cursor-help border border-zinc-700/50 transition-colors"
                      >
                        Source {idx + 1}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
