import { ArrowLeft, Globe, Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { showError, showSuccess } from '@/hooks/use-toast';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

// ── Types ──

interface HoldingEntry {
  tokenId: string;
  tokenLabel: string;
  balance: string;
}

type InstitutionMode = 'select' | 'create';
type AccountMode = 'select' | 'create';

const CREATE_NEW = '__create_new__';

// ── Searchable Input Component ──

function SearchableDropdown({
  items,
  value,
  onSelect,
  placeholder,
}: {
  items: Array<{ id: string; label: string; subtitle?: string; icon?: string | null }>;
  value: string;
  onSelect: (id: string) => void;
  placeholder: string;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const selected = items.find((i) => i.id === value);
  const filtered = search
    ? items.filter(
        (i) =>
          i.label.toLowerCase().includes(search.toLowerCase()) ||
          (i.subtitle && i.subtitle.toLowerCase().includes(search.toLowerCase()))
      )
    : items;

  if (selected && !open) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1 px-3 py-2 border rounded-md bg-muted text-sm">
          {selected.icon && (
            <img
              src={selected.icon}
              alt=""
              className="h-4 w-4 rounded-sm object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
          <span className="font-medium">{selected.label}</span>
          {selected.subtitle && (
            <span className="text-muted-foreground text-xs">{selected.subtitle}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs shrink-0"
          onClick={() => {
            onSelect('');
            setOpen(true);
            setSearch('');
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <Input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        autoFocus={open}
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-popover border rounded-md shadow-lg max-h-[250px] overflow-y-auto">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-accent flex items-center gap-2 border-b"
            onClick={() => {
              onSelect(CREATE_NEW);
              setOpen(false);
              setSearch('');
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Create new
          </button>
          {filtered.map((item) => (
            <button
              type="button"
              key={item.id}
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
                setSearch('');
              }}
            >
              {item.icon && (
                <img
                  src={item.icon}
                  alt=""
                  className="h-4 w-4 rounded-sm object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <span className="font-medium">{item.label}</span>
              {item.subtitle && (
                <span className="text-muted-foreground text-xs">{item.subtitle}</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No results found</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Token Search ──

function TokenSearchInput({
  value,
  label,
  onSelect,
  onClear,
}: {
  value: { id: string; label: string } | null;
  label?: string;
  onSelect: (id: string, label: string) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { data: tokens } = trpc.tokens.getAll.useQuery();

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const filtered = useMemo(() => {
    if (!tokens || !search) return [];
    const q = search.toLowerCase();
    return tokens
      .filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
      .slice(0, 12);
  }, [tokens, search]);

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium px-3 py-2 border rounded-md flex-1 bg-muted truncate">
          {value.label}
        </span>
        <Button variant="ghost" size="sm" className="h-8 text-xs shrink-0" onClick={onClear}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      {label && <Label className="text-xs mb-1 block">{label}</Label>}
      <Input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => search.length > 0 && setOpen(true)}
        placeholder="Search tokens (BTC, USD, AAPL...)"
      />
      {open && search.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-popover border rounded-md shadow-lg max-h-[200px] overflow-y-auto">
          {filtered.map((t) => (
            <button
              type="button"
              key={t.id}
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
              onClick={() => {
                onSelect(t.id, `${t.symbol} — ${t.name}`);
                setSearch('');
                setOpen(false);
              }}
            >
              <span className="font-medium w-14">{t.symbol}</span>
              <span className="text-muted-foreground text-xs truncate">{t.name}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No tokens found for "{search}"
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──

export function ManualEntryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // URL context params
  const urlAccountId = searchParams.get('accountId') || '';
  const urlInstitutionId = searchParams.get('institutionId') || '';

  // Data queries
  // Institution picker needs the full system-wide catalog, not just the
  // institutions the user already has accounts with — otherwise a new user
  // with no data sees an empty selector. Use `getAll`.
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  // Institution state
  const [institutionMode, setInstitutionMode] = useState<InstitutionMode>('select');
  const [institutionId, setInstitutionId] = useState('');
  const [newInstName, setNewInstName] = useState('');
  const [newInstTypeId, setNewInstTypeId] = useState('');
  const [newInstWebsite, setNewInstWebsite] = useState('');
  const [fetchingOG, setFetchingOG] = useState(false);

  // Pre-select institution from URL param or from pre-selected account
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized) return;
    if (!institutions || !accounts) return;

    if (urlAccountId) {
      const acc = accounts.find((a) => a.id === urlAccountId);
      if (acc) {
        setInstitutionId(acc.institutionId);
      }
    } else if (urlInstitutionId) {
      if (institutions.some((i) => i.id === urlInstitutionId)) {
        setInstitutionId(urlInstitutionId);
      }
    }
    setInitialized(true);
  }, [urlAccountId, urlInstitutionId, institutions, accounts, initialized]);

  // Account state
  const [accountMode, setAccountMode] = useState<AccountMode>('select');
  const [accountId, setAccountId] = useState(urlAccountId);
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountTypeId, setNewAccountTypeId] = useState('');

  // Holdings state
  const [holdings, setHoldings] = useState<HoldingEntry[]>([
    { tokenId: '', tokenLabel: '', balance: '' },
  ]);

  // OpenGraph metadata fetch
  const utils = trpc.useUtils();

  const handleFetchOG = async () => {
    if (!newInstWebsite.trim()) return;
    setFetchingOG(true);
    try {
      const url = newInstWebsite.startsWith('http') ? newInstWebsite : `https://${newInstWebsite}`;
      const meta = await utils.institutions.getOpenGraphMetadata.fetch({ url });
      if (meta.title || meta.siteName) {
        setNewInstName(meta.siteName || meta.title || '');
      }
    } catch {
      // Silently fail — user can enter name manually
    }
    setFetchingOG(false);
  };

  // Create mutation
  const createMutation = trpc.batchOperations.createHoldingsWithDependencies.useMutation({
    onSuccess: () => {
      showSuccess('Holdings created successfully');
      navigate(V2_ROUTES.holdings);
    },
    onError: (err) => showError(err, 'Creating holdings'),
  });

  // Institution items for dropdown
  const institutionItems = useMemo(
    () =>
      (institutions ?? []).map((inst) => ({
        id: inst.id,
        label: inst.name,
        subtitle: undefined as string | undefined,
        icon: getFaviconUrl(inst.website),
      })),
    [institutions]
  );

  // Account items filtered by selected institution
  const accountItems = useMemo(() => {
    const accs = accounts ?? [];
    const filtered = institutionId ? accs.filter((a) => a.institutionId === institutionId) : accs;
    return filtered.map((acc) => ({
      id: acc.id,
      label: acc.name,
      subtitle: undefined as string | undefined,
      icon: null as string | null,
    }));
  }, [accounts, institutionId]);

  // Holdings management
  const addHolding = () => {
    setHoldings((prev) => [...prev, { tokenId: '', tokenLabel: '', balance: '' }]);
  };

  const removeHolding = (index: number) => {
    setHoldings((prev) => prev.filter((_, i) => i !== index));
  };

  const handleInstitutionSelect = (id: string) => {
    if (id === CREATE_NEW) {
      setInstitutionMode('create');
      setInstitutionId('');
    } else {
      setInstitutionMode('select');
      setInstitutionId(id);
      // Reset account when institution changes
      setAccountId('');
      setAccountMode('select');
    }
  };

  const handleAccountSelect = (id: string) => {
    if (id === CREATE_NEW) {
      setAccountMode('create');
      setAccountId('');
    } else {
      setAccountMode('select');
      setAccountId(id);
    }
  };

  // Submit
  const handleSubmit = useCallback(() => {
    const validHoldings = holdings.filter((h) => h.tokenId && h.balance.trim());
    if (validHoldings.length === 0) return;

    const isNewInst = institutionMode === 'create';
    const isNewAccount = accountMode === 'create';

    createMutation.mutate({
      institution:
        isNewInst && newInstName.trim() && newInstTypeId
          ? {
              name: newInstName.trim(),
              typeId: newInstTypeId,
              website: newInstWebsite.trim()
                ? newInstWebsite.startsWith('http')
                  ? newInstWebsite.trim()
                  : `https://${newInstWebsite.trim()}`
                : undefined,
            }
          : undefined,
      accountId: isNewAccount ? undefined : accountId || undefined,
      account:
        isNewAccount && newAccountName.trim() && newAccountTypeId
          ? {
              name: newAccountName.trim(),
              typeId: newAccountTypeId,
              // When the user picked an existing institution, forward its id
              // on the new account so the backend uses it. When the user is
              // creating a new institution (isNewInst), leave institutionId
              // undefined — the backend will create the institution from the
              // `institution: {...}` payload above and wire it up.
              institutionId:
                !isNewInst && institutionMode === 'select' ? institutionId || undefined : undefined,
            }
          : undefined,
      holdings: validHoldings.map((h) => ({
        tokenId: h.tokenId,
        balance: h.balance.trim(),
      })),
    });
  }, [
    holdings,
    institutionMode,
    accountMode,
    institutionId,
    accountId,
    newInstName,
    newInstTypeId,
    newInstWebsite,
    newAccountName,
    newAccountTypeId,
    createMutation,
  ]);

  const hasValidHoldings = holdings.some((h) => h.tokenId && h.balance.trim());
  const hasValidInstitution =
    institutionMode === 'select' ? !!institutionId : !!(newInstName.trim() && newInstTypeId);
  const hasValidAccount =
    accountMode === 'select' ? !!accountId : !!(newAccountName.trim() && newAccountTypeId);
  const canSubmit = hasValidHoldings && hasValidInstitution && hasValidAccount;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to={V2_ROUTES.addData}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Add Data
          </Link>
        </Button>
        <h2 className="text-2xl font-bold tracking-tight">Manual Entry</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Add holdings to an existing or new account
        </p>
      </div>

      {/* ── Step 1: Institution ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Institution</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {institutionMode === 'select' ? (
            <SearchableDropdown
              items={institutionItems}
              value={institutionId}
              onSelect={handleInstitutionSelect}
              placeholder="Search institutions..."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs shrink-0"
                  onClick={() => {
                    setInstitutionMode('select');
                    setNewInstName('');
                    setNewInstWebsite('');
                    setNewInstTypeId('');
                  }}
                >
                  ← Select existing
                </Button>
                <span className="text-xs text-muted-foreground">Creating new institution</span>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Website (auto-fills name)</Label>
                <div className="flex gap-2">
                  <Input
                    value={newInstWebsite}
                    onChange={(e) => setNewInstWebsite(e.target.value)}
                    placeholder="e.g. revolut.com"
                    className="flex-1"
                    onBlur={handleFetchOG}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleFetchOG();
                    }}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={handleFetchOG}
                    disabled={fetchingOG || !newInstWebsite.trim()}
                  >
                    {fetchingOG ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Globe className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Name</Label>
                <Input
                  value={newInstName}
                  onChange={(e) => setNewInstName(e.target.value)}
                  placeholder="Institution name"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Type</Label>
                <Select value={newInstTypeId} onValueChange={setNewInstTypeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {institutionTypes?.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 2: Account ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {accountMode === 'select' ? (
            <SearchableDropdown
              items={accountItems}
              value={accountId}
              onSelect={handleAccountSelect}
              placeholder="Search accounts..."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs shrink-0"
                  onClick={() => {
                    setAccountMode('select');
                    setNewAccountName('');
                    setNewAccountTypeId('');
                  }}
                >
                  ← Select existing
                </Button>
                <span className="text-xs text-muted-foreground">Creating new account</span>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Account Name</Label>
                <Input
                  value={newAccountName}
                  onChange={(e) => setNewAccountName(e.target.value)}
                  placeholder="e.g. Current Account, Savings, Trading"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Account Type</Label>
                <Select value={newAccountTypeId} onValueChange={setNewAccountTypeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {accountTypes?.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 3: Holdings ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Holdings</CardTitle>
            <Button variant="outline" size="sm" onClick={addHolding}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {holdings.map((entry, index) => (
            <div key={`holding-${index}`} className="flex gap-2 items-start">
              <div className="flex-1 min-w-0">
                <TokenSearchInput
                  value={entry.tokenId ? { id: entry.tokenId, label: entry.tokenLabel } : null}
                  onSelect={(id, label) => {
                    setHoldings((prev) =>
                      prev.map((h, i) =>
                        i === index ? { ...h, tokenId: id, tokenLabel: label } : h
                      )
                    );
                  }}
                  onClear={() => {
                    setHoldings((prev) =>
                      prev.map((h, i) => (i === index ? { ...h, tokenId: '', tokenLabel: '' } : h))
                    );
                  }}
                />
              </div>
              <div className="w-28 shrink-0">
                <NumericFormat
                  value={entry.balance}
                  onValueChange={(values) =>
                    setHoldings((prev) =>
                      prev.map((h, i) => (i === index ? { ...h, balance: values.value } : h))
                    )
                  }
                  placeholder="0.00"
                  customInput={Input}
                  thousandSeparator=","
                  decimalSeparator="."
                  decimalScale={8}
                  allowNegative={false}
                />
              </div>
              {holdings.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground"
                  onClick={() => removeHolding(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── Submit ── */}
      <Button
        onClick={handleSubmit}
        disabled={!canSubmit || createMutation.isPending}
        className="w-full"
      >
        {createMutation.isPending ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Creating...
          </>
        ) : (
          'Create Holdings'
        )}
      </Button>
    </div>
  );
}
