import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

interface HoldingEntry {
  tokenId: string;
  tokenLabel: string;
  balance: string;
}

const NEW_INSTITUTION = '__new__';
const NEW_ACCOUNT = '__new__';

export function ManualEntryPage() {
  const navigate = useNavigate();

  const { data: institutions } = trpc.institutions.getByUserId.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();

  const [institutionId, setInstitutionId] = useState('');
  const [newInstitutionName, setNewInstitutionName] = useState('');
  const [newInstitutionTypeId, setNewInstitutionTypeId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountTypeId, setNewAccountTypeId] = useState('');
  const [holdings, setHoldings] = useState<HoldingEntry[]>([
    { tokenId: '', tokenLabel: '', balance: '' },
  ]);
  const [tokenSearch, setTokenSearch] = useState<Record<number, string>>({});

  const filteredAccounts = (accounts ?? []).filter(
    (a) => !institutionId || institutionId === NEW_INSTITUTION || a.institutionId === institutionId
  );

  const createMutation = trpc.batchOperations.createHoldingsWithDependencies.useMutation({
    onSuccess: () => {
      showSuccess('Holdings created successfully');
      navigate(V2_ROUTES.holdings);
    },
    onError: (err) => showError(err, 'Creating holdings'),
  });

  const addHolding = () => {
    setHoldings((prev) => [...prev, { tokenId: '', tokenLabel: '', balance: '' }]);
  };

  const removeHolding = (index: number) => {
    setHoldings((prev) => prev.filter((_, i) => i !== index));
  };

  const selectToken = (index: number, tokenId: string, label: string) => {
    setHoldings((prev) =>
      prev.map((h, i) => (i === index ? { ...h, tokenId, tokenLabel: label } : h))
    );
    setTokenSearch((prev) => ({ ...prev, [index]: '' }));
  };

  const updateBalance = (index: number, balance: string) => {
    setHoldings((prev) => prev.map((h, i) => (i === index ? { ...h, balance } : h)));
  };

  const getFilteredTokens = (searchTerm: string) => {
    if (!tokens || !searchTerm) return [];
    const q = searchTerm.toLowerCase();
    return tokens
      .filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
      .slice(0, 10);
  };

  const handleSubmit = useCallback(() => {
    const validHoldings = holdings.filter((h) => h.tokenId && h.balance.trim());
    if (validHoldings.length === 0) return;

    const isNewInstitution = institutionId === NEW_INSTITUTION;
    const isNewAccount = accountId === NEW_ACCOUNT;

    createMutation.mutate({
      institution:
        isNewInstitution && newInstitutionName.trim() && newInstitutionTypeId
          ? { name: newInstitutionName.trim(), typeId: newInstitutionTypeId }
          : undefined,
      accountId: isNewAccount ? undefined : accountId || undefined,
      account:
        isNewAccount && newAccountName.trim() && newAccountTypeId
          ? { name: newAccountName.trim(), typeId: newAccountTypeId }
          : undefined,
      holdings: validHoldings.map((h) => ({
        tokenId: h.tokenId,
        balance: h.balance.trim(),
      })),
    });
  }, [
    holdings,
    institutionId,
    accountId,
    newInstitutionName,
    newInstitutionTypeId,
    newAccountName,
    newAccountTypeId,
    createMutation,
  ]);

  const hasValidHoldings = holdings.some((h) => h.tokenId && h.balance.trim());

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
        <p className="text-sm text-muted-foreground mt-1">Manually enter your holdings</p>
      </div>

      {/* Institution */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Institution</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={institutionId} onValueChange={setInstitutionId}>
            <SelectTrigger>
              <SelectValue placeholder="Select institution" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_INSTITUTION}>+ Create new institution</SelectItem>
              {institutions?.map((inst) => (
                <SelectItem key={inst.id} value={inst.id}>
                  {inst.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {institutionId === NEW_INSTITUTION && (
            <div className="space-y-3">
              <Input
                value={newInstitutionName}
                onChange={(e) => setNewInstitutionName(e.target.value)}
                placeholder="Institution name"
              />
              <Select value={newInstitutionTypeId} onValueChange={setNewInstitutionTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Institution type" />
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
          )}
        </CardContent>
      </Card>

      {/* Account */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_ACCOUNT}>+ Create new account</SelectItem>
              {filteredAccounts.map((acc) => (
                <SelectItem key={acc.id} value={acc.id}>
                  {acc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {accountId === NEW_ACCOUNT && (
            <div className="space-y-3">
              <Input
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="Account name"
              />
              <Select value={newAccountTypeId} onValueChange={setNewAccountTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Account type" />
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
          )}
        </CardContent>
      </Card>

      {/* Holdings */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Holdings</CardTitle>
            <Button variant="outline" size="sm" onClick={addHolding}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add Row
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {holdings.map((entry, index) => (
            <div key={`holding-${index}`} className="flex gap-2 items-end">
              <div className="flex-1 space-y-1 relative">
                <Label className="text-xs">Token</Label>
                {entry.tokenId ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium px-3 py-2 border rounded-md flex-1 bg-muted">
                      {entry.tokenLabel}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => {
                        setHoldings((prev) =>
                          prev.map((h, i) =>
                            i === index ? { ...h, tokenId: '', tokenLabel: '' } : h
                          )
                        );
                      }}
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Input
                      value={tokenSearch[index] ?? ''}
                      onChange={(e) =>
                        setTokenSearch((prev) => ({ ...prev, [index]: e.target.value }))
                      }
                      placeholder="Search tokens..."
                    />
                    {(tokenSearch[index] ?? '').length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-popover border rounded-md shadow-lg max-h-[200px] overflow-y-auto">
                        {getFilteredTokens(tokenSearch[index] ?? '').map((t) => (
                          <button
                            type="button"
                            key={t.id}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                            onClick={() => selectToken(index, t.id, `${t.symbol} — ${t.name}`)}
                          >
                            <span className="font-medium">{t.symbol}</span>
                            <span className="text-muted-foreground text-xs truncate">{t.name}</span>
                          </button>
                        ))}
                        {getFilteredTokens(tokenSearch[index] ?? '').length === 0 && (
                          <p className="px-3 py-2 text-xs text-muted-foreground">No tokens found</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="w-32 space-y-1">
                <Label className="text-xs">Balance</Label>
                <Input
                  value={entry.balance}
                  onChange={(e) => updateBalance(index, e.target.value)}
                  placeholder="0.00"
                  type="text"
                  inputMode="decimal"
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

      <Button
        onClick={handleSubmit}
        disabled={!hasValidHoldings || createMutation.isPending}
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
