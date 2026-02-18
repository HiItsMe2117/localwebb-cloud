import { useEffect, useRef } from 'react';
import { Shield, Database, MessageSquare } from 'lucide-react';
import type { ChatMessage } from '../types';

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
        <div className="w-16 h-16 bg-zinc-800/50 rounded-full flex items-center justify-center mx-auto mb-6 border border-zinc-700/50">
          <MessageSquare size={32} className="text-zinc-500" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-white mb-2">Investigation Chat</h2>
        <p className="text-zinc-500 text-sm max-w-sm mx-auto leading-relaxed mb-8">
          This is your direct line to the AI analysis engine. Start by asking a question below.
        </p>
        <div className="grid grid-cols-1 gap-3">
          {SUGGESTED_QUERIES.slice(0, 3).map((q, i) => (
            <button
              key={i}
              onClick={() => onSuggestedQuery(q)}
              className="group text-center text-sm text-zinc-400 hover:text-white bg-zinc-900/50 hover:bg-zinc-800 border border-zinc-800/50 hover:border-zinc-700 rounded-full px-5 py-2.5 transition-all"
            >
              <span>{q}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "radial-gradient(circle at top, #18181b, #09090b)"}}>
      {messages.length === 0 ? welcomeScreen : (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-2">
          {messages.map((msg, index) => {
            const isUser = msg.role === 'user';
            const prevMessageIsSameSender = index > 0 && messages[index - 1].role === msg.role;

            return (
              <div
                key={msg.id}
                className={`flex items-end gap-2 ${isUser ? 'justify-end' : 'justify-start'} ${prevMessageIsSameSender ? '' : 'mt-5'}`}
              >
                {!isUser && (
                  <div className={`w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center border border-zinc-700 self-end ${prevMessageIsSameSender ? 'opacity-0' : ''}`}>
                    <Shield size={16} className="text-zinc-500" />
                  </div>
                )}
                
                <div 
                  className={`max-w-[75%] px-4 py-2.5 text-sm leading-relaxed ${
                    isUser 
                      ? 'bg-blue-600 text-white rounded-3xl rounded-br-lg' 
                      : 'bg-zinc-800 text-zinc-200 rounded-3xl rounded-bl-lg'
                  }`}
                >
                  {msg.content ? (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  ) : (
                    <div className="flex items-center gap-1.5 py-1">
                      <div className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                      <div className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                      <div className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" />
                    </div>
                  )}

                  {msg.error && (
                    <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg">
                      {msg.error}
                    </div>
                  )}

                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-zinc-700/50 flex flex-col gap-2">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                        <Database size={12} /> Sources
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.sources.map((_: any, idx: number) => (
                          <span 
                            key={idx} 
                            className="text-[10px] bg-zinc-700 hover:bg-zinc-600 text-zinc-300 px-2 py-0.5 rounded-md cursor-pointer border border-zinc-600/50 transition-colors"
                          >
                            {idx + 1}
                          </span>
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
