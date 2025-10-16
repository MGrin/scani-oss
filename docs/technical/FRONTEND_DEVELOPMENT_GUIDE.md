# Development Notes - Frontend V2

## Quick Start

```bash
# Install dependencies
bun install

# Start dev server
bun dev

# Build for production
bun run build
```

## Project Status

**Status**: Initial setup complete ✅
**Next Steps**: Begin implementing core features

## What's Ready

- ✅ Project structure and folders
- ✅ All configuration files (TypeScript, Vite, Tailwind, PostCSS)
- ✅ Package dependencies installed
- ✅ Build tooling configured
- ✅ Development server runs on port 5174
- ✅ Basic routing skeleton
- ✅ Placeholder files for all major features
- ✅ PWA manifest and service worker templates
- ✅ Environment variable setup

## What Needs Implementation

### Phase 1: Foundation (Priority: High)

1. **tRPC Client Setup** (`src/lib/trpc.ts`)

   - Configure tRPC React Query integration
   - Set up HTTP client with auth headers
   - Add error handling

2. **Supabase Client** (`src/lib/supabase.ts`)

   - Initialize Supabase client
   - Configure auth persistence
   - Set up real-time subscriptions

3. **Authentication Context** (`src/contexts/auth-context.tsx`)

   - Create auth provider
   - Implement login/logout/signup flows
   - Add protected route wrapper
   - Handle token refresh

4. **Base UI Components** (`src/components/ui/`)
   - Add shadcn/ui components:
     - Button, Input, Select
     - Dialog, Sheet, Popover
     - Card, Toast, Avatar
     - Form components
   - Create component documentation

### Phase 2: Layout & Navigation (Priority: High)

5. **Layout Components** (`src/components/layout/`)

   - `AppLayout.tsx` - Main app shell
   - `Header.tsx` - Top navigation bar
   - `Sidebar.tsx` - Side navigation
   - `MobileNav.tsx` - Mobile navigation drawer
   - `Footer.tsx` - Footer (if needed)

6. **Routing Structure** (`src/App.tsx`)
   - Define route configuration
   - Add protected routes
   - Implement loading states
   - Add error boundaries
   - 404 page

### Phase 3: Core Features (Priority: High)

7. **Dashboard Page** (`src/pages/Dashboard.tsx`)

   - Portfolio overview
   - Recent transactions
   - Account summaries
   - Quick actions

8. **Accounts Feature** (`src/components/features/accounts/`)

   - Account list view
   - Account detail view
   - Create/edit account forms
   - Account type selection

9. **Transactions Feature** (`src/components/features/transactions/`)

   - Transaction list with filtering
   - Transaction detail view
   - Add transaction form
   - Import transactions

10. **Portfolio Feature** (`src/components/features/portfolio/`)
    - Portfolio value chart
    - Asset allocation
    - Performance metrics
    - Holdings table

### Phase 4: Advanced Features (Priority: Medium)

11. **Crypto Wallets** (`src/components/features/wallets/`)

    - Wallet connection
    - Token balances
    - Transaction history
    - Multi-chain support

12. **Settings & Profile** (`src/pages/Settings.tsx`)

    - User profile
    - Account settings
    - Notification preferences
    - Theme selection

13. **Charts & Visualizations**
    - Recharts integration
    - Portfolio performance over time
    - Asset allocation pie chart
    - Transaction trends

### Phase 5: Polish & PWA (Priority: Medium)

14. **PWA Features**

    - Icon generation script
    - Service worker caching
    - Offline support
    - Install prompts

15. **Performance Optimization**

    - Code splitting
    - Lazy loading
    - Image optimization
    - Bundle analysis

16. **Accessibility**
    - Keyboard navigation
    - Screen reader support
    - Focus management
    - ARIA labels

### Phase 6: Testing & Quality (Priority: Low)

17. **Testing Setup**
    - Vitest configuration
    - Component tests
    - Integration tests
    - E2E tests (optional)

## Implementation Tips

### tRPC Integration

```typescript
// lib/trpc.ts
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@scani/backend/router";

export const trpc = createTRPCReact<AppRouter>();

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${import.meta.env.VITE_API_URL}/trpc`,
      headers: async () => {
        const token = localStorage.getItem("supabase.auth.token");
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});
```

### Component Structure

Each feature should follow this pattern:

```
features/[feature]/
├── index.ts              # Exports
├── [Feature]List.tsx     # List view
├── [Feature]Detail.tsx   # Detail view
├── [Feature]Form.tsx     # Create/edit form
├── [Feature]Card.tsx     # Card component
└── hooks/
    └── use[Feature].ts   # Feature-specific hooks
```

### Form Pattern

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const schema = z.object({
  name: z.string().min(1),
  amount: z.number().positive(),
});

function MyForm() {
  const form = useForm({
    resolver: zodResolver(schema),
  });

  // ...
}
```

## Development Workflow

1. **Start with the foundation**: tRPC, auth, and base components
2. **Build layout**: Get the shell working first
3. **Implement features one by one**: Complete each feature fully before moving on
4. **Test as you go**: Manual testing in the browser
5. **Iterate on UX**: Improve based on user feedback

## Architecture Decisions

### Why Separate from V1?

- Clean slate for better architecture
- Remove technical debt
- Implement modern patterns
- Better performance and UX
- Easier to maintain

### Key Improvements Over V1

- Better component organization
- Cleaner state management
- Type-safe API layer
- Modern UI components
- PWA optimizations
- Better mobile experience

### Technology Choices

- **Vite**: Faster than Create React App, better DX
- **Tailwind**: Rapid styling, smaller bundle
- **shadcn/ui**: Better than component libraries (bundle size, customization)
- **React Query**: Best practice for server state
- **tRPC**: Type safety without code generation

## Common Patterns

### Loading States

```typescript
const { data, isLoading, error } = trpc.query.useQuery();

if (isLoading) return <Skeleton />;
if (error) return <ErrorMessage error={error} />;
return <Component data={data} />;
```

### Mutations

```typescript
const mutation = trpc.mutation.useMutation({
  onSuccess: () => {
    toast({ title: "Success!" });
    queryClient.invalidateQueries();
  },
  onError: (error) => {
    toast({ title: "Error", description: error.message });
  },
});
```

### Conditional Classes

```typescript
import { cn } from "@/lib/utils";

<div
  className={cn(
    "base-classes",
    condition && "conditional-classes",
    variant === "primary" && "primary-classes"
  )}
/>;
```

## Resources

- [React Query Docs](https://tanstack.com/query/latest)
- [tRPC Docs](https://trpc.io/docs)
- [shadcn/ui Components](https://ui.shadcn.com/)
- [Tailwind CSS Docs](https://tailwindcss.com/docs)
- [Vite Guide](https://vitejs.dev/guide/)

## Environment Setup

Copy `.env.example` to `.env` and fill in:

```env
VITE_SUPABASE_URL=your_project_url
VITE_SUPABASE_ANON_KEY=your_anon_key
VITE_API_URL=http://localhost:3001
```

Get these values from:

1. Supabase Dashboard → Project Settings → API
2. Backend should be running on port 3001

## Port Information

- **Frontend V1**: 5173
- **Frontend V2**: 5174 (this app)
- **Backend**: 3001

## Code Style

- Use functional components with hooks
- Prefer const over let
- Use TypeScript types, not any
- Document complex functions
- Keep files under 200 lines
- One component per file
- Co-locate related files

## Git Workflow

- Branch from `ng/refactor-into-proper-architecture`
- Feature branches: `feature/[feature-name]`
- Commit messages: `feat: add feature` or `fix: resolve bug`
- PR review required before merge

## Notes

- No tests required initially (per project guidelines)
- Focus on functionality and UX first
- Optimize after features are working
- Document as you build
- Keep the existing frontend (v1) running during development
