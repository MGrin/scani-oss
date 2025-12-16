# Schedules Feature

## Overview

The Schedules feature allows users to define recurring patterns of monetary movements that will be repeated in the future. This is useful for modeling:

- Income allocation strategies (e.g., "When I get paid, put 50% in savings, 30% in investments, 20% in checking")
- Recurring subscriptions (e.g., "Pay $15 to Netflix every month")
- Recurring payments (e.g., "Transfer $500 to rent account on the 1st of each month")
- Other recurring monetary patterns

## Database Structure

### Tables

#### `schedules`
Main table for storing schedule definitions.

**Fields:**
- `id` (UUID) - Primary key
- `user_id` (UUID) - Foreign key to users table
- `name` (TEXT) - Name of the schedule
- `description` (TEXT, nullable) - Optional description
- `repetitive_cron_pattern` (TEXT) - Cron expression defining when the schedule repeats
- `type_id` (UUID) - Foreign key to schedule_types table
- `is_active` (BOOLEAN) - Whether the schedule is active
- `created_at`, `updated_at` (TIMESTAMP) - Audit timestamps

#### `schedule_types` (Enum Table)
Dynamic enum table for schedule types.

**Pre-seeded values:**
- `income_allocation` - Recurring pattern for allocating incoming income
- `subscription` - Recurring subscription payments
- `payment` - Recurring payment obligations
- `other` - Other types of recurring monetary movements

#### `schedule_steps`
Table for storing individual steps within a schedule.

**Fields:**
- `id` (UUID) - Primary key
- `schedule_id` (UUID) - Foreign key to schedules table
- `type_id` (UUID) - Foreign key to schedule_step_types table
- `data` (JSONB) - Step-specific data (structure varies by type)
- `step_order` (REAL) - Order of execution within the schedule
- `created_at`, `updated_at` (TIMESTAMP) - Audit timestamps

#### `schedule_step_types` (Enum Table)
Dynamic enum table for schedule step types.

**Pre-seeded values:**
- `inflow` - Money coming into a holding from an external source
- `outflow` - Money going out of a holding to an external destination
- `transfer` - Transfer of the same token between two holdings
- `conversion` - Conversion from one token to another between holdings

## Schedule Step Data Structures

The `data` field in `schedule_steps` is a JSONB object that varies based on the step type:

### Inflow Step
Represents money coming into a holding.

```json
{
  "from": "Employer Name",           // Name of counterparty
  "toHoldingId": "uuid",             // Holding receiving money
  "amount": "5000.00"                // Amount as string for precision
}
```

### Outflow Step
Represents money leaving a holding.

```json
{
  "fromHoldingId": "uuid",           // Holding sending money
  "to": "Netflix",                   // Name of counterparty
  "amount": "15.99"                  // Amount as string for precision
}
```

### Transfer Step
Represents transferring the same token between holdings.

**Important:** Both holdings must contain the same token type.

```json
{
  "fromHoldingId": "uuid",           // Source holding
  "toHoldingId": "uuid",             // Destination holding
  "amount": "1000.00"                // Fixed amount (mutually exclusive with percent)
}
```

OR

```json
{
  "fromHoldingId": "uuid",           // Source holding
  "toHoldingId": "uuid",             // Destination holding
  "percent": 50                      // Percentage of inflow (mutually exclusive with amount)
}
```

### Conversion Step
Represents converting from one token to another.

```json
{
  "fromHoldingId": "uuid",           // Source holding
  "toHoldingId": "uuid",             // Destination holding (different token)
  "amount": "500.00"                 // Fixed amount (mutually exclusive with percent)
}
```

OR

```json
{
  "fromHoldingId": "uuid",           // Source holding
  "toHoldingId": "uuid",             // Destination holding (different token)
  "percent": 30                      // Percentage of inflow (mutually exclusive with amount)
}
```

## API Endpoints

All endpoints are protected and require authentication.

### Schedules

- `GET /schedules/getAll` - Get all schedules for the authenticated user
- `GET /schedules/getById?id={uuid}` - Get a specific schedule by ID
- `POST /schedules/create` - Create a new schedule
- `PATCH /schedules/update` - Update an existing schedule
- `DELETE /schedules/delete?id={uuid}` - Delete a schedule (soft delete)

### Schedule Steps

- `GET /schedules/getSteps?id={scheduleId}` - Get all steps for a schedule
- `POST /schedules/createStep` - Create a new schedule step
- `PATCH /schedules/updateStep` - Update an existing schedule step
- `DELETE /schedules/deleteStep?id={stepId}&scheduleId={scheduleId}` - Delete a schedule step

## Validation Rules

### Schedule Creation
- `name` is required and must be 1-200 characters
- `repetitiveCronPattern` is required and must be a valid cron expression
- `typeId` is required and must reference a valid schedule type

### Schedule Step Creation
- `scheduleId` is required and must reference a valid schedule
- `typeId` is required and must reference a valid schedule step type
- `data` must conform to the structure for the specified step type

### Transfer Steps
- Both `fromHoldingId` and `toHoldingId` must reference holdings owned by the user
- Both holdings must contain the same token
- Exactly one of `amount` or `percent` must be provided (mutually exclusive)

### Conversion Steps
- Both `fromHoldingId` and `toHoldingId` must reference holdings owned by the user
- Holdings can have different tokens
- Exactly one of `amount` or `percent` must be provided (mutually exclusive)

## Real-time Updates

The schedules feature integrates with the WebSocket real-time updates system. The following entity types are supported:

- `schedule` - For schedule create, update, and delete operations
- `schedule_step` - For schedule step create, update, and delete operations

## Cron Pattern Format

The `repetitiveCronPattern` field uses standard cron format:

```
* * * * *
│ │ │ │ │
│ │ │ │ └─── Day of week (0-6, Sunday = 0)
│ │ │ └───── Month (1-12)
│ │ └─────── Day of month (1-31)
│ └───────── Hour (0-23)
└─────────── Minute (0-59)
```

**Examples:**
- `0 9 1 * *` - Every month on the 1st at 9:00 AM
- `0 0 * * 1` - Every Monday at midnight
- `0 12 * * *` - Every day at noon
- `*/15 * * * *` - Every 15 minutes

## Usage Example

### Creating a Paycheck Allocation Schedule

This example shows how to create a schedule that allocates a monthly paycheck:

1. **Create the schedule:**
```json
POST /schedules/create
{
  "name": "Monthly Paycheck Allocation",
  "description": "Allocate paycheck on the 1st of each month",
  "repetitiveCronPattern": "0 9 1 * *",
  "typeId": "<income_allocation_type_id>"
}
```

2. **Add inflow step (paycheck arrives):**
```json
POST /schedules/createStep
{
  "scheduleId": "<schedule_id>",
  "typeId": "<inflow_type_id>",
  "stepOrder": 1,
  "data": {
    "from": "Acme Corp",
    "toHoldingId": "<checking_account_holding_id>",
    "amount": "5000.00"
  }
}
```

3. **Add transfer step (50% to savings):**
```json
POST /schedules/createStep
{
  "scheduleId": "<schedule_id>",
  "typeId": "<transfer_type_id>",
  "stepOrder": 2,
  "data": {
    "fromHoldingId": "<checking_account_holding_id>",
    "toHoldingId": "<savings_account_holding_id>",
    "percent": 50
  }
}
```

4. **Add transfer step (30% to investments):**
```json
POST /schedules/createStep
{
  "scheduleId": "<schedule_id>",
  "typeId": "<transfer_type_id>",
  "stepOrder": 3,
  "data": {
    "fromHoldingId": "<checking_account_holding_id>",
    "toHoldingId": "<investment_account_holding_id>",
    "percent": 30
  }
}
```

## Database Migration

To apply the schedules feature to your database:

```bash
cd /path/to/scani
bun run db:migrate
```

This will:
1. Create the `schedules`, `schedule_steps`, `schedule_types`, and `schedule_step_types` tables
2. Seed the initial schedule types and schedule step types

## Future Enhancements

The following features could be added in future iterations:

- **Schedule execution engine** - Automatically execute schedules based on cron patterns
- **Schedule history** - Track past executions of schedules
- **Dry-run mode** - Preview what a schedule would do without executing it
- **Schedule templates** - Pre-defined schedule patterns users can copy
- **Schedule recommendations** - AI-powered suggestions based on user's financial data
- **Conditional steps** - Steps that only execute if certain conditions are met
- **Schedule notifications** - Alert users before/after schedule execution

## Implementation Notes

### Architecture
- Follows clean architecture with Repository → Service → Router layers
- All database operations use Drizzle ORM (no raw SQL)
- User scoping enforced at service layer
- All endpoints protected with JWT authentication

### Security
- All holdings referenced in schedule steps are validated to belong to the user
- Token matching enforced for transfer steps
- Input validation using Zod schemas
- Soft delete for schedules (preserves audit trail)

### Data Integrity
- Foreign key constraints ensure referential integrity
- Cascade deletes when users are deleted
- Restrict deletes on enum tables to prevent orphaned data
- Indexes on frequently queried fields for performance
