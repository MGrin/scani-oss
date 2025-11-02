import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Mail } from "lucide-react";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { MagicCodeInput } from "@/components/MagicCodeInput";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SvgIcon } from "@/components/ui/SvgIcon";
import { useAuth } from "@/contexts/AuthContext";
import { isPWA } from "@/lib/pwa-utils";

const authSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
});

type AuthFormData = z.infer<typeof authSchema>;

export function Auth() {
  const { authenticate, verifyCode } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isEmailSent, setIsEmailSent] = useState(false);
  const [userEmail, setUserEmail] = useState<string>("");

  // Get return URL from query params
  const returnTo = searchParams.get("returnTo") || "/";

  // Detect if running in PWA
  const runningAsPWA = isPWA();

  // Log for debugging
  console.log("[Auth Page] Running as PWA:", runningAsPWA);

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
    setUserEmail(data.email);

    const result = await authenticate(data.email);

    if (result.error) {
      setError(result.error);
    } else {
      setIsEmailSent(true);
    }

    setIsLoading(false);
  };

  const handleCodeSubmit = async (code: string) => {
    setError(null);
    const result = await verifyCode(userEmail, code);

    if (result.error) {
      setError(result.error);
      throw new Error(result.error);
    } else {
      // Successfully authenticated, redirect to return URL or dashboard
      navigate(returnTo, { replace: true });
    }
  };

  const handleResendCode = async () => {
    setError(null);
    const result = await authenticate(userEmail);
    if (result.error) {
      setError(result.error);
      throw new Error(result.error);
    }
  };

  if (isEmailSent) {
    if (runningAsPWA) {
      // Show code input for PWA users
      return (
        <div
          className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8"
          style={{
            paddingTop: "max(3rem, calc(3rem + env(safe-area-inset-top)))",
            paddingBottom:
              "max(3rem, calc(3rem + env(safe-area-inset-bottom)))",
            paddingLeft: "max(1rem, calc(1rem + env(safe-area-inset-left)))",
            paddingRight: "max(1rem, calc(1rem + env(safe-area-inset-right)))",
          }}
        >
          <div className="w-full max-w-md space-y-8 flex flex-col items-center">
            <SvgIcon
              name="scani-logo"
              className="h-12 w-auto"
              aria-label="Scani"
            />
            <Card className="w-full">
              <CardHeader className="space-y-1">
                <CardTitle className="text-2xl text-center">
                  Enter verification code
                </CardTitle>
                <CardDescription className="text-center">
                  We've sent a 6-digit code to {userEmail}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MagicCodeInput
                  onSubmit={handleCodeSubmit}
                  onResend={handleResendCode}
                  isLoading={isLoading}
                  error={error}
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setIsEmailSent(false);
                    setError(null);
                  }}
                  className="w-full mt-4"
                >
                  Use a different email
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      );
    }

    // Show magic link message for browser users
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8"
        style={{
          paddingTop: "max(3rem, calc(3rem + env(safe-area-inset-top)))",
          paddingBottom: "max(3rem, calc(3rem + env(safe-area-inset-bottom)))",
          paddingLeft: "max(1rem, calc(1rem + env(safe-area-inset-left)))",
          paddingRight: "max(1rem, calc(1rem + env(safe-area-inset-right)))",
        }}
      >
        <div className="w-full max-w-md space-y-8 flex flex-col items-center">
          <SvgIcon
            name="scani-logo"
            className="h-12 w-auto"
            aria-label="Scani"
          />
          <Card className="w-full">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl text-center">
                Check your email
              </CardTitle>
              <CardDescription className="text-center">
                We've sent you a magic link to sign in
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center space-y-4">
              <Mail className="mx-auto h-12 w-12 text-blue-600" />
              <p className="text-sm text-muted-foreground">
                Click the link in your email to access your account. If this is
                your first time, we'll create an account for you automatically.
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
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8"
      style={{
        paddingTop: "max(3rem, calc(3rem + env(safe-area-inset-top)))",
        paddingBottom: "max(3rem, calc(3rem + env(safe-area-inset-bottom)))",
        paddingLeft: "max(1rem, calc(1rem + env(safe-area-inset-left)))",
        paddingRight: "max(1rem, calc(1rem + env(safe-area-inset-right)))",
      }}
    >
      <div className="w-full max-w-md space-y-8 flex flex-col items-center">
        <SvgIcon name="scani-logo" className="h-12 w-32" aria-label="Scani" />
        <Card className="w-full">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">Welcome</CardTitle>
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
                  {...register("email")}
                  disabled={isLoading}
                />
                {errors.email && (
                  <p className="text-sm text-red-600">{errors.email.message}</p>
                )}
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Continue with Email
              </Button>

              <div className="text-center text-sm text-muted-foreground">
                <p>
                  {runningAsPWA
                    ? "We'll send you a 6-digit code to sign in."
                    : "We'll send you a secure magic link to sign in."}{" "}
                  <br />
                  New to Scani? Your account will be created automatically.
                </p>
              </div>
              {import.meta.env.DEV && (
                <div className="text-center text-xs text-muted-foreground mt-2">
                  Mode: {runningAsPWA ? "PWA (Code)" : "Browser (Link)"}
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
