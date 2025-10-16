import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";

interface AccountBadgeProps {
  accountId: string;
  accountName: string;
  className?: string;
}

export function AccountBadge({
  accountId,
  accountName,
  className,
}: AccountBadgeProps) {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/accounts/${accountId}`);
  };

  return (
    <Badge
      variant="outline"
      className={`px-4 py-2 cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors ${
        className || ""
      }`}
      onClick={handleClick}
    >
      {accountName}
    </Badge>
  );
}
