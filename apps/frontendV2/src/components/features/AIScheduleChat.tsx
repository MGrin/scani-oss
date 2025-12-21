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

export function AIScheduleChat({ scheduleId }: AIScheduleChatProps) {
  return (
    <div className="flex flex-col h-[600px]">
      <div ref={scrollAreaRef} className="flex-1 p-4 overflow-y-auto">
        <div className="space-y-4">
          <Card className="p-4 bg-muted">
            <div className="flex items-center gap-3">
              <Bot className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                AI Schedule Chat feature is not yet implemented. Coming soon!
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
