import { ExternalLink, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createPWADeepLink, getPlatform } from '@/lib/pwa-utils';

interface PWAAuthBridgeProps {
  /** If true, shows that auth was successful but in wrong context */
  authSuccess?: boolean;
}

/**
 * PWA Auth Bridge Component
 *
 * Displays when authentication happens in the browser but the user has
 * the PWA installed. Provides instructions and a button to return to the PWA.
 */
export function PWAAuthBridge({ authSuccess = true }: PWAAuthBridgeProps) {
  const platform = getPlatform();
  const deepLink = createPWADeepLink('/');

  const handleOpenPWA = () => {
    // Try to open the PWA
    window.location.href = deepLink;
  };

  const platformInstructions = {
    ios: 'Tap the button below, then select "Open in Scani" when prompted.',
    android: 'Tap the button below to return to the Scani app.',
    desktop: 'Click the button below to return to the Scani app.',
    unknown: 'Click the button below to return to the Scani app.',
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <div className="flex justify-center mb-4">
            <Smartphone className="h-12 w-12 text-blue-600" />
          </div>
          <CardTitle className="text-2xl text-center">
            {authSuccess ? 'Authentication Successful!' : 'Open in Scani App'}
          </CardTitle>
          <CardDescription className="text-center">
            {authSuccess
              ? 'Your authentication was completed in the browser'
              : 'This link should open in the Scani app'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {authSuccess && (
            <div className="p-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg">
              <p className="text-sm text-green-800 dark:text-green-200 text-center">
                ✓ You've been successfully signed in
              </p>
            </div>
          )}

          <div className="space-y-3">
            <p className="text-sm text-muted-foreground text-center">
              To continue using Scani, please return to the installed app.
            </p>
            <p className="text-sm text-muted-foreground text-center font-medium">
              {platformInstructions[platform]}
            </p>
          </div>

          <Button onClick={handleOpenPWA} className="w-full" size="lg">
            <ExternalLink className="mr-2 h-4 w-4" />
            Open Scani App
          </Button>

          <div className="pt-4 border-t">
            <p className="text-xs text-muted-foreground text-center">
              <strong>Why did this happen?</strong>
              <br />
              Authentication links from email open in your default browser by default. For the best
              experience, always use the Scani app installed on your device.
            </p>
          </div>

          {platform === 'ios' && (
            <div className="pt-2">
              <p className="text-xs text-muted-foreground text-center italic">
                <strong>iOS Tip:</strong> After tapping "Open Scani App", select "Open" when iOS
                asks how you want to open the link.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
