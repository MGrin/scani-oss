import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CronInput } from '@/components/ui/cron-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function ScheduleCreate() {
  const navigate = useNavigate();
  const [cronPattern, setCronPattern] = useState('0 0 1 * *'); // Default: Monthly on the 1st
  const { toast } = useToast();
  const utils = trpc.useUtils();

  // Fetch schedule types
  const { data: scheduleTypes, isLoading: scheduleTypesLoading } =
    trpc.scheduleTypes.getAll.useQuery();

  // Create schedule mutation
  const createSchedule = trpc.schedules.create.useMutation({
    onSuccess: () => {
      utils.schedules.getAll.invalidate();
      toast({
        title: 'Schedule created',
        description: 'Your schedule has been created successfully.',
      });
      navigate('/schedules');
    },
    onError: (error) => showError(error, 'Creating schedule'),
  });

  const handleCreateSchedule = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    createSchedule.mutate({
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      repetitiveCronPattern: cronPattern,
      typeId: formData.get('typeId') as string,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Create Schedule"
        subtitle="Create a new recurring monetary movement pattern"
        backButton={{
          onClick: () => navigate('/schedules'),
          label: 'Back to Schedules',
        }}
      />

      {/* Create Form */}
      <Card>
        <CardHeader>
          <CardTitle>Schedule Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreateSchedule} className="space-y-6">
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  required
                  placeholder="e.g., Monthly Paycheck Allocation"
                />
              </div>
              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  placeholder="Optional description"
                  rows={3}
                />
              </div>
              <div>
                <Label htmlFor="typeId">Type</Label>
                <Select name="typeId" required disabled={scheduleTypesLoading}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {scheduleTypes?.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="cronPattern">Schedule Frequency</Label>
                <CronInput value={cronPattern} onChange={setCronPattern} className="mt-2" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => navigate('/schedules')}>
                Cancel
              </Button>
              <Button type="submit" disabled={createSchedule.isPending}>
                <Plus className="mr-2 h-4 w-4" />
                {createSchedule.isPending ? 'Creating...' : 'Create Schedule'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
