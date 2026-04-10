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
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../../lib/routes';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { toggleTheme, resolvedTheme } = useTheme();
  const [search, setSearch] = useState('');

  // Load user data for search (these are already cached by other pages)
  const { data: holdingsData } = trpc.holdings.getWithDetails.useQuery(undefined, {
    enabled: open,
  });
  const { data: accountsData } = trpc.accounts.getByUserIdWithSummary.useQuery(undefined, {
    enabled: open,
  });
  const { data: institutionsData } = trpc.institutions.getByUserIdWithSummary.useQuery(undefined, {
    enabled: open,
  });
  const { data: groupsData } = trpc.groups.getAllWithCounts.useQuery(undefined, {
    enabled: open,
  });
  const { data: vaultsData } = trpc.vaults.getAll.useQuery(undefined, {
    enabled: open,
  });

  const go = useCallback(
    (path: string) => {
      navigate(path);
      onOpenChange(false);
    },
    [navigate, onOpenChange]
  );

  // Reset search when closing
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

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

  const q = search.toLowerCase();
  const hasSearch = q.length > 0;

  // Filter data based on search
  const matchedHoldings = useMemo(() => {
    if (!hasSearch || !holdingsData?.holdings) return [];
    return holdingsData.holdings
      .filter(
        (h) => h.token.symbol.toLowerCase().includes(q) || h.token.name.toLowerCase().includes(q)
      )
      .slice(0, 5);
  }, [holdingsData, q, hasSearch]);

  const matchedAccounts = useMemo(() => {
    if (!hasSearch || !accountsData) return [];
    return accountsData.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 5);
  }, [accountsData, q, hasSearch]);

  const matchedInstitutions = useMemo(() => {
    if (!hasSearch || !institutionsData) return [];
    return institutionsData.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 5);
  }, [institutionsData, q, hasSearch]);

  const matchedGroups = useMemo(() => {
    if (!hasSearch || !groupsData) return [];
    return groupsData.filter((g) => g.name.toLowerCase().includes(q)).slice(0, 5);
  }, [groupsData, q, hasSearch]);

  const matchedVaults = useMemo(() => {
    if (!hasSearch || !vaultsData) return [];
    return vaultsData.filter((v) => v.name.toLowerCase().includes(q)).slice(0, 5);
  }, [vaultsData, q, hasSearch]);

  const hasDataResults =
    matchedHoldings.length > 0 ||
    matchedAccounts.length > 0 ||
    matchedInstitutions.length > 0 ||
    matchedGroups.length > 0 ||
    matchedVaults.length > 0;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Search holdings, accounts, institutions..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Data search results */}
        {hasSearch && hasDataResults && (
          <>
            {matchedHoldings.length > 0 && (
              <CommandGroup heading="Holdings">
                {matchedHoldings.map((h) => (
                  <CommandItem
                    key={h.id}
                    value={`holding-${h.token.symbol}-${h.token.name}-${h.id}`}
                    onSelect={() => go(V2_ROUTES.holdingDetail(h.id))}
                  >
                    <PieChart className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium mr-2">{h.token.symbol}</span>
                    <span className="text-muted-foreground text-xs truncate">{h.token.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">
                      {h.institution.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {matchedAccounts.length > 0 && (
              <CommandGroup heading="Accounts">
                {matchedAccounts.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={`account-${a.name}-${a.id}`}
                    onSelect={() => go(V2_ROUTES.accountDetail(a.id))}
                  >
                    <Wallet className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{a.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">
                      {a.summary.holdingsCount} holdings
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {matchedInstitutions.length > 0 && (
              <CommandGroup heading="Institutions">
                {matchedInstitutions.map((inst) => {
                  const favicon = getFaviconUrl(inst.website);
                  return (
                    <CommandItem
                      key={inst.id}
                      value={`institution-${inst.name}-${inst.id}`}
                      onSelect={() => go(V2_ROUTES.institutionDetail(inst.id))}
                    >
                      {favicon ? (
                        <img
                          src={favicon}
                          alt=""
                          className="mr-2 h-4 w-4 rounded-sm object-contain shrink-0"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <Building2 className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="font-medium">{inst.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground shrink-0">
                        {inst.summary?.accountCount ?? 0} accounts
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            {matchedGroups.length > 0 && (
              <CommandGroup heading="Groups">
                {matchedGroups.map((g) => (
                  <CommandItem
                    key={g.id}
                    value={`group-${g.name}-${g.id}`}
                    onSelect={() => go(V2_ROUTES.groups)}
                  >
                    <span
                      className="mr-2 h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: g.color }}
                    />
                    <span className="font-medium">{g.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {matchedVaults.length > 0 && (
              <CommandGroup heading="Vaults">
                {matchedVaults.map((v) => (
                  <CommandItem
                    key={v.id}
                    value={`vault-${v.name}-${v.id}`}
                    onSelect={() => go(V2_ROUTES.vaultDetail(v.id))}
                  >
                    <Vault className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{v.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">
                      {v.progress?.toFixed(0) ?? 0}%
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            <CommandSeparator />
          </>
        )}

        {/* Pages (always shown, filtered by cmdk) */}
        <CommandGroup heading="Pages">
          <CommandItem value="page-dashboard" onSelect={() => go(V2_ROUTES.dashboard)}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem value="page-holdings" onSelect={() => go(V2_ROUTES.holdings)}>
            <PieChart className="mr-2 h-4 w-4" />
            Holdings
          </CommandItem>
          <CommandItem value="page-accounts" onSelect={() => go(V2_ROUTES.accounts)}>
            <Wallet className="mr-2 h-4 w-4" />
            Accounts
          </CommandItem>
          <CommandItem value="page-institutions" onSelect={() => go(V2_ROUTES.institutions)}>
            <Building2 className="mr-2 h-4 w-4" />
            Institutions
          </CommandItem>
          <CommandItem value="page-groups" onSelect={() => go(V2_ROUTES.groups)}>
            <Tags className="mr-2 h-4 w-4" />
            Groups
          </CommandItem>
          <CommandItem value="page-vaults" onSelect={() => go(V2_ROUTES.vaults)}>
            <Vault className="mr-2 h-4 w-4" />
            Vaults
          </CommandItem>
          <CommandItem value="page-integrations" onSelect={() => go(V2_ROUTES.integrations)}>
            <Plug className="mr-2 h-4 w-4" />
            Integrations
          </CommandItem>
          <CommandItem value="page-settings" onSelect={() => go(V2_ROUTES.settings)}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Quick Actions">
          <CommandItem value="action-add-data" onSelect={() => go(V2_ROUTES.addData)}>
            <PlusCircle className="mr-2 h-4 w-4" />
            Add Data
          </CommandItem>
          <CommandItem value="action-import" onSelect={() => go(V2_ROUTES.fileImport)}>
            <FileUp className="mr-2 h-4 w-4" />
            Import File
          </CommandItem>
          <CommandItem
            value="action-theme"
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
