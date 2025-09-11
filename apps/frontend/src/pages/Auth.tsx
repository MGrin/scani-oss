import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Mail } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';

const authSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

type AuthFormData = z.infer<typeof authSchema>;

export function Auth() {
  const { authenticate } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isEmailSent, setIsEmailSent] = useState(false);

  const emailId = useId();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AuthFormData>({
    resolver: zodResolver(authSchema),
  });

  const onSubmit = async (data: AuthFormData) => {
    setIsLoading(true);
    setError(null);

    const result = await authenticate(data.email);

    if (result.error) {
      setError(result.error);
    } else {
      setIsEmailSent(true);
    }

    setIsLoading(false);
  };

  if (isEmailSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">Check your email</CardTitle>
            <CardDescription className="text-center">
              We've sent you a magic link to sign in
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <Mail className="mx-auto h-12 w-12 text-blue-600" />
            <p className="text-sm text-gray-600">
              Click the link in your email to access your account. If this is your first time, we'll
              create an account for you automatically.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setIsEmailSent(false);
                setError(null);
              }}
              className="w-full"
            >
              Send another email
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl text-center">Welcome to Scani</CardTitle>
          <CardDescription className="text-center">
            Enter your email to sign in or create an account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor={emailId}>Email</Label>
              <Input
                id={emailId}
                type="email"
                placeholder="Enter your email address"
                {...register('email')}
                disabled={isLoading}
              />
              {errors.email && <p className="text-sm text-red-600">{errors.email.message}</p>}
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Continue with Email
            </Button>

            <div className="text-center text-sm text-gray-600">
              <p>
                We'll send you a secure magic link to sign in. <br />
                New to Scani? Your account will be created automatically.
              </p>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
