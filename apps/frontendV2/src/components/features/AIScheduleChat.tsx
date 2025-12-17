import type { UIMessage } from 'ai';
import { Bot, Send, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

interface AIScheduleChatProps {
  scheduleId: string;
}

/**
 * AI Schedule Chat Component using AI SDK types with VoltAgent backend
 *
 * This component integrates Vercel AI SDK message patterns with VoltAgent backend via tRPC.
 * It uses UIMessage type from AI SDK for compatibility with VoltAgent's @voltagent/vercel-ui adapters.
 *
 * The backend uses VoltAgent's Agent with PostgreSQL memory for conversation persistence.
 */
export function AIScheduleChat({ scheduleId }: AIScheduleChatProps) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversationId] = useState<string>(() => crypto.randomUUID());
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Load conversation history on mount
  const { data: conversationHistory } = trpc.aiChat.getConversation.useQuery(
    {
      scheduleId,
      conversationId,
    },
    {
      enabled: Boolean(scheduleId && conversationId),
      refetchOnWindowFocus: false,
    }
  );

  // Initialize messages with history or welcome message
  useEffect(() => {
    if (conversationHistory) {
      if (conversationHistory.length > 0) {
        // Load existing conversation - convert to AI SDK UIMessage format
        const uiMessages: UIMessage[] = conversationHistory.map((msg) => ({
          id: msg.id,
          role: msg.role,
          parts: [{ type: 'text' as const, text: msg.content }],
        }));
        setMessages(uiMessages);
      } else {
        // Start new conversation with welcome message
        setMessages([
          {
            id: '1',
            role: 'assistant',
            parts: [
              {
                type: 'text' as const,
                text: "Hi! I'm your AI assistant for configuring schedule steps. I can help you create inflow, outflow, transfer, and conversion steps. What would you like to do?",
              },
            ],
          },
        ]);
      }
      setIsLoadingHistory(false);
    }
  }, [conversationHistory]);

  // Send message mutation
  const sendMessage = trpc.aiChat.sendMessage.useMutation({
    onSuccess: (response) => {
      // Add assistant response as UIMessage
      setMessages((prev) => [
        ...prev,
        {
          id: response.id,
          role: 'assistant',
          parts: [{ type: 'text' as const, text: response.message }],
        },
      ]);
      setIsLoading(false);
    },
    onError: (error) => {
      showError(error, 'Sending message');
      setIsLoading(false);
    },
  });

  // Auto-scroll to bottom when new messages arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: We want to scroll on every message change
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    // Add user message to UI immediately (optimistic update with UIMessage format)
    const userMessage: UIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text' as const, text: input }],
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    // Send to VoltAgent backend via tRPC
    sendMessage.mutate({
      scheduleId,
      message: input,
      conversationId,
    });
  };

  // Show loading state while fetching history
  if (isLoadingHistory) {
    return (
      <div className="flex flex-col h-[600px] items-center justify-center">
        <div className="text-muted-foreground">Loading conversation...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[600px]">
      {/* Messages Area */}
      <div ref={scrollAreaRef} className="flex-1 p-4 overflow-y-auto">
        <div className="space-y-4">
          {messages.map((message) => {
            // Extract text content from UIMessage parts
            const content = message.parts
              .filter((part) => part.type === 'text')
              // biome-ignore lint/suspicious/noExplicitAny: UIMessage parts can have different structures
              .map((part: any) => part.text)
              .join('');

            return (
              <div
                key={message.id}
                className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {message.role === 'assistant' && (
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                    <Bot className="h-4 w-4 text-primary-foreground" />
                  </div>
                )}
                <Card
                  className={`max-w-[80%] p-3 ${
                    message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                  }`}
                >
                  <p className="text-sm whitespace-pre-wrap">{content}</p>
                </Card>
                {message.role === 'user' && (
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                    <User className="h-4 w-4 text-secondary-foreground" />
                  </div>
                )}
              </div>
            );
          })}
          {isLoading && (
            <div className="flex gap-3 justify-start">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                <Bot className="h-4 w-4 text-primary-foreground" />
              </div>
              <Card className="bg-muted p-3">
                <div className="flex gap-1">
                  <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" />
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>

      {/* Input Area - AI SDK pattern */}
      <form onSubmit={handleSubmit} className="border-t p-4">
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            disabled={isLoading}
            className="flex-1"
          />
          <Button type="submit" disabled={!input.trim() || isLoading} size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">Press Enter to send</p>
      </form>
    </div>
  );
}
