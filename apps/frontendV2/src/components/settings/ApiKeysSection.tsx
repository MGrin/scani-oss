import { Check, Copy, Key, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function ApiKeysSection() {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [createdKey, setCreatedKey] = useState<{
    name: string;
    plainKey: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [keyToRevoke, setKeyToRevoke] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const { data: apiKeys, isLoading } = trpc.apiKeys.list.useQuery();

  const createMutation = trpc.apiKeys.create.useMutation({
    onSuccess: (data) => {
      setCreatedKey({ name: newKeyName, plainKey: data.plainKey });
      setNewKeyName('');
      setExpiresAt('');
      setCreateDialogOpen(false);
      utils.apiKeys.list.invalidate();
      toast({
        title: 'API Key Created',
        description: 'Your new API key has been created. Make sure to copy it now!',
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to Create Key',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      setRevokeDialogOpen(false);
      setKeyToRevoke(null);
      utils.apiKeys.list.invalidate();
      toast({
        title: 'API Key Revoked',
        description: 'The API key has been revoked and can no longer be used.',
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to Revoke Key',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleCreate = () => {
    if (!newKeyName.trim()) {
      toast({
        title: 'Name Required',
        description: 'Please enter a name for your API key',
        variant: 'destructive',
      });
      return;
    }
    createMutation.mutate({
      name: newKeyName,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });
  };

  const handleRevoke = () => {
    if (keyToRevoke) {
      revokeMutation.mutate({ id: keyToRevoke.id });
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({
      title: 'Copied',
      description: 'API key copied to clipboard',
    });
  };

  const formatDate = (date: string | null) => {
    if (!date) return 'Never';
    return new Date(date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center space-x-2">
                <Key className="h-5 w-5" />
                <span>API Keys</span>
              </CardTitle>
              <CardDescription>
                Manage API keys for MCP (Model Context Protocol) access
              </CardDescription>
            </div>
            <Button onClick={() => setCreateDialogOpen(true)} size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Create Key
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading API keys...</div>
          ) : !apiKeys || apiKeys.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Key className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No API keys created yet</p>
              <p className="text-sm mt-1">
                Create an API key to connect MCP clients like Claude Desktop
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-sm">{key.keyPrefix}...</TableCell>
                    <TableCell className="text-sm">{formatDate(key.lastUsedAt)}</TableCell>
                    <TableCell className="text-sm">{formatDate(key.expiresAt)}</TableCell>
                    <TableCell>
                      {key.isActive ? (
                        <span className="text-green-600 text-sm">Active</span>
                      ) : (
                        <span className="text-gray-500 text-sm">Revoked</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setKeyToRevoke({ id: key.id, name: key.name });
                          setRevokeDialogOpen(true);
                        }}
                        disabled={!key.isActive}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create API Key Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New API Key</DialogTitle>
            <DialogDescription>
              Create a new API key for MCP client access. The key will only be shown once.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">Key Name *</Label>
              <Input
                id="key-name"
                placeholder="e.g., Claude Desktop, My Automation"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expires-at">Expiration Date (Optional)</Label>
              <Input
                id="expires-at"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
              />
              <p className="text-xs text-muted-foreground">Leave empty for no expiration</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create Key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Display Created Key Dialog */}
      <Dialog open={!!createdKey} onOpenChange={() => setCreatedKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>
              Save this key securely. It will only be shown once and cannot be retrieved later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Alert>
              <AlertDescription className="font-mono text-sm break-all">
                {createdKey?.plainKey}
              </AlertDescription>
            </Alert>
            <Button
              onClick={() => createdKey && copyToClipboard(createdKey.plainKey)}
              className="w-full"
              variant="outline"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy to Clipboard
                </>
              )}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreatedKey(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Key Confirmation Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API Key</DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke "{keyToRevoke?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? 'Revoking...' : 'Revoke Key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
