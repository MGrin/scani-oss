# Quick Reference - Frontend V2

## Essential Commands

```bash
# Development
bun dev                 # Start dev server (port 5174)
bun run build          # Production build
bun run preview        # Preview production build
bun run type-check     # TypeScript validation
bun run clean          # Clean build artifacts

# Icon Generation
bun run generate-icons # Generate PWA icons
```

## File Structure Quick Reference

```
Key Files to Edit:
├── src/App.tsx                    # Main app component & routing
├── src/main.tsx                   # Entry point
├── src/lib/trpc.ts               # tRPC client config
├── src/lib/supabase.ts           # Supabase client
├── src/contexts/auth-context.tsx # Auth state
└── src/components/               # All components

Configuration Files (Don't Touch Unless Needed):
├── vite.config.ts      # Vite bundler config
├── tsconfig.json       # TypeScript config
├── tailwind.config.js  # Tailwind CSS config
└── package.json        # Dependencies & scripts
```

## Import Aliases

```typescript
import { Component } from "@/components/ui/component";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import type { User } from "@/types";
```

`@/` resolves to `src/`

## Common Patterns

### tRPC Query

```typescript
const { data, isLoading, error } = trpc.entity.query.useQuery();
```

### tRPC Mutation

```typescript
const mutation = trpc.entity.mutation.useMutation({
  onSuccess: () => {
    /* ... */
  },
});
```

### Form with Validation

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

const form = useForm({
  resolver: zodResolver(schema),
});
```

### Styling with Tailwind

```typescript
<div className="flex items-center gap-4 p-4 bg-card rounded-lg">
```

### Conditional Classes

```typescript
import { cn } from "@/lib/utils";

<div className={cn("base", isActive && "active", variant)} />;
```

## Component Template

```typescript
import { FC } from "react";

interface MyComponentProps {
  title: string;
  onAction?: () => void;
}

export const MyComponent: FC<MyComponentProps> = ({ title, onAction }) => {
  return (
    <div className="p-4">
      <h2>{title}</h2>
      {onAction && <button onClick={onAction}>Action</button>}
    </div>
  );
};
```

## Color Palette (CSS Variables)

Use these Tailwind classes for theming:

```
bg-background       # Main background
text-foreground     # Main text color
bg-card            # Card background
bg-primary         # Primary color
text-primary       # Primary text
bg-secondary       # Secondary color
text-muted         # Muted/subdued text
border-border      # Border color
```

## Environment Variables

Access in code:

```typescript
const apiUrl = import.meta.env.VITE_API_URL;
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
```

## Useful VS Code Extensions

Recommended (see `.vscode/extensions.json`):

- Tailwind CSS IntelliSense
- ESLint
- Prettier
- Error Lens
- TypeScript Next

## Debugging

### Check Build Output

```bash
bun run build && ls -lh dist/
```

### Check TypeScript Errors

```bash
bun run type-check
```

### Network Requests

Open DevTools → Network tab to see tRPC calls

### React DevTools

Install React DevTools browser extension

## Common Issues

### Import Errors

- Check file exists
- Verify import path
- Ensure proper file extension (.tsx for React components)

### Type Errors

- Run `bun run type-check`
- Check TypeScript configuration
- Verify imported types

### Styling Not Working

- Ensure Tailwind classes are in content paths
- Check PostCSS is processing
- Verify CSS is imported in main.tsx

### tRPC Not Working

- Backend must be running (port 3001)
- Check proxy configuration in vite.config.ts
- Verify API URL in .env

## Folder Purpose Reference

```
components/ui/       → Reusable UI primitives (buttons, inputs)
components/layout/   → Page structure (header, sidebar)
components/features/ → Domain components (accounts, portfolio)
pages/              → Route-level components
hooks/              → Custom React hooks
contexts/           → React Context providers
lib/                → Core utilities and clients
services/           → Business logic and API calls
types/              → TypeScript type definitions
utils/              → Helper functions
styles/             → Global styles (mainly in index.css)
```

## Next Steps Checklist

- [ ] Set up environment variables (.env)
- [ ] Implement tRPC client (lib/trpc.ts)
- [ ] Set up Supabase client (lib/supabase.ts)
- [ ] Create authentication context (contexts/auth-context.tsx)
- [ ] Add shadcn/ui components (components/ui/)
- [ ] Build layout components (components/layout/)
- [ ] Create routing structure (App.tsx)
- [ ] Implement first feature (dashboard or accounts)

## Resources

**Documentation:**

- This README.md
- ARCHITECTURE.md - Architecture overview
- DEVELOPMENT.md - Detailed implementation guide

**External:**

- [tRPC Docs](https://trpc.io)
- [React Query](https://tanstack.com/query)
- [shadcn/ui](https://ui.shadcn.com)
- [Tailwind CSS](https://tailwindcss.com)

## Getting Help

1. Check DEVELOPMENT.md for detailed guidance
2. Review existing frontend (v1) for reference
3. Check backend router types for API structure
4. Look at shadcn/ui documentation for component usage

## Remember

- Use `bun` not `npm` or `yarn`
- Port 5174 (not 5173)
- No tests required initially
- Focus on features first, optimize later
- Document as you code
