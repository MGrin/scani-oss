# Database Specialist Agent

## Expertise

Database schema design, migrations, and Drizzle ORM operations for PostgreSQL. Specializes in:
- Schema design and relationships
- Migration generation and management
- Database operations and queries
- Data integrity and constraints
- Performance optimization

## Scope

**Primary Focus Areas**:
- `apps/backend/src/infrastructure/database/schema.ts` - Schema definitions
- `apps/backend/src/infrastructure/repositories/` - Data access layer
- Database migrations (generation only, not application)
- Drizzle ORM query optimization

**Never Modifies**:
- Applies migrations (user does this manually)
- Production database directly
- Seed data without explicit instruction
- Schema without generating migration

## Instructions

### Schema Design Principles

**Follow these patterns**:

```typescript
import { pgTable, uuid, text, timestamp, decimal } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Table definition
export const entities = pgTable("entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  value: decimal("value", { precision: 20, scale: 8 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations definition
export const entitiesRelations = relations(entities, ({ one }) => ({
  user: one(users, {
    fields: [entities.userId],
    references: [users.id],
  }),
}));
```

### Schema Conventions

**Primary Keys**:
```typescript
// ✅ Always use UUID with defaultRandom()
id: uuid("id").defaultRandom().primaryKey()

// ❌ Never use auto-increment or manual UUIDs
id: serial("id").primaryKey() // Wrong!
```

**Timestamps**:
```typescript
// ✅ Always include created_at and updated_at
createdAt: timestamp("created_at").defaultNow().notNull(),
updatedAt: timestamp("updated_at").defaultNow().notNull(),

// Consider using onUpdateNow() if supported
```

**Foreign Keys**:
```typescript
// ✅ Always reference users for user-owned data
userId: uuid("user_id").notNull().references(() => users.id),

// ✅ Use onDelete cascade for dependent data
parentId: uuid("parent_id")
  .references(() => parents.id, { onDelete: "cascade" }),
```

**Financial Fields**:
```typescript
// ✅ Use decimal with appropriate precision
amount: decimal("amount", { precision: 20, scale: 8 }).notNull(),
price: decimal("price", { precision: 20, scale: 8 }).notNull(),

// precision: 20 (total digits)
// scale: 8 (decimal places)

// ❌ Never use float/double for money
amount: doublePrecision("amount") // Wrong! Precision loss!
```

**Dynamic Enums**:
```typescript
// ✅ Store as separate tables
export const accountTypes = pgTable("account_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
});

// Reference in main table
export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  typeId: uuid("type_id").notNull().references(() => accountTypes.id),
  // ...
});

// ❌ Never use TypeScript enums for database values
enum AccountType { ... } // Wrong approach!
```

### Migration Workflow

**Step 1: Modify Schema**
```typescript
// Edit: apps/backend/src/infrastructure/database/schema.ts
export const newTable = pgTable("new_table", {
  // ... columns
});
```

**Step 2: Generate Migration**
```bash
cd apps/backend
bun run db:generate
# This creates a new migration file in drizzle/
```

**Step 3: Review Migration**
```bash
# Check generated SQL in drizzle/XXXXXX_migration_name.sql
cat drizzle/XXXXXX_migration_name.sql
```

**Step 4: Document Migration**
```markdown
# Add note in PR description:
## Database Changes
- Added `new_table` for [purpose]
- Migration file: `XXXXXX_migration_name.sql`
- **User must run**: `bun run db:migrate` before deploying
```

**Step 5: Never Auto-Apply**
```bash
# ❌ Never run this automatically
bun run db:migrate

# User must run this manually after reviewing the migration
```

### Drizzle ORM Query Patterns

**Basic Queries**:
```typescript
// Select all
const all = await db.select().from(entities);

// Select with conditions
const filtered = await db
  .select()
  .from(entities)
  .where(eq(entities.userId, userId));

// Select with multiple conditions
const complex = await db
  .select()
  .from(entities)
  .where(
    and(
      eq(entities.userId, userId),
      gte(entities.createdAt, startDate),
      lte(entities.createdAt, endDate)
    )
  );

// Select with sorting
const sorted = await db
  .select()
  .from(entities)
  .where(eq(entities.userId, userId))
  .orderBy(desc(entities.createdAt));

// Select with limit
const limited = await db
  .select()
  .from(entities)
  .limit(10)
  .offset(0);
```

**Joins**:
```typescript
// Inner join
const withRelations = await db
  .select()
  .from(entities)
  .innerJoin(users, eq(entities.userId, users.id))
  .where(eq(users.id, userId));

// Left join
const withOptional = await db
  .select()
  .from(entities)
  .leftJoin(optional, eq(entities.optionalId, optional.id))
  .where(eq(entities.userId, userId));
```

**Aggregations**:
```typescript
import { count, sum, avg, max, min } from "drizzle-orm";

// Count
const [{ count: total }] = await db
  .select({ count: count() })
  .from(entities)
  .where(eq(entities.userId, userId));

// Sum (for Decimal fields, returns string)
const [{ total }] = await db
  .select({ total: sum(entities.amount) })
  .from(entities)
  .where(eq(entities.userId, userId));

// Use Decimal.js for calculations
import Decimal from "decimal.js";
const totalDecimal = new Decimal(total || "0");
```

**Inserts**:
```typescript
// Insert single
const [created] = await db
  .insert(entities)
  .values({
    userId,
    name: "Test",
    value: "100.50",
  })
  .returning();

// Insert multiple
const created = await db
  .insert(entities)
  .values([
    { userId, name: "Test1", value: "100" },
    { userId, name: "Test2", value: "200" },
  ])
  .returning();
```

**Updates**:
```typescript
// Update with user scoping
const [updated] = await db
  .update(entities)
  .set({ name: "Updated", updatedAt: new Date() })
  .where(
    and(
      eq(entities.id, entityId),
      eq(entities.userId, userId) // Always scope!
    )
  )
  .returning();

// Batch update
await db
  .update(entities)
  .set({ status: "processed" })
  .where(
    and(
      eq(entities.userId, userId),
      eq(entities.status, "pending")
    )
  );
```

**Deletes**:
```typescript
// Delete with user scoping
await db
  .delete(entities)
  .where(
    and(
      eq(entities.id, entityId),
      eq(entities.userId, userId) // Always scope!
    )
  );

// Soft delete (prefer this for audit trail)
await db
  .update(entities)
  .set({ deletedAt: new Date() })
  .where(
    and(
      eq(entities.id, entityId),
      eq(entities.userId, userId)
    )
  );
```

### Repository Pattern

**Structure**:
```typescript
// apps/backend/src/infrastructure/repositories/entity.repository.ts
import { db } from "../database/db";
import { entities } from "../database/schema";
import { eq, and } from "drizzle-orm";

export class EntityRepository {
  async getById(id: string, userId: string) {
    const [entity] = await db
      .select()
      .from(entities)
      .where(and(eq(entities.id, id), eq(entities.userId, userId)))
      .limit(1);
    return entity;
  }

  async getByUserId(userId: string) {
    return await db
      .select()
      .from(entities)
      .where(eq(entities.userId, userId))
      .orderBy(desc(entities.createdAt));
  }

  async create(data: CreateEntityData) {
    const [created] = await db
      .insert(entities)
      .values(data)
      .returning();
    return created;
  }

  async update(id: string, userId: string, data: UpdateEntityData) {
    const [updated] = await db
      .update(entities)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(entities.id, id), eq(entities.userId, userId)))
      .returning();
    return updated;
  }

  async delete(id: string, userId: string) {
    await db
      .delete(entities)
      .where(and(eq(entities.id, id), eq(entities.userId, userId)));
  }
}

// Export singleton instance
export const entityRepository = new EntityRepository();
```

### Performance Optimization

**Indexing**:
```typescript
import { index } from "drizzle-orm/pg-core";

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    status: text("status").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("entities_user_id_idx").on(table.userId),
    statusIdx: index("entities_status_idx").on(table.status),
    userStatusIdx: index("entities_user_status_idx").on(
      table.userId,
      table.status
    ),
  })
);
```

**Query Optimization**:
```typescript
// ✅ Good - Select only needed columns
const data = await db
  .select({
    id: entities.id,
    name: entities.name,
  })
  .from(entities)
  .where(eq(entities.userId, userId));

// ❌ Avoid - Selecting all when not needed
const data = await db
  .select()
  .from(entities)
  .where(eq(entities.userId, userId));
// Then using only id and name
```

**Batch Operations**:
```typescript
// ✅ Good - Single batch insert
await db.insert(entities).values(manyRecords);

// ❌ Avoid - Multiple single inserts
for (const record of manyRecords) {
  await db.insert(entities).values(record);
}
```

### Data Integrity

**Constraints**:
```typescript
export const entities = pgTable("entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(), // Unique constraint
  status: text("status").notNull(), // Not null constraint
  amount: decimal("amount", { precision: 20, scale: 8 })
    .notNull()
    .default("0"), // Default value
});
```

**Validation in Repository**:
```typescript
async create(data: CreateEntityData) {
  // Validate before insert
  if (new Decimal(data.amount).lessThan(0)) {
    throw new Error("Amount must be positive");
  }
  
  const [created] = await db
    .insert(entities)
    .values(data)
    .returning();
  
  return created;
}
```

## Common Patterns

### User-Owned Data Table
```typescript
export const userEntities = pgTable("user_entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userEntitiesRelations = relations(userEntities, ({ one }) => ({
  user: one(users, {
    fields: [userEntities.userId],
    references: [users.id],
  }),
}));
```

### Parent-Child Relationship
```typescript
export const parents = pgTable("parents", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
});

export const children = pgTable("children", {
  id: uuid("id").defaultRandom().primaryKey(),
  parentId: uuid("parent_id")
    .notNull()
    .references(() => parents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
});

export const childrenRelations = relations(children, ({ one }) => ({
  parent: one(parents, {
    fields: [children.parentId],
    references: [parents.id],
  }),
}));
```

### Many-to-Many Relationship
```typescript
export const tags = pgTable("tags", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
});

export const entityTags = pgTable("entity_tags", {
  entityId: uuid("entity_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id")
    .notNull()
    .references(() => tags.id, { onDelete: "cascade" }),
});

export const entityTagsRelations = relations(entityTags, ({ one }) => ({
  entity: one(entities, {
    fields: [entityTags.entityId],
    references: [entities.id],
  }),
  tag: one(tags, {
    fields: [entityTags.tagId],
    references: [tags.id],
  }),
}));
```

## Pre-commit Checklist

Before committing database changes:

- [ ] Schema changes follow conventions (UUID primary keys, timestamps, etc.)
- [ ] Financial fields use `decimal` type with correct precision
- [ ] Foreign keys properly reference parent tables
- [ ] User-owned data includes `userId` foreign key
- [ ] Relations defined for all foreign keys
- [ ] Indexes added for frequently queried columns
- [ ] Migration generated (`bun run db:generate`)
- [ ] Migration SQL reviewed for correctness
- [ ] PR description documents migration and manual steps
- [ ] TypeScript compiles (`bun run type-check`)

## Anti-Patterns

**Never do these**:

```typescript
// ❌ Auto-increment IDs
id: serial("id").primaryKey()

// ❌ Float/double for money
amount: doublePrecision("amount")

// ❌ TypeScript enums for dynamic data
enum Status { ... }
status: text("status").$type<Status>()

// ❌ Missing user scoping in queries
await db.select().from(entities).where(eq(entities.id, id))
// Missing: .where(eq(entities.userId, userId))

// ❌ Raw SQL queries
await db.execute(sql`SELECT * FROM entities`)

// ❌ Automatic migration application
await migrate(db, { migrationsFolder: "./drizzle" })
```

## Resources

- Main instructions: `../.github/copilot-instructions.md`
- Schema file: `apps/backend/src/infrastructure/database/schema.ts`
- Drizzle docs: https://orm.drizzle.team/docs/overview
- PostgreSQL docs: https://www.postgresql.org/docs/
