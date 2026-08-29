import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@scani/ui/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@scani/ui/ui/alert';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Checkbox } from '@scani/ui/ui/checkbox';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@scani/ui/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@scani/ui/ui/dialog';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { LoadingDots, LoadingSpinner } from '@scani/ui/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@scani/ui/ui/popover';
import { Progress } from '@scani/ui/ui/progress';
import { ScrollArea } from '@scani/ui/ui/scroll-area';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Separator } from '@scani/ui/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@scani/ui/ui/sheet';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Switch } from '@scani/ui/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@scani/ui/ui/tabs';
import { Textarea } from '@scani/ui/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@scani/ui/ui/tooltip';
import { AccountPicker, type AccountPickerOption } from '@scani/ui/v3/components/AccountPicker';
import { DeltaPill } from '@scani/ui/v3/components/charts/DeltaPill';
import { Sparkline } from '@scani/ui/v3/components/charts/Sparkline';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { Wallet } from 'lucide-react';
import { useId, useState } from 'react';
import { AllocationBar } from '../components/charts/AllocationBar';
import { V3TokenScope } from '../components/V3TokenScope';

/** Unlinked and outside `V3_ROUTES` — the gallery is not a destination. */
const KITCHEN_SINK_BASE = '/kitchen-sink';

/**
 * The v3 primitive gallery — every `@scani/ui` primitive rendered against the
 * v3 tokens, in both themes at once, as the screenshot target that stands in
 * for Storybook (research brief §1.3: a second build pipeline was not worth
 * what it adds over a route that lives in the app).
 *
 * Deliberately deletable: this file plus its one `<Route>` in `V3App.tsx` are
 * the whole footprint. It is not in the nav and nothing imports it.
 *
 * Each pane is its own `V3TokenScope`, so an overlay opened from the light
 * pane portals into the light pane and one opened from the dark pane into the
 * dark pane (V3-22). Overlays are `fixed inset-0`, so they cover the viewport
 * either way — what the pane decides is which token set they resolve against,
 * which is the whole point of having them here.
 *
 * Toast is omitted: it is app-level plumbing (a `<Toaster>` at the root), not
 * a primitive that renders in place.
 */

const THEMES = ['light', 'dark'] as const;

const CHART_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** A month of net worth with a realistic amount of noise on the way up. */
const NET_WORTH_SERIES = [
  118_400, 119_100, 118_050, 120_600, 121_300, 120_900, 122_800, 123_400, 122_100, 124_900, 125_600,
  124_300, 126_800, 127_500, 128_450,
];

const ALLOCATION = [
  { key: 'crypto', label: 'Crypto', value: 52_400 },
  { key: 'stocks', label: 'Stocks', value: 38_100 },
  { key: 'cash', label: 'Cash', value: 17_000 },
  { key: 'bonds', label: 'Bonds', value: 11_200 },
  { key: 'realestate', label: 'Real estate', value: 6_300 },
  { key: 'commodities', label: 'Commodities', value: 2_100 },
  { key: 'collectibles', label: 'Collectibles', value: 1_050 },
  { key: 'other', label: 'Private equity', value: 400 },
];

/** Enough rows to overflow the ScrollArea's fixed height. */
const SCROLL_ROWS = Array.from({ length: 12 }, (_, i) => ({
  label: `Position ${i + 1}`,
  value: 1000 - i * 37,
}));

/** Deliberately spanning four orders of magnitude, so a screenshot shows
 *  whether the digits still land in the same columns. */
const ALIGNMENT_ROWS = [
  { label: 'One', value: 7.05, delta: 0.4 },
  { label: 'Two', value: 481.2, delta: -12.75 },
  { label: 'Three', value: 12_804.99, delta: 340.1 },
  { label: 'Four', value: 1_284_320.4, delta: 0 },
] as const;

/** A long identity against a long figure — the case that decides which zone
 *  gives way. */
const HOLDING_ROWS = [
  { symbol: 'BTC', venue: 'Kraken · Spot', value: 18_204.55, delta: 2.14 },
  { symbol: 'ETH', venue: 'Coinbase · Spot', value: 3180.4, delta: -1.08 },
  { symbol: 'VWRA', venue: 'Interactive Brokers · Taxable brokerage', value: 128_400.62, delta: 0 },
  {
    symbol: 'Wrapped Staked Ether (long identity that has to truncate)',
    venue: 'Ethereum mainnet · 0x7f2c…9ab1',
    value: 1_284_320.4,
    delta: 11.9,
  },
  { symbol: 'CASH', venue: 'Wise · SGD', value: null, delta: 0 },
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The rows SC-850 was reported over, near enough to be recognisable.
 *
 * `Airwallex` at Airwallex and the Bitcoin wallet are the doubled labels from
 * the production screenshot; the two Airwallex USD holdings are the shape the
 * subtitle exists for, and every row below them deliberately has none.
 */
const SPECIMEN_ACCOUNTS: AccountPickerOption[] = [
  {
    id: 'ap-1',
    name: 'Airwallex',
    institution: 'Airwallex',
    subtitle: '1,201.50 USD · import_airwallex',
    group: 'Already holds USD',
  },
  {
    id: 'ap-2',
    name: 'Airwallex',
    institution: 'Airwallex',
    subtitle: '6,217.15 USD · manual',
    group: 'Already holds USD',
  },
  {
    id: 'ap-3',
    name: 'Solana Network - 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    institution: 'Solana Network',
    group: 'On the same network',
    groupHint: 'No USD tracked here yet — a holding will be created',
  },
  { id: 'ap-4', name: 'Edge Capital', institution: 'Edge Capital', group: 'Your other accounts' },
  {
    id: 'ap-5',
    name: 'Bitcoin Network - bc1q5n8k3vqfjy7t2ep0mhq9wr6l4xz8dc2u',
    institution: 'Bitcoin Network',
    group: 'Your other accounts',
  },
  { id: 'ap-6', name: 'Spot', institution: 'Kraken', group: 'Your other accounts' },
  { id: 'ap-7', name: 'Joint current', institution: 'Revolut', group: 'Your other accounts' },
  { id: 'ap-8', name: 'SGD balance', institution: 'Wise', group: 'Your other accounts' },
  { id: 'ap-9', name: 'Cash box', institution: null, group: 'Your other accounts' },
];

function Specimens() {
  const [switchOn, setSwitchOn] = useState(true);
  const [range, setRange] = useState('30d');
  const [checked, setChecked] = useState(true);
  const [pickedAccount, setPickedAccount] = useState<string | null>('ap-2');
  const switchId = useId();
  const checkboxId = useId();
  const inputId = useId();

  return (
    <div className="flex flex-col gap-6">
      <Section title="Type scale">
        <div className="flex flex-col gap-1">
          {/* `text-display` is the size role; the face comes from `<Numeric>`,
              which sets `font-mono` — and `--font-display` is an alias of
              `--font-mono`, so a display figure needs no second class. */}
          <Numeric className="block text-display" value={128_400.62} currency="USD" />
          <p className="text-title">Title — page and sheet headings</p>
          <p className="text-body">Body — the default, and every input</p>
          <p className="text-label">Label — row identity and form labels</p>
          <p className="text-caption text-muted-foreground">Caption — timestamps, the 13px floor</p>
        </div>
      </Section>

      <Section title="Type faces">
        <div className="flex flex-col gap-1">
          <p className="text-body">Plex Sans carries language — 400, 500, 600.</p>
          <p className="text-body font-medium">Plex Sans medium at the label weight.</p>
          <p className="text-body font-semibold">Plex Sans semibold at the title weight.</p>
          {/* Same digits in both faces: the mono row's columns line up, the
              sans row's do not. If they look identical the face never loaded. */}
          <p className="text-body font-mono tabular-nums">Plex Mono 0123456789 · 1,000.00</p>
          <p className="text-body tabular-nums">Plex Sans 0123456789 · 1,000.00</p>
        </div>
      </Section>

      <Section title="Surface ramp and semantic colour">
        {/* In light, surface-0 and surface-2 are both pure white and this row
            reads as three swatches where two are the same. That is the ramp,
            not a bug: a white page has no lightness left to spend, so a
            floating surface separates itself with `--elevation-2` instead —
            which is why each swatch carries the hairline that does the other
            half of the job. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-md border border-border bg-surface-0 p-3 text-caption">
            surface-0
          </div>
          <div className="rounded-md border border-border bg-surface-1 p-3 text-caption">
            surface-1
          </div>
          <div className="rounded-md border border-border bg-surface-2 p-3 text-caption shadow-md">
            surface-2
          </div>
          <div className="rounded-md border border-border bg-surface-hover p-3 text-caption">
            hover
          </div>
        </div>
        <div className="flex items-center gap-4 text-label">
          <Numeric value={4.21} format="percent" delta />
          <Numeric value={-1.08} format="percent" delta />
          <Numeric value={0} format="percent" delta />
          <span className="text-interactive">interactive</span>
        </div>
        {/* The border split (V3-23): the hairline is decoration and is
            deliberately under 3:1; the strong one is the WCAG 1.4.11 value
            and reaches controls through `--input`. */}
        <div className="flex items-center gap-4 text-caption text-muted-foreground">
          <span className="flex-1 border-border border-t pt-2">border — hairline</span>
          <span className="flex-1 border-border-strong border-t pt-2">
            border-strong — controls
          </span>
        </div>
      </Section>

      <Section title="Numeric">
        {/* Every figure in v3, at every size, through one component: the face,
            the figure widths, the sign, the token and the arrow. Nothing here
            applies `tabular-nums` or a colour utility by hand. */}
        <div className="flex flex-col gap-2 text-label">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">currency</span>
            <Numeric value={18_204.55} currency="USD" />
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">negative magnitude, untoned</span>
            <Numeric value={-742.1} currency="USD" />
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">gain</span>
            <Numeric value={1284.32} currency="USD" delta />
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">loss</span>
            <Numeric value={-421.3} currency="USD" delta />
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">zero — neutral, unsigned</span>
            <Numeric value={0} currency="USD" delta />
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">sign only, for dense columns</span>
            <Numeric value={-421.3} currency="USD" delta indicator="sign" />
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">compact</span>
            <Numeric value={1_284_320} currency="USD" compact />
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">plain, unit count</span>
            <Numeric value={0.4218} format="plain" decimals={4} />
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-caption text-muted-foreground">unpriceable</span>
            <Numeric value={null} currency="USD" />
          </div>
        </div>
        {/* The columns line up because the face is monospaced, not because
            anything here sets a width. */}
        <DataRowList aria-label="Figure alignment">
          {ALIGNMENT_ROWS.map((row) => (
            <DataRow
              key={row.label}
              label={row.label}
              value={<Numeric value={row.value} currency="USD" />}
              delta={<Numeric value={row.delta} currency="USD" delta indicator="sign" />}
            />
          ))}
        </DataRowList>
      </Section>

      <Section title="DataRow">
        {/* Three zones and no fourth: identity truncates, the value never
            does, the delta sits under it. Everything else about a holding
            belongs in the peek sheet. */}
        <DataRowList aria-label="Holdings">
          {HOLDING_ROWS.map((row) => (
            <DataRow
              key={row.symbol}
              label={row.symbol}
              sublabel={row.venue}
              value={<Numeric value={row.value} currency="USD" />}
              delta={<Numeric value={row.delta} format="percent" delta />}
              onClick={() => undefined}
            />
          ))}
        </DataRowList>
      </Section>

      <Section title="Chart ramp">
        {/* The eight categorical slots plus the fold bucket, in assignment
            order. Both panes render the same swatches, so a slot changing hue
            between the two is visible here rather than in production. */}
        <div className="flex flex-col gap-2">
          <div className="flex gap-[2px]">
            {CHART_SLOTS.map((slot) => (
              <div
                key={slot}
                className="h-6 flex-1 first:rounded-s-sm last:rounded-e-sm"
                style={{ backgroundColor: `hsl(var(--chart-${slot}))` }}
              />
            ))}
            <div className="h-6 flex-1 rounded-e-sm bg-chart-other" />
          </div>
          <p className="text-caption text-muted-foreground">
            Slots 1–6, then the two reserved for `--interactive` and `--loss`, then the fold.
          </p>
        </div>
      </Section>

      <Section title="Stat tile, delta pill and sparkline">
        <div className="rounded-lg bg-card p-4">
          <StatTile
            label="Net worth"
            emphasis="hero"
            value={<Numeric value={128_450.22} currency="USD" />}
            delta={<DeltaPill value={4_218.4} currency="USD" period="30d" />}
            trend={<Sparkline data={NET_WORTH_SERIES} label="Net worth over 30 days, rising" />}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-card p-4">
            <StatTile
              label="Cash"
              value={<Numeric value={17_000} currency="USD" compact />}
              delta={<DeltaPill value={-2.4} format="percent" decimals={1} />}
              trend={
                <Sparkline
                  data={[...NET_WORTH_SERIES].reverse()}
                  label="Cash over 30 days, falling"
                  height={32}
                />
              }
            />
          </div>
          <div className="rounded-lg bg-card p-4">
            <StatTile
              label="Unpriced"
              value={<Numeric value={null} currency="USD" />}
              delta={<DeltaPill value={null} currency="USD" period="30d" />}
            />
          </div>
        </div>
      </Section>

      <Section title="Allocation bar">
        {/* Replaces v2's donut. The list is the relief channel three of the
            light palette steps require, not optional chrome. */}
        <div className="rounded-lg bg-card p-4">
          <AllocationBar items={ALLOCATION} currency="USD" label="Allocation by type" />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="holdings">
          <TabsList>
            <TabsTrigger value="holdings">Holdings</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
          </TabsList>
          <TabsContent value="holdings" className="text-body text-muted-foreground">
            12 positions across 4 institutions.
          </TabsContent>
          <TabsContent value="activity" className="text-body text-muted-foreground">
            Last sync 6 minutes ago.
          </TabsContent>
          <TabsContent value="notes" className="text-body text-muted-foreground">
            Nothing recorded yet.
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="Segmented control">
        <Segmented value={range} onValueChange={setRange} aria-label="Time range">
          <SegmentedItem value="7d">7D</SegmentedItem>
          <SegmentedItem value="30d">30D</SegmentedItem>
          <SegmentedItem value="1y">1Y</SegmentedItem>
          <SegmentedItem value="all">All</SegmentedItem>
        </Segmented>
      </Section>

      <Section title="Switch">
        <div className="flex items-center gap-3">
          <Switch id={switchId} checked={switchOn} onCheckedChange={setSwitchOn} />
          <Label htmlFor={switchId}>Hide zero balances</Label>
        </div>
        <div className="flex items-center gap-3 opacity-100">
          <Switch checked={false} disabled aria-label="Disabled, off" />
          <span className="text-caption text-muted-foreground">disabled</span>
        </div>
      </Section>

      <Section title="Accordion">
        <Accordion type="single" collapsible defaultValue="fees">
          <AccordionItem value="fees">
            <AccordionTrigger>What counts as a fee?</AccordionTrigger>
            <AccordionContent>
              Anything the venue deducts from the trade, including spread when the provider reports
              it separately.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="staleness">
            <AccordionTrigger>How fresh are prices?</AccordionTrigger>
            <AccordionContent>Refreshed hourly, per the pricing job cadence.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>

      <Section title="ScrollArea">
        <ScrollArea className="h-32 rounded-md border border-border p-3">
          <ul className="flex flex-col gap-2 text-body">
            {SCROLL_ROWS.map((row) => (
              <li key={row.label} className="flex justify-between">
                <span>{row.label}</span>
                <Numeric
                  className="text-muted-foreground"
                  value={row.value}
                  currency="USD"
                  decimals={0}
                />
              </li>
            ))}
          </ul>
        </ScrollArea>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>
      </Section>

      <Section title="Card">
        <Card>
          <CardHeader>
            <CardTitle>Kraken</CardTitle>
            <CardDescription>Synced 6 minutes ago</CardDescription>
          </CardHeader>
          <CardContent className="text-body">
            <Numeric value={18_204.55} currency="USD" />
          </CardContent>
        </Card>
      </Section>

      <Section title="Alert">
        <Alert>
          <AlertTitle>Two accounts need review</AlertTitle>
          <AlertDescription>
            A sync returned balances that changed by more than 40%.
          </AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>Couldn't reach Kraken</AlertTitle>
          <AlertDescription>The credential was rejected. Reconnect to retry.</AlertDescription>
        </Alert>
      </Section>

      <Section title="Form controls">
        <div className="flex flex-col gap-2">
          <Label htmlFor={inputId}>Ticker</Label>
          <Input id={inputId} placeholder="BTC" />
          <Textarea placeholder="Notes" rows={2} />
          <Select defaultValue="usd">
            {/* A `SelectTrigger` is a `role="combobox"` button, and a
                placeholder is not an accessible name — with no visible label
                beside it, the name has to be spelled out or the control
                announces as "button". */}
            <SelectTrigger aria-label="Currency">
              <SelectValue placeholder="Currency" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="usd">USD</SelectItem>
              <SelectItem value="eur">EUR</SelectItem>
              <SelectItem value="sgd">SGD</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Checkbox
              id={checkboxId}
              checked={checked}
              onCheckedChange={(next) => setChecked(next === true)}
            />
            <Label htmlFor={checkboxId}>Include closed positions</Label>
          </div>
        </div>
      </Section>

      <Section title="Progress, loading, skeleton">
        {/* `role="progressbar"` owes a name like any other widget; without it
            a screen reader announces "62 percent" of nothing. */}
        <Progress value={62} aria-label="Import progress" />
        <div className="flex items-center gap-4">
          <LoadingSpinner size="sm" />
          <LoadingDots />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </Section>

      <Section title="Separator">
        <div className="flex items-center gap-3 text-caption text-muted-foreground">
          <span>Left</span>
          <Separator orientation="vertical" className="h-4" />
          <span>Right</span>
        </div>
        <Separator />
      </Section>

      <Section title="Table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Asset</TableHead>
              <TableHead className="text-end">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>BTC</TableCell>
              <TableCell className="text-end">
                <Numeric value={64_120} currency="USD" />
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>ETH</TableCell>
              <TableCell className="text-end">
                <Numeric value={3180.4} currency="USD" />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section title="Command">
        <Command className="rounded-md border border-border">
          <CommandInput placeholder="Search holdings" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading="Recent">
              <CommandItem>Bitcoin</CommandItem>
              <CommandItem>Ethereum</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </Section>

      <Section title="Overlays">
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete holding</DialogTitle>
                <DialogDescription>This cannot be undone.</DialogDescription>
              </DialogHeader>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Sheet</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
              </SheetHeader>
            </SheetContent>
          </Sheet>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Popover</Button>
            </PopoverTrigger>
            <PopoverContent>Grouped by institution.</PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Tooltip</Button>
            </TooltipTrigger>
            <TooltipContent>Last priced 6 minutes ago</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      <Section title="Account picker">
        {/* The specimen carries every case SC-850 was reported for, so the
            baseline is what a reader would actually complain about: an account
            named after its institution, a wallet whose identifying half is at
            the far end of the name, a subtitle on some rows and none on
            others, and enough rows to bring out the search field and the fade
            at the foot. Rendered at the width the transfer sheet gives it. */}
        <div className="max-w-md">
          <AccountPicker
            options={SPECIMEN_ACCOUNTS}
            value={pickedAccount}
            onChange={(option) => setPickedAccount(option.id)}
            name="kitchen-sink-account"
            legend="Where this money went"
            emptyLabel="You have no other account to move this to."
          />
        </div>
      </Section>
    </div>
  );
}

/** V3-10's surface, with data shaped like the real thing: no round figures, no
 *  `Acme`, one identity long enough to force the truncation decision, and one
 *  unpriceable position. A fixture of `$1,000.00` hides exactly the alignment
 *  bugs a specimen exists to show. */
const SPECIMEN_HOLDINGS = [
  {
    id: 'h1',
    symbol: 'BTC',
    name: 'Bitcoin',
    type: 'Crypto',
    institution: 'Kraken',
    units: 0.2841,
    price: 64_072.18,
    value: 18_204.55,
    change: 2.14,
  },
  {
    id: 'h2',
    symbol: 'VWRA',
    name: 'Vanguard FTSE All-World UCITS ETF',
    type: 'Equity',
    institution: 'Interactive Brokers',
    units: 1_042,
    price: 123.23,
    value: 128_400.62,
    change: 0.37,
  },
  {
    id: 'h3',
    symbol: 'ETH',
    name: 'Ethereum',
    type: 'Crypto',
    institution: 'Coinbase',
    units: 1.077,
    price: 2953.02,
    value: 3180.4,
    change: -1.08,
  },
  {
    id: 'h4',
    symbol: 'SGD',
    name: 'Singapore dollar',
    type: 'Cash',
    institution: 'Wise',
    units: 12_480.09,
    price: 0.7412,
    value: 9250.24,
    change: 0.02,
  },
  {
    id: 'h5',
    symbol: 'wstETH',
    name: 'Wrapped Staked Ether held in the long-term staking position',
    type: 'Crypto',
    institution: 'Kraken',
    units: 4.6012,
    price: 3471.88,
    value: 15_974.71,
    change: 11.9,
  },
  {
    id: 'h6',
    symbol: 'SOL',
    name: 'Solana',
    type: 'Crypto',
    institution: 'Coinbase',
    units: 61.4,
    price: 141.07,
    value: 8661.7,
    change: -4.62,
  },
  {
    id: 'h7',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    type: 'Equity',
    institution: 'Interactive Brokers',
    units: 84,
    price: 227.41,
    value: 19_102.44,
    change: 0,
  },
  {
    id: 'h8',
    symbol: 'PRIVCO',
    name: 'Series B preferred, no public mark',
    type: 'Equity',
    institution: 'Manual entry',
    units: 2_500,
    price: null,
    value: null,
    change: 0,
  },
] as const;

type SpecimenHolding = (typeof SPECIMEN_HOLDINGS)[number];

const SPECIMEN_CONFIG: Omit<V3DataViewConfig<SpecimenHolding>, 'data'> = {
  pageKey: 'kitchen-sink-holdings',
  nounKey: 'ui.dataView.noun.holdings',
  searchPlaceholderKey: 'ui.dataView.kitchenSink.config.searchHoldings',
  searchFn: (item, query) =>
    `${item.symbol} ${item.name} ${item.institution}`.toLowerCase().includes(query),
  filterDefs: [
    {
      key: 'type',
      labelKey: 'ui.dataView.kitchenSink.filter.type',
      options: [
        { value: 'Crypto', label: 'Crypto' },
        { value: 'Equity', label: 'Equity' },
        { value: 'Cash', label: 'Cash' },
      ],
      fn: (item: SpecimenHolding, value) => item.type === value,
    },
    {
      key: 'institution',
      labelKey: 'ui.dataView.kitchenSink.filter.institution',
      options: [
        { value: 'Kraken', label: 'Kraken' },
        { value: 'Coinbase', label: 'Coinbase' },
        { value: 'Interactive Brokers', label: 'Interactive Brokers' },
        { value: 'Wise', label: 'Wise' },
        { value: 'Manual entry', label: 'Manual entry' },
      ],
      fn: (item: SpecimenHolding, value) => item.institution === value,
    },
  ],
  sortDefs: [
    { key: 'value', labelKey: 'ui.dataView.kitchenSink.sort.value' },
    { key: 'symbol', labelKey: 'ui.dataView.kitchenSink.sort.name' },
    { key: 'change', labelKey: 'ui.dataView.kitchenSink.sort.change' },
  ],
  sortFn: (a, b, field, direction) => {
    const factor = direction === 'asc' ? 1 : -1;
    if (field === 'symbol') return a.symbol.localeCompare(b.symbol) * factor;
    if (field === 'change') return (a.change - b.change) * factor;
    return ((a.value ?? 0) - (b.value ?? 0)) * factor;
  },
  defaultSort: { field: 'value', direction: 'desc' },
  groupByDefs: [
    {
      key: 'institution',
      labelKey: 'ui.dataView.kitchenSink.group.institution',
      fn: (item: SpecimenHolding) => item.institution,
    },
    {
      key: 'type',
      labelKey: 'ui.dataView.kitchenSink.group.type',
      fn: (item: SpecimenHolding) => item.type,
    },
  ],
  renderRow: (item) => ({
    label: item.symbol,
    sublabel: `${item.name} · ${item.institution}`,
    value: <Numeric value={item.value} currency="USD" />,
    delta: <Numeric value={item.change} format="percent" delta indicator="sign" />,
    ariaLabel: `${item.symbol}, ${item.name}`,
  }),
  columns: [
    {
      key: 'symbol',
      headerKey: 'ui.dataView.kitchenSink.col.holding',
      sortable: true,
      width: 'w-[28%]',
      render: (item) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-label">{item.symbol}</span>
          <span className="truncate text-caption text-muted-foreground">{item.name}</span>
        </span>
      ),
    },
    {
      key: 'institution',
      headerKey: 'ui.dataView.kitchenSink.col.institution',
      width: 'w-[18%]',
      render: (item) => <span className="text-body">{item.institution}</span>,
    },
    {
      key: 'units',
      headerKey: 'ui.dataView.kitchenSink.col.units',
      numeric: true,
      render: (item) => <Numeric value={item.units} format="plain" className="text-body" />,
    },
    {
      key: 'price',
      headerKey: 'ui.dataView.kitchenSink.col.price',
      numeric: true,
      render: (item) => <Numeric value={item.price} currency="USD" className="text-body" />,
    },
    {
      key: 'value',
      headerKey: 'ui.dataView.kitchenSink.col.value',
      sortable: true,
      numeric: true,
      render: (item) => <Numeric value={item.value} currency="USD" className="text-body" />,
    },
    {
      key: 'change',
      headerKey: 'ui.dataView.kitchenSink.col.24h',
      sortable: true,
      numeric: true,
      render: (item) => (
        <Numeric value={item.change} format="percent" delta className="text-body" />
      ),
    },
  ],
  empty: {
    icon: Wallet,
    titleKey: 'ui.dataView.kitchenSink.empty.noHoldingsYet',
    descriptionKey:
      'ui.dataView.kitchenSink.empty.connectAnExchangeOrImportAStatementAndYourPositionsAppearHere',
    action: <Button>Connect an exchange</Button>,
  },
  // The peek sheet (V3-11). Twelve facts, which is the count §2.2 says a v2
  // holding card carried in one row — here they are one tap away instead, and
  // the URL they open at is `/kitchen-sink/<id>`.
  peek: {
    basePath: KITCHEN_SINK_BASE,
    render: (item) => ({
      title: item.symbol,
      subtitle: item.name,
      value: <Numeric value={item.value} currency="USD" />,
      delta: <Numeric value={item.change} format="percent" delta indicator="sign" />,
      actions: (
        <>
          <Button size="sm">Refresh price</Button>
          <Button size="sm" variant="outline">
            Edit
          </Button>
        </>
      ),
      primary: [
        { label: 'Units', value: <Numeric value={item.units} format="plain" /> },
        { label: 'Price', value: <Numeric value={item.price} currency="USD" /> },
        { label: 'Type', value: item.type },
        { label: 'Institution', value: item.institution },
      ],
      sections: [
        {
          title: 'Source',
          facts: [
            { label: 'Account', value: `${item.institution} · Main` },
            { label: 'Source', value: item.price === null ? 'Manual entry' : 'Exchange sync' },
            { label: 'Last priced', value: item.price === null ? 'Never' : '14 minutes ago' },
            { label: 'First seen', value: '3 March 2026' },
          ],
        },
        {
          title: 'Organisation',
          facts: [
            { label: 'Groups', value: 'Long term, Tax-sheltered' },
            { label: 'Vault', value: 'None' },
            // Long, unbroken and the reason the value column wraps rather
            // than truncates.
            {
              label: 'Identifier',
              value: <span className="font-mono">0x7f2c9a4b1d8e6f30a2c5b7e9d1f4a68c0b3e5d72</span>,
            },
            { label: 'Decimals', value: <Numeric value={18} format="plain" /> },
          ],
        },
      ],
    }),
  },
  renderBulkActions: (selectedIds, clearSelection) => (
    <>
      <Button variant="outline" size="sm" onClick={clearSelection}>
        Move to vault
      </Button>
      <Button variant="outline" size="sm" onClick={clearSelection}>
        {`Refresh ${selectedIds.size}`}
      </Button>
    </>
  ),
};

/** A shape `describeQueryError` reads as a 500 — the ordinary case, and the
 *  one whose copy the gallery is here to let someone judge. */
const SPECIMEN_ERROR = { data: { httpStatus: 500 }, message: 'INTERNAL_SERVER_ERROR' };

function ListSurfaceSpecimen() {
  const [state, setState] = useState<'data' | 'empty' | 'loading' | 'error'>('data');

  return (
    <V3TokenScope className="rounded-lg border border-border bg-background p-4 text-foreground">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="text-title">List surface</p>
        <Segmented value={state} onValueChange={(v) => setState(v as typeof state)}>
          <SegmentedItem value="data">With data</SegmentedItem>
          <SegmentedItem value="empty">Empty</SegmentedItem>
          <SegmentedItem value="loading">Loading</SegmentedItem>
          <SegmentedItem value="error">Error</SegmentedItem>
        </Segmented>
      </div>
      {/* "Loading" here holds for the full ramp, so the specimen is what the
          three bands actually look like in sequence: nothing, then the rail,
          then the skeleton, then the stalled notice. */}
      <V3DataView
        config={{
          ...SPECIMEN_CONFIG,
          data:
            state === 'data'
              ? (SPECIMEN_HOLDINGS as readonly SpecimenHolding[]).slice()
              : ([] as SpecimenHolding[]),
        }}
        getId={(item) => item.id}
        query={{
          isLoading: state === 'loading',
          isError: state === 'error',
          error: SPECIMEN_ERROR,
          retry: () => setState('data'),
          // The specimen holds every row it has — this surface is not paginated.
          more: null,
        }}
      />
    </V3TokenScope>
  );
}

function ThemePane({ theme }: { theme: (typeof THEMES)[number] }) {
  return (
    <V3TokenScope
      theme={theme}
      // `dark` carries the two `dark:` utilities and the globals chart ramp;
      // `data-theme` (set by `V3TokenScope`) is what pins the v3 token block
      // against the document theme, so this pane stays itself whichever theme
      // the app is in.
      className={`${theme === 'dark' ? 'dark ' : ''}flex-1 rounded-lg border border-border bg-background p-4 text-foreground`}
    >
      <p className="mb-4 text-title capitalize">{theme}</p>
      <Specimens />
    </V3TokenScope>
  );
}

export function KitchenSinkPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header>
        <h2 className="text-title">Kitchen sink</h2>
        <p className="text-caption text-muted-foreground">
          Every `@scani/ui` primitive against the v3 tokens. Delete with the route in V3App.tsx.
        </p>
      </header>
      <div className="flex flex-col gap-4 lg:flex-row">
        {THEMES.map((theme) => (
          <ThemePane key={theme} theme={theme} />
        ))}
      </div>
      {/* Full width and outside the panes, because the list surface picks its
          presentation from the *viewport* — rows below `lg`, table above — and
          inside a half-width pane it would be asked a question about the
          window that the pane cannot answer. One instance, at the real width,
          following the document theme. */}
      <ListSurfaceSpecimen />
    </div>
  );
}
