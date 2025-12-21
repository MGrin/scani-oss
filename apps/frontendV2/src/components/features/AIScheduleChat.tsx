import { Bot } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface AIScheduleChatProps {
  scheduleId: string;
}

export function AIScheduleChat({ scheduleId }: AIScheduleChatProps) {
  console.log(scheduleId);

  return (
    <div className="flex flex-col h-[600px]">
      <div className="flex-1 p-4 overflow-y-auto">
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
