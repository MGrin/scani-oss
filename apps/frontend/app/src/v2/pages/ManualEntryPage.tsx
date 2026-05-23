import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { showError } from '@scani/ui/ui/use-toast';
import { ArrowLeft, Globe, Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { TokenSearchInput } from '../components/tokens/TokenSearchInput';
import { V2_ROUTES } from '../lib/routes';

// ── Types ──

interface HoldingEntry {
  uid: string;
  tokenId: string;
  tokenLabel: string;
  balance: string;
}

const newHolding = (): HoldingEntry => ({
  uid: crypto.randomUUID(),
  tokenId: '',
  tokenLabel: '',
  balance: '',
});

type InstitutionMode = 'select' | 'create';
type AccountMode = 'select' | 'create';

const CREATE_NEW = '__create_new__';

// ── Searchable Input Component ──

function SearchableDropdown({
  items,
  value,
  onSelect,
  placeholder,
  disabled,
}: {
  items: Array<{ id: string; label: string; subtitle?: string; icon?: string | null }>;
  value: string;
  // searchText is the current input text — forwarded only on CREATE_NEW so
  // the parent can pre-fill the new-record form's name field.
  onSelect: (id: string, searchText?: string) => void;
  placeholder: string;
  disabled?: boolean;
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
          i.subtitle?.toLowerCase().includes(search.toLowerCase())
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
          disabled={disabled}
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
        disabled={disabled}
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-popover border rounded-md shadow-lg max-h-[250px] overflow-y-auto">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-accent flex items-center gap-2 border-b"
            onClick={() => {
              onSelect(CREATE_NEW, search);
              setOpen(false);
              setSearch('');
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {search.trim() ? `Create new "${search.trim()}"` : 'Create new'}
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
  const [holdings, setHoldings] = useState<HoldingEntry[]>(() => [newHolding()]);

  // Per-form requestId — stable across renders, regenerated only on mount
  // so a user who navigates away and comes back gets a fresh dedup key.
  // Worker uses this in computeJobId to coalesce double-submits.
  const requestId = useMemo(() => crypto.randomUUID(), []);

  // OpenGraph metadata fetch
  const utils = trpc.useUtils();

  const handleFetchOG = async () => {
    if (fetchingOG) return;
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

  // Enqueue mutation — returns a jobId; the worker handles institution +
  // account + holdings + per-holding price fetch. We navigate straight to
  // the job detail page so the user can watch progress instead of landing
  // on /holdings with un-priced rows.
  const createMutation = trpc.batchOperations.createHoldingsBatch.useMutation({
    onSuccess: ({ jobId }) => {
      navigate(V2_ROUTES.jobDetail(jobId));
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

  // Account items filtered by selected institution.
  // When creating a new institution, the institution doesn't exist yet, so
  // no existing accounts can belong to it — show an empty list.
  // When nothing is picked yet, show all accounts so the user can select
  // one and have the institution auto-derived.
  const accountItems = useMemo(() => {
    const accs = accounts ?? [];
    const filtered =
      institutionMode === 'create'
        ? []
        : institutionId
          ? accs.filter((a) => a.institutionId === institutionId)
          : accs;
    return filtered.map((acc) => ({
      id: acc.id,
      label: acc.name,
      subtitle: undefined as string | undefined,
      icon: null as string | null,
    }));
  }, [accounts, institutionId, institutionMode]);

  // Holdings management
  const addHolding = () => {
    setHoldings((prev) => [...prev, newHolding()]);
  };

  const removeHolding = (index: number) => {
    setHoldings((prev) => prev.filter((_, i) => i !== index));
  };

  const handleInstitutionSelect = (id: string, searchText?: string) => {
    if (id === CREATE_NEW) {
      setInstitutionMode('create');
      setInstitutionId('');
      if (searchText?.trim()) setNewInstName(searchText.trim());
    } else {
      setInstitutionMode('select');
      setInstitutionId(id);
      // Reset account when institution changes
      setAccountId('');
      setAccountMode('select');
    }
  };

  const handleAccountSelect = (id: string, searchText?: string) => {
    if (id === CREATE_NEW) {
      setAccountMode('create');
      setAccountId('');
      if (searchText?.trim()) setNewAccountName(searchText.trim());
    } else {
      setAccountMode('select');
      setAccountId(id);
      // If no institution is selected yet, auto-select the one this account
      // belongs to so the two selections stay consistent.
      if (!institutionId && institutionMode === 'select') {
        const acc = (accounts ?? []).find((a) => a.id === id);
        if (acc) setInstitutionId(acc.institutionId);
      }
    }
  };

  // Submit
  const handleSubmit = useCallback(() => {
    const validHoldings = holdings.filter((h) => h.tokenId && h.balance.trim());
    if (validHoldings.length === 0) return;

    const isNewInst = institutionMode === 'create';
    const isNewAccount = accountMode === 'create';

    createMutation.mutate({
      requestId,
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
              institutionId:
                !isNewInst && institutionMode === 'select' ? institutionId || undefined : undefined,
            }
          : undefined,
      newHoldings: validHoldings.map((h) => ({
        tokenId: h.tokenId,
        balance: h.balance.trim(),
      })),
      updateHoldings: [],
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
    requestId,
  ]);

  const hasValidHoldings = holdings.some((h) => h.tokenId && h.balance.trim());
  const hasValidInstitution =
    institutionMode === 'select' ? !!institutionId : !!(newInstName.trim() && newInstTypeId);
  const hasValidAccount =
    accountMode === 'select' ? !!accountId : !!(newAccountName.trim() && newAccountTypeId);
  const canSubmit = hasValidHoldings && hasValidInstitution && hasValidAccount;
  const isSaving = createMutation.isPending;

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
              disabled={isSaving}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs shrink-0"
                  disabled={isSaving}
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
                    disabled={isSaving}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={handleFetchOG}
                    disabled={fetchingOG || !newInstWebsite.trim() || isSaving}
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
                  disabled={isSaving}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Type</Label>
                <Select value={newInstTypeId} onValueChange={setNewInstTypeId} disabled={isSaving}>
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
              disabled={isSaving}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs shrink-0"
                  disabled={isSaving}
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
                  disabled={isSaving}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Account Type</Label>
                <Select
                  value={newAccountTypeId}
                  onValueChange={setNewAccountTypeId}
                  disabled={isSaving}
                >
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
            <Button variant="outline" size="sm" onClick={addHolding} disabled={isSaving}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {holdings.map((entry, index) => (
            <div key={entry.uid} className="flex gap-2 items-start">
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
                  disabled={isSaving}
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
                  disabled={isSaving}
                />
              </div>
              {holdings.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground"
                  onClick={() => removeHolding(index)}
                  disabled={isSaving}
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
