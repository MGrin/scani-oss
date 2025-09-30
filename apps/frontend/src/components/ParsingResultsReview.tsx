import type { ParsedHolding } from '@scani/shared';
import {
  AlertTriangle,
  Brain,
  CheckCircle,
  Edit3,
  Eye,
  EyeOff,
  Info,
  Plus,
  Trash2,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn, normalizeSymbol } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

// Using shared ParsedHolding type; UI can augment transient fields in component state if needed

interface ParsedPortfolio {
  holdings: ParsedHolding[];
  overallConfidence: number;
  context?: string;
  detectedCurrency?: string;
}

interface ParsingResultsReviewProps {
  portfolio: ParsedPortfolio;
  account: {
    id: string;
    name: string;
    institutionName: string;
  };
  summary: {
    totalHoldings: number;
    existingTokens: number;
    newTokensRequired: number;
    averageConfidence: number;
    hasErrors: boolean;
    hasWarnings: boolean;
  };
  aiMetadata?: {
    provider: string;
    model: string;
    processingTime?: number;
    tokensUsed?: number;
  };
  onApprove: (holdings: ParsedHolding[], options: { createMissingTokens: boolean }) => void;
  onCancel: () => void;
  isProcessing?: boolean;
}

export function ParsingResultsReview({
  portfolio,
  account,
  summary: _summary, // Original summary for reference, we calculate our own
  aiMetadata,
  onApprove,
  onCancel,
  isProcessing = false,
}: ParsingResultsReviewProps) {
  const checkboxId = useId();
  const [holdings, setHoldings] = useState<ParsedHolding[]>(portfolio.holdings);
  const rowKeysRef = useRef<string[]>(
    portfolio.holdings.map((_, i) => `holding-${i}-${Math.random().toString(36).slice(2, 9)}`)
  );
  const [createMissingTokens, setCreateMissingTokens] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Validate a single field and return errors/warnings
  const validateField = useCallback((field: string, value: string) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    switch (field) {
      case 'symbol':
        if (!value || value.length === 0) {
          errors.push('Symbol is required');
        } else if (value.length > 20) {
          errors.push('Symbol must be 20 characters or less');
        } else if (!/^[A-Z0-9-_]+$/i.test(value)) {
          warnings.push('Symbol contains special characters');
        }
        break;
      case 'balance':
        if (!value || value === '0') {
          errors.push('Balance must be greater than 0');
        } else {
          try {
            const num = parseFloat(value);
            if (Number.isNaN(num) || num <= 0) {
              errors.push('Balance must be a positive number');
            } else if (num > 1e12) {
              warnings.push('Very large balance - please verify');
            }
          } catch {
            errors.push('Invalid balance format');
          }
        }
        break;
      case 'name':
        if (value && value.length > 100) {
          errors.push('Name must be 100 characters or less');
        }
        break;
    }

    return { errors, warnings };
  }, []);

  // Handle holding edits with validation
  const updateHolding = useCallback(
    (index: number, updates: Partial<ParsedHolding>) => {
      setHoldings((prev) =>
        prev.map((holding, i) => {
          if (i !== index) return holding;

          const updated = { ...holding, ...updates };

          // Clear previous errors and warnings for updated fields
          updated.errors = updated.errors.filter(
            (error) => !Object.keys(updates).some((field) => error.includes(field))
          );
          updated.warnings = updated.warnings.filter(
            (warning) => !Object.keys(updates).some((field) => warning.includes(field))
          );

          // Validate updated fields
          Object.entries(updates).forEach(([field, value]) => {
            if (typeof value === 'string') {
              const validation = validateField(field, value);
              updated.errors.push(...validation.errors);
              updated.warnings.push(...validation.warnings);
            }
          });

          return updated;
        })
      );
    },
    [validateField]
  );

  const removeHolding = useCallback((index: number) => {
    setHoldings((prev) => prev.filter((_, i) => i !== index));
    rowKeysRef.current.splice(index, 1);
  }, []);

  const addHolding = useCallback(() => {
    const newHolding: ParsedHolding = {
      symbol: '',
      balance: '0',
      confidence: 1,
      tokenExists: false,
      errors: [],
      warnings: ['Manually added holding'],
    };
    setHoldings((prev) => [...prev, newHolding]);
    rowKeysRef.current.push(
      `holding-${rowKeysRef.current.length}-${Math.random().toString(36).slice(2, 9)}`
    );
    setEditingIndex(holdings.length);
  }, [holdings.length]);

  // Get confidence color
  const getConfidenceColor = useCallback((confidence: number) => {
    if (confidence >= 0.8) return 'text-green-600';
    if (confidence >= 0.6) return 'text-yellow-600';
    return 'text-red-600';
  }, []);

  const getConfidenceLabel = useCallback((confidence: number) => {
    if (confidence >= 0.8) return 'High';
    if (confidence >= 0.6) return 'Medium';
    return 'Low';
  }, []);

  // Calculate updated summary
  const updatedSummary = React.useMemo(() => {
    const validHoldings = holdings.filter((h) => h.symbol && h.balance && h.balance !== '0');
    return {
      totalHoldings: validHoldings.length,
      existingTokens: validHoldings.filter((h) => h.tokenExists).length,
      newTokensRequired: validHoldings.filter((h) => !h.tokenExists).length,
      averageConfidence:
        validHoldings.length > 0
          ? validHoldings.reduce((sum, h) => sum + h.confidence, 0) / validHoldings.length
          : 0,
      hasErrors: validHoldings.some((h) => h.errors.length > 0),
      hasWarnings: validHoldings.some((h) => h.warnings.length > 0),
    };
  }, [holdings]);

  const canApprove =
    holdings.length > 0 &&
    holdings.every((h) => h.symbol && h.balance && h.balance !== '0') &&
    !updatedSummary.hasErrors;

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold">Review Extracted Holdings</h2>
              <p className="text-muted-foreground">
                AI detected {portfolio.holdings.length} holdings from your screenshot
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
              {showDetails ? 'Hide' : 'Show'} Details
            </Button>
          </div>

          {/* Account Info */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <p className="font-medium">{account.name}</p>
                  <p className="text-sm text-muted-foreground">at {account.institutionName}</p>
                </div>
                {portfolio.detectedCurrency && (
                  <Badge variant="secondary">{portfolio.detectedCurrency}</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* AI Analysis Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              AI Analysis Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold">{updatedSummary.totalHoldings}</div>
                <div className="text-sm text-muted-foreground">Holdings Detected</div>
              </div>
              <div className="text-center">
                <div
                  className={cn(
                    'text-2xl font-bold',
                    getConfidenceColor(updatedSummary.averageConfidence)
                  )}
                >
                  {Math.round(updatedSummary.averageConfidence * 100)}%
                </div>
                <div className="text-sm text-muted-foreground">Avg Confidence</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">
                  {updatedSummary.existingTokens}
                </div>
                <div className="text-sm text-muted-foreground">Known Assets</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-orange-600">
                  {updatedSummary.newTokensRequired}
                </div>
                <div className="text-sm text-muted-foreground">New Assets</div>
              </div>
            </div>

            {showDetails && (
              <>
                <Separator />
                <div className="space-y-2">
                  {aiMetadata && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">AI Provider:</span>
                      <span className="font-medium">
                        {aiMetadata.provider} ({aiMetadata.model})
                      </span>
                    </div>
                  )}
                  {portfolio.context && (
                    <div className="flex items-start justify-between text-sm">
                      <span className="text-muted-foreground">Context:</span>
                      <span className="font-medium text-right max-w-xs">{portfolio.context}</span>
                    </div>
                  )}
                  {aiMetadata?.processingTime && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Processing Time:</span>
                      <span className="font-medium">{aiMetadata.processingTime}ms</span>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Alerts */}
            {updatedSummary.hasErrors && (
              <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-lg border border-destructive/20">
                <XCircle className="h-4 w-4 text-destructive" />
                <span className="text-sm text-destructive font-medium">
                  Some holdings have errors that need to be fixed before proceeding
                </span>
              </div>
            )}

            {updatedSummary.hasWarnings && (
              <div className="flex items-center gap-2 p-3 bg-warning/10 rounded-lg border border-warning/20">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <span className="text-sm text-warning font-medium">
                  Some holdings have warnings - please review carefully
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Holdings List */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Detected Holdings</h3>
            <Button variant="outline" size="sm" onClick={addHolding}>
              <Plus className="h-4 w-4 mr-2" />
              Add Holding
            </Button>
          </div>

          {holdings.map((holding, index) => (
            <HoldingCard
              key={rowKeysRef.current[index]}
              holding={holding}
              index={index}
              isEditing={editingIndex === index}
              onEdit={() => setEditingIndex(editingIndex === index ? null : index)}
              onUpdate={(updates) => updateHolding(index, updates)}
              onRemove={() => removeHolding(index)}
              getConfidenceColor={getConfidenceColor}
              getConfidenceLabel={getConfidenceLabel}
            />
          ))}

          {holdings.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground">No holdings detected or all removed</p>
                <Button variant="outline" onClick={addHolding} className="mt-4">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Holding Manually
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Options */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center space-x-2">
              <Checkbox
                id={checkboxId}
                checked={createMissingTokens}
                onCheckedChange={setCreateMissingTokens}
              />
              <Label htmlFor={checkboxId} className="text-sm">
                Create missing assets automatically
              </Label>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>If enabled, new asset types will be created for unrecognized symbols</p>
                </TooltipContent>
              </Tooltip>
            </div>
            {updatedSummary.newTokensRequired > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                {updatedSummary.newTokensRequired} new assets will be created
              </p>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center justify-between pt-4">
          <Button variant="outline" onClick={onCancel} disabled={isProcessing}>
            Cancel
          </Button>
          <div className="space-y-2">
            <Button
              onClick={() => onApprove(holdings, { createMissingTokens })}
              disabled={!canApprove || isProcessing}
              className="min-w-48"
            >
              {isProcessing ? (
                <>
                  <TrendingUp className="h-4 w-4 mr-2 animate-pulse" />
                  Processing {updatedSummary.totalHoldings} Holdings...
                </>
              ) : (
                <>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Create Holdings ({updatedSummary.totalHoldings})
                </>
              )}
            </Button>

            {isProcessing && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p>• Creating holdings</p>
                <p>• {createMissingTokens ? 'Creating missing tokens' : 'Using existing tokens'}</p>
                <p>• This may take a few moments...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

// Individual holding card component
interface HoldingCardProps {
  holding: ParsedHolding;
  index: number;
  isEditing: boolean;
  onEdit: () => void;
  onUpdate: (updates: Partial<ParsedHolding>) => void;
  onRemove: () => void;
  getConfidenceColor: (confidence: number) => string;
  getConfidenceLabel: (confidence: number) => string;
}

const HoldingCard = React.memo(function HoldingCard({
  holding,
  index,
  isEditing,
  onEdit,
  onUpdate,
  onRemove,
  getConfidenceColor,
  getConfidenceLabel,
}: HoldingCardProps) {
  const [localSymbol, setLocalSymbol] = useState(holding.symbol);
  const [localBalance, setLocalBalance] = useState(holding.balance);
  const [localName, setLocalName] = useState(holding.name || '');
  const symbolInputRef = useRef<HTMLInputElement | null>(null);
  const balanceInputRef = useRef<HTMLInputElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [focusedField, setFocusedField] = useState<'symbol' | 'balance' | 'name' | null>(null);

  // Default focus when entering edit mode
  useEffect(() => {
    if (isEditing && !focusedField) {
      setFocusedField('balance');
    }
    if (!isEditing && focusedField) {
      setFocusedField(null);
    }
  }, [isEditing, focusedField]);

  // Preserve focus on the currently active field while editing
  useEffect(() => {
    if (!isEditing) return;
    const targetRef =
      focusedField === 'symbol'
        ? symbolInputRef.current
        : focusedField === 'balance'
          ? balanceInputRef.current
          : focusedField === 'name'
            ? nameInputRef.current
            : null;
    if (targetRef) {
      queueMicrotask(() => targetRef.focus({ preventScroll: true }));
    }
  }, [isEditing, focusedField]);

  const saveChanges = useCallback(() => {
    onUpdate({
      symbol: normalizeSymbol(localSymbol),
      balance: localBalance,
      name: localName || undefined,
    });
    onEdit();
  }, [localSymbol, localBalance, localName, onUpdate, onEdit]);

  const cancelChanges = useCallback(() => {
    setLocalSymbol(holding.symbol);
    setLocalBalance(holding.balance);
    setLocalName(holding.name || '');
    onEdit();
  }, [holding, onEdit]);

  return (
    <Card
      className={cn(
        'transition-all',
        holding.errors.length > 0 && 'border-destructive/50 bg-destructive/5',
        holding.warnings.length > 0 && !holding.errors.length && 'border-warning/50 bg-warning/5',
        isEditing && 'ring-2 ring-primary/40'
      )}
    >
      <CardContent className="p-4">
        {isEditing ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Badge variant="secondary" className="uppercase tracking-wide">
                Editing
              </Badge>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={cancelChanges}
                  aria-label="Cancel editing"
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={saveChanges} aria-label="Save changes">
                  Save
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor={`symbol-${index}`}>Symbol</Label>
                <Input
                  id={`symbol-${index}`}
                  ref={symbolInputRef}
                  value={localSymbol}
                  onChange={(e) => setLocalSymbol(e.target.value)}
                  placeholder="AAPL"
                  onFocus={() => setFocusedField('symbol')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveChanges();
                    if (e.key === 'Escape') cancelChanges();
                  }}
                />
              </div>
              <div>
                <Label htmlFor={`balance-${index}`}>Balance</Label>
                <Input
                  id={`balance-${index}`}
                  ref={balanceInputRef}
                  value={localBalance}
                  onChange={(e) => setLocalBalance(e.target.value)}
                  placeholder="0.00"
                  // Use text + inputMode to avoid browser number quirks and focus issues
                  type="text"
                  inputMode="decimal"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveChanges();
                    if (e.key === 'Escape') cancelChanges();
                  }}
                  onFocus={() => setFocusedField('balance')}
                />
              </div>
            </div>
            <div>
              <Label htmlFor={`name-${index}`}>Name (Optional)</Label>
              <Input
                id={`name-${index}`}
                ref={nameInputRef}
                value={localName}
                onChange={(e) => setLocalName(e.target.value)}
                placeholder="Apple Inc."
                onFocus={() => setFocusedField('name')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveChanges();
                  if (e.key === 'Escape') cancelChanges();
                }}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-lg">{holding.symbol}</span>
                    {holding.name && (
                      <span className="text-muted-foreground text-sm">({holding.name})</span>
                    )}
                    {!holding.tokenExists && (
                      <Badge variant="outline" className="text-xs">
                        New
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <span className="text-xl font-semibold">{holding.balance}</span>
                    <div className="flex items-center gap-1">
                      <span
                        className={cn(
                          'text-sm font-medium',
                          getConfidenceColor(holding.confidence)
                        )}
                      >
                        {getConfidenceLabel(holding.confidence)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({Math.round(holding.confidence * 100)}%)
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Errors and warnings */}
              {holding.errors.length > 0 && (
                <div className="mt-2">
                  {holding.errors.map((error, i) => (
                    <div
                      key={`error-${i}-${error}`}
                      className="flex items-center gap-1 text-xs text-destructive"
                    >
                      <XCircle className="h-3 w-3" />
                      {error}
                    </div>
                  ))}
                </div>
              )}

              {holding.warnings.length > 0 && (
                <div className="mt-2">
                  {holding.warnings.map((warning, i) => (
                    <div
                      key={`warning-${i}-${warning}`}
                      className="flex items-center gap-1 text-xs text-warning"
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {warning}
                    </div>
                  ))}
                </div>
              )}

              {/* Provider validation status */}
              {holding.providerValidation && (
                <div className="mt-2 space-y-1">
                  {holding.providerValidation.exactMatch && (
                    <div className="flex items-center gap-1 text-xs text-green-600">
                      <CheckCircle className="h-3 w-3" />
                      Verified in {holding.providerValidation.exactMatch.metadata?.provider}
                      {holding.providerValidation.exactMatch.metadata?.exchange && (
                        <span className="text-muted-foreground">
                          ({holding.providerValidation.exactMatch.metadata.exchange})
                        </span>
                      )}
                    </div>
                  )}

                  {holding.providerValidation.similarMatches &&
                    holding.providerValidation.similarMatches.length > 0 &&
                    !holding.providerValidation.exactMatch && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1 text-xs text-orange-600">
                          <Info className="h-3 w-3" />
                          {holding.providerValidation.similarMatches.length} similar match
                          {holding.providerValidation.similarMatches.length !== 1 ? 'es' : ''} found
                          - please select:
                        </div>

                        <div className="space-y-1 ml-4">
                          {holding.providerValidation.similarMatches
                            .slice(0, 5)
                            .map((match, matchIndex) => (
                              <button
                                type="button"
                                key={`${match.metadata?.symbol || 'unknown'}-${matchIndex}`}
                                className="flex items-center justify-between w-full text-xs p-2 rounded border hover:bg-muted/50 text-left"
                                onClick={() => {
                                  // Update the holding with the selected match
                                  onUpdate({
                                    symbol: match.metadata?.symbol || holding.symbol,
                                    name: match.metadata?.name || holding.name,
                                    providerValidation: {
                                      ...(holding.providerValidation || {}),
                                      exactMatch: match,
                                      similarMatches: [],
                                    },
                                  });
                                }}
                              >
                                <div className="flex flex-col gap-1">
                                  <div className="font-medium">
                                    {match.metadata?.symbol || 'Unknown'}
                                  </div>
                                  {match.metadata?.name && (
                                    <div className="text-muted-foreground">
                                      {match.metadata.name}
                                    </div>
                                  )}
                                </div>
                                <div className="text-right">
                                  <div className="text-muted-foreground">
                                    {match.metadata?.provider || 'Unknown'}
                                  </div>
                                  {match.metadata?.exchange && (
                                    <div className="text-muted-foreground text-xs">
                                      {match.metadata.exchange}
                                    </div>
                                  )}
                                </div>
                              </button>
                            ))}

                          {holding.providerValidation.similarMatches.length > 5 && (
                            <div className="text-xs text-muted-foreground ml-2">
                              ... and {holding.providerValidation.similarMatches.length - 5} more
                              matches
                            </div>
                          )}

                          <button
                            type="button"
                            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 ml-2 mt-1"
                            onClick={() => {
                              // Show full token selector or allow manual token creation
                              // TODO: Implement token creation/selection modal
                            }}
                          >
                            <Plus className="h-3 w-3" />
                            Create new token instead
                          </button>
                        </div>
                      </div>
                    )}

                  {holding.providerValidation.noMatches && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1 text-xs text-red-600">
                        <XCircle className="h-3 w-3" />
                        No matches found in pricing providers
                      </div>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 ml-4"
                        onClick={() => {
                          // Show full token selector or allow manual token creation
                          // TODO: Implement token creation/selection modal
                        }}
                      >
                        <Plus className="h-3 w-3" />
                        Create new token or select from existing
                      </button>
                    </div>
                  )}
                </div>
              )}

              {holding.notes && (
                <p className="text-xs text-muted-foreground mt-2">{holding.notes}</p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger>
                  <span>
                    <Button variant="outline" size="sm" onClick={onEdit} aria-label="Edit holding">
                      <Edit3 className="h-4 w-4 mr-1" /> Edit
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Edit this holding</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onRemove}
                      aria-label="Remove holding"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Remove this holding</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
