'use client';

import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { MessageActions } from '@/components/chat/MessageActions';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

interface ParsedAssistantContent {
  hasReasoning: boolean;
  reasoningText: string;
  responseText: string;
  reasoningStreaming: boolean;
}

function parseAssistantContent(content: string): ParsedAssistantContent {
  const leadingThoughtMatch = content.match(/^\s*<thought>/i);

  if (!leadingThoughtMatch) {
    return {
      hasReasoning: false,
      reasoningText: '',
      responseText: content,
      reasoningStreaming: false,
    };
  }

  const thoughtOpenLength = leadingThoughtMatch[0].length;
  const closeTag = '</thought>';
  const closeIndex = content.toLowerCase().indexOf(closeTag, thoughtOpenLength);

  if (closeIndex === -1) {
    return {
      hasReasoning: true,
      reasoningText: content.slice(thoughtOpenLength).trim(),
      responseText: '',
      reasoningStreaming: true,
    };
  }

  return {
    hasReasoning: true,
    reasoningText: content.slice(thoughtOpenLength, closeIndex).trim(),
    responseText: content.slice(closeIndex + closeTag.length).trimStart(),
    reasoningStreaming: false,
  };
}

const MessageParts = ({
  message,
  isLastMessage,
  isLoading,
}: {
  message: ChatMsg;
  isLastMessage: boolean;
  isLoading: boolean;
}) => {
  const isStreamingThis = isLastMessage && isLoading && message.role === 'assistant';
  const parsedContent = parseAssistantContent(message.content);
  const showReasoning =
    isStreamingThis || parsedContent.hasReasoning;
  const visibleContent = parsedContent.responseText;
  const reasoningIsStreaming = isStreamingThis || parsedContent.reasoningStreaming;
  const reasoningText = parsedContent.reasoningText;

  return (
    <>
      {showReasoning && (
        <Reasoning className="w-full" isStreaming={reasoningIsStreaming}>
          <ReasoningTrigger
            getThinkingMessage={(streamingState, duration) =>
              streamingState
                ? `Nicole is thinking${duration != null && duration > 0 ? ` (${duration}s)` : ''}`
                : `Thought${duration != null && duration > 0 ? ` for ${duration}s` : ''}`
            }
          />
          {reasoningText && <ReasoningContent>{reasoningText}</ReasoningContent>}
        </Reasoning>
      )}

      {visibleContent && (
        <div className="max-w-none">
          <MarkdownRenderer content={visibleContent} />
        </div>
      )}
    </>
  );
};

export default function Chat() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load chat history on mount
  useEffect(() => {
    fetch('/api/nicole/history')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setMessages(data.map((m: any) => ({ ...m, id: m.id || String(Math.random()) })));
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Auto-scroll on-new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when loaded
  useEffect(() => {
    if (loaded) textareaRef.current?.focus();
  }, [loaded]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };

  const sendMessage = async () => {
    if ((!input.trim() && !selectedFile) || sending) return;

    const userMsg: ChatMsg = {
      id: String(Date.now() - 1),
      role: 'user',
      content: input.trim(),
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    const currentInput = input.trim();
    const currentFile = selectedFile;
    setInput('');
    setSelectedFile(null);
    setSending(true);

    // Add placeholder for assistant's streaming response
    const assistantMsgId = Date.now();
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: '', createdAt: new Date().toISOString(), id: String(assistantMsgId) },
    ]);

    try {
      const body: { message: string; file?: { mediaType: string; data: string } } = {
        message: currentInput,
      };

      if (currentFile) {
        const base64Content = await fileToBase64(currentFile);
        body.file = {
          mediaType: currentFile.type,
          data: base64Content,
        };
      }

      const res = await fetch('/api/nicole/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === String(assistantMsgId)
              ? { ...m, content: data.error || 'Something went wrong.' }
              : m
          )
        );
        return;
      }

      setStreaming(true);
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let streamedContent = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          streamedContent += chunk;

          setMessages((prev) =>
            prev.map((m) =>
              m.id === String(assistantMsgId)
                ? { ...m, content: streamedContent }
                : m
            )
          );
        }
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === String(assistantMsgId)
            ? { ...m, content: "I'm offline right now." }
            : m
        )
      );
    } finally {
      setStreaming(false);
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const isAILoading = sending || streaming;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center">
      {/* Chat Content */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 space-y-8 mt-14 pb-40">
        <div className="space-y-6">
          {messages.map((message, messageIndex) => {
            const isLastMessage = messageIndex === messages.length - 1;
            const isStreamingThis = isLastMessage && isAILoading && message.role === 'assistant';
            const parsedContent =
              message.role === 'assistant'
                ? parseAssistantContent(message.content)
                : null;
            const visibleAssistantText = parsedContent?.responseText || '';

            return (
              <div key={message.id} className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
                {message.role === 'user' ? (
                  <div className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-br-md px-3 py-2">
                    <p className="text-sm">{message.content}</p>
                  </div>
                ) : (
                  <div className="w-full max-w-none space-y-2">
                    <MessageParts
                      message={message}
                      isLastMessage={isLastMessage}
                      isLoading={isAILoading}
                    />
                    {!isStreamingThis && visibleAssistantText && (
                      <MessageActions
                        messageText={visibleAssistantText}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Show reasoning when waiting for assistant message to appear */}
          {isAILoading && (messages.length === 0 || messages[messages.length - 1].role === 'user') && (
            <div className="flex flex-col items-start">
              <Reasoning className="w-full" isStreaming={true}>
                <ReasoningTrigger
                  getThinkingMessage={(streamingState, duration) =>
                    streamingState
                      ? `Nicole is thinking${duration != null && duration > 0 ? ` (${duration}s)` : ''}`
                      : `Thought${duration != null && duration > 0 ? ` for ${duration}s` : ''}`
                  }
                />
              </Reasoning>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Fixed Bottom Input */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/80 backdrop-blur-sm pb-8">
        <div className="max-w-3xl mx-auto">
          {/* File Preview */}
          {selectedFile && (
            <div className="flex items-center gap-2 mb-3 ml-4">
              <div className="relative w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center bg-muted">
                {selectedFile.type.startsWith('image/') ? (
                  <img
                    src={URL.createObjectURL(selectedFile)}
                    alt="Selected file preview"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-[10px] text-muted-foreground">{selectedFile.type.split('/')[1] || 'File'}</span>
                )}
                <button
                  onClick={() => setSelectedFile(null)}
                  className="absolute -top-1 -right-1 bg-destructive text-white rounded-full w-4 h-4 text-[10px] flex items-center justify-center cursor-pointer"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="relative flex items-center gap-2 rounded-full border border-border/50 bg-muted/20 px-2.5 pl-3 py-2 transition-all hover:bg-muted/30 hover:border-border/80 focus-within:border-white/20 focus-within:bg-muted/30">
              <label htmlFor="file-input" className="flex items-center justify-center cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
                <Plus className="h-4 w-4" />
              </label>
              <input
                id="file-input"
                type="file"
                className="hidden"
                onChange={handleFileChange}
              />
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question..."
                rows={1}
                className="flex-1 resize-none bg-transparent py-2 text-sm placeholder:text-muted-foreground focus:outline-none max-h-32"
                style={{ minHeight: '24px' }}
              />
              <div className="flex-shrink-0">
                <Button
                  type="submit"
                  size="icon"
                  className="h-8 w-8 rounded-full bg-foreground text-background hover:bg-foreground/90 transition-all cursor-pointer"
                  disabled={(!input.trim() && !selectedFile) || isAILoading}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </form>

          <div className="text-center mt-3">
          </div>
        </div>
      </div>
    </div>
  );
}
