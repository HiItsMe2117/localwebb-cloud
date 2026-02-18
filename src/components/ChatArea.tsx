import { useEffect, useRef } from 'react';
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
      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center p-4 font-mono">
        <div className="max-w-2xl w-full border border-[#2b4a9c] p-6 bg-[#050510] text-[#a4b9ef]">
          <pre className="text-[10px] sm:text-xs leading-none text-[#4169E1] mb-6">
{`
   __   ____  ___  __    __    _  _  ____  ____  ____ 
  (  ) (  _ \\/ __)(  )  (  )  / )( \\(  __)(  _ \\(  _ \\
  / (_/\\) _ ( (__ / (_/\\/ (_/\\) \\/ ( ) _)  ) _ ( ) _ (
  \\____(____/\\___)\\____/\\____/\\____/(____)(____/(____/
  
  :: INVESTIGATIVE INTELLIGENCE OS :: v2.0 ::
`}
          </pre>
          
          <div className="mb-6 space-y-2">
            <p className="text-sm">SYSTEM_STATUS: <span className="text-[#4169E1]">ONLINE</span></p>
            <p className="text-sm">GRAPH_ENGINE: <span className="text-[#4169E1]">READY</span></p>
            <p className="text-sm">AWAITING_INPUT...</p>
          </div>

          <div className="border-t border-[#2b4a9c] pt-4">
            <p className="text-xs text-[#2b4a9c] mb-3">SUGGESTED_COMMANDS:</p>
            <div className="flex flex-col gap-2">
              {SUGGESTED_QUERIES.map((q, i) => (
                <button
                  key={i}
                  onClick={() => onSuggestedQuery(q)}
                  className="text-left text-xs text-[#a4b9ef] hover:text-[#4169E1] hover:bg-[#4169E1]/10 px-2 py-1 transition-colors group flex items-center gap-2"
                >
                  <span className="text-[#2b4a9c] opacity-0 group-hover:opacity-100">&gt;</span>
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 font-mono text-sm">
      <div className="max-w-4xl mx-auto space-y-6">
        {messages.map((msg) => (
          <div key={msg.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs opacity-70">
              <span className={msg.role === 'user' ? 'text-[#00ffff]' : 'text-[#4169E1]'}>
                [{msg.role.toUpperCase()}]
              </span>
              <span className="text-[#2b4a9c]">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>
            
            <div className={`pl-4 border-l-2 ${msg.role === 'user' ? 'border-[#00ffff] text-[#a4b9ef]' : 'border-[#4169E1] text-[#a4b9ef]'}`}>
              {msg.content ? (
                <div className="whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </div>
              ) : (
                <span className="animate-pulse">_</span>
              )}
              
              {msg.error && (
                 <div className="mt-2 text-red-500 border border-red-500/50 bg-red-900/10 p-2">
                   ERROR: {msg.error}
                 </div>
              )}

              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-3 pt-2 border-t border-[#2b4a9c]/30">
                  <span className="text-xs text-[#2b4a9c] block mb-1">SOURCES_DETECTED:</span>
                  <div className="flex flex-wrap gap-2">
                    {msg.sources.map((_: any, idx: number) => (
                      <span key={idx} className="text-xs border border-[#2b4a9c] px-1 py-0.5 text-[#2b4a9c]">
                        REF_{idx+1}
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
