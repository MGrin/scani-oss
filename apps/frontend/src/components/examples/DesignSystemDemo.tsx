import {
  Building2,
  CheckCircle2,
  CreditCard,
  Plus,
  Settings,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import type React from 'react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  EmptyState,
  ErrorMessage,
  feedbackMessages,
  getConfirmationMessage,
  InfoMessage,
  LoadingMessage,
  ProgressIndicator,
  StatusIndicator,
  SuccessMessage,
  WarningMessage,
} from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { colorSystem, designSystem } from '@/styles/design-system';

// TabButton component moved outside to avoid recreation on each render
const TabButton: React.FC<{
  tab: 'typography' | 'colors' | 'spacing' | 'feedback' | 'interactive';
  activeTab: 'typography' | 'colors' | 'spacing' | 'feedback' | 'interactive';
  onClick: (tab: 'typography' | 'colors' | 'spacing' | 'feedback' | 'interactive') => void;
  children: React.ReactNode;
}> = ({ tab, activeTab, onClick, children }) => (
  <Button
    variant={activeTab === tab ? 'default' : 'outline'}
    size="sm"
    onClick={() => onClick(tab)}
    className="whitespace-nowrap"
  >
    {children}
  </Button>
);

/**
 * DesignSystemDemo - A comprehensive demonstration of our standardized design system
 *
 * This component showcases:
 * - Consistent typography, spacing, and colors
 * - Standardized feedback messages and states
 * - Proper use of design tokens
 * - Theme-aware components
 * - Accessible UI patterns
 */
export const DesignSystemDemo: React.FC = () => {
  const [activeTab, setActiveTab] = useState<
    'typography' | 'colors' | 'spacing' | 'feedback' | 'interactive'
  >('typography');
  const [progress, setProgress] = useState(65);
  const [status, setStatus] = useState<'online' | 'offline' | 'syncing' | 'error'>('online');
  const [showSuccess, setShowSuccess] = useState(false);
  const [showError, setShowError] = useState(false);
  const [showWarning, setShowWarning] = useState(false);

  // Generate unique IDs for form inputs
  const accountNameId = useId();
  const accountTypeId = useId();
  const initialBalanceId = useId();

  const renderTypographyDemo = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Typography Scale</h3>
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            XS - 12px - {designSystem.typography.sizes.xs}
          </div>
          <div className="text-sm text-muted-foreground">
            SM - 14px - {designSystem.typography.sizes.sm}
          </div>
          <div className="text-base">BASE - 16px - {designSystem.typography.sizes.base}</div>
          <div className="text-lg">LG - 18px - {designSystem.typography.sizes.lg}</div>
          <div className="text-xl">XL - 20px - {designSystem.typography.sizes.xl}</div>
          <div className="text-2xl">2XL - 24px - {designSystem.typography.sizes['2xl']}</div>
          <div className="text-3xl">3XL - 30px - {designSystem.typography.sizes['3xl']}</div>
          <div className="text-4xl">4XL - 36px - {designSystem.typography.sizes['4xl']}</div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Font Weights</h3>
        <div className="space-y-2">
          <div className="font-light">Light (300) - Financial data with subtle emphasis</div>
          <div className="font-normal">Normal (400) - Regular body text for readability</div>
          <div className="font-medium">Medium (500) - Labels and secondary headings</div>
          <div className="font-semibold">Semibold (600) - Primary headings and buttons</div>
          <div className="font-bold">Bold (700) - Strong emphasis and titles</div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Font Families</h3>
        <div className="space-y-2">
          <div style={{ fontFamily: designSystem.typography.fonts.sans.join(', ') }}>
            Sans-serif: Inter, system-ui - Primary interface font
          </div>
          <div style={{ fontFamily: designSystem.typography.fonts.mono.join(', ') }}>
            Monospace: JetBrains Mono - For account numbers and codes
          </div>
          <div style={{ fontFamily: designSystem.typography.fonts.display.join(', ') }}>
            Display: Cal Sans - For marketing and hero sections
          </div>
        </div>
      </div>
    </div>
  );

  const renderColorsDemo = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Status Colors</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Object.entries(colorSystem.status).map(([type, colors]) => (
            <div key={type} className="space-y-2">
              <div className={`p-3 rounded-lg ${colors.bg} ${colors.border} border`}>
                <div className={`text-sm font-medium ${colors.text}`}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </div>
                <div className={`text-xs ${colors.text} mt-1`}>
                  Background, text, and border styles
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Semantic Colors (Theme Adaptive)</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {Object.entries(colorSystem.semantic).map(([name, value]) => (
            <div key={name} className="flex items-center gap-2">
              <div className="w-4 h-4 rounded border" style={{ backgroundColor: value }} />
              <span className="text-sm font-mono">{name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderSpacingDemo = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Spacing Scale</h3>
        <div className="space-y-3">
          {['0', '1', '2', '3', '4', '6', '8', '12', '16', '24', '32'].map((size) => (
            <div key={size} className="flex items-center gap-4">
              <div className="w-16 text-sm font-mono">{size}</div>
              <div className="w-20 text-xs text-muted-foreground">
                {designSystem.spacing[size as keyof typeof designSystem.spacing]}
              </div>
              <div
                className="bg-primary h-4"
                style={{ width: designSystem.spacing[size as keyof typeof designSystem.spacing] }}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Component Spacing Examples</h3>
        <div className="space-y-4">
          <div className="border rounded-lg p-4">
            <h4 className="font-medium mb-3">Button Sizes</h4>
            <div className="flex items-center gap-3">
              <Button size="sm">Small Button</Button>
              <Button size="default">Default Button</Button>
              <Button size="lg">Large Button</Button>
            </div>
          </div>

          <div className="border rounded-lg p-4">
            <h4 className="font-medium mb-3">Input Sizes</h4>
            <div className="space-y-3 max-w-xs">
              <Input placeholder="Small input" className="h-8 text-sm" />
              <Input placeholder="Default input" />
              <Input placeholder="Large input" className="h-12" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderFeedbackDemo = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Feedback Messages</h3>
        <div className="space-y-4">
          <SuccessMessage
            message={feedbackMessages.institutionCreated().message}
            dismissible
            onDismiss={() => setShowSuccess(false)}
          />

          <ErrorMessage
            title="Transaction Failed"
            message={feedbackMessages.networkError().message}
            actions={
              <Button variant="outline" size="sm">
                Retry Transaction
              </Button>
            }
          />

          <WarningMessage message={feedbackMessages.unsavedChanges().message} variant="outlined" />

          <InfoMessage message={feedbackMessages.syncing().message} variant="subtle" />
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Status & Progress</h3>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <StatusIndicator status={status} showLabel />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const statuses: (typeof status)[] = ['online', 'offline', 'syncing', 'error'];
                const currentIndex = statuses.indexOf(status);
                const nextStatus = statuses[(currentIndex + 1) % statuses.length];
                if (nextStatus) {
                  setStatus(nextStatus);
                }
              }}
            >
              Toggle Status
            </Button>
          </div>

          <div className="space-y-3">
            <ProgressIndicator progress={progress} />
            <ProgressIndicator progress={progress} variant="circular" />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProgress(Math.max(0, progress - 10))}
              >
                -10%
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProgress(Math.min(100, progress + 10))}
              >
                +10%
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Loading & Empty States</h3>
        <div className="space-y-4">
          <LoadingMessage variant="inline" />

          <EmptyState
            icon={<Building2 className="h-12 w-12" />}
            title="No institutions found"
            message="Start by adding your first financial institution to track your accounts"
            action={
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Institution
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );

  const renderInteractiveDemo = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Interactive Feedback</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5" />
                Chase Bank
              </CardTitle>
              <CardDescription>Primary checking and savings accounts</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Total Balance</span>
                  <span className="font-semibold">$12,485.43</span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setShowSuccess(true);
                      setTimeout(() => setShowSuccess(false), 3000);
                    }}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1" />
                    Update
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      const confirmed = confirm(
                        getConfirmationMessage('delete', 'institution', 'Chase Bank')
                      );
                      if (confirmed) {
                        setShowError(true);
                        setTimeout(() => setShowError(false), 3000);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Investment Account
              </CardTitle>
              <CardDescription>Brokerage and retirement funds</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Portfolio Value</span>
                  <span className="font-semibold text-green-600">$84,192.17</span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setShowWarning(true);
                      setTimeout(() => setShowWarning(false), 3000);
                    }}
                  >
                    <TrendingUp className="h-4 w-4 mr-1" />
                    Rebalance
                  </Button>
                  <Button size="sm" variant="outline">
                    <Settings className="h-4 w-4 mr-1" />
                    Settings
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Form Example</h3>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Add New Account</CardTitle>
            <CardDescription>Create a new financial account to track</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor={accountNameId}>Account Name</Label>
              <Input id={accountNameId} placeholder="e.g., Main Checking" className="mt-1" />
            </div>
            <div>
              <Label htmlFor={accountTypeId}>Account Type</Label>
              <Input
                id={accountTypeId}
                placeholder="e.g., Checking, Savings, Investment"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor={initialBalanceId}>Initial Balance</Label>
              <Input
                id={initialBalanceId}
                type="number"
                placeholder="0.00"
                step="0.01"
                min="0"
                className="mt-1"
              />
            </div>
            <Button className="w-full">Create Account</Button>
          </CardContent>
        </Card>
      </div>

      {/* Active Feedback Messages */}
      <div className="space-y-2">
        {showSuccess && (
          <SuccessMessage
            message={feedbackMessages.institutionUpdated().message}
            dismissible
            onDismiss={() => setShowSuccess(false)}
          />
        )}
        {showError && (
          <ErrorMessage
            message={feedbackMessages.deleteFailed('institution').message}
            dismissible
            onDismiss={() => setShowError(false)}
          />
        )}
        {showWarning && (
          <WarningMessage
            title="Rebalancing Required"
            message="Your portfolio allocation has drifted from target. Consider rebalancing."
            dismissible
            onDismiss={() => setShowWarning(false)}
            actions={
              <div className="flex gap-2">
                <Button variant="outline" size="sm">
                  Learn More
                </Button>
                <Button size="sm">Auto-Rebalance</Button>
              </div>
            }
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold">Scani Design System</h1>
        <p className="text-muted-foreground text-lg">
          Comprehensive UI components and design tokens for consistent user experience
        </p>
      </div>

      {/* Navigation Tabs */}
      <div className="flex gap-2 p-1 bg-muted rounded-lg overflow-x-auto">
        <TabButton tab="typography" activeTab={activeTab} onClick={setActiveTab}>
          Typography
        </TabButton>
        <TabButton tab="colors" activeTab={activeTab} onClick={setActiveTab}>
          Colors
        </TabButton>
        <TabButton tab="spacing" activeTab={activeTab} onClick={setActiveTab}>
          Spacing
        </TabButton>
        <TabButton tab="feedback" activeTab={activeTab} onClick={setActiveTab}>
          Feedback
        </TabButton>
        <TabButton tab="interactive" activeTab={activeTab} onClick={setActiveTab}>
          Interactive
        </TabButton>
      </div>

      {/* Content Panels */}
      <Card>
        <CardContent className="p-6">
          {activeTab === 'typography' && renderTypographyDemo()}
          {activeTab === 'colors' && renderColorsDemo()}
          {activeTab === 'spacing' && renderSpacingDemo()}
          {activeTab === 'feedback' && renderFeedbackDemo()}
          {activeTab === 'interactive' && renderInteractiveDemo()}
        </CardContent>
      </Card>

      {/* Design Token Usage Examples */}
      <Card>
        <CardHeader>
          <CardTitle>Design Token Usage</CardTitle>
          <CardDescription>Examples of how to use design tokens programmatically</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-muted rounded-lg p-4 font-mono text-sm space-y-2">
            <div>{/* Import design system */}</div>
            <div>import {'{ designSystem, getDesignToken }'} from '@/styles/design-system';</div>
            <div></div>
            <div>{/* Use tokens directly */}</div>
            <div>fontSize: designSystem.typography.sizes.lg</div>
            <div>padding: designSystem.spacing[4]</div>
            <div></div>
            <div>{/* Or use utility functions */}</div>
            <div>getDesignToken('components.button.heights.default') {/* "2.5rem" */}</div>
            <div>getDesignToken('typography.sizes.2xl') {/* "1.5rem" */}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default DesignSystemDemo;
