import {
  Building2,
  CalendarClock,
  ClipboardCheck,
  Coins,
  Files,
  Home,
  ListChecks,
  type LucideIcon,
  PieChart,
  PiggyBank,
  Plus,
  Repeat,
  Settings,
  Store,
  Tags,
  Wallet,
} from 'lucide-react';

/** Nav items name their icon as a string so the route table stays a plain
 * data module — importable from a test without pulling in React. */
const ICONS: Record<string, LucideIcon> = {
  Building2,
  CalendarClock,
  ClipboardCheck,
  Coins,
  Files,
  Home,
  ListChecks,
  PieChart,
  Plus,
  Repeat,
  Settings,
  Store,
  Tags,
  // lucide's `Vault` is a rounded square with four diagonal spokes running to a
  // centre circle — a safe's dial at 48px, and a boxed ✗ at the 20px a tab or a
  // drawer cell actually draws it, which reads as "delete" on the row that
  // opens them (SC-71 10.4). A vault here is a savings goal with a target
  // amount, so the piggy bank is both unmistakable and the truer noun.
  Vault: PiggyBank,
  Wallet,
};

export function navIcon(name: string): LucideIcon {
  return ICONS[name] ?? PieChart;
}
