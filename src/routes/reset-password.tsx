import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { Session } from "@supabase/supabase-js";
import { ArrowLeft, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import logo from "@/assets/logo-shp.png.asset.json";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Set a New Password | Fake Rider Motorparts" },
      { name: "robots", content: "noindex" },
    ],
  }),
  ssr: false,
  component: ResetPasswordPage,
});

type Stage = "checking" | "ready" | "invalid";

/** The error Supabase puts in the link when it has expired or was used. */
function linkError() {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
  return params.get("error_description");
}

/** Whether the session was started by a password reset link. */
function isRecoverySession(session: Session | null) {
  if (!session) return false;
  try {
    const payload = session.access_token.split(".")[1] ?? "";
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      amr?: { method?: string }[];
    };
    return (claims.amr ?? []).some((entry) => entry.method === "recovery");
  } catch {
    return false;
  }
}

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; confirmPassword?: string }>({});

  useEffect(() => {
    if (linkError()) {
      setStage("invalid");
      return;
    }
    // Opening the reset link signs this tab in and raises PASSWORD_RECOVERY.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" && session) setStage("ready");
    });
    let timer: number | undefined;
    void supabase.auth.getSession().then(({ data }) => {
      // The event is sent just after the session is read from the link.
      timer = window.setTimeout(() => {
        setStage((current) =>
          current !== "checking" ? current : isRecoverySession(data.session) ? "ready" : "invalid",
        );
      }, 0);
    });
    return () => {
      subscription.unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      // End every session, including any started with the old password.
      await supabase.auth.signOut({ scope: "global" });
    },
    onSuccess: () => {
      navigate({ to: "/auth", search: { reset: "done" }, replace: true });
    },
    onError: (error: Error) => {
      const message = error.message.toLowerCase();
      setErrors({
        password: message.includes("different from the old")
          ? "Choose a password you have not used for this account."
          : message.includes("session") || message.includes("expired")
            ? "This reset link has expired. Request a new one from the login page."
            : error.message || "We could not change the password. Please try again.",
      });
    },
  });

  function validate() {
    const nextErrors: { password?: string; confirmPassword?: string } = {};
    if (password.length < 8) nextErrors.password = "Your new password needs at least 8 characters.";
    if (confirmPassword !== password) nextErrors.confirmPassword = "The passwords do not match.";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-md border-border/70 bg-card/70">
        <CardContent className="p-8">
          <img src={logo.url} alt="Fake Rider Motorparts logo" className="mx-auto h-24 w-auto" />
          <h1 className="mt-4 text-center font-display text-2xl uppercase">Set a new password</h1>

          {stage === "checking" && (
            <p
              role="status"
              className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking your reset
              link...
            </p>
          )}

          {stage === "invalid" && (
            <div className="mt-4 space-y-4 text-center">
              <p className="text-sm text-muted-foreground">
                This reset link is invalid or has expired. Links work once; request a new one from
                the login page.
              </p>
              <Button asChild className="w-full font-display uppercase">
                <Link to="/auth">Back to admin login</Link>
              </Button>
            </div>
          )}

          {stage === "ready" && (
            <form
              className="mt-6 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (validate()) save.mutate();
              }}
            >
              <p className="text-center text-sm text-muted-foreground">
                Choose a new password. Every device signed in to this account will be signed out.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">New password</Label>
                <div className="relative">
                  <Input
                    id="new-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setErrors({});
                    }}
                    aria-invalid={!!errors.password}
                    className="pr-11"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute top-0 right-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Hide passwords" : "Show passwords"}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <FieldError message={errors.password} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-new-password">Confirm new password</Label>
                <Input
                  id="confirm-new-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setErrors({});
                  }}
                  aria-invalid={!!errors.confirmPassword}
                />
                <FieldError message={errors.confirmPassword} />
              </div>
              <Button
                type="submit"
                className="w-full font-display uppercase"
                disabled={save.isPending}
              >
                {save.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} Save new
                password
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
