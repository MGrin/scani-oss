import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { getFaviconUrl } from "@/lib/icons";

interface InstitutionBadgeProps {
  institutionId: string;
  institutionName: string;
  institutionWebsite?: string;
  className?: string;
}

export function InstitutionBadge({
  institutionId,
  institutionName,
  institutionWebsite,
  className,
}: InstitutionBadgeProps) {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/institutions/${institutionId}`);
  };

  const faviconUrl = getFaviconUrl(institutionWebsite);

  return (
    <Badge
      variant="outline"
      className={`px-4 py-2 cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors flex items-center ${
        className || ""
      }`}
      onClick={handleClick}
    >
      {faviconUrl && (
        <img
          src={faviconUrl}
          alt={`${institutionName} logo`}
          className="w-4 h-4 mr-2 rounded-sm object-contain flex-shrink-0"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      <span className="truncate">{institutionName}</span>
    </Badge>
  );
}
