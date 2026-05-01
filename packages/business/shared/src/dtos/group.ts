import { z } from 'zod';

// Predefined color palette for groups (similar to macOS tags)
export const GROUP_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#10b981', // emerald
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#0ea5e9', // sky
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#a855f7', // purple
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#64748b', // slate
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export type Group = {
  id: string;
  userId: string;
  name: string;
  color: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export const CreateGroupDto = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  description: z.string().max(200).optional().nullable(),
  displayOrder: z.number().optional(),
});

export type CreateGroupInput = z.infer<typeof CreateGroupDto>;

export const UpdateGroupDto = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  description: z.string().max(200).optional().nullable(),
  displayOrder: z.number().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateGroupInput = z.infer<typeof UpdateGroupDto>;

// DTO for assigning groups to holdings
export const AssignHoldingGroupsDto = z.object({
  holdingId: z.string().uuid(),
  groupIds: z.array(z.string().uuid()),
});

export type AssignHoldingGroupsInput = z.infer<typeof AssignHoldingGroupsDto>;

// DTO for assigning groups to accounts
export const AssignAccountGroupsDto = z.object({
  accountId: z.string().uuid(),
  groupIds: z.array(z.string().uuid()),
});

export type AssignAccountGroupsInput = z.infer<typeof AssignAccountGroupsDto>;

// Extended holding type with groups
export const HoldingWithGroupsDto = z.object({
  id: z.string(),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
    })
  ),
});

export type HoldingWithGroups = z.infer<typeof HoldingWithGroupsDto>;

// Extended account type with groups
export const AccountWithGroupsDto = z.object({
  id: z.string(),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
    })
  ),
});

export type AccountWithGroups = z.infer<typeof AccountWithGroupsDto>;

// Group with counts for display
export const GroupWithCountsDto = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
  displayOrder: z.number(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  counts: z.object({
    holdings: z.number(),
    accounts: z.number(),
  }),
});

export type GroupWithCounts = z.infer<typeof GroupWithCountsDto>;
