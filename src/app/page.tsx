'use client';

import { startTransition, useState, useRef, useEffect } from 'react';
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

const HISTORY_POLL_INTERVAL_MS = 5000;
const AUTO_SCROLL_THRESHOLD_PX = 160;

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
        <div className="max-w-none min-w-0">
          <MarkdownRenderer content={visibleContent} />
        </div>
      )}
    </>
  );
};

function normalizeChatMessage(message: Partial<ChatMsg> & { role?: string; content?: string }): ChatMsg {
  return {
    id:
      typeof message.id === 'string' && message.id.length > 0
        ? message.id
        : String(Math.random()),
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content || '',
    createdAt:
      typeof message.createdAt === 'string'
        ? message.createdAt
        : message.createdAt
          ? new Date(message.createdAt).toISOString()
          : undefined,
  };
}

function areMessagesEqual(current: ChatMsg[], next: ChatMsg[]): boolean {
  if (current.length !== next.length) return false;

  return current.every((message, index) => {
    const nextMessage = next[index];
    return (
      message.id === nextMessage.id &&
      message.role === nextMessage.role &&
      message.content === nextMessage.content &&
      message.createdAt === nextMessage.createdAt
    );
  });
}

function isNearBottom(): boolean {
  if (typeof window === 'undefined') return true;

  const scrollTop = window.scrollY;
  const viewportHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;

  return documentHeight - (scrollTop + viewportHeight) <= AUTO_SCROLL_THRESHOLD_PX;
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isSyncingRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const forceScrollOnNextUpdateRef = useRef(false);

  const syncHistory = async (force = false) => {
    if (isSyncingRef.current) return;
    if (!force && (sending || streaming)) return;

    isSyncingRef.current = true;

    try {
      const res = await fetch('/api/nicole/history', {
        cache: 'no-store',
      });

      if (!res.ok) return;

      const data = await res.json();
      if (!Array.isArray(data)) return;

      const nextMessages = data.map((message: Partial<ChatMsg>) =>
        normalizeChatMessage(message)
      );

      startTransition(() => {
        setMessages((currentMessages) =>
          areMessagesEqual(currentMessages, nextMessages)
            ? currentMessages
            : nextMessages
        );
      });
    } catch {
      // Non-fatal: keep local UI state if history sync fails.
    } finally {
      isSyncingRef.current = false;
      setLoaded(true);
    }
  };

  // Load chat history on mount
  useEffect(() => {
    void syncHistory(true);
  }, []);

  useEffect(() => {
    const shouldScroll =
      forceScrollOnNextUpdateRef.current || shouldStickToBottomRef.current;

    if (!shouldScroll) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({
      behavior: loaded ? 'smooth' : 'auto',
      block: 'end',
    });
    forceScrollOnNextUpdateRef.current = false;
  }, [messages]);

  // Focus input when loaded
  useEffect(() => {
    if (loaded) textareaRef.current?.focus();
  }, [loaded]);

  useEffect(() => {
    const handleScroll = () => {
      shouldStickToBottomRef.current = isNearBottom();
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;

    const interval = window.setInterval(() => {
      void syncHistory();
    }, HISTORY_POLL_INTERVAL_MS);

    const handleFocus = () => {
      void syncHistory(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncHistory(true);
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loaded, sending, streaming]);

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

    forceScrollOnNextUpdateRef.current = true;
    shouldStickToBottomRef.current = true;

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
      forceScrollOnNextUpdateRef.current = true;
      shouldStickToBottomRef.current = true;
      void syncHistory(true);
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
    <div className="flex min-h-dvh w-full flex-col items-center bg-background">
      {/* Chat Content */}
      <main className="mt-14 flex-1 w-full max-w-3xl px-[max(0.75rem,env(safe-area-inset-left))] py-6 pr-[max(0.75rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+8rem)] sm:mx-auto sm:px-4 sm:py-8 sm:pb-40">
        <div className="space-y-5 sm:space-y-6">
          {messages.map((message, messageIndex) => {
            const isLastMessage = messageIndex === messages.length - 1;
            const isStreamingThis = isLastMessage && isAILoading && message.role === 'assistant';
            const parsedContent =
              message.role === 'assistant'
                ? parseAssistantContent(message.content)
                : null;
            const visibleAssistantText = parsedContent?.responseText || '';

            return (
              <div key={message.id} className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'w-full min-w-0 items-start'}`}>
                {message.role === 'user' ? (
                  <div className="max-w-[90%] rounded-2xl rounded-br-md bg-primary px-3 py-2 text-primary-foreground sm:max-w-[85%]">
                    <p className="text-sm">{message.content}</p>
                  </div>
                ) : (
                  <div className="w-full min-w-0 max-w-none space-y-2">
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
      <div className="fixed bottom-0 left-0 right-0 bg-background/80 px-[max(0.75rem,env(safe-area-inset-left))] pb-[max(0.75rem,calc(env(safe-area-inset-bottom)+0.75rem))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-3 backdrop-blur-sm sm:px-4 sm:pb-8 sm:pt-4">
        <div className="w-full max-w-3xl sm:mx-auto">
          {/* File Preview */}
          {selectedFile && (
            <div className="mb-3 ml-2 flex items-center gap-2 sm:ml-4">
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
            <div className="relative flex items-center gap-2 rounded-full border border-border/50 bg-muted/20 px-2.5 py-2 pl-3 transition-all hover:border-border/80 hover:bg-muted/30 focus-within:border-white/20 focus-within:bg-muted/30">
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
                className="max-h-32 flex-1 resize-none bg-transparent py-2 text-[16px] leading-6 placeholder:text-muted-foreground focus:outline-none"
                style={{ minHeight: '24px', fontSize: '16px' }}
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
