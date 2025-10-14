# Frontend V2 Architecture

## Overview

This document describes the architectural decisions and patterns for Scani Frontend V2.

## Design Principles

1. **Separation of Concerns**: Clear boundaries between UI, business logic, and data
2. **Type Safety**: End-to-end type safety with TypeScript and tRPC
3. **Performance**: Code splitting, lazy loading, and optimized bundle size
4. **Accessibility**: WCAG 2.1 AA compliance
5. **Mobile First**: Progressive Web App with offline capabilities
6. **Maintainability**: Clean, documented, testable code

## Technology Stack

### Core Technologies

- **React 18**: Component framework with hooks and concurrent features
- **TypeScript 5**: Static typing and enhanced IDE support
- **Vite**: Fast build tool with HMR
- **Bun**: Package manager and runtime

### Styling

- **Tailwind CSS**: Utility-first CSS framework
- **shadcn/ui**: High-quality, accessible component library
- **CSS Variables**: Theme customization via HSL color space

### Data Layer

- **tRPC**: Type-safe API client with automatic type inference
- **React Query**: Async state management, caching, and synchronization
- **Zod**: Runtime validation and schema definition

### Authentication

- **Supabase Auth**: JWT-based authentication
- **React Context**: Auth state management across the app

### Routing

- **React Router v6**: Client-side routing with data loaders

### Forms

- **React Hook Form**: Performant form management
- **Zod Resolver**: Validation integration

## Folder Structure

### Components Architecture

```
components/
├── ui/              # Atomic, reusable components (shadcn/ui)
│   ├── button.tsx
│   ├── dialog.tsx
│   ├── input.tsx
│   └── ...
├── layout/          # Structural components
│   ├── AppLayout.tsx
│   ├── Header.tsx
│   ├── Sidebar.tsx
│   └── Navigation.tsx
└── features/        # Domain-specific components
    ├── portfolio/
    ├── accounts/
    ├── transactions/
    └── wallets/
```

### State Management

```
contexts/            # Global state via React Context
├── auth-context.tsx
├── theme-context.tsx
└── settings-context.tsx

hooks/               # Custom React hooks
├── useAuth.ts
├── useTheme.ts
└── useDebounce.ts
```

### API Integration

```
lib/
├── trpc.ts          # tRPC client configuration
├── supabase.ts      # Supabase client
└── utils.ts         # Utility functions (cn, formatters)

services/            # Business logic layer
├── portfolio.ts
├── pricing.ts
└── analytics.ts
```

## Component Patterns

### Component Types

1. **Presentational Components** (`components/ui/`)

   - Pure, stateless when possible
   - Accept props, emit events
   - No business logic
   - Highly reusable

2. **Container Components** (`components/features/`)

   - Connect to data layer (tRPC hooks)
   - Handle business logic
   - Compose presentational components
   - Feature-specific

3. **Layout Components** (`components/layout/`)

   - Structural organization
   - Navigation and routing
   - Global UI elements

4. **Page Components** (`pages/`)
   - Top-level route components
   - Data loading and error boundaries
   - Compose containers and layouts

### Example Component Structure

```typescript
// components/features/portfolio/PortfolioCard.tsx
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";

interface PortfolioCardProps {
  portfolioId: string;
}

export function PortfolioCard({ portfolioId }: PortfolioCardProps) {
  const { data, isLoading } = trpc.portfolio.getById.useQuery({
    id: portfolioId,
  });

  if (isLoading) return <Card.Skeleton />;

  return <Card>{/* Render portfolio data */}</Card>;
}
```

## Data Flow

### tRPC Query Pattern

```typescript
// Query data
const { data, isLoading, error } = trpc.accounts.getAll.useQuery();

// Mutation
const createAccount = trpc.accounts.create.useMutation({
  onSuccess: () => {
    // Invalidate and refetch
    trpcUtils.accounts.getAll.invalidate();
  },
});
```

### Authentication Flow

```
1. User logs in via Supabase
2. JWT token stored in localStorage
3. AuthContext provides user state
4. tRPC client includes token in headers
5. Backend validates and authorizes requests
```

## Performance Optimization

### Code Splitting

- Route-based splitting via `React.lazy()`
- Component lazy loading for heavy features
- Dynamic imports for large libraries

### Bundle Optimization

- Tree shaking enabled (Vite + ES modules)
- CSS purging (Tailwind)
- Image optimization (WebP, lazy loading)

### Caching Strategy

- React Query for API caching
- Service Worker for offline assets
- LocalStorage for user preferences

## PWA Features

### Manifest Configuration

- App name, icons, theme colors
- Display mode: standalone
- Orientation: portrait-primary
- Shortcuts to key features

### Service Worker

- Cache-first for static assets
- Network-first for API calls
- Offline fallback page

### Installation

- Add to Home Screen prompt
- iOS Safari support
- Android TWA (Trusted Web Activity)

## Accessibility

### Standards

- WCAG 2.1 AA compliance
- Semantic HTML
- ARIA attributes where needed
- Keyboard navigation support

### Implementation

- Focus management
- Screen reader announcements
- Color contrast ratios (4.5:1 minimum)
- Touch target sizes (44x44px minimum)

## Error Handling

### Levels

1. **Component Level**: Error boundaries around features
2. **API Level**: tRPC error handling with React Query
3. **Form Level**: Validation errors with user feedback
4. **Global Level**: Toast notifications for system errors

### User Feedback

- Loading states for async operations
- Error messages with actionable guidance
- Success confirmations
- Progress indicators

## Testing Strategy (Future)

- Unit tests: Components and utilities (Vitest)
- Integration tests: Feature workflows (Testing Library)
- E2E tests: Critical user paths (Playwright)
- Visual regression: Component library (Chromatic)

## Security Considerations

### Client-Side

- XSS prevention (React automatic escaping)
- CSRF protection (Supabase Auth)
- Secure token storage
- Input validation and sanitization

### API Communication

- HTTPS only
- JWT token authentication
- Request rate limiting
- CORS configuration

## Deployment

### Build Process

1. Type checking (`tsc --noEmit`)
2. Icon generation
3. Vite build
4. Asset optimization
5. Service worker generation

### Environment Variables

- Development: `.env.development`
- Production: `.env.production`
- Never commit secrets

### Hosting

- Static hosting (Vercel, Netlify, Cloudflare Pages)
- CDN for global distribution
- Automatic HTTPS
- Preview deployments for PRs

## Future Enhancements

1. **Internationalization** (i18n)

   - Multi-language support
   - Currency formatting per locale

2. **Advanced PWA Features**

   - Push notifications
   - Background sync
   - Share target API

3. **Performance Monitoring**

   - Real User Monitoring (RUM)
   - Core Web Vitals tracking
   - Error tracking (Sentry)

4. **Advanced Features**
   - Dark/light/auto theme
   - Customizable dashboard
   - Export/import functionality
   - Advanced filtering and search

## Migration from V1

When ready to migrate features from frontend v1:

1. **Don't Copy**: Reimplement with new patterns
2. **API Integration**: Use tRPC hooks instead of direct fetch
3. **Components**: Break down into smaller, reusable pieces
4. **Styling**: Convert to Tailwind classes
5. **State**: Use React Query for server state
6. **Forms**: Migrate to React Hook Form + Zod

## Development Workflow

1. Create feature branch
2. Implement component with types
3. Add tRPC integration
4. Style with Tailwind
5. Test manually in browser
6. Create PR with screenshots
7. Code review
8. Merge and deploy

## Coding Standards

- Follow TypeScript strict mode
- Use functional components with hooks
- Prefer composition over inheritance
- Keep components under 200 lines
- Document complex logic with comments
- Use meaningful variable names
- Follow ESLint/Biome rules
