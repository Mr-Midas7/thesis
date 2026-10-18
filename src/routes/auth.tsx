import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, Eye, EyeOff, Loader2, Lock, Mail, MailCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

import logo from "@/assets/logo-shp.png.asset.json";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { recordAdminActivityEvent } from "@/lib/admin-activity";

export const Route = createFileRoute("/auth")({
  // reset=done: the password was just changed on /reset-password.
  validateSearch: z.object({ reset: z.literal("done").optional() }),
  head: () => ({
    meta: [
      { title: "Admin Login | Fake Rider Motorparts" },
      {
        name: "description",
        content:
          "Administrator login for the Fake Rider Motorparts appointment management console.",
      },
      { name: "robots", content: "noindex" },
      { property: "og:title", content: "Admin Login | Fake Rider Motorparts" },
      {
        property: "og:description",
        content: "Administrator access to the shop management console.",
      },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const { reset } = Route.useSearch();
  const [mode, setMode] = useState<"sign-in" | "forgot">("sign-in");
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      const { data: isActive, error } = await supabase.rpc("validate_admin_session");
      if (!isMounted) return;
      if (!error && isActive) {
        navigate({ to: "/admin", replace: true });
        return;
      }
      await supabase.auth.signOut({ scope: "local" });
    });
    return () => {
      isMounted = false;
    };
  }, [navigate]);

  const signIn = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) throw new Error(`AUTHENTICATION_FAILED: ${error.message}`);

      const { error: claimError } = await supabase.rpc("claim_admin_session", {
        p_handover_token: null,
      });
      if (claimError) {
        await supabase.auth.signOut({ scope: "local" });
        throw new Error(`ADMIN_SESSION_FAILED: ${claimError.message}`);
      }

      // Do not navigate until the same server-side check used by protected
      // admin routes confirms this JWT owns the lease.
      const { data: isActive, error: validationError } =
        await supabase.rpc("validate_admin_session");
      if (validationError || !isActive) {
        await supabase.auth.signOut({ scope: "local" });
        throw new Error(
          `ADMIN_SESSION_FAILED: ${validationError?.message ?? "The new administrator session could not be verified."}`,
        );
      }
    },
    onSuccess: async () => {
      try {
        await recordAdminActivityEvent({
          action: "signed in",
          resourceType: "Authentication",
          targetLabel: "Admin console",
          summary: "Administrator signed in to the admin console.",
        });
      } catch {
        // Access is verified by the protected admin route; a log failure must
        // not leave an authenticated administrator stuck on the login screen.
      }
      navigate({ to: "/admin", replace: true });
    },
    onError: (error: Error) => {
      const message = error.message.replace(
        /^(AUTHENTICATION_FAILED|ADMIN_SESSION_FAILED):\s*/,
        "",
      );
      setErrors((current) => ({
        ...current,
        password: /^AUTHENTICATION_FAILED:/.test(error.message)
          ? "Invalid email or password."
          : message || "We could not start the administrator session. Please try again.",
      }));
    },
  });

  const sendReset = useMutation({
    mutationFn: async () => {
      const address = email.trim().toLowerCase();
      const { error } = await supabase.auth.resetPasswordForEmail(address, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      return address;
    },
    onSuccess: (address) => setResetSentTo(address),
    onError: (error: Error & { status?: number }) => {
      setErrors({
        email:
          error.status === 429 || /rate limit|too many/i.test(error.message)
            ? "Too many reset emails were requested. Wait a few minutes and try again."
            : "We could not send the reset email. Please try again shortly.",
      });
    },
  });

  function showSignIn() {
    setMode("sign-in");
    setResetSentTo(null);
    setErrors({});
  }

  function validate() {
    const nextErrors: { email?: string; password?: string } = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) nextErrors.email = "Enter a valid email address.";
    if (!password) nextErrors.password = "Enter your password.";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-md border-border/70 bg-card/70">
        <CardContent className="p-8">
          <img src={logo.url} alt="Fake Rider Motorparts logo" className="mx-auto h-24 w-auto" />
          <h1 className="mt-4 text-center font-display text-2xl uppercase">
            {mode === "forgot" ? "Reset password" : "Admin login"}
          </h1>
          <p className="mt-1 text-center text-sm text-muted-foreground">
            {mode === "forgot"
              ? "Enter your admin email and we'll send a link to set a new password."
              : "Administrator access only."}
          </p>
          {reset === "done" && mode === "sign-in" && (
            <p
              role="status"
              className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-400"
            >
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Your password was changed. Sign in with your new password.
            </p>
          )}

          {mode === "forgot" ? (
            resetSentTo ? (
              <div className="mt-6 space-y-4">
                <p
                  role="status"
                  className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-400"
                >
                  <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  If {resetSentTo} belongs to an admin account, a reset link is on its way. The link
                  works once.
                </p>
                <Button
                  type="button"
                  className="w-full font-display uppercase"
                  onClick={showSignIn}
                >
                  Back to sign in
                </Button>
              </div>
            ) : (
              <form
                className="mt-6 space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
                    setErrors({ email: "Enter a valid email address." });
                    return;
                  }
                  sendReset.mutate();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="reset-email">Email</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value.toLowerCase());
                      setErrors({});
                    }}
                    placeholder="admin@fakerider.ph"
                    aria-invalid={!!errors.email}
                  />
                  <FieldError message={errors.email} />
                </div>
                <Button
                  type="submit"
                  className="w-full font-display uppercase"
                  disabled={sendReset.isPending}
                >
                  {sendReset.isPending ? <Loader2 className="animate-spin" /> : <Mail />} Send reset
                  link
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={showSignIn}>
                  Back to sign in
                </Button>
              </form>
            )
          ) : (
            <form
              className="mt-6 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (validate()) signIn.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value.toLowerCase());
                    setErrors((current) => {
                      const { email: _, ...rest } = current;
                      return rest;
                    });
                  }}
                  placeholder="admin@fakerider.ph"
                  required
                  aria-invalid={!!errors.email}
                />
                <FieldError message={errors.email} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="admin-password">Password</Label>
                <div className="relative">
                  <Input
                    id="admin-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setErrors((current) => {
                        const { password: _, ...rest } = current;
                        return rest;
                      });
                    }}
                    required
                    aria-invalid={!!errors.password}
                    className="pr-11"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute top-0 right-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <FieldError message={errors.password} />
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => {
                      setMode("forgot");
                      setErrors({});
                    }}
                  >
                    Forgot password?
                  </button>
                </div>
              </div>
              <Button
                type="submit"
                className="w-full font-display uppercase"
                disabled={signIn.isPending}
              >
                {signIn.isPending ? <Lock className="animate-pulse" /> : <Lock />} Sign in
              </Button>
            </form>
          )}

          <Button asChild variant="ghost" className="mt-4 w-full justify-center text-sm">
            <Link to="/">
              <ArrowLeft /> Back to home
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
