import { Badge } from "@/components/ui/badge";

// Helper function to assign colors to asset types
function getColorForAssetType(code: string): string {
  if (!code) return "bg-slate-500";

  const colorMap: Record<string, string> = {
    stock: "bg-blue-500",
    equity: "bg-blue-500",
    bond: "bg-green-500",
    crypto: "bg-orange-500",
    cryptocurrency: "bg-orange-500",
    fiat: "bg-gray-500",
    cash: "bg-gray-500",
    commodity: "bg-yellow-500",
    real_estate: "bg-purple-500",
    etf: "bg-cyan-500",
  };

  return colorMap[code.toLowerCase()] || "bg-slate-500";
}

interface TokenTypeBadgeProps {
  tokenTypeCode?: string;
  className?: string;
}

export function TokenTypeBadge({
  tokenTypeCode,
  className,
}: TokenTypeBadgeProps) {
  if (!tokenTypeCode || tokenTypeCode.trim() === "") {
    return null;
  }

  const colorClass = getColorForAssetType(tokenTypeCode);

  return (
    <Badge
      variant="secondary"
      className={`inline-flex items-center gap-1.5 ${className || ""}`}
    >
      <div className={`w-2 h-2 rounded-full ${colorClass}`} />
      {tokenTypeCode.toUpperCase()}
    </Badge>
  );
}
