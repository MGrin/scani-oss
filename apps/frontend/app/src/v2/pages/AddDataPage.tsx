import { Card, CardContent } from '@scani/ui/ui/card';
import { FileUp, Keyboard, Plug, Wallet } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { V2_ROUTES } from '../lib/routes';

interface MethodOption {
  id: string;
  icon: React.ElementType;
  title: string;
  description: string;
  action: () => void;
}

export function AddDataPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Forward context params (accountId, institutionId) to sub-pages
  const contextParams = new URLSearchParams();
  const accountId = searchParams.get('accountId');
  const institutionId = searchParams.get('institutionId');
  if (accountId) contextParams.set('accountId', accountId);
  if (institutionId) contextParams.set('institutionId', institutionId);
  const qs = contextParams.toString() ? `?${contextParams.toString()}` : '';

  const methods: MethodOption[] = [
    {
      id: 'manual',
      icon: Keyboard,
      title: 'Manual Entry',
      description: 'Manually enter your holdings and balances',
      action: () => navigate(`${V2_ROUTES.manualEntry}${qs}`),
    },
    {
      id: 'file',
      icon: FileUp,
      title: 'Upload File or Screenshot',
      description: 'Upload a CSV, OFX statement, or screenshot to import your data',
      action: () => navigate(`${V2_ROUTES.fileImport}${qs}`),
    },
    {
      id: 'wallet',
      icon: Wallet,
      title: 'Crypto Wallet',
      description: 'Import balances from your blockchain wallet address',
      action: () => navigate(V2_ROUTES.walletImport),
    },
    {
      id: 'exchange',
      icon: Plug,
      title: 'Connect Exchange',
      description: 'Connect your exchange or broker with API keys',
      action: () => navigate(V2_ROUTES.integrations),
    },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Add Data</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose how you want to add your financial data
        </p>
      </div>

      <div className="grid gap-3">
        {methods.map((method) => (
          <Card
            key={method.id}
            className="cursor-pointer hover:border-primary/50 transition-colors"
            onClick={method.action}
          >
            <CardContent className="flex items-center gap-4 p-4">
              <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <method.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium text-sm">{method.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{method.description}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
