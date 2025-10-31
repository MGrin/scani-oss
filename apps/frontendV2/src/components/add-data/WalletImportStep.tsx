import { AlertCircle, CheckCircle2, Loader2, Search, Wallet } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner, ProgressIndicator } from '@/components/ui/loading';
import { showError, toast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import type { CompleteImportData } from '@/types/addData';

interface WalletImportStepProps {
  completeImportData: CompleteImportData;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
  isCreatingHoldings: boolean;
  onChangesDetected?: (hasChanges: boolean) => void;
}

interface WalletImportResult {
  accounts: Array<{
    id: string;
    name: string;
    chainId: string | number;
    chainName: string;
    institutionId: string;
    institutionName: string;
  }>;
  holdings: Array<{
    id: string;
    accountId: string;
    tokenSymbol: string;
    tokenName: string;
    balance: string;
  }>;
  chainsDetected: number;
  tokensImported: number;
  errors: Array<{
    chainId: string | number;
    chainName: string;
    error: string;
  }>;
}

interface DetectedChain {
  chainId: string | number;
  name: string;
  type: string;
  nativeSymbol: string;
}

export function WalletImportStep({ onChangesDetected }: WalletImportStepProps) {
  const walletAddressId = useId();
  const displayNameId = useId();
  const [walletAddress, setWalletAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isDetecting, setIsDetecting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [detectedChains, setDetectedChains] = useState<DetectedChain[]>([]);
  const [importResult, setImportResult] = useState<WalletImportResult | null>(null);
  const [importProgress, setImportProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState('');

  // tRPC mutations
  const detectChainsMutation = trpc.wallet.detectChains.useMutation({
    onSuccess: (data: { chainsDetected: DetectedChain[]; totalChains: number }) => {
      setDetectedChains(data.chainsDetected);
      setIsDetecting(false);
      if (data.chainsDetected.length === 0) {
        showError('No chains detected', 'No valid blockchain networks found for this address');
      } else {
        toast({
          title: `${data.chainsDetected.length} chain${data.chainsDetected.length > 1 ? 's' : ''} detected`,
          description: 'Ready to import wallet',
        });
      }
    },
    onError: (error) => {
      setIsDetecting(false);
      showError(error.message, 'Detection failed');
    },
  });

  const importWalletMutation = trpc.wallet.importAddress.useMutation({
    onSuccess: (data: WalletImportResult) => {
      setImportResult(data);
      setIsImporting(false);
      setImportProgress(100);
      setCurrentStep('Import complete');

      if (data.tokensImported > 0) {
        toast({
          title: 'Wallet imported successfully',
          description: `Imported ${data.tokensImported} token${data.tokensImported > 1 ? 's' : ''} from ${data.chainsDetected} chain${data.chainsDetected > 1 ? 's' : ''}`,
        });
        onChangesDetected?.(true);
      } else {
        showError('No tokens found', 'Wallet detected but no tokens with balance found');
      }
    },
    onError: (error) => {
      setIsImporting(false);
      setImportProgress(0);
      setCurrentStep('');
      showError(error.message, 'Import failed');
    },
  });

  // Simulate progress updates during import
  useEffect(() => {
    if (isImporting) {
      const steps = [
        { progress: 10, step: 'Validating wallet address...' },
        { progress: 25, step: 'Detecting blockchain networks...' },
        { progress: 40, step: 'Fetching token balances...' },
        { progress: 60, step: 'Processing token data...' },
        { progress: 80, step: 'Creating accounts and holdings...' },
        { progress: 95, step: 'Finalizing import...' },
      ];

      let currentIndex = 0;
      const interval = setInterval(() => {
        if (currentIndex < steps.length) {
          setImportProgress(steps[currentIndex]?.progress ?? 0);
          setCurrentStep(steps[currentIndex]?.step ?? '');
          currentIndex++;
        } else {
          clearInterval(interval);
        }
      }, 1500);

      return () => clearInterval(interval);
    }
  }, [isImporting]);

  const handleDetectChains = useCallback(() => {
    if (!walletAddress.trim()) {
      showError('Address required', 'Please enter a wallet address');
      return;
    }

    setIsDetecting(true);
    setDetectedChains([]);
    setImportResult(null);
    detectChainsMutation.mutate({ address: walletAddress.trim() });
  }, [walletAddress, detectChainsMutation]);

  const handleImportWallet = useCallback(() => {
    if (!walletAddress.trim()) {
      showError('Address required', 'Please enter a wallet address');
      return;
    }

    setIsImporting(true);
    setImportProgress(0);
    setCurrentStep('Starting import...');
    setImportResult(null);

    importWalletMutation.mutate({
      address: walletAddress.trim(),
      displayName: displayName.trim() || undefined,
    });
  }, [walletAddress, displayName, importWalletMutation]);

  const handleReset = () => {
    setWalletAddress('');
    setDisplayName('');
    setDetectedChains([]);
    setImportResult(null);
    setImportProgress(0);
    setCurrentStep('');
  };

  // Render loading state during import
  if (isImporting) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="p-8">
            <div className="space-y-6">
              {/* Animated loading header */}
              <div className="text-center space-y-4">
                <div className="flex justify-center">
                  <div className="relative">
                    <Wallet className="h-16 w-16 text-primary animate-pulse" />
                    <LoadingSpinner className="absolute -top-2 -right-2 text-primary" size="lg" />
                  </div>
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-2">Importing Your Wallet</h3>
                  <p className="text-muted-foreground">
                    This may take a moment as we scan multiple blockchains...
                  </p>
                </div>
              </div>

              {/* Progress indicator */}
              <ProgressIndicator progress={importProgress} label={currentStep} />

              {/* Info cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
                <Card className="border-dashed">
                  <CardContent className="p-4 text-center">
                    <div className="text-2xl font-bold text-primary">44+</div>
                    <div className="text-sm text-muted-foreground">Blockchains Scanned</div>
                  </CardContent>
                </Card>
                <Card className="border-dashed">
                  <CardContent className="p-4 text-center">
                    <div className="text-2xl font-bold text-primary">
                      <LoadingSpinner className="mx-auto" />
                    </div>
                    <div className="text-sm text-muted-foreground">Detecting Tokens</div>
                  </CardContent>
                </Card>
                <Card className="border-dashed">
                  <CardContent className="p-4 text-center">
                    <div className="text-2xl font-bold text-primary">Auto</div>
                    <div className="text-sm text-muted-foreground">Account Creation</div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Render import results
  if (importResult) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-6 w-6 text-green-500" />
              <CardTitle>Import Complete</CardTitle>
            </div>
            <CardDescription>Your wallet has been successfully imported to Scani</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-3xl font-bold text-primary">
                    {importResult.chainsDetected}
                  </div>
                  <div className="text-sm text-muted-foreground">Chains</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-3xl font-bold text-primary">
                    {importResult.accounts.length}
                  </div>
                  <div className="text-sm text-muted-foreground">Accounts</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-3xl font-bold text-primary">
                    {importResult.tokensImported}
                  </div>
                  <div className="text-sm text-muted-foreground">Tokens</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-3xl font-bold text-primary">
                    {importResult.holdings.length}
                  </div>
                  <div className="text-sm text-muted-foreground">Holdings</div>
                </CardContent>
              </Card>
            </div>

            {/* Accounts created */}
            {importResult.accounts.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-semibold">Accounts Created</h4>
                <div className="space-y-2">
                  {importResult.accounts.map((account) => (
                    <Card key={account.id}>
                      <CardContent className="p-3 flex items-center justify-between">
                        <div>
                          <div className="font-medium">{account.name}</div>
                          <div className="text-sm text-muted-foreground">{account.chainName}</div>
                        </div>
                        <Badge variant="secondary">{account.institutionName}</Badge>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Errors */}
            {importResult.errors && importResult.errors.length > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Partial Import - Some Chains Failed</AlertTitle>
                <AlertDescription>
                  <div className="mt-2 space-y-2">
                    {importResult.errors.map((error) => (
                      <details key={`${error.chainId}-${error.chainName}`} className="text-sm">
                        <summary className="cursor-pointer font-medium">
                          {error.chainName} (Chain ID: {error.chainId})
                        </summary>
                        <div className="mt-1 pl-4 text-xs font-mono bg-destructive/10 p-2 rounded">
                          {error.error}
                        </div>
                      </details>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button onClick={handleReset} variant="outline" className="flex-1">
                Import Another Wallet
              </Button>
              <Button
                onClick={() => {
                  window.location.href = '/holdings';
                }}
                className="flex-1"
              >
                View Holdings
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Main input form
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Cryptocurrency Wallet Import
          </CardTitle>
          <CardDescription>
            Import your crypto holdings from any blockchain wallet address
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Info alert */}
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Alpha Feature</AlertTitle>
            <AlertDescription>
              This feature is in alpha. We support 44+ blockchains including Ethereum, Bitcoin,
              Solana, and more. If you encounter any issues, full error details will be displayed.
            </AlertDescription>
          </Alert>

          {/* Wallet address input */}
          <div className="space-y-2">
            <Label htmlFor={walletAddressId}>
              Wallet Address <span className="text-destructive">*</span>
            </Label>
            <Input
              id={walletAddressId}
              placeholder="0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb..."
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
              disabled={isDetecting || isImporting}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Enter your wallet address from any supported blockchain
            </p>
          </div>

          {/* Display name input */}
          <div className="space-y-2">
            <Label htmlFor={displayNameId}>Display Name (Optional)</Label>
            <Input
              id={displayNameId}
              placeholder="My Main Wallet"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={isDetecting || isImporting}
            />
            <p className="text-xs text-muted-foreground">
              Give your wallet a friendly name (uses shortened address if not provided)
            </p>
          </div>

          {/* Detected chains preview */}
          {detectedChains.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Detected Chains ({detectedChains.length})</Label>
                <Badge variant="secondary">Ready to Import</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {detectedChains.map((chain) => (
                  <Badge
                    key={`${chain.chainId}-${chain.name}`}
                    variant="outline"
                    className="flex items-center gap-1"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    {chain.name}
                    <span className="text-xs text-muted-foreground">({chain.nativeSymbol})</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              onClick={handleDetectChains}
              disabled={!walletAddress.trim() || isDetecting || isImporting}
              variant="outline"
              className="flex-1"
            >
              {isDetecting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Detecting...
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Preview Chains
                </>
              )}
            </Button>

            <Button
              onClick={handleImportWallet}
              disabled={!walletAddress.trim() || isDetecting || isImporting}
              className="flex-1"
            >
              {isImporting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Wallet className="mr-2 h-4 w-4" />
                  Import Wallet
                </>
              )}
            </Button>
          </div>

          {/* Supported chains info */}
          <Card className="bg-muted/50">
            <CardContent className="p-4">
              <div className="text-sm space-y-2">
                <div className="font-semibold">Supported Blockchains (44+)</div>
                <div className="text-muted-foreground">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                    <div>✓ Ethereum</div>
                    <div>✓ Bitcoin</div>
                    <div>✓ Solana</div>
                    <div>✓ Polygon</div>
                    <div>✓ Arbitrum</div>
                    <div>✓ Optimism</div>
                    <div>✓ Base</div>
                    <div>✓ Avalanche</div>
                    <div>✓ BSC</div>
                    <div>✓ Tron</div>
                    <div>✓ TON</div>
                    <div>✓ And 33 more...</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  );
}
