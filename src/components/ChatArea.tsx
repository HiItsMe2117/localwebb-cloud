import { useEffect, useRef } from 'react';
import { Shield, Search } from 'lucide-react';
import ChatBubble from './ChatBubble';
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
      <div className="flex-1 overflow-y-auto flex items-center justify-center">
        <div className="max-w-md text-center px-4">
          <div className="w-16 h-16 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-900/30">
            <Shield size={30} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-white mb-2">Start an Investigation</h2>
          <p className="text-sm text-zinc-500 mb-8">
            Ask questions about your uploaded documents. The AI will search across all indexed evidence using GraphRAG.
          </p>
          <div className="flex flex-col gap-2">
            {SUGGESTED_QUERIES.map((q, i) => (
              <button
                key={i}
                onClick={() => onSuggestedQuery(q)}
                className="flex items-center gap-3 text-left text-sm text-zinc-400 hover:text-white bg-zinc-900/50 hover:bg-zinc-800/80 border border-white/5 hover:border-white/10 rounded-xl px-4 py-3 transition-all group"
              >
                <Search size={14} className="text-zinc-600 group-hover:text-blue-400 shrink-0" />
                <span>{q}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6">
        {messages.map((msg) => (
          <ChatBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
