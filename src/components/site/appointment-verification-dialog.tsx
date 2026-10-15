import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CircleAlert, Info, Loader2, Mail, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestAppointmentActionCode, verifyAppointmentActionCode } from "@/lib/booking.functions";

export type AppointmentAction = "cancel" | "reschedule";

export type AppointmentVerification = { token: string; expiresAt: string };

/**
 * Confirms the customer can read the booking's email before an online
 * cancellation or reschedule: sends a 6-digit code, then exchanges it for a
 * short-lived verification token that the action request must include.
 */
export function AppointmentVerificationDialog({
  open,
  action,
  reference,
  emailHint,
  schedule,
  notice,
  onOpenChange,
  onVerified,
}: {
  open: boolean;
  action: AppointmentAction;
  reference: string;
  emailHint: string;
  /** For example "Saturday, October 24, 2026 at 9:00 AM". */
  schedule: string;
  /** Why verification is being asked for again, such as an expired verification. */
  notice?: string | null;
  onOpenChange: (open: boolean) => void;
  onVerified: (verification: AppointmentVerification) => void;
}) {
  const requestCodeFn = useServerFn(requestAppointmentActionCode);
  const verifyCodeFn = useServerFn(verifyAppointmentActionCode);
  const [step, setStep] = useState<"send" | "code">("send");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState(emailHint);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep("send");
    setCode("");
    setCodeError(null);
    setError(null);
    setSentTo(emailHint);
    setResent(false);
  }, [open, action, emailHint]);

  const requestCode = useMutation({
    mutationFn: () => requestCodeFn({ data: { reference, action } }),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setCodeError(null);
      setCode("");
      setSentTo(result.emailHint);
      setResent(step === "code");
      setStep("code");
    },
    onError: () => setError("We could not send the verification email. Please try again shortly."),
  });

  const verifyCode = useMutation({
    mutationFn: () => verifyCodeFn({ data: { reference, action, code: code.trim() } }),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onVerified({ token: result.token, expiresAt: result.expiresAt });
    },
    onError: () => setError("We could not check the code right now. Please try again shortly."),
  });

  const isCancel = action === "cancel";
  const busy = requestCode.isPending || verifyCode.isPending;
  const dismissLabel = isCancel ? "Keep appointment" : "Not now";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      {/* minmax(0,1fr) keeps long, non-wrapping text from widening the dialog. */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === "code"
              ? "Enter your verification code"
              : isCancel
                ? "Cancel this appointment?"
                : "Verify it's you"}
          </DialogTitle>
          <DialogDescription>
            {step === "code" ? (
              <>
                We sent a 6-digit code to <strong className="text-foreground">{sentTo}</strong>. It
                expires in 10 minutes.
              </>
            ) : isCancel ? (
              <>
                This cannot be undone. Your {schedule} slot will be released, and you will need to
                book a new schedule, subject to availability.
              </>
            ) : (
              <>
                Before you choose a new schedule for {reference}, confirm that this booking is
                yours.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (step === "send") {
              requestCode.mutate();
              return;
            }
            if (!/^\d{6}$/.test(code.trim())) {
              setCodeError("Enter the 6-digit code from the email.");
              return;
            }
            verifyCode.mutate();
          }}
        >
          {notice && step === "send" && (
            <Alert className="border-primary/30 bg-primary/5">
              <Info className="size-4" aria-hidden="true" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          {step === "send" ? (
            <div className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              <p>
                To protect your booking, we&apos;ll email a 6-digit code to{" "}
                <strong className="break-words">{emailHint}</strong>.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="appointment-verification-code">Verification code</Label>
              <Input
                id="appointment-verification-code"
                type="text"
                value={code}
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, ""));
                  setCodeError(null);
                  setError(null);
                }}
                placeholder="123456"
                aria-invalid={Boolean(codeError)}
                className="h-11 font-display text-xl tracking-[0.4em] md:h-11 md:text-xl"
              />
              <FieldError message={codeError ?? undefined} />
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
                <span>Didn&apos;t get it? Check your spam folder or</span>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto px-0 text-xs md:h-auto"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    requestCode.mutate();
                  }}
                >
                  {requestCode.isPending && <Loader2 className="animate-spin" />}
                  send a new code
                </Button>
              </div>
              {resent && !requestCode.isPending && (
                <p role="status" className="flex items-center gap-1.5 text-xs text-foreground">
                  <Mail className="size-3.5 text-primary" aria-hidden="true" /> A new code is on its
                  way. Only the newest code works.
                </p>
              )}
            </div>
          )}

          {error && (
            <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
              <CircleAlert className="size-4" aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="sm:flex-wrap sm:space-x-0">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                {dismissLabel}
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={step === "code" && isCancel ? "destructive" : "default"}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : step === "send" ? (
                <Mail aria-hidden="true" />
              ) : (
                <ShieldCheck aria-hidden="true" />
              )}
              {step === "send"
                ? requestCode.isPending
                  ? "Sending code…"
                  : "Email me a code"
                : verifyCode.isPending
                  ? "Checking code…"
                  : isCancel
                    ? "Verify and cancel"
                    : "Verify and continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
