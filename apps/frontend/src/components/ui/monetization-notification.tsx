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
    <Alert className={`bg-blue-50 border-blue-200 ${className}`}>
      <Info className="h-4 w-4 text-blue-600" />
      <div className="flex-1">
        <AlertDescription className="text-blue-800">
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <p className="font-medium mb-2">
                {tokenCount} {pluralTokens} couldn't be priced automatically
              </p>
              <p className="text-sm mb-3">
                We're using basic/free plans from data providers which have limited coverage.
                Developers are funding data costs from their own pocket but can't afford premium
                subscriptions. Upgrade to help cover these costs.
              </p>

              <details className="text-sm mb-3">
                <summary className="cursor-pointer hover:text-blue-900 font-medium">
                  View affected tokens ({tokenCount})
                </summary>
                <div className="mt-2 pl-4 border-l-2 border-blue-200">
                  {unpriceableTokens.map((token) => (
                    <div
                      key={`${token.symbol}-${token.institutionName}-${token.accountName}`}
                      className="mb-2 p-2 bg-blue-25 rounded border"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs bg-blue-100 px-2 py-1 rounded">
                          {token.symbol}
                        </span>
                        <span className="text-xs text-blue-600">
                          {token.institutionName} → {token.accountName}
                        </span>
                      </div>
                      <div className="text-xs text-blue-700 mb-1">{token.reason}</div>
                      <div className="flex items-center gap-1 text-xs">
                        <span className="text-blue-600">Provider: {token.provider}</span>
                        {token.providerPricingUrl && (
                          <a
                            href={token.providerPricingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-800 hover:text-blue-900 underline"
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
                  className="text-blue-700 border-blue-300 hover:bg-blue-100"
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
              className="text-blue-600 hover:bg-blue-100 ml-4"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </AlertDescription>
      </div>
    </Alert>
  );
};
