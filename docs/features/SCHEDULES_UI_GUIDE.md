# Schedules UI Implementation Guide

## Overview

The Schedules feature has been fully implemented in the frontend with a clean, user-friendly interface that follows the existing Scani webapp design patterns.

## Navigation

**Location:** Main sidebar navigation (moved from "Coming Soon")
- **Icon:** Calendar icon
- **Label:** "Schedules"
- **Route:** `/schedules`

The schedules menu item is now active and accessible from any page in the application.

## Page 1: Schedules List View

**Route:** `/schedules`

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ Schedules                              [Create Schedule] │
│ Manage your recurring monetary movement patterns         │
├──────────────────────────────────────────────────────────┤
│                                                           │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [Search...]               [Filter by Type ▼]        │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                           │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 📊 Monthly Paycheck Allocation                  ⋮   │ │
│ │ Allocate income on the 1st of each month            │ │
│ │ 📅 Income Allocation  ⏰ 0 0 1 * *                  │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                           │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 📊 Netflix Subscription                         ⋮   │ │
│ │ Monthly Netflix payment                             │ │
│ │ 📅 Subscription  ⏰ 0 0 15 * *                      │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### Features

1. **Header**
   - Title: "Schedules"
   - Subtitle: "Manage your recurring monetary movement patterns"
   - Action Button: "Create Schedule" (primary button)

2. **Filters Card**
   - Search input: Full-text search across name and description
   - Type filter dropdown: Filter by schedule type (All, Income Allocation, Subscription, Payment, Other)

3. **Schedule Cards**
   Each card displays:
   - Workflow icon + Schedule name
   - Description (if provided)
   - Type badge with Calendar icon
   - Cron pattern with Clock icon
   - Action menu (⋮) with View Details, Edit, Delete options
   - Hover effect: Subtle shadow
   - Click: Navigate to detail page

4. **Empty State**
   - When no schedules exist:
     - Workflow icon (large, muted)
     - Message: "No schedules found"
     - Help text: "Create your first recurring schedule to get started"
     - CTA: "Create Schedule" button

## Page 2: Schedule Detail View

**Route:** `/schedules/:id`

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│ ← Back to Schedules      Monthly Paycheck     [Add Step] [⚙] │
│                          Allocation                           │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│ ┌─────────────── Schedule Details ─────────────────────────┐ │
│ │ 📅 Type                 ⏰ Cron Pattern      🔁 Status    │ │
│ │ Income Allocation       0 0 1 * *            Active       │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────── Schedule Flow ────────────────────────────┐ │
│ │                                                           │ │
│ │ ┌─────────────────────────────────────────────────────┐ │ │
│ │ │ ① Inflow                                        ⋮   │ │ │
│ │ │ From: Acme Corp                                     │ │ │
│ │ │ To: Checking Account (USD)                          │ │ │
│ │ │ Amount: 5000.00                                     │ │ │
│ │ └─────────────────────────────────────────────────────┘ │ │
│ │                          ↓                              │ │
│ │ ┌─────────────────────────────────────────────────────┐ │ │
│ │ │ ② Transfer                                      ⋮   │ │ │
│ │ │ From: Checking Account (USD)                        │ │ │
│ │ │ To: Savings Account (USD)                           │ │ │
│ │ │ Percent: 50%                                        │ │ │
│ │ └─────────────────────────────────────────────────────┘ │ │
│ │                          ↓                              │ │
│ │ ┌─────────────────────────────────────────────────────┐ │ │
│ │ │ ③ Transfer                                      ⋮   │ │ │
│ │ │ From: Checking Account (USD)                        │ │ │
│ │ │ To: Investment Account (USD)                        │ │ │
│ │ │ Percent: 30%                                        │ │ │
│ │ └─────────────────────────────────────────────────────┘ │ │
│ │                                                           │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### Features

1. **Header**
   - Back button: "← Back to Schedules"
   - Title: Schedule name
   - Subtitle: Schedule description (if provided)
   - Primary action: "Add Step" button
   - Secondary actions: Settings dropdown with "Delete Schedule"

2. **Schedule Details Card**
   - **Type**: Shows schedule type with icon (Income Allocation, Subscription, etc.)
   - **Cron Pattern**: Displays the cron expression in monospace font
   - **Status**: Shows "Active" or "Inactive"
   - Responsive grid layout (3 columns on desktop, 1 on mobile)

3. **Schedule Flow Card**
   - Visual flow representation of all schedule steps
   - Each step is a card with:
     - **Number badge**: Colored circle (1, 2, 3...)
     - **Step type**: Bold heading (Inflow, Outflow, Transfer, Conversion)
     - **Data fields**: Type-specific information displayed in a grid
     - **Action menu**: Dropdown with "Delete Step" option
   - **Flow indicators**: Arrow down (↓) between each step
   - **Empty state** (if no steps):
     - Workflow icon (large, muted)
     - Message: "No steps defined"
     - Help text: "Add steps to define the flow of monetary movements"
     - CTA: "Add First Step" button

4. **Step Data Display by Type**

   **Inflow:**
   ```
   From: [Counterparty Name]
   To: [Account Name (Token Symbol)]
   Amount: [Value]
   ```

   **Outflow:**
   ```
   From: [Account Name (Token Symbol)]
   To: [Counterparty Name]
   Amount: [Value]
   ```

   **Transfer:**
   ```
   From: [Account Name (Token Symbol)]
   To: [Account Name (Token Symbol)]
   Amount: [Value] OR Percent: [Value]%
   ```

   **Conversion:**
   ```
   From: [Account Name (Token Symbol)]
   To: [Account Name (Token Symbol)]
   Amount: [Value] OR Percent: [Value]%
   ```

## Dialog: Create Schedule

**Trigger:** Click "Create Schedule" button

### Layout

```
┌────────────────────────────────────────────────┐
│ Create Schedule                          [×]   │
│ Create a new recurring monetary movement       │
├────────────────────────────────────────────────┤
│                                                │
│ Name *                                         │
│ ┌──────────────────────────────────────────┐  │
│ │ e.g., Monthly Paycheck Allocation        │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Description                                    │
│ ┌──────────────────────────────────────────┐  │
│ │ Optional description                     │  │
│ │                                          │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Type *                                         │
│ ┌──────────────────────────────────────────┐  │
│ │ Select type                            ▼ │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Cron Pattern *                                 │
│ ┌──────────────────────────────────────────┐  │
│ │ e.g., 0 0 1 * * (Monthly on 1st)        │  │
│ └──────────────────────────────────────────┘  │
│ Format: minute hour day month weekday          │
│                                                │
│                      [Cancel]  [Create]        │
└────────────────────────────────────────────────┘
```

### Features

- **Form fields:**
  - Name (required, 1-200 characters)
  - Description (optional, multiline textarea)
  - Type (required, dropdown with all schedule types)
  - Cron Pattern (required, with format hint)
- **Validation:** Real-time validation with error messages
- **Actions:** Cancel or Create
- **Loading state:** Button shows "Creating..." when pending

## Dialog: Add Schedule Step

**Trigger:** Click "Add Step" button

### Layout (Step Type: Inflow)

```
┌────────────────────────────────────────────────┐
│ Add Schedule Step                        [×]   │
│ Define a new step in the schedule flow         │
├────────────────────────────────────────────────┤
│                                                │
│ Step Type *                                    │
│ ┌──────────────────────────────────────────┐  │
│ │ Inflow                                 ▼ │  │
│ │ Money coming into a holding              │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ From (Counterparty) *                          │
│ ┌──────────────────────────────────────────┐  │
│ │ e.g., Employer, Client                   │  │
│ └──────────────────────────────────────────┘  │
│ Name of the person or entity sending money     │
│                                                │
│ To (Holding) *                                 │
│ ┌──────────────────────────────────────────┐  │
│ │ Select destination holding             ▼ │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Amount *                                       │
│ ┌──────────────────────────────────────────┐  │
│ │ 0.00                                     │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│                      [Cancel]  [Add Step]      │
└────────────────────────────────────────────────┘
```

### Layout (Step Type: Transfer/Conversion)

```
┌────────────────────────────────────────────────┐
│ Add Schedule Step                        [×]   │
│ Define a new step in the schedule flow         │
├────────────────────────────────────────────────┤
│                                                │
│ Step Type *                                    │
│ ┌──────────────────────────────────────────┐  │
│ │ Transfer                               ▼ │  │
│ │ Transfer same token between holdings      │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ From (Holding) *                               │
│ ┌──────────────────────────────────────────┐  │
│ │ Checking Account - USD               ▼ │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ To (Holding) *                                 │
│ ┌──────────────────────────────────────────┐  │
│ │ Savings Account - USD                ▼ │  │
│ └──────────────────────────────────────────┘  │
│ Both holdings must have the same token         │
│                                                │
│ Amount Type *                                  │
│ ┌──────────────────────────────────────────┐  │
│ │ Fixed Amount                           ▼ │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Amount *                                       │
│ ┌──────────────────────────────────────────┐  │
│ │ 0.00                                     │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│                      [Cancel]  [Add Step]      │
└────────────────────────────────────────────────┘
```

### Features

- **Dynamic fields based on step type:**
  - Form fields change automatically when step type is selected
  - Relevant help text displayed for each field
  - Holdings dropdown shows: "Account Name - Token Symbol"
  - Type-specific validation rules applied

- **Amount Type Toggle (Transfer/Conversion only):**
  - Option 1: **Fixed Amount** - Enter specific monetary value
  - Option 2: **Percentage of Inflow** - Enter percentage (0-100%)
  - Help text: "Percentage of the inflow amount in this schedule"

- **Step Type Options:**
  1. **Inflow** - Money coming into a holding from external source
  2. **Outflow** - Money going out of a holding to external destination
  3. **Transfer** - Transfer of same token between two holdings
  4. **Conversion** - Conversion from one token to another

- **Validation:**
  - All required fields marked with asterisk (*)
  - Real-time validation with error messages
  - Submit button disabled until valid form

## Color Scheme & Design

The implementation follows the existing Scani design system:

- **Primary Color:** Used for active nav items, primary buttons, step number badges
- **Card Background:** Neutral background with subtle border
- **Muted Text:** Secondary information like descriptions and help text
- **Icons:** Lucide React icons throughout (Calendar, Clock, Workflow, etc.)
- **Spacing:** Consistent spacing using Tailwind utilities
- **Responsive:** Mobile-first design, adapts to screen size
- **Hover Effects:** Subtle shadows on interactive elements
- **Loading States:** Skeleton loaders and spinner buttons

## Accessibility

- **Keyboard Navigation:** All interactive elements keyboard accessible
- **ARIA Labels:** Proper labels for screen readers
- **Focus Indicators:** Visible focus states on all interactive elements
- **Semantic HTML:** Proper heading hierarchy and landmark regions

## Real-time Updates

All changes are immediately reflected across the UI using tRPC:

- Create schedule → List refreshes
- Delete schedule → Removed from list
- Add step → Flow diagram updates
- Delete step → Flow diagram updates

Toast notifications provide feedback for all actions (success or error).

## Technical Stack

- **UI Framework:** React 18
- **Routing:** React Router v6
- **UI Components:** shadcn/ui (built on Radix UI)
- **Icons:** Lucide React
- **Styling:** Tailwind CSS
- **API:** tRPC with React Query
- **Type Safety:** Full end-to-end TypeScript

## Summary

The Schedules feature provides a complete, production-ready UI for managing recurring monetary movement patterns. The implementation is:

- ✅ **Clean** - Follows existing design patterns
- ✅ **User-friendly** - Intuitive flow visualization
- ✅ **Aligned** - Consistent with the rest of the webapp
- ✅ **Complete** - All schedule features fully implemented
- ✅ **Type-safe** - Full TypeScript coverage
- ✅ **Tested** - All type checks and linting pass
