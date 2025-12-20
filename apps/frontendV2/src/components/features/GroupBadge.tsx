import { Badge } from '@/components/ui/badge';

interface GroupBadgeProps {
  groupName: string;
  groupColor: string;
  className?: string;
}

export function GroupBadge({ groupName, groupColor, className }: GroupBadgeProps) {
  return (
    <Badge variant="secondary" className={`inline-flex items-center gap-1.5 ${className || ''}`}>
      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: groupColor }} />
      {groupName}
    </Badge>
  );
}

interface GroupBadgesProps {
  groups: Array<{ id: string; name: string; color: string }>;
  className?: string;
}

export function GroupBadges({ groups, className }: GroupBadgesProps) {
  if (!groups || groups.length === 0) {
    return null;
  }

  return (
    <div className={`flex flex-wrap gap-1 ${className || ''}`}>
      {groups.map((group) => (
        <GroupBadge key={group.id} groupName={group.name} groupColor={group.color} />
      ))}
    </div>
  );
}
