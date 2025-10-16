import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";

interface InstitutionBadgeProps {
  institutionId: string;
  institutionName: string;
  className?: string;
}

export function InstitutionBadge({
  institutionId,
  institutionName,
  className,
}: InstitutionBadgeProps) {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/institutions/${institutionId}`);
  };

  return (
    <Badge
      variant="outline"
      className={`px-4 py-2 cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors ${
        className || ""
      }`}
      onClick={handleClick}
    >
      {institutionName}
    </Badge>
  );
}
