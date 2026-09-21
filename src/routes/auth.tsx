import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Eye, EyeOff, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import logo from "@/assets/logo-shp.png.asset.json";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { recordAdminActivityEvent } from "@/lib/admin-activity";

export const Route = createFileRoute("/auth")({
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/admin", replace: true });
    });
  }, [navigate]);

  const signIn = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) throw error;
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
    onError: (e: Error) => {
      setErrors((current) => ({
        ...current,
        password: e.message || "Invalid email or password.",
      }));
    },
  });

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
          <h1 className="mt-4 text-center font-display text-2xl uppercase">Admin login</h1>
          <p className="mt-1 text-center text-sm text-muted-foreground">
            Administrator access only.
          </p>

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
            </div>
            <Button
              type="submit"
              className="w-full font-display uppercase"
              disabled={signIn.isPending}
            >
              {signIn.isPending ? <Lock className="animate-pulse" /> : <Lock />} Sign in
            </Button>
          </form>

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
