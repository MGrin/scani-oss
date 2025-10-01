import { ExternalLink, Info, X } from 'lucide-react';
import type React from 'react';
import { Alert, AlertDescription } from './alert';
import { Button } from './button';

export interface UnpriceableToken {
  symbol: string;
  balance: string;
  reason: string;
  provider: string;
  providerPricingUrl?: string;
  institutionName: string;
  accountName: string;
}

interface MonetizationNotificationProps {
  unpriceableTokens: UnpriceableToken[];
  onDismiss: () => void;
  className?: string;
}

export const MonetizationNotification: React.FC<MonetizationNotificationProps> = ({
  unpriceableTokens,
  onDismiss,
  className = '',
}) => {
  if (!unpriceableTokens || unpriceableTokens.length === 0) {
    return null;
  }

  const tokenCount = unpriceableTokens.length;
  const pluralTokens = tokenCount === 1 ? 'token' : 'tokens';

  return (
    <Alert
      className={`bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800 ${className}`}
    >
      <Info className="h-4 w-4 text-blue-600 dark:text-blue-300" />
      <div className="flex-1">
        <AlertDescription className="text-blue-800 dark:text-blue-100">
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <p className="font-medium mb-2">
                {tokenCount} {pluralTokens} couldn't be priced automatically
              </p>
              <p className="text-sm mb-2">
                Some of these assets are being priced through a temporary Google Sheet fallback we
                maintain by hand. It's fine for demos, but it's not reliable enough for the
                long-term portfolio tracking you deserve.
              </p>
              <p className="text-sm mb-3">
                Scani is a bootstrapped project with no investors—we stretch free provider tiers and
                hacky workarounds to keep things running. Upgrading to Premium helps us cover real
                market data costs and invest more time into building the product faster.
              </p>

              <details className="text-sm mb-3">
                <summary className="cursor-pointer hover:text-blue-900 dark:hover:text-blue-50 font-medium">
                  View affected tokens ({tokenCount})
                </summary>
                <div className="mt-2 pl-4 border-l-2 border-blue-200 dark:border-blue-700">
                  {unpriceableTokens.map((token) => (
                    <div
                      key={`${token.symbol}-${token.institutionName}-${token.accountName}`}
                      className="mb-2 p-2 bg-blue-50 dark:bg-blue-950 rounded border"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs bg-blue-100 dark:bg-blue-900 dark:text-blue-100 px-2 py-1 rounded">
                          {token.symbol}
                        </span>
                        <span className="text-xs text-blue-600 dark:text-blue-200">
                          {token.institutionName} → {token.accountName}
                        </span>
                      </div>
                      <div className="text-xs text-blue-700 dark:text-blue-200 mb-1">
                        {token.reason}
                      </div>
                      <div className="flex items-center gap-1 text-xs">
                        <span className="text-blue-600 dark:text-blue-200">
                          Provider: {token.provider}
                        </span>
                        {token.providerPricingUrl && (
                          <a
                            href={token.providerPricingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-800 dark:text-blue-100 hover:text-blue-900 dark:hover:text-blue-50 underline"
                          >
                            (view pricing)
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </details>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900"
                  onClick={() => window.open('#', '_blank')}
                >
                  Upgrade to Premium
                  <ExternalLink className="ml-1 h-3 w-3" />
                </Button>
              </div>
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              className="text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900 ml-4"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </AlertDescription>
      </div>
    </Alert>
  );
};
