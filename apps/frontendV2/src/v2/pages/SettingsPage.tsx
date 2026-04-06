import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';

export function SettingsPage() {
  const { data: user, isLoading: userLoading } = trpc.users.getCurrent.useQuery();
  const { data: currencies } = trpc.users.getSupportedCurrencies.useQuery();
  const utils = trpc.useUtils();

  const updateMutation = trpc.users.updateCurrent.useMutation({
    onSuccess: () => {
      utils.users.getCurrent.invalidate();
      utils.users.getBaseCurrency.invalidate();
    },
  });

  const [name, setName] = useState('');
  const [baseCurrencyId, setBaseCurrencyId] = useState('');

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setBaseCurrencyId(user.baseCurrencyId || '');
    }
  }, [user]);

  const isDirty = useMemo(() => {
    if (!user) return false;
    return name !== (user.name || '') || baseCurrencyId !== (user.baseCurrencyId || '');
  }, [user, name, baseCurrencyId]);

  // Auto-save on change with debounce
  useEffect(() => {
    if (!isDirty || !user) return;
    const timer = setTimeout(() => {
      updateMutation.mutate({
        name: name || undefined,
        baseCurrencyId: baseCurrencyId || undefined,
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [name, baseCurrencyId, isDirty, updateMutation.mutate, user]);

  if (userLoading) {
    return (
      <div className="max-w-2xl space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">Manage your preferences</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={user?.email || ''} disabled className="bg-muted" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currency">Base Currency</Label>
            <Select value={baseCurrencyId} onValueChange={setBaseCurrencyId}>
              <SelectTrigger id="currency">
                <SelectValue placeholder="Select currency" />
              </SelectTrigger>
              <SelectContent>
                {currencies?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.symbol} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {updateMutation.isPending && <p className="text-xs text-muted-foreground">Saving...</p>}
      {isDirty && !updateMutation.isPending && (
        <p className="text-xs text-muted-foreground">Changes will auto-save</p>
      )}
    </div>
  );
}
