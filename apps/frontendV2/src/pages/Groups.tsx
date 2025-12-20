import { GROUP_COLORS, type GroupColor } from '@scani/shared';
import { GripVertical, Palette, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

type GroupWithCounts = {
  id: string;
  userId: string;
  name: string;
  color: GroupColor;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  holdingsCount: number;
  accountsCount: number;
};

export function Groups() {
  const { data: groups, isLoading } = trpc.groups.getAllWithCounts.useQuery();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  // Type assert the groups to ensure color is properly typed as GroupColor
  const typedGroups = groups as GroupWithCounts[] | undefined;

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<GroupWithCounts | null>(null);
  const [formData, setFormData] = useState<{
    name: string;
    color: GroupColor;
    description: string;
  }>({
    name: '',
    color: GROUP_COLORS[0],
    description: '',
  });
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null);
  const [orderedGroups, setOrderedGroups] = useState<GroupWithCounts[]>([]);

  const createGroupMutation = trpc.groups.create.useMutation({
    onSuccess: () => {
      utils.groups.getAllWithCounts.invalidate();
      utils.dashboard.getOverview.invalidate();
      toast({
        title: 'Group created',
        description: 'The group has been successfully created.',
      });
      setIsCreateDialogOpen(false);
      setFormData({ name: '', color: GROUP_COLORS[0], description: '' });
    },
    onError: (error) => showError(error, 'Creating group'),
  });

  const updateGroupMutation = trpc.groups.update.useMutation({
    onSuccess: () => {
      utils.groups.getAllWithCounts.invalidate();
      utils.dashboard.getOverview.invalidate();
      toast({
        title: 'Group updated',
        description: 'The group has been successfully updated.',
      });
      setIsEditDialogOpen(false);
      setEditingGroup(null);
    },
    onError: (error) => showError(error, 'Updating group'),
  });

  const deleteGroupMutation = trpc.groups.delete.useMutation({
    onSuccess: () => {
      utils.groups.getAllWithCounts.invalidate();
      utils.dashboard.getOverview.invalidate();
      toast({
        title: 'Group deleted',
        description: 'The group has been successfully deleted.',
      });
    },
    onError: (error) => showError(error, 'Deleting group'),
  });

  const handleCreateGroup = () => {
    createGroupMutation.mutate({
      name: formData.name,
      color: formData.color,
      description: formData.description || null,
    });
  };

  const handleUpdateGroup = () => {
    if (!editingGroup) return;

    updateGroupMutation.mutate({
      id: editingGroup.id,
      data: {
        name: formData.name,
        color: formData.color,
        description: formData.description || null,
      },
    });
  };

  const handleEditClick = (group: GroupWithCounts) => {
    setEditingGroup(group);
    setFormData({
      name: group.name,
      color: group.color,
      description: group.description || '',
    });
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (group: GroupWithCounts) => {
    if (
      window.confirm(
        `Are you sure you want to delete "${group.name}"? This will remove the group from all holdings and accounts.`
      )
    ) {
      deleteGroupMutation.mutate({ id: group.id });
    }
  };

  // Drag and drop handlers
  const handleDragStart = (groupId: string) => {
    setDraggedGroupId(groupId);
  };

  const handleDragOver = (e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault();
    if (!draggedGroupId || draggedGroupId === targetGroupId) return;

    const currentGroups = orderedGroups.length > 0 ? orderedGroups : typedGroups || [];
    const draggedIndex = currentGroups.findIndex((g) => g.id === draggedGroupId);
    const targetIndex = currentGroups.findIndex((g) => g.id === targetGroupId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    const newGroups = [...currentGroups];
    const [draggedItem] = newGroups.splice(draggedIndex, 1);
    if (!draggedItem) return;
    newGroups.splice(targetIndex, 0, draggedItem);

    setOrderedGroups(newGroups);
  };

  const handleDragEnd = () => {
    if (orderedGroups.length > 0) {
      // Update display order for all affected groups
      orderedGroups.forEach((group, index) => {
        if (group.displayOrder !== index) {
          updateGroupMutation.mutate({
            id: group.id,
            data: {
              displayOrder: index,
            },
          });
        }
      });
    }
    setDraggedGroupId(null);
    setOrderedGroups([]);
  };

  // Use ordered groups if dragging, otherwise use fetched groups
  const displayGroups = orderedGroups.length > 0 ? orderedGroups : typedGroups;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Groups"
        subtitle="Organize your holdings with custom groups"
        primaryAction={{
          label: 'New Group',
          onClick: () => setIsCreateDialogOpen(true),
          icon: <Plus className="h-4 w-4" />,
        }}
      />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !displayGroups || displayGroups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Palette className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No groups yet</h3>
            <p className="text-sm text-muted-foreground text-center max-w-md mb-4">
              Create custom groups to organize your holdings. Groups work like tags - you can assign
              multiple groups to each holding.
            </p>
            <Button onClick={() => setIsCreateDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Group
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {displayGroups.map((group) => (
            <Card
              key={group.id}
              className="hover:shadow-lg transition-shadow cursor-move"
              draggable
              onDragStart={() => handleDragStart(group.id)}
              onDragOver={(e) => handleDragOver(e, group.id)}
              onDragEnd={handleDragEnd}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex items-center gap-2">
                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: group.color }} />
                  <CardTitle className="text-lg">{group.name}</CardTitle>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleEditClick(group)}
                    className="h-8 w-8 p-0"
                  >
                    <Palette className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteClick(group)}
                    className="h-8 w-8 p-0 text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {group.description && (
                  <p className="text-sm text-muted-foreground mb-3">{group.description}</p>
                )}
                <div className="flex gap-4 text-sm">
                  <div>
                    <span className="font-medium">{group.holdingsCount}</span>{' '}
                    <span className="text-muted-foreground">
                      {group.holdingsCount === 1 ? 'holding' : 'holdings'}
                    </span>
                  </div>
                  <div>
                    <span className="font-medium">{group.accountsCount}</span>{' '}
                    <span className="text-muted-foreground">
                      {group.accountsCount === 1 ? 'account' : 'accounts'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Group</DialogTitle>
            <DialogDescription>
              Create a custom group to organize your holdings and accounts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Retirement, Emergency Fund, Crypto"
                maxLength={50}
              />
            </div>
            <div>
              <Label>Color</Label>
              <div className="grid grid-cols-9 gap-2 mt-2">
                {GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setFormData({ ...formData, color })}
                    className={`w-8 h-8 rounded-full border-2 transition-all ${
                      formData.color === color
                        ? 'border-foreground scale-110'
                        : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: color }}
                    aria-label={color}
                  />
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="What is this group for?"
                maxLength={200}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateGroup} disabled={!formData.name.trim()}>
              Create Group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Group</DialogTitle>
            <DialogDescription>Update the group name, color, or description.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Retirement, Emergency Fund, Crypto"
                maxLength={50}
              />
            </div>
            <div>
              <Label>Color</Label>
              <div className="grid grid-cols-9 gap-2 mt-2">
                {GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setFormData({ ...formData, color })}
                    className={`w-8 h-8 rounded-full border-2 transition-all ${
                      formData.color === color
                        ? 'border-foreground scale-110'
                        : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: color }}
                    aria-label={color}
                  />
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="edit-description">Description (optional)</Label>
              <Textarea
                id="edit-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="What is this group for?"
                maxLength={200}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateGroup} disabled={!formData.name.trim()}>
              Update Group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
