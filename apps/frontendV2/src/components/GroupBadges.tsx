import { Badge } from "@/components/ui/badge";

export interface Group {
  id: string;
  name: string;
  color?: string;
}

interface GroupBadgesProps {
  groups?: Group[];
  maxDisplay?: number;
  size?: "sm" | "md" | "lg";
}

export function GroupBadges({
  groups = [],
  maxDisplay = 3,
  size = "sm",
}: GroupBadgesProps) {
  if (!groups || groups.length === 0) {
    return <span className="text-xs text-muted-foreground">No groups</span>;
  }

  const displayedGroups = groups.slice(0, maxDisplay);
  const remainingCount = Math.max(0, groups.length - maxDisplay);

  const sizeClasses = {
    sm: "text-xs px-2 py-0.5",
    md: "text-sm px-2.5 py-1",
    lg: "text-base px-3 py-1.5",
  };

  const getBadgeStyle = (color?: string) => {
    if (!color) return undefined;
    // Color can be hex or named color, just pass it through
    return { backgroundColor: color, opacity: 0.2 };
  };

  return (
    <div className="flex flex-wrap gap-1">
      {displayedGroups.map((group) => (
        <Badge
          key={group.id}
          variant="outline"
          className={`${sizeClasses[size]} truncate`}
          style={getBadgeStyle(group.color)}
        >
          {group.name}
        </Badge>
      ))}
      {remainingCount > 0 && (
        <Badge variant="secondary" className={`${sizeClasses[size]}`}>
          +{remainingCount}
        </Badge>
      )}
    </div>
  );
}
