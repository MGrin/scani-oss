# Feature UI Mockup: Show and Restore Removed Holdings

## Account Detail Page - Wallet Account

### Filter Section (Desktop View)
```
┌─────────────────────────────────────────────────────────────────────┐
│ Holdings (42 total, 42 shown)                    Total: $125,432.50 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  🔍 Search holdings...                                              │
│                                                                      │
│  [Filter by type ▼]  [Filter by token ▼]  [All Values ▼]           │
│                                                                      │
│  ☑ Show removed holdings                                            │
│                                                                      │
│  [Clear Filters]                        [Cards] [Table]             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Filter Section (Mobile View)
```
┌────────────────────────────────┐
│ Holdings (42 total)            │
│ Total: $125,432.50             │
├────────────────────────────────┤
│ 🔍 Search...                   │
│                                │
│ [Filter by type ▼]             │
│ [Filter by token ▼]            │
│ [All Values ▼]                 │
│                                │
│ ☑ Show removed holdings        │
│                                │
│ [Clear Filters]                │
│ [Cards] [Table]                │
└────────────────────────────────┘
```

## Holdings Table View - With Removed Holdings Shown

### Desktop Table View
```
┌────────────────────────────────────────────────────────────────────────┐
│ ☑ Token              Amount       Price         Value        Actions  │
├────────────────────────────────────────────────────────────────────────┤
│ ☐ BTC                                                                  │
│   Bitcoin            0.5432       $43,250.00    $23,485.40   ⋯        │
│   [Cryptocurrency]                                                     │
├────────────────────────────────────────────────────────────────────────┤
│ ☐ ETH [Removed]                                                        │
│   Ethereum           2.3         $2,250.00      $5,175.00    ⋯        │
│   [Cryptocurrency]                                                     │
├────────────────────────────────────────────────────────────────────────┤
│ ☐ USDT                                                                 │
│   Tether             1000.00      $1.00         $1,000.00    ⋯        │
│   [Stablecoin]                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Mobile Card View
```
┌─────────────────────────────────┐
│ BTC [Cryptocurrency]            │
│ Bitcoin                         │
│                                 │
│ Amount: 0.5432                  │
│ Price: $43,250.00               │
│ Value: $23,485.40               │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ ETH [Cryptocurrency] [Removed]  │
│ Ethereum                        │
│                                 │
│ Amount: 2.3                     │
│ Price: $2,250.00                │
│ Value: $5,175.00                │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ USDT [Stablecoin]               │
│ Tether                          │
│                                 │
│ Amount: 1000.00                 │
│ Price: $1.00                    │
│ Value: $1,000.00                │
└─────────────────────────────────┘
```

## Action Menus

### For Visible Holding
```
┌──────────────────────┐
│ ⋯                    │
│ ┌──────────────────┐ │
│ │ 🗑️  Remove Holding│ │  ← Red text
│ └──────────────────┘ │
└──────────────────────┘
```

### For Hidden/Removed Holding
```
┌──────────────────────┐
│ ⋯                    │
│ ┌──────────────────┐ │
│ │ ↩️  Restore Holding│ │  ← Green text
│ └──────────────────┘ │
└──────────────────────┘
```

## User Flows

### Flow 1: View Removed Holdings
```
1. User opens wallet account detail page
   │
   ├─ Sees "Show removed holdings" checkbox
   │
2. User clicks checkbox
   │
   ├─ Holdings list refreshes
   ├─ Removed holdings appear with [Removed] badge
   │
3. User can view all holdings including removed ones
```

### Flow 2: Restore a Removed Holding
```
1. User enables "Show removed holdings"
   │
   ├─ Sees removed holding with [Removed] badge
   │
2. User clicks action menu (⋯)
   │
   ├─ Menu shows "↩️ Restore Holding" option
   │
3. User clicks "Restore Holding"
   │
   ├─ Holding is restored
   ├─ [Removed] badge disappears
   ├─ Toast: "Holding restored"
   │
4. Holding now appears in normal list
```

### Flow 3: Non-Wallet Account (No Toggle)
```
1. User opens manual/exchange account
   │
   ├─ NO "Show removed holdings" checkbox visible
   │
2. Normal behavior - delete is permanent
```

## Visual Design Notes

### Color Scheme
- **Removed Badge**: Muted gray background (`bg-muted`)
- **Restore Action**: Green text (`text-green-600`)
- **Remove Action**: Red text (`text-destructive`)

### Badge Styling
```css
Removed Badge:
- Background: Muted gray
- Text: Muted foreground
- Padding: Small (px-2 py-0.5)
- Border radius: Rounded corners
- Font size: Extra small (text-xs)
```

### Checkbox Styling
```css
Checkbox:
- Size: 16x16px (h-4 w-4)
- Border: Primary color
- Checked state: Primary background
- Focus: Ring offset for accessibility
- Label: Clickable, medium weight font
```

### Responsive Behavior
- **Desktop**: Filters displayed in a single row
- **Tablet**: Filters wrap as needed
- **Mobile**: Filters stack vertically
- **All sizes**: Checkbox label wraps if needed

## Accessibility Features

1. **Keyboard Navigation**
   - Checkbox is fully keyboard accessible
   - Tab navigation through all interactive elements
   - Enter/Space to toggle checkbox

2. **Screen Readers**
   - Label properly associated with checkbox
   - "Removed" badge announced when present
   - Action buttons have descriptive text

3. **Visual Feedback**
   - Clear focus indicators
   - High contrast for badges
   - Touch-friendly target sizes (mobile)

## Edge Cases Handled

1. **Empty State**: When no holdings match filters
2. **All Hidden**: When all holdings are removed
3. **Toggle While Filtered**: Other filters remain active
4. **Clear Filters**: Resets toggle to unchecked state
5. **Real-time Updates**: WebSocket events update UI
6. **Error Handling**: Toast notifications for failures

---

## Implementation Notes

- Badge is inline with token symbol
- Mobile layout ensures all text is readable
- Actions context-aware based on holding state
- No flickering during toggle transitions
- Proper loading states maintained
