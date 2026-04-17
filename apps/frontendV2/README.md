# Scani Frontend V2

A modern, redesigned frontend for the Scani personal finance management application.

## Architecture

This is a clean-slate React + TypeScript application built with:

- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS + shadcn/ui components
- **State Management**: React Query (TanStack Query)
- **API Communication**: tRPC
- **Authentication**: Supabase Auth
- **Routing**: React Router v6
- **Forms**: React Hook Form + Zod validation
- **Charts**: Recharts
- **PWA**: Custom service worker + manifest

## Project Structure

```
frontendV2/
├── public/                      # Static assets
│   ├── icons/                   # PWA icons (generated)
│   ├── .well-known/            # PWA configuration
│   ├── manifest.json           # PWA manifest
│   └── sw.js                   # Service worker
├── scripts/                     # Build and utility scripts
│   └── generate-icons.js       # PWA icon generator
├── src/
│   ├── components/
│   │   ├── ui/                 # shadcn/ui base components
│   │   ├── layout/             # Layout components (nav, sidebar, etc.)
│   │   └── features/           # Feature-specific components
│   ├── contexts/               # React contexts (auth, theme, etc.)
│   ├── hooks/                  # Custom React hooks
│   ├── lib/                    # Core libraries (trpc, supabase, utils)
│   ├── pages/                  # Page components
│   ├── services/               # API service layer
│   ├── styles/                 # Global styles and themes
│   ├── types/                  # TypeScript type definitions
│   ├── utils/                  # Helper functions
│   ├── App.tsx                 # Root application component
│   ├── main.tsx               # Application entry point
│   └── index.css              # Global CSS with Tailwind
├── index.html                  # HTML entry point
├── package.json               # Dependencies and scripts
├── tsconfig.json              # TypeScript configuration
├── vite.config.ts             # Vite configuration
├── tailwind.config.js         # Tailwind CSS configuration
└── postcss.config.js          # PostCSS configuration
```

## Getting Started

### Prerequisites

- Bun (not npm/yarn)
- Node.js 18+

### Installation

```bash
# Install dependencies
bun install

# Set up environment variables
cp .env.example .env
# Edit .env with your Supabase credentials
```

### Development

```bash
# Start development server (runs on port 5174)
bun dev

# Type checking
bun run type-check

# Build for production
bun run build

# Preview production build
bun run preview
```

### Environment Variables

Create a `.env` file with the following variables:

```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_API_URL=http://localhost:3001
```

## Development Guidelines

### Component Organization

- **UI Components** (`components/ui/`): Reusable, low-level components (buttons, inputs, dialogs)
- **Layout Components** (`components/layout/`): Structural components (navigation, sidebar, header)
- **Feature Components** (`components/features/`): Domain-specific components (portfolio cards, account forms)

### State Management

- Use React Query for server state
- Use React Context for global client state (auth, theme)
- Keep component state local when possible

### Styling

- Use Tailwind CSS utility classes
- Follow shadcn/ui design system
- CSS variables for theming (see `index.css`)
- Use `cn()` utility from `lib/utils.ts` for conditional classes

### API Communication

- All backend communication via tRPC
- Type-safe with shared types from `@scani/backend`
- React Query hooks auto-generated via tRPC

### TypeScript

- Strict mode enabled
- Prefer interfaces over types for object shapes
- Use type inference where possible
- Document complex types

## Key Technologies

### tRPC Integration

```typescript
// lib/trpc.ts - TODO: Implement
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@scani/backend/types";

export const trpc = createTRPCReact<AppRouter>();
```

### Authentication

```typescript
// contexts/auth-context.tsx - TODO: Implement
// Supabase auth with automatic user sync
```

### Forms

```typescript
// Use React Hook Form + Zod for validation
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
```

## Build and Deployment

### Production Build

```bash
bun run build
```

Outputs to `dist/` directory.

### PWA Configuration

- Icons generated via `scripts/generate-icons.js`
- Manifest configured in `public/manifest.json`
- Service worker in `public/sw.js`

## Next Steps

1. Implement tRPC client setup
2. Add Supabase authentication
3. Create base UI components (shadcn/ui)
4. Build layout components
5. Implement routing structure
6. Add feature-specific components

## Notes

- Port 5174 (different from frontend v1 on 5173)
- Uses same backend as frontendV1
- Clean architecture - no code carried over from v1
- Focus on better UX, performance, and maintainability
