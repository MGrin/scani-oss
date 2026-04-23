import { Badge } from '@scani/frontend-shared/ui/badge';
import { Button } from '@scani/frontend-shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/frontend-shared/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@scani/frontend-shared/ui/dialog';
import { Input } from '@scani/frontend-shared/ui/input';
import { Label } from '@scani/frontend-shared/ui/label';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '../lib/trpc';

/** Relative time label for `lastUsedAt` / `createdAt`. */
function rel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

interface CreatedKey {
  id: string;
  name: string;
  keyPrefix: string;
  rawToken: string;
}

export function KeysPage() {
  const list = trpc.keys.list.useQuery();
  const utils = trpc.useContext();
  const create = trpc.keys.create.useMutation({
    onSuccess: () => utils.keys.list.invalidate(),
  });
  const revoke = trpc.keys.revoke.useMutation({
    onSuccess: () => utils.keys.list.invalidate(),
  });

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [justCreated, setJustCreated] = useState<CreatedKey | null>(null);

  const onCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const res = await create.mutateAsync({ name: trimmed, tier: 'free' });
    setJustCreated({
      id: res.id,
      name: res.name,
      keyPrefix: res.keyPrefix,
      rawToken: res.rawToken,
    });
    setNewName('');
    setCreating(false);
  };

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">API keys</h1>
          <p className="text-sm text-muted-foreground">
            Keys authenticate your self-hosted backend/worker against Scani Cloud.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" /> New key
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Your keys
          </CardTitle>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <div className="py-6 text-sm text-muted-foreground">Loading…</div>
          ) : list.data && list.data.length > 0 ? (
            <div className="divide-y">
              {list.data.map((k) => (
                <div key={k.id} className="flex items-center justify-between py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="font-medium">{k.name}</div>
                      <Badge variant="outline" className="text-[10px]">
                        {k.tier}
                      </Badge>
                      {k.revokedAt && (
                        <Badge variant="destructive" className="text-[10px]">
                          revoked
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {k.keyPrefix}… · last used {rel(k.lastUsedAt)}
                    </div>
                  </div>
                  {!k.revokedAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Revoke key "${k.name}"? This cannot be undone.`)) {
                          revoke.mutate({ id: k.id });
                        }
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" /> Revoke
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-sm text-muted-foreground">
              No keys yet. Create one to connect your backend + worker to Scani Cloud.
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              Give the key a descriptive name (e.g. production, staging).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="production"
              />
            </div>
            <Button
              className="w-full"
              onClick={onCreate}
              disabled={!newName.trim() || create.isLoading}
            >
              {create.isLoading ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!justCreated} onOpenChange={(o) => !o && setJustCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your new key</DialogTitle>
            <DialogDescription>Copy this key now — it will not be shown again.</DialogDescription>
          </DialogHeader>
          {justCreated && (
            <div className="space-y-4">
              <div className="rounded border bg-muted p-3 font-mono text-xs break-all">
                {justCreated.rawToken}
              </div>
              <Button
                className="w-full"
                onClick={() => {
                  navigator.clipboard.writeText(justCreated.rawToken);
                }}
              >
                <Copy className="mr-2 h-4 w-4" /> Copy to clipboard
              </Button>
              <Button variant="outline" className="w-full" onClick={() => setJustCreated(null)}>
                I've saved it
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
