import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { GroupFormDialog } from '../components/groups/GroupFormDialog';
import { V2_ROUTES } from '../lib/routes';

const GROUP_SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e', 'f'];

export function GroupsPage() {
  const { data: groups, isLoading } = trpc.groups.getAllWithCounts.useQuery();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleEdit = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingId(id);
    setFormOpen(true);
  };

  const handleCreate = () => {
    setEditingId(null);
    setFormOpen(true);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {GROUP_SKELETON_KEYS.map((k) => (
            <Skeleton key={`group-skel-${k}`} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Groups</h2>
          <p className="text-sm text-muted-foreground mt-1">Organize your holdings and accounts</p>
        </div>
        <Button onClick={handleCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          New Group
        </Button>
      </div>

      {groups && groups.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...groups]
            .sort((a, b) => (b.holdingsCount ?? 0) - (a.holdingsCount ?? 0))
            .map((group) => (
              <Card key={group.id} className="hover:border-primary/50 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: group.color }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{group.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {group.holdingsCount ?? 0} holdings &middot; {group.accountsCount ?? 0}{' '}
                        accounts
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={(e) => handleEdit(e, group.id)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  {/* Quick links to view group contents */}
                  <div className="flex gap-2 mt-3 pt-3 border-t border-border">
                    {(group.holdingsCount ?? 0) > 0 && (
                      <Link
                        to={`${V2_ROUTES.holdings}?group=${group.id}`}
                        className="text-xs text-primary hover:underline"
                      >
                        View holdings
                      </Link>
                    )}
                    {(group.accountsCount ?? 0) > 0 && (
                      <Link
                        to={`${V2_ROUTES.accounts}?group=${group.id}`}
                        className="text-xs text-primary hover:underline"
                      >
                        View accounts
                      </Link>
                    )}
                    {(group.holdingsCount ?? 0) === 0 && (group.accountsCount ?? 0) === 0 && (
                      <p className="text-xs text-muted-foreground/60">No members yet</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No groups yet</p>
          <Button onClick={handleCreate} variant="outline" className="mt-3" size="sm">
            <Plus className="h-4 w-4 mr-1" />
            Create your first group
          </Button>
        </div>
      )}

      <GroupFormDialog open={formOpen} onOpenChange={setFormOpen} groupId={editingId} />
    </div>
  );
}
