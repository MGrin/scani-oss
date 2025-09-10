import { Button } from '@/components/ui/button';

export function SkipLinks() {
  const handleSkipToMain = () => {
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
      mainContent.focus();
      mainContent.scrollIntoView();
    }
  };

  const handleSkipToNavigation = () => {
    const navigation = document.getElementById('main-navigation');
    if (navigation) {
      const firstNavLink = navigation.querySelector('a, button');
      if (firstNavLink) {
        (firstNavLink as HTMLElement).focus();
      }
    }
  };

  return (
    <div className="sr-only focus-within:not-sr-only fixed top-0 left-0 z-[9999] bg-background border-b shadow-lg">
      <div className="flex gap-2 p-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleSkipToMain}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Skip to main content
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSkipToNavigation}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Skip to navigation
        </Button>
      </div>
    </div>
  );
}
