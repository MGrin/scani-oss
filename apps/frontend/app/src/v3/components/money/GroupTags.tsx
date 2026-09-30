import { Badge } from '@scani/ui/ui/badge';
import type { ReactNode } from 'react';

export interface GroupTag {
  name: string;
  color: string;
}

/**
 * The groups a bill is in (SC-1408), as badges in the row's value zone under
 * whatever that line already says. Not in the sublabel: the identity zone
 * truncates, and a badge beside a payee's name cuts the name off — the reason
 * Accounts and the group page moved theirs there (UI standard, rule 5). Drawn
 * as the holding peek draws a group: an outline in the group's own colour.
 * Unknown ids are skipped rather than shown as blanks, because the group list
 * may still be arriving.
 */
export function WithGroupTags({
  groupIds,
  groupById,
  children,
  align = 'items-end',
}: {
  groupIds: readonly string[] | undefined;
  groupById: ReadonlyMap<string, GroupTag>;
  children?: ReactNode;
  /** `items-start` in a table column, which reads left to right. */
  align?: 'items-end' | 'items-start';
}) {
  const tags = (groupIds ?? []).flatMap((id) => {
    const group = groupById.get(id);
    return group ? [{ id, ...group }] : [];
  });
  if (tags.length === 0) return <>{children}</>;
  return (
    <span className={`flex flex-col ${align} gap-1`}>
      {children}
      {tags.map((tag) => (
        <Badge key={tag.id} variant="outline" style={{ borderColor: tag.color, color: tag.color }}>
          {tag.name}
        </Badge>
      ))}
    </span>
  );
}
