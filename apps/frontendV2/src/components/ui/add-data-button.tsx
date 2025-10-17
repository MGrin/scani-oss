import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

interface AddDataButtonProps {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'link' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
}

export function AddDataButton({
  variant = 'default',
  size = 'default',
  className,
}: AddDataButtonProps) {
  return (
    <Link to="/add-data">
      <Button variant={variant} size={size} className={className}>
        <Plus className="h-4 w-4 mr-2" />
        Add Data
      </Button>
    </Link>
  );
}

// Helper function to get AddDataButton config for PageHeader
export function getAddDataAction() {
  return {
    label: 'Add Data',
    onClick: () => {
      window.location.href = '/add-data';
    },
    icon: <Plus className="h-4 w-4" />,
  };
}
