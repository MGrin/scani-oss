import {
  Building2,
  FileUp,
  LayoutDashboard,
  Moon,
  PieChart,
  Plug,
  PlusCircle,
  Settings,
  Sun,
  Tags,
  Vault,
  Wallet,
} from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useTheme } from '@/contexts/ThemeContext';
import { V2_ROUTES } from '../../lib/routes';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { toggleTheme, resolvedTheme } = useTheme();

  const go = useCallback(
    (path: string) => {
      navigate(path);
      onOpenChange(false);
    },
    [navigate, onOpenChange]
  );

  // Global Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Pages">
          <CommandItem onSelect={() => go(V2_ROUTES.dashboard)}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem onSelect={() => go(V2_ROUTES.holdings)}>
            <PieChart className="mr-2 h-4 w-4" />
            Holdings
          </CommandItem>
          <CommandItem onSelect={() => go(V2_ROUTES.accounts)}>
            <Wallet className="mr-2 h-4 w-4" />
            Accounts
          </CommandItem>
          <CommandItem onSelect={() => go(V2_ROUTES.institutions)}>
            <Building2 className="mr-2 h-4 w-4" />
            Institutions
          </CommandItem>
          <CommandItem onSelect={() => go(V2_ROUTES.groups)}>
            <Tags className="mr-2 h-4 w-4" />
            Groups
          </CommandItem>
          <CommandItem onSelect={() => go(V2_ROUTES.vaults)}>
            <Vault className="mr-2 h-4 w-4" />
            Vaults
          </CommandItem>
          <CommandItem onSelect={() => go(V2_ROUTES.integrations)}>
            <Plug className="mr-2 h-4 w-4" />
            Integrations
          </CommandItem>
          <CommandItem onSelect={() => go(V2_ROUTES.settings)}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Quick Actions">
          <CommandItem onSelect={() => go(V2_ROUTES.addData)}>
            <PlusCircle className="mr-2 h-4 w-4" />
            Add Data
          </CommandItem>
          <CommandItem onSelect={() => go(V2_ROUTES.fileImport)}>
            <FileUp className="mr-2 h-4 w-4" />
            Import File
          </CommandItem>
          <CommandItem
            onSelect={() => {
              toggleTheme();
              onOpenChange(false);
            }}
          >
            {resolvedTheme === 'dark' ? (
              <Sun className="mr-2 h-4 w-4" />
            ) : (
              <Moon className="mr-2 h-4 w-4" />
            )}
            Toggle Theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
