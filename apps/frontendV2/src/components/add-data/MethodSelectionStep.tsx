import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
      disabled: false,
    },
    {
      id: 'screenshots' as const,
      title: 'Screenshots Upload',
      description: 'Upload screenshots of your statements and let AI extract the data',
      icon: '📸',
      disabled: false,
    },
    {
      id: 'wallet' as const,
      title: 'Cryptocurrency Wallet',
      description: 'Import your crypto holdings from any blockchain wallet address',
      icon: '🔐',
      disabled: false,
    },
    {
      id: 'binance' as const,
      title: 'Connect Binance',
      description: 'Connect your Binance account with API credentials',
      icon: '📊',
      disabled: false,
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
                  <Badge
                    variant="secondary"
                    className="absolute top-2 right-2 bg-muted text-muted-foreground"
                  >
                    Coming Soon
                  </Badge>
                )}
                <div className="text-3xl md:text-4xl mb-2 md:mb-4">{method.icon}</div>
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
