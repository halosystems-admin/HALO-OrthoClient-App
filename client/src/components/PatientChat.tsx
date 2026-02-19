import React, { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../../shared/types';
import { MessageCircle, Send } from 'lucide-react';
import { renderInlineMarkdown } from '../utils/formatting';

interface PatientChatProps {
  patientName: string;
  chatMessages: ChatMessage[];
  chatInput: string;
  onChatInputChange: (value: string) => void;
  chatLoading: boolean;
  chatLongWait?: boolean;
  onSendChat: () => void;
}

export const PatientChat: React.FC<PatientChatProps> = ({
  patientName, chatMessages, chatInput, onChatInputChange, chatLoading, chatLongWait, onSendChat,
}) => {
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatLoading]);

  return (
    <div className="h-[600px] flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="bg-gradient-to-r from-sky-50 to-sky-100 px-4 py-3 border-b border-slate-200 flex items-center gap-2">
        <MessageCircle size={16} className="text-sky-600" />
        <span className="text-sm font-bold text-sky-800 uppercase tracking-wider">Ask HALO</span>
        <span className="text-xs text-slate-400 ml-2">AI-powered patient data assistant</span>
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {chatMessages.length === 0 && !chatLoading && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 bg-sky-50 rounded-full flex items-center justify-center mb-4">
              <MessageCircle size={28} className="text-sky-400" />
            </div>
            <h3 className="text-lg font-bold text-slate-700 mb-1">Ask HALO anything</h3>
            <p className="text-sm text-slate-400 max-w-sm">
              I can answer questions about <span className="font-semibold text-slate-500">{patientName}</span>'s files and clinical data.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              {['Summarize recent notes', 'Any abnormal lab results?', 'What medications are listed?'].map(q => (
                <button
                  key={q}
                  onClick={() => onChatInputChange(q)}
                  className="text-xs px-3 py-1.5 bg-slate-100 hover:bg-sky-50 text-slate-600 hover:text-sky-700 rounded-full transition-colors border border-slate-200 hover:border-sky-200"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {chatMessages.map((msg, idx) => {
          const isLastAssistantStreaming = chatLoading && idx === chatMessages.length - 1 && msg.role === 'assistant';
          return (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-sky-600 text-white rounded-br-md'
                  : 'bg-slate-100 text-slate-800 rounded-bl-md border border-slate-200'
              }`}>
                {msg.role === 'assistant' && (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-sky-600 block mb-1">HALO</span>
                )}
                <div className="text-sm leading-relaxed whitespace-pre-wrap">
                  {msg.content.split('\n').map((line, li) => (
                    <span key={li}>{li > 0 && <br />}{renderInlineMarkdown(line)}</span>
                  ))}
                  {isLastAssistantStreaming && <span className="inline-block w-2 h-4 ml-0.5 bg-sky-500 animate-pulse" />}
                </div>
                {!isLastAssistantStreaming && (
                  <span className={`text-[10px] mt-1 block ${msg.role === 'user' ? 'text-sky-200' : 'text-slate-400'}`}>
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {/* Thinking animation — show until first chunk arrives; "may take a while" after 8s */}
        {chatLoading && !(chatMessages.length > 0 && chatMessages[chatMessages.length - 1]?.role === 'assistant' && chatMessages[chatMessages.length - 1]?.content) && (
          <div className="flex justify-start">
            <div className="bg-slate-100 border border-slate-200 rounded-2xl rounded-bl-md px-4 py-3 max-w-[80%]">
              <span className="text-[10px] font-bold uppercase tracking-wider text-sky-600 block mb-1">HALO</span>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-slate-500 italic animate-pulse">(HALO is thinking...)</span>
                  <span className="flex gap-0.5">
                    <span className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                </div>
                {chatLongWait && (
                  <span className="text-xs text-slate-400">Complex questions may take 15–60 seconds.</span>
                )}
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Chat input */}
      <div className="border-t border-slate-200 p-3 bg-slate-50">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={e => onChatInputChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendChat(); } }}
            placeholder="Ask a question about this patient..."
            className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-800 text-sm focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none transition placeholder:text-slate-400"
            disabled={chatLoading}
          />
          <button
            onClick={onSendChat}
            disabled={!chatInput.trim() || chatLoading}
            className="p-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-xl disabled:opacity-40 transition-all shadow-sm"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};
