import { Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getFaviconUrl } from '@/lib/icons';
import type { CompleteImportData } from '@/types/addData';

interface MethodSelectionStepProps {
  completeImportData: CompleteImportData;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
}

export function MethodSelectionStep({
  completeImportData,
  onCompleteDataUpdate,
}: MethodSelectionStepProps) {
  const methods = [
    {
      id: 'manual' as const,
      title: 'Manual Entry',
      description: 'Manually enter your holdings, transactions, and account information',
      icon: '📝',
      iconType: 'emoji' as const,
      disabled: false,
    },
    {
      id: 'screenshots' as const,
      title: 'Screenshots Upload',
      description: 'Upload screenshots of your statements and let AI extract the data',
      icon: '📸',
      iconType: 'emoji' as const,
      disabled: false,
    },
    {
      id: 'wallet' as const,
      title: 'Cryptocurrency Wallet',
      description: 'Import your crypto holdings from any blockchain wallet address',
      icon: '🔐',
      iconType: 'emoji' as const,
      disabled: false,
    },
    {
      id: 'binance' as const,
      title: 'Connect Binance',
      description: 'Connect your Binance account with API credentials',
      icon: 'https://binance.com',
      iconType: 'favicon' as const,
      disabled: false,
    },
    {
      id: 'kraken' as const,
      title: 'Connect Kraken',
      description: 'Connect your Kraken account with API credentials',
      icon: 'https://kraken.com',
      iconType: 'favicon' as const,
      disabled: false,
    },
    {
      id: 'plaid' as const,
      title: 'Connect Bank Account',
      description: 'Securely connect your bank account via Plaid',
      icon: '🏦',
      iconType: 'emoji' as const,
      disabled: true,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>How would you like to add your data?</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-1 lg:grid-cols-3">
          {methods.map((method) => (
            <Card
              key={method.id}
              className={`transition-all hover:shadow-md ${
                completeImportData.method === method.id ? 'ring-2 ring-primary' : ''
              } ${
                method.disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:shadow-md'
              }`}
              onClick={() => {
                if (!method.disabled) {
                  onCompleteDataUpdate({ method: method.id });
                }
              }}
            >
              <CardContent className="p-4 md:p-6 text-center relative">
                {method.disabled && (
                  <div className="absolute top-2 right-2 flex items-center gap-1">
                    <Badge variant="secondary" className="bg-muted text-muted-foreground">
                      Coming Soon
                    </Badge>
                    {method.id === 'plaid' && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-full p-1 hover:bg-muted/80 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Info className="h-4 w-4 text-muted-foreground" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80" align="end">
                          <div className="space-y-2">
                            <h4 className="font-medium leading-none">Why is this disabled?</h4>
                            <p className="text-sm text-muted-foreground">
                              We utilize Plaid to enable secure bank account connections. Plaid
                              maintains rigorous security standards and requires comprehensive
                              onboarding procedures. We are currently awaiting completion of Plaid's
                              security audit. Once the audit is finalized and approved, we will
                              promptly enable this feature and notify all users.
                            </p>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                )}
                <div className="flex justify-center items-center mb-2 md:mb-4">
                  {method.iconType === 'emoji' ? (
                    <div className="text-3xl md:text-4xl">{method.icon}</div>
                  ) : (
                    <img
                      src={getFaviconUrl(method.icon) || ''}
                      alt={`${method.title} logo`}
                      className="w-12 h-12 md:w-16 md:h-16 rounded-lg object-contain"
                      onError={(e) => {
                        // Fallback to a generic icon or emoji if favicon fails to load
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )}
                </div>
                <h3 className="font-semibold mb-1 md:mb-2 text-sm md:text-base">{method.title}</h3>
                <p className="text-xs md:text-sm text-muted-foreground">{method.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
