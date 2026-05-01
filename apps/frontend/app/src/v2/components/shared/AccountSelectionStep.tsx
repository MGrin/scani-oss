import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Globe, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { CREATE_NEW, SearchableDropdown } from './SearchableDropdown';

type InstitutionMode = 'select' | 'create';
type AccountMode = 'select' | 'create';

export interface AccountSelectionResult {
  institutionId?: string;
  accountId?: string;
  newInstitution?: { name: string; typeId: string; website?: string };
  newAccount?: { name: string; typeId: string };
}

interface AccountSelectionStepProps {
  /** Pre-selected account ID from URL params */
  initialAccountId?: string;
  /** Pre-selected institution ID from URL params */
  initialInstitutionId?: string;
  /** Called whenever the selection changes */
  onChange: (result: AccountSelectionResult) => void;
  /** Whether the selection is valid (has required fields) */
  onValidChange: (valid: boolean) => void;
}

export function AccountSelectionStep({
  initialAccountId,
  initialInstitutionId,
  onChange,
  onValidChange,
}: AccountSelectionStepProps) {
  // Institution picker needs the full system-wide catalog, not just the
  // institutions the user already has accounts with — otherwise a new user
  // with no data sees an empty selector. Use `getAll`.
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();
  const utils = trpc.useUtils();

  const [institutionMode, setInstitutionMode] = useState<InstitutionMode>('select');
  const [institutionId, setInstitutionId] = useState('');
  const [newInstName, setNewInstName] = useState('');
  const [newInstTypeId, setNewInstTypeId] = useState('');
  const [newInstWebsite, setNewInstWebsite] = useState('');
  const [fetchingOG, setFetchingOG] = useState(false);

  const [accountMode, setAccountMode] = useState<AccountMode>('select');
  const [accountId, setAccountId] = useState(initialAccountId || '');
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountTypeId, setNewAccountTypeId] = useState('');

  // Initialize from URL params
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized || !institutions || !accounts) return;
    if (initialAccountId) {
      const acc = accounts.find((a) => a.id === initialAccountId);
      if (acc) setInstitutionId(acc.institutionId);
    } else if (initialInstitutionId) {
      if (institutions.some((i) => i.id === initialInstitutionId)) {
        setInstitutionId(initialInstitutionId);
      }
    }
    setInitialized(true);
  }, [initialAccountId, initialInstitutionId, institutions, accounts, initialized]);

  // Notify parent of changes
  const hasValidInstitution =
    institutionMode === 'select' ? !!institutionId : !!(newInstName.trim() && newInstTypeId);
  const hasValidAccount =
    accountMode === 'select' ? !!accountId : !!(newAccountName.trim() && newAccountTypeId);
  const isValid = hasValidInstitution && hasValidAccount;

  useEffect(() => {
    onValidChange(isValid);
    onChange({
      institutionId: institutionMode === 'select' ? institutionId : undefined,
      accountId: accountMode === 'select' ? accountId : undefined,
      newInstitution:
        institutionMode === 'create' && newInstName.trim() && newInstTypeId
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
      newAccount:
        accountMode === 'create' && newAccountName.trim() && newAccountTypeId
          ? { name: newAccountName.trim(), typeId: newAccountTypeId }
          : undefined,
    });
  }, [
    institutionMode,
    institutionId,
    accountMode,
    accountId,
    newInstName,
    newInstTypeId,
    newInstWebsite,
    newAccountName,
    newAccountTypeId,
    isValid,
    onChange,
    onValidChange,
  ]);

  const institutionItems = useMemo(
    () =>
      (institutions ?? []).map((inst) => ({
        id: inst.id,
        label: inst.name,
        icon: getFaviconUrl(inst.website),
      })),
    [institutions]
  );

  const accountItems = useMemo(() => {
    const accs = accounts ?? [];
    // When creating a new institution, the institution doesn't exist yet, so
    // no existing accounts can belong to it — show an empty list.
    // When an existing institution is picked, filter to its accounts.
    // When nothing is picked yet, show all accounts so the user can select
    // one and have the institution auto-derived.
    const filtered =
      institutionMode === 'create'
        ? []
        : institutionId
          ? accs.filter((a) => a.institutionId === institutionId)
          : accs;
    return filtered.map((acc) => ({ id: acc.id, label: acc.name, icon: null as string | null }));
  }, [accounts, institutionId, institutionMode]);

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
      // Silently fail
    }
    setFetchingOG(false);
  };

  const handleInstitutionSelect = (id: string, searchText?: string) => {
    if (id === CREATE_NEW) {
      setInstitutionMode('create');
      setInstitutionId('');
      if (searchText?.trim()) setNewInstName(searchText.trim());
    } else {
      setInstitutionMode('select');
      setInstitutionId(id);
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

  return (
    <div className="space-y-4">
      {/* Institution */}
      <Card>
        <CardHeader className="pb-2">
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
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => {
                  setInstitutionMode('select');
                  setNewInstName('');
                  setNewInstWebsite('');
                  setNewInstTypeId('');
                }}
              >
                ← Select existing
              </Button>
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

      {/* Account */}
      <Card>
        <CardHeader className="pb-2">
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
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => {
                  setAccountMode('select');
                  setNewAccountName('');
                  setNewAccountTypeId('');
                }}
              >
                ← Select existing
              </Button>
              <div className="space-y-2">
                <Label className="text-xs">Account Name</Label>
                <Input
                  value={newAccountName}
                  onChange={(e) => setNewAccountName(e.target.value)}
                  placeholder="e.g. Current Account, Savings"
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
    </div>
  );
}
