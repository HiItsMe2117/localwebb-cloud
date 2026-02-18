import React, { useState } from 'react';
import { Shield, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import type { ChatMessage } from '../types';

interface ChatBubbleProps {
  message: ChatMessage;
}

const ChatBubble = React.memo(function ChatBubble({ message }: ChatBubbleProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%] bg-blue-600 text-white px-4 py-3 rounded-2xl rounded-br-md text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 mb-4">
      <div className="shrink-0 w-8 h-8 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-lg flex items-center justify-center mt-1">
        <Shield size={14} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 max-w-[85%]">
        {message.error ? (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-2xl rounded-bl-md px-4 py-3 text-sm">
            {message.error}
          </div>
        ) : (
          <div className="bg-zinc-800/80 text-zinc-200 rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
            {message.content}
            {message.isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-blue-400 ml-0.5 animate-pulse rounded-sm align-middle" />
            )}
          </div>
        )}

        {message.sources.length > 0 && !message.isStreaming && (
          <div className="mt-1.5">
            <button
              onClick={() => setSourcesOpen(!sourcesOpen)}
              className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1 rounded-lg hover:bg-zinc-800/50"
            >
              <FileText size={11} />
              <span>{message.sources.length} source{message.sources.length !== 1 ? 's' : ''}</span>
              {sourcesOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>

            {sourcesOpen && (
              <div className="mt-1 ml-1 p-2.5 bg-zinc-900/60 rounded-xl border border-white/5 flex flex-col gap-1">
                {message.sources.map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400 truncate max-w-[70%]">{s.filename}</span>
                    {s.score != null && (
                      <span className="text-[10px] font-mono text-zinc-600">{(s.score * 100).toFixed(0)}%</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default ChatBubble;
