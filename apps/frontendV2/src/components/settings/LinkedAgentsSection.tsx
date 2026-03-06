import { Bot, Link2, Plus } from 'lucide-react';
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

export function LinkedAgentsSection() {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [claimDialogOpen, setClaimDialogOpen] = useState(false);
  const [agentApiKey, setAgentApiKey] = useState('');
  const [claimError, setClaimError] = useState('');

  const { data: linkedAgents, isLoading } = trpc.agents.listLinkedAgents.useQuery();

  const claimMutation = trpc.agents.claimAgentIdentity.useMutation({
    onSuccess: (data) => {
      toast({ title: 'Agent linked', description: data.message });
      setClaimDialogOpen(false);
      setAgentApiKey('');
      setClaimError('');
      utils.agents.listLinkedAgents.invalidate();
    },
    onError: (error) => {
      setClaimError(error.message ?? 'Failed to claim agent identity');
    },
  });

  const handleClaim = () => {
    if (!agentApiKey.trim()) {
      setClaimError('Please enter an agent API key');
      return;
    }
    setClaimError('');
    claimMutation.mutate({ agentApiKey: agentApiKey.trim() });
  };

  const fmt = (d: Date | string) =>
    new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5" />
                Linked AI Agents
              </CardTitle>
              <CardDescription>
                Claim agent-generated accounts to consolidate autonomous portfolio data with your
                account.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => setClaimDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Claim Agent
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !linkedAgents || linkedAgents.length === 0 ? (
            <Alert>
              <Bot className="h-4 w-4" />
              <AlertDescription>
                No AI agents linked yet. If an autonomous agent has been managing your finances,
                click &ldquo;Claim Agent&rdquo; to consolidate its data with your account.
              </AlertDescription>
            </Alert>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent Name</TableHead>
                  <TableHead>Agent ID</TableHead>
                  <TableHead>Linked On</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {linkedAgents.map((agent) => (
                  <TableRow key={agent.agentId}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-muted-foreground" />
                        {agent.name}
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">
                        {agent.agentId.substring(0, 8)}…
                      </code>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {fmt(agent.linkedAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {fmt(agent.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Claim Agent Dialog */}
      <Dialog
        open={claimDialogOpen}
        onOpenChange={(open) => {
          setClaimDialogOpen(open);
          if (!open) {
            setAgentApiKey('');
            setClaimError('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Claim Agent Identity
            </DialogTitle>
            <DialogDescription>
              Enter the API key generated by your autonomous AI agent to link its financial data to
              your account.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="agent-api-key">Agent API Key</Label>
              <Input
                id="agent-api-key"
                placeholder="sk_live_…"
                value={agentApiKey}
                onChange={(e) => {
                  setAgentApiKey(e.target.value);
                  setClaimError('');
                }}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                The key the agent received when it called{' '}
                <code className="rounded bg-muted px-1">agent_register</code>. It starts with{' '}
                <code className="rounded bg-muted px-1">sk_live_</code>.
              </p>
            </div>

            {claimError && (
              <Alert variant="destructive">
                <AlertDescription>{claimError}</AlertDescription>
              </Alert>
            )}

            <Alert>
              <AlertDescription className="text-xs">
                After claiming, the agent&apos;s accounts and holdings will be linked to your Scani
                profile. The agent can continue using its own API key independently.
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setClaimDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleClaim} disabled={claimMutation.isPending || !agentApiKey.trim()}>
              {claimMutation.isPending ? 'Claiming…' : 'Claim Agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
