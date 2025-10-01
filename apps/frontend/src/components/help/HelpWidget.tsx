import { HelpCircle, MessageSquare } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface HelpArticle {
  id: string;
  title: string;
  description: string;
  category: string;
}

const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'add-institution',
    title: 'How to Add an Institution',
    description: 'Learn how to add your first financial institution to start tracking your assets.',
    category: 'Getting Started',
  },
  {
    id: 'create-account',
    title: 'Creating Accounts',
    description: 'Understand how to organize your holdings with accounts.',
    category: 'Getting Started',
  },
  {
    id: 'add-holdings',
    title: 'Adding Holdings',
    description: 'Track your stocks, crypto, and other assets.',
    category: 'Portfolio Management',
  },
  {
    id: 'screenshot-upload',
    title: 'Quick Add with Screenshots',
    description: 'Use AI to quickly add holdings from screenshots.',
    category: 'Advanced Features',
  },
  {
    id: 'currency-conversion',
    title: 'Currency Conversion',
    description: 'Set your base currency and view values in different currencies.',
    category: 'Settings',
  },
  {
    id: 'portfolio-value',
    title: 'Understanding Portfolio Value',
    description: 'Learn how your total portfolio value is calculated.',
    category: 'Portfolio Management',
  },
];

interface HelpWidgetProps {
  contextualArticles?: string[];
  className?: string;
}

export function HelpWidget({ contextualArticles = [], className }: HelpWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showContactForm, setShowContactForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchId = useId();

  const relevantArticles = contextualArticles.length
    ? HELP_ARTICLES.filter((article) => contextualArticles.includes(article.id))
    : HELP_ARTICLES;

  const filteredArticles = searchQuery
    ? relevantArticles.filter(
        (article) =>
          article.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          article.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : relevantArticles;

  return (
    <>
      {/* Floating help button */}
      <Button
        onClick={() => setIsOpen(true)}
        size="icon"
        className={cn(
          'fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg z-40',
          'hover:scale-110 transition-transform',
          className
        )}
        aria-label="Get help"
      >
        <HelpCircle className="h-6 w-6" />
      </Button>

      {/* Help dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Help & Support</DialogTitle>
            <DialogDescription>
              Find answers to common questions or contact our support team.
            </DialogDescription>
          </DialogHeader>

          {!showContactForm ? (
            <div className="space-y-4">
              {/* Search */}
              <div className="space-y-2">
                <Label htmlFor={searchId}>Search Help Articles</Label>
                <Input
                  id={searchId}
                  placeholder="What do you need help with?"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              {/* Articles */}
              <div className="space-y-3">
                {filteredArticles.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No articles found. Try a different search term.
                  </p>
                ) : (
                  filteredArticles.map((article) => (
                    <Card key={article.id} className="cursor-pointer hover:bg-accent/50 transition">
                      <CardHeader className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <CardTitle className="text-base">{article.title}</CardTitle>
                            <CardDescription className="text-sm">
                              {article.description}
                            </CardDescription>
                          </div>
                          <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                            {article.category}
                          </span>
                        </div>
                      </CardHeader>
                    </Card>
                  ))
                )}
              </div>

              {/* Contact support */}
              <div className="pt-4 border-t">
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => setShowContactForm(true)}
                >
                  <MessageSquare className="h-4 w-4" />
                  Contact Support
                </Button>
              </div>
            </div>
          ) : (
            <ContactForm onBack={() => setShowContactForm(false)} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ContactForm({ onBack }: { onBack: () => void }) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const subjectId = useId();
  const messageId = useId();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // In a real app, this would send the message to your support system
    console.log('Support request:', { subject, message });
    setSubmitted(true);
    setTimeout(() => {
      setSubmitted(false);
      onBack();
    }, 2000);
  };

  if (submitted) {
    return (
      <div className="text-center py-8">
        <div className="mb-4 p-3 rounded-full bg-green-100 dark:bg-green-900 inline-block">
          <MessageSquare className="h-8 w-8 text-green-600 dark:text-green-400" />
        </div>
        <h3 className="text-lg font-semibold mb-2">Message Sent!</h3>
        <p className="text-sm text-muted-foreground">We'll get back to you within 24 hours.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} type="button">
        ← Back to Help Articles
      </Button>

      <div className="space-y-2">
        <Label htmlFor={subjectId}>Subject</Label>
        <Input
          id={subjectId}
          placeholder="Brief description of your issue"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={messageId}>Message</Label>
        <Textarea
          id={messageId}
          placeholder="Describe your issue in detail..."
          rows={6}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
        />
      </div>

      <Button type="submit" className="w-full">
        Send Message
      </Button>
    </form>
  );
}

// Contextual help tooltip
interface ContextualHelpProps {
  content: string;
  title?: string;
  className?: string;
}

export function ContextualHelp({ content, title, className }: ContextualHelpProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={cn('inline-block', className)}>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
        onClick={() => setIsOpen(true)}
        aria-label={title || 'Help'}
      >
        <HelpCircle className="h-4 w-4" />
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-md">
          {title && (
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
          )}
          <div className="text-sm text-muted-foreground">{content}</div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
