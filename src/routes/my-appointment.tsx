import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CircleAlert, CircleHelp, Copy, Loader2, Search } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useEffect, useMemo, useState } from "react";

import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { TurnstileChallenge } from "@/components/site/turnstile-challenge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError } from "@/components/ui/field-error";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import {
  createBooking,
  getAvailability,
  lookupAppointment,
  cancelAppointment,
} from "@/lib/booking.functions";
import {
  requestReferenceRecoveryCode,
  verifyReferenceRecoveryCode,
} from "@/lib/appointment-reference-recovery.functions";
import {
  type Availability,
  computeAvailableDates,
  computeAvailableSlots,
  computeFullyBookedDates,
} from "@/lib/availability";
import {
  DEFAULT_BOOKING_TERMS,
  formatDateLong,
  formatPHP,
  formatTime,
  isReferenceCode,
  normalizePhilippineMobile,
  normalizeReferenceCode,
  statusLabel,
  statusTone,
} from "@/lib/shop";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/my-appointment")({
  head: () => ({
    meta: [
      { title: "View or Cancel My Appointment | Fake Rider" },
      {
        name: "description",
        content:
          "Enter your reference code to view your motorcycle service appointment or cancel it online.",
      },
      { property: "og:title", content: "Track your appointment | Fake Rider Motorparts" },
      {
        property: "og:description",
        content: "Check the status of your booking with your reference code.",
      },
    ],
  }),
  component: MyAppointment,
});

const turnstileEnabled = Boolean(import.meta.env["VITE_TURNSTILE_SITE_KEY"]);

function MyAppointment() {
  const lookup = useServerFn(lookupAppointment);
  const cancel = useServerFn(cancelAppointment);
  const requestRecoveryCode = useServerFn(requestReferenceRecoveryCode);
  const verifyRecoveryCode = useServerFn(verifyReferenceRecoveryCode);
  const createRescheduleRequest = useServerFn(createBooking);
  const availabilityFn = useServerFn(getAvailability);
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<{ reference?: string }>({});
  const [referenceRecoveryOpen, setReferenceRecoveryOpen] = useState(false);
  const [recoveryStep, setRecoveryStep] = useState<"email" | "code">("email");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryErrors, setRecoveryErrors] = useState<{ email?: string; code?: string }>({});
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [appointmentPreviewError, setAppointmentPreviewError] = useState<string | null>(null);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [newStartTime, setNewStartTime] = useState("");
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [rescheduleRequestId, setRescheduleRequestId] = useState<string | null>(null);
  const [rescheduleTurnstileToken, setRescheduleTurnstileToken] = useState("");
  const [rescheduleConfirmation, setRescheduleConfirmation] = useState<{
    reference: string;
    date: string;
    startTime: string;
  } | null>(null);
  const [rescheduleReferenceCopyStatus, setRescheduleReferenceCopyStatus] = useState<
    "copied" | "error" | null
  >(null);
  const [rescheduleTermsAccepted, setRescheduleTermsAccepted] = useState(false);
  const [rescheduleErrors, setRescheduleErrors] = useState<{
    date?: string;
    time?: string;
    reason?: string;
    terms?: string;
    request?: string;
  }>({});
  const [rescheduleReviewOpen, setRescheduleReviewOpen] = useState(false);
  const [supportsSlideTransition, setSupportsSlideTransition] = useState(true);
  const [appt, setAppt] = useState<
    null | Extract<Awaited<ReturnType<typeof lookupAppointment>>, { ok: true }>["appointment"]
  >(null);

  useEffect(() => {
    setSupportsSlideTransition(
      typeof window !== "undefined" &&
        typeof window.CSS?.supports === "function" &&
        window.CSS.supports("transition", "opacity 1ms ease"),
    );
  }, []);

  const rescheduleServiceIds = useMemo(
    () =>
      (appt?.services ?? []).flatMap((service) => (service.serviceId ? [service.serviceId] : [])),
    [appt?.services],
  );
  const rescheduleAvailability = useQuery<Availability>({
    queryKey: ["appointment-reschedule-availability", appt?.reference, rescheduleServiceIds],
    queryFn: () =>
      availabilityFn({
        data: {
          days: 45,
          serviceIds: rescheduleServiceIds,
          rescheduling: true,
          rescheduleReference: appt?.reference,
          reschedulePhone: appt?.phone,
        },
      }),
    enabled: isRescheduling && Boolean(appt) && rescheduleServiceIds.length > 0,
  });
  const bookingTerms = useQuery({
    queryKey: ["public-booking-terms"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shop_settings")
        .select("booking_terms")
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return data?.booking_terms || DEFAULT_BOOKING_TERMS;
    },
  });
  const rescheduleDates = useMemo(
    () =>
      rescheduleAvailability.data
        ? computeAvailableDates(rescheduleAvailability.data).filter((date) => date !== appt?.date)
        : [],
    [appt?.date, rescheduleAvailability.data],
  );
  const rescheduleDateSet = useMemo(() => new Set(rescheduleDates), [rescheduleDates]);
  const rescheduleSlots = useMemo(
    () =>
      rescheduleAvailability.data && newDate
        ? computeAvailableSlots(rescheduleAvailability.data, newDate)
        : [],
    [newDate, rescheduleAvailability.data],
  );
  const rescheduleFullyBookedDates = useMemo(
    () =>
      rescheduleAvailability.data
        ? computeFullyBookedDates(rescheduleAvailability.data).filter((date) => date !== appt?.date)
        : [],
    [appt?.date, rescheduleAvailability.data],
  );

  const search = useMutation({
    mutationFn: (referenceCode: string) =>
      lookup({
        data: {
          reference: normalizeReferenceCode(referenceCode),
        },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        setAppt(null);
        setAppointmentPreviewError(res.error);
        return;
      }
      setAppointmentPreviewError(null);
      setAppt(res.appointment);
    },
    onError: () => {
      setAppt(null);
      setAppointmentPreviewError(
        "We could not retrieve your appointment details right now. Please try again shortly.",
      );
    },
  });

  const requestRecoveryCodeMutation = useMutation({
    mutationFn: () => requestRecoveryCode({ data: { email: recoveryEmail.trim() } }),
    onSuccess: (result) => {
      if (!result.ok) {
        setRecoveryError(result.error);
        return;
      }
      setRecoveryError(null);
      setRecoveryErrors({});
      setRecoveryCode("");
      setRecoveryMessage(result.message);
      setRecoveryStep("code");
    },
    onError: () => {
      setRecoveryError("Reference recovery is temporarily unavailable. Please try again shortly.");
    },
  });

  const verifyRecoveryCodeMutation = useMutation({
    mutationFn: () =>
      verifyRecoveryCode({ data: { email: recoveryEmail.trim(), code: recoveryCode.trim() } }),
    onSuccess: (result) => {
      if (!result.ok) {
        setRecoveryError(result.error);
        return;
      }
      setRecoveryError(null);
      setRecoveryErrors({});
      setRecoveryCode("");
      setRecoveryMessage(result.message);
      setRecoveryStep("email");
    },
    onError: () => {
      setRecoveryError("Reference recovery is temporarily unavailable. Please try again shortly.");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (referenceCode: string) =>
      cancel({
        data: {
          reference: normalizeReferenceCode(referenceCode),
        },
      }),
    onSuccess: (res, referenceCode) => {
      if (!res.ok) {
        setAppointmentPreviewError(res.error);
        return;
      }
      search.mutate(referenceCode);
    },
    onError: () =>
      setAppointmentPreviewError(
        "We could not cancel the appointment right now. Please try again or contact the shop.",
      ),
  });

  const rescheduleMutation = useMutation({
    mutationFn: async () => {
      if (!appt) throw new Error("Appointment details are no longer available.");
      const result = await createRescheduleRequest({
        data: {
          // The server reloads and trusts the original appointment record. These
          // values only satisfy the public booking input shape and cannot alter it.
          firstName: appt.firstName,
          middleName: appt.middleName,
          lastName: appt.lastName,
          phone: normalizePhilippineMobile(appt.phone)!,
          motoBrand: "Original",
          motoModel: "Appointment",
          motoVariant: "",
          motoYear: 2000,
          plateNumber: appt.plateNumber,
          serviceIds: rescheduleServiceIds,
          date: newDate,
          startTime: newStartTime,
          notes: "",
          turnstileToken: rescheduleTurnstileToken,
          // Keep this value stable for retries so a lost response returns the
          // originally reserved reference instead of creating a new request.
          idempotencyKey: rescheduleRequestId ?? crypto.randomUUID(),
          termsAccepted: true as const,
          rescheduleReference: appt.reference,
          rescheduleReason: rescheduleReason.trim(),
        },
      });
      return result;
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setRescheduleErrors((current) => ({ ...current, request: result.error }));
        return;
      }
      setRescheduleReferenceCopyStatus(null);
      setRescheduleConfirmation({
        reference: result.reference,
        date: newDate,
        startTime: newStartTime,
      });
      setIsRescheduling(false);
      setRescheduleReviewOpen(false);
      if (appt) search.mutate(appt.reference);
    },
    onError: () => {
      setRescheduleErrors((current) => ({
        ...current,
        request: "We could not submit your reschedule request. Please try again.",
      }));
    },
  });

  function beginReschedule() {
    if (!appt || !["pending", "confirmed"].includes(appt.status)) {
      setAppointmentPreviewError(
        "This appointment can no longer be rescheduled online. Please call the shop.",
      );
      return;
    }
    if ((appt?.rescheduleCount ?? 0) >= 3) {
      setAppointmentPreviewError("This appointment has reached the maximum of 3 reschedules.");
      return;
    }
    if (rescheduleServiceIds.length !== (appt?.services.length ?? 0)) {
      setAppointmentPreviewError(
        "The original services are no longer available for online rescheduling.",
      );
      return;
    }
    setNewDate("");
    setNewStartTime("");
    setRescheduleReason("");
    setRescheduleRequestId(crypto.randomUUID());
    setRescheduleTurnstileToken("");
    setRescheduleConfirmation(null);
    setRescheduleTermsAccepted(false);
    setRescheduleErrors({});
    setIsRescheduling(true);
  }

  function validateReschedule() {
    const nextErrors: typeof rescheduleErrors = {};
    if (!newDate) nextErrors.date = "Choose a new appointment date.";
    else if (newDate === appt?.date)
      nextErrors.date = "Choose a date different from your current appointment.";
    if (!newStartTime) nextErrors.time = "Choose an available appointment time.";
    if (!rescheduleReason.trim()) nextErrors.reason = "Tell us why you need to reschedule.";
    if (!rescheduleTermsAccepted) nextErrors.terms = "You must agree to the terms and conditions.";
    setRescheduleErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function openRescheduleReview() {
    if (validateReschedule()) setRescheduleReviewOpen(true);
  }

  function submitRescheduleRequest() {
    if (!validateReschedule()) {
      setRescheduleReviewOpen(false);
      return;
    }
    rescheduleMutation.mutate();
  }

  function closeAppointmentPreview() {
    setAppt(null);
    setIsRescheduling(false);
    setNewDate("");
    setNewStartTime("");
    setRescheduleReason("");
    setRescheduleRequestId(null);
    setRescheduleTurnstileToken("");
    setRescheduleConfirmation(null);
    setRescheduleErrors({});
    setAppointmentPreviewError(null);
    setReference("");
    setErrors({});
  }

  function validate() {
    const nextErrors: { reference?: string } = {};
    if (!isReferenceCode(reference)) {
      nextErrors.reference = "Enter a valid reference code.";
    }
    setErrors(nextErrors);
    setAppointmentPreviewError(null);
    return Object.keys(nextErrors).length === 0;
  }

  function resetReferenceRecovery() {
    setRecoveryStep("email");
    setRecoveryEmail("");
    setRecoveryCode("");
    setRecoveryErrors({});
    setRecoveryError(null);
    setRecoveryMessage(null);
  }

  function validateRecoveryEmail() {
    const nextErrors: typeof recoveryErrors = {};
    if (!/^\S+@\S+\.\S+$/.test(recoveryEmail.trim())) {
      nextErrors.email = "Enter a valid email address.";
    }
    setRecoveryErrors(nextErrors);
    setRecoveryError(null);
    setRecoveryMessage(null);
    return Object.keys(nextErrors).length === 0;
  }

  function validateRecoveryCode() {
    const nextErrors: typeof recoveryErrors = {};
    if (!/^\d{6}$/.test(recoveryCode.trim())) {
      nextErrors.code = "Enter the 6-digit verification code.";
    }
    setRecoveryErrors(nextErrors);
    setRecoveryError(null);
    setRecoveryMessage(null);
    return Object.keys(nextErrors).length === 0;
  }

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-12">
        <p className="text-xs tracking-[0.3em] text-accent uppercase">Appointment tracker</p>
        <h1 className="font-display text-4xl font-bold uppercase md:text-5xl">My appointment</h1>
        <p className="mt-2 text-muted-foreground">
          Enter the reference code you received when booking.
        </p>

        <form
          className="mt-8 grid gap-4 rounded-xl border border-border/70 bg-card/50 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            if (validate()) {
              setRescheduleConfirmation(null);
              search.mutate(reference);
            }
          }}
        >
          <div className="space-y-1.5">
            <Label>Reference code</Label>
            <Input
              value={reference}
              onChange={(e) => {
                setReference(normalizeReferenceCode(e.target.value));
                setAppointmentPreviewError(null);
                setErrors((current) => {
                  const { reference: _, ...rest } = current;
                  return rest;
                });
              }}
              placeholder="FRM-XXXXXX"
              maxLength={10}
              autoCapitalize="characters"
              aria-invalid={!!errors.reference}
            />
            <div className="space-y-1 pt-0.5 sm:min-h-7">
              <FieldError message={errors.reference} />
              <Dialog
                open={referenceRecoveryOpen}
                onOpenChange={(open) => {
                  setReferenceRecoveryOpen(open);
                  if (!open) resetReferenceRecovery();
                }}
              >
                <DialogTrigger asChild>
                  <Button type="button" variant="link" className="h-auto px-0 text-xs">
                    <CircleHelp className="size-3" aria-hidden="true" /> Forgot Reference Code?
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Recover your reference code</DialogTitle>
                    <DialogDescription>
                      {recoveryStep === "email"
                        ? "Enter the email address used for your booking. We will send a verification code before emailing your reference code."
                        : "Enter the verification code we sent to your booking email address."}
                    </DialogDescription>
                  </DialogHeader>
                  <form
                    className="space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (recoveryStep === "email") {
                        if (validateRecoveryEmail()) requestRecoveryCodeMutation.mutate();
                        return;
                      }
                      if (validateRecoveryCode()) verifyRecoveryCodeMutation.mutate();
                    }}
                  >
                    {recoveryStep === "email" ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="recovery-email">Email address</Label>
                        <Input
                          id="recovery-email"
                          type="email"
                          value={recoveryEmail}
                          maxLength={254}
                          autoComplete="email"
                          onChange={(event) => {
                            setRecoveryEmail(event.target.value);
                            setRecoveryErrors(({ email: _, ...current }) => current);
                            setRecoveryError(null);
                          }}
                          placeholder="you@example.com"
                          aria-invalid={Boolean(recoveryErrors.email)}
                        />
                        <FieldError message={recoveryErrors.email} />
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Label htmlFor="recovery-code">Verification code</Label>
                        <Input
                          id="recovery-code"
                          type="text"
                          value={recoveryCode}
                          maxLength={6}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          onChange={(event) => {
                            setRecoveryCode(event.target.value.replace(/\D/g, ""));
                            setRecoveryErrors(({ code: _, ...current }) => current);
                            setRecoveryError(null);
                          }}
                          placeholder="123456"
                          aria-invalid={Boolean(recoveryErrors.code)}
                        />
                        <FieldError message={recoveryErrors.code} />
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto px-0 text-xs"
                          disabled={requestRecoveryCodeMutation.isPending}
                          onClick={() => requestRecoveryCodeMutation.mutate()}
                        >
                          {requestRecoveryCodeMutation.isPending && (
                            <Loader2 className="animate-spin" />
                          )}
                          Send a new code
                        </Button>
                      </div>
                    )}
                    {recoveryError && (
                      <Alert
                        variant="destructive"
                        className="border-destructive/40 bg-destructive/5"
                      >
                        <CircleAlert className="size-4" aria-hidden="true" />
                        <AlertDescription>{recoveryError}</AlertDescription>
                      </Alert>
                    )}
                    {recoveryMessage && (
                      <div
                        role="status"
                        className="rounded-lg border border-primary/30 bg-primary/5 p-4"
                      >
                        <p className="text-sm font-medium">{recoveryMessage}</p>
                      </div>
                    )}
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button type="button" variant="outline">
                          Close
                        </Button>
                      </DialogClose>
                      {recoveryStep === "code" && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setRecoveryStep("email");
                            setRecoveryCode("");
                            setRecoveryErrors({});
                            setRecoveryError(null);
                            setRecoveryMessage(null);
                          }}
                        >
                          Change email
                        </Button>
                      )}
                      <Button
                        type="submit"
                        disabled={
                          requestRecoveryCodeMutation.isPending ||
                          verifyRecoveryCodeMutation.isPending
                        }
                      >
                        {(requestRecoveryCodeMutation.isPending ||
                          verifyRecoveryCodeMutation.isPending) && (
                          <Loader2 className="animate-spin" />
                        )}
                        {recoveryStep === "email"
                          ? "Send verification code"
                          : "Email my reference code"}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>
          <div className="sm:pt-[1.625rem]">
            <Button
              type="submit"
              disabled={search.isPending}
              className="w-full font-display uppercase sm:w-auto"
            >
              {search.isPending ? <Loader2 className="animate-spin" /> : <Search />} Find
            </Button>
          </div>
        </form>

        {appointmentPreviewError && (
          <Alert variant="destructive" className="mt-4 border-destructive/40 bg-destructive/5">
            <CircleAlert className="size-4" aria-hidden="true" />
            <div>
              <AlertTitle>Unable to show appointment details</AlertTitle>
              <AlertDescription>
                <p>{appointmentPreviewError}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  No changes have been made to your appointment.
                </p>
              </AlertDescription>
            </div>
          </Alert>
        )}

        {rescheduleConfirmation && (
          <section
            role="status"
            className="mt-8 rounded-xl border border-primary/40 bg-primary/5 p-5 text-center"
          >
            <p className="text-xs font-semibold tracking-[0.24em] text-primary uppercase">
              New connected booking reference
            </p>
            <p className="font-display mt-2 text-3xl tracking-widest text-primary">
              {rescheduleConfirmation.reference}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(rescheduleConfirmation.reference);
                  setRescheduleReferenceCopyStatus("copied");
                } catch {
                  setRescheduleReferenceCopyStatus("error");
                }
              }}
            >
              <Copy /> {rescheduleReferenceCopyStatus === "copied" ? "Copied" : "Copy code"}
            </Button>
            {rescheduleReferenceCopyStatus === "error" && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                Could not copy the code automatically. Please copy it manually.
              </p>
            )}
            <p className="mt-3 text-sm text-muted-foreground">
              Reserved for {formatDateLong(rescheduleConfirmation.date)} at{" "}
              {formatTime(rescheduleConfirmation.startTime)}. Save this code; the linked booking
              becomes active once the shop approves your request.
            </p>
          </section>
        )}

        {appt && (
          <Card className="mt-8 border-border/70 bg-card/60">
            <CardContent className="p-0">
              <div className="relative isolate overflow-hidden">
                <div
                  aria-hidden={isRescheduling && supportsSlideTransition}
                  inert={isRescheduling && supportsSlideTransition}
                  className={cn(
                    "p-6 transition-[opacity,transform] duration-500 ease-out will-change-[opacity,transform] motion-reduce:transition-none",
                    isRescheduling && supportsSlideTransition
                      ? "pointer-events-none absolute inset-x-0 top-0 -translate-x-8 opacity-0"
                      : "relative translate-x-0 opacity-100",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs tracking-widest text-muted-foreground uppercase">
                        Reference
                      </p>
                      <p className="font-display text-2xl tracking-widest text-primary">
                        {appt.reference}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={cn("uppercase", statusTone(appt.status))}>
                        {statusLabel(appt.status)}
                      </Badge>
                    </div>
                  </div>

                  <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                    <Row label="Customer" value={appt.customerName} />
                    <Row label="Mobile" value={appt.phone} />
                    <Row
                      label="Schedule"
                      value={`${formatDateLong(appt.date)} at ${formatTime(appt.startTime)}`}
                    />
                    <Row label="Motorcycle" value={appt.motorcycle} />
                    <Row label="Plate number" value={appt.plateNumber} />
                  </dl>

                  <div className="mt-5">
                    <p className="text-xs tracking-widest text-muted-foreground uppercase">
                      Services
                    </p>
                    <ul className="mt-2 space-y-1 text-sm">
                      {appt.services.map((s) => (
                        <li
                          key={s.name}
                          className="flex justify-between border-b border-border/50 py-1"
                        >
                          <span>{s.name}</span>
                          <span className="text-primary">{formatPHP(s.price)}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex items-center justify-between border-t border-border/70 pt-3 text-sm font-medium">
                      <span>Estimated Total</span>
                      <span className="text-primary">{formatPHP(appt.total)}</span>
                    </div>
                  </div>

                  {isRescheduling && !supportsSlideTransition && (
                    <div className="mt-6 space-y-5 border-t border-border/70 pt-6">
                      <div>
                        <p className="text-xs tracking-[0.3em] text-accent uppercase">
                          Reschedule appointment
                        </p>
                        <h2 className="font-display mt-1 text-2xl uppercase">
                          Choose a new schedule
                        </h2>
                        <p className="mt-2 text-sm text-muted-foreground">
                          Your personal details, motorcycle, and selected services above are
                          retained exactly as shown. Choose a different date and an available time
                          below.
                        </p>
                      </div>

                      {rescheduleAvailability.isLoading ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" /> Loading available schedules...
                        </p>
                      ) : rescheduleAvailability.isError || rescheduleAvailability.data?.error ? (
                        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                          {rescheduleAvailability.data?.error ??
                            "We could not load available schedules. Please try again."}
                        </p>
                      ) : (
                        <>
                          <div>
                            <Label>New preferred date</Label>
                            <div
                              className={cn(
                                "mt-2 w-full overflow-x-auto rounded-lg border border-border bg-card/50 p-2",
                                rescheduleErrors.date && "border-destructive",
                              )}
                            >
                              <Calendar
                                mode="single"
                                selected={newDate ? parseISO(newDate) : undefined}
                                onSelect={(selected) => {
                                  if (!selected) return;
                                  setNewDate(format(selected, "yyyy-MM-dd"));
                                  setNewStartTime("");
                                  setRescheduleErrors(
                                    ({ date: _, time: __, ...current }) => current,
                                  );
                                }}
                                disabled={(day) =>
                                  !rescheduleDateSet.has(format(day, "yyyy-MM-dd"))
                                }
                                modifiers={{
                                  fullyBooked: rescheduleFullyBookedDates.map((value) =>
                                    parseISO(value),
                                  ),
                                }}
                                modifiersClassNames={{
                                  fullyBooked:
                                    "bg-destructive/15 text-destructive line-through opacity-100",
                                }}
                                classNames={{
                                  nav: "justify-between gap-1",
                                  month_caption:
                                    "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
                                }}
                              />
                            </div>
                            <FieldError message={rescheduleErrors.date} className="mt-2" />
                          </div>

                          <div>
                            <Label>New preferred time</Label>
                            {newDate ? (
                              <div
                                className={cn(
                                  "mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4",
                                  rescheduleErrors.time && "rounded-lg ring-1 ring-destructive",
                                )}
                              >
                                {rescheduleSlots.map((slot) => (
                                  <button
                                    type="button"
                                    key={slot.id}
                                    disabled={slot.disabled}
                                    onClick={() => {
                                      setNewStartTime(slot.startTime);
                                      setRescheduleErrors(({ time: _, ...current }) => current);
                                    }}
                                    className={cn(
                                      "rounded-lg border p-3 text-center transition-colors",
                                      slot.disabled && "cursor-not-allowed opacity-40",
                                      newStartTime === slot.startTime
                                        ? "border-primary bg-primary/15"
                                        : "border-border bg-card/50 hover:border-primary/50",
                                    )}
                                  >
                                    <span className="font-display block">
                                      {formatTime(slot.startTime)}
                                    </span>
                                    <span className="block text-[11px] text-muted-foreground">
                                      {slot.disabled ? "Unavailable" : "Available"}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-2 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                                Select a new date to view available times.
                              </p>
                            )}
                            <FieldError message={rescheduleErrors.time} className="mt-2" />
                          </div>

                          <div>
                            <Label htmlFor="reschedule-reason">Reason for Rescheduling</Label>
                            <Textarea
                              id="reschedule-reason"
                              value={rescheduleReason}
                              maxLength={500}
                              onChange={(event) => {
                                setRescheduleReason(event.target.value);
                                setRescheduleErrors(({ reason: _, ...current }) => current);
                              }}
                              placeholder="Tell the shop why you need a different schedule."
                              aria-invalid={Boolean(rescheduleErrors.reason)}
                              className="mt-2"
                            />
                            <FieldError message={rescheduleErrors.reason} className="mt-2" />
                          </div>

                          <div
                            className={cn(
                              "flex items-start gap-3 rounded-md text-sm",
                              rescheduleErrors.terms && "border border-destructive p-3",
                            )}
                          >
                            <Checkbox
                              id="reschedule-terms"
                              checked={rescheduleTermsAccepted}
                              onCheckedChange={(value) => {
                                setRescheduleTermsAccepted(value === true);
                                setRescheduleErrors(({ terms: _, ...current }) => current);
                              }}
                              className="mt-0.5"
                            />
                            <div className="leading-6">
                              <label htmlFor="reschedule-terms">
                                I have read and agree to the{" "}
                              </label>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    type="button"
                                    className="font-bold text-primary underline decoration-primary/70 underline-offset-4 transition-colors hover:text-primary/80"
                                  >
                                    Terms and Conditions
                                  </button>
                                </DialogTrigger>
                                <DialogContent className="sm:max-w-2xl">
                                  <DialogHeader>
                                    <DialogTitle className="font-display text-2xl uppercase">
                                      Terms and Conditions
                                    </DialogTitle>
                                    <DialogDescription>
                                      Please read the complete booking terms before submitting your
                                      request.
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border/70 bg-card/50 p-4 text-sm leading-6 whitespace-pre-line text-muted-foreground">
                                    {bookingTerms.data || DEFAULT_BOOKING_TERMS}
                                  </div>
                                  <DialogFooter>
                                    <DialogClose asChild>
                                      <Button type="button" variant="outline">
                                        Close
                                      </Button>
                                    </DialogClose>
                                  </DialogFooter>
                                </DialogContent>
                              </Dialog>
                              <span>.</span>
                            </div>
                          </div>
                          <FieldError message={rescheduleErrors.terms} />
                          <FieldError message={rescheduleErrors.request} />
                          <TurnstileChallenge
                            resetKey={rescheduleRequestId ?? ""}
                            onToken={setRescheduleTurnstileToken}
                          />

                          <div className="flex flex-wrap gap-3">
                            <Button
                              type="button"
                              className="font-display uppercase"
                              onClick={openRescheduleReview}
                              disabled={
                                rescheduleMutation.isPending ||
                                (turnstileEnabled && !rescheduleTurnstileToken)
                              }
                            >
                              Reschedule
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="font-display uppercase"
                                >
                                  Cancel
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    Cancel this reschedule request?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Your appointment will stay unchanged and you will return to its
                                    details.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Keep editing</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => {
                                      setIsRescheduling(false);
                                      setRescheduleErrors({});
                                    }}
                                  >
                                    Yes, return to details
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </>
                      )}

                      <AlertDialog
                        open={rescheduleReviewOpen}
                        onOpenChange={setRescheduleReviewOpen}
                      >
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Confirm reschedule request?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Your request will move from {formatDateLong(appt?.date ?? "")} at{" "}
                              {formatTime(appt?.startTime ?? "00:00")} to{" "}
                              {newDate ? formatDateLong(newDate) : "your selected date"} at{" "}
                              {newStartTime ? formatTime(newStartTime) : "your selected time"}. The
                              shop must review it first. Reason:{" "}
                              {rescheduleReason || "Not provided"}.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Go back</AlertDialogCancel>
                            <AlertDialogAction
                              disabled={
                                rescheduleMutation.isPending ||
                                (turnstileEnabled && !rescheduleTurnstileToken)
                              }
                              onClick={submitRescheduleRequest}
                            >
                              {rescheduleMutation.isPending && <Loader2 className="animate-spin" />}{" "}
                              Confirm request
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}

                  {appt.rescheduledFromReference && (
                    <p className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-muted-foreground">
                      This appointment was rescheduled from{" "}
                      <strong>{appt.rescheduledFromReference}</strong>.
                    </p>
                  )}

                  {appt.rescheduledToReference && (
                    <p className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm text-muted-foreground">
                      This appointment has been rescheduled. Your new reference is{" "}
                      <strong>{appt.rescheduledToReference}</strong>.
                    </p>
                  )}

                  {appt.rescheduleRequestPending &&
                    appt.requestedRescheduleDate &&
                    appt.requestedRescheduleStartTime && (
                      <p className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm text-muted-foreground">
                        Your reschedule request for {formatDateLong(appt.requestedRescheduleDate)}{" "}
                        at {formatTime(appt.requestedRescheduleStartTime)} is awaiting the
                        shop&apos;s review. Your current appointment remains reserved until then.
                        {appt.requestedRescheduleReference && (
                          <>
                            {" "}
                            Your reserved new reference is{" "}
                            <strong>{appt.requestedRescheduleReference}</strong>.
                          </>
                        )}
                        {appt.requestedRescheduleReason && (
                          <>
                            {" "}
                            Reason: <strong>{appt.requestedRescheduleReason}</strong>
                          </>
                        )}
                      </p>
                    )}

                  {appt.rescheduleRequestRejected && (
                    <div
                      role="status"
                      className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
                    >
                      <p className="font-medium text-destructive">Reschedule Request Rejected</p>
                      <p className="mt-1 text-muted-foreground">
                        {appt.rescheduleRequestRejectionMessage ||
                          "Your requested reschedule was not approved. Your original appointment remains unchanged and reserved."}
                      </p>
                    </div>
                  )}

                  {!isRescheduling &&
                    !appt.hasReplacement &&
                    !appt.rescheduleRequestPending &&
                    appt.rescheduleCount >= 3 && (
                      <p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-muted-foreground">
                        <strong className="text-destructive">
                          Maximum reschedule limit reached.
                        </strong>{" "}
                        This appointment has already been rescheduled 3 times and cannot be
                        rescheduled again.
                      </p>
                    )}

                  {appt.notes && (
                    <p className="mt-4 text-sm text-muted-foreground">Notes: {appt.notes}</p>
                  )}

                  {!isRescheduling && (
                    <div className="mt-6 flex flex-wrap justify-end gap-3 border-t border-border/70 pt-5">
                      {["pending", "confirmed", "rescheduled"].includes(appt.status) &&
                        !appt.hasReplacement &&
                        !appt.rescheduleRequestPending && (
                          <>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="destructive" className="font-display uppercase">
                                  Cancel
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Cancel this appointment?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This cannot be undone. You will need to book a new schedule,
                                    subject to availability.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => cancelMutation.mutate(appt.reference)}
                                  >
                                    Yes, cancel
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                            {["pending", "confirmed"].includes(appt.status) &&
                              appt.rescheduleCount < 3 && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="font-display uppercase"
                                  onClick={beginReschedule}
                                >
                                  Reschedule
                                </Button>
                              )}
                          </>
                        )}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button type="button" variant="outline" className="uppercase">
                            Close
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Close appointment preview?</AlertDialogTitle>
                            <AlertDialogDescription>
                              You will return to the Appointment Tracker. Your appointment will not
                              be changed.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={closeAppointmentPreview}>
                              Confirm Close
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
                <div
                  aria-hidden={!isRescheduling || !supportsSlideTransition}
                  inert={!isRescheduling || !supportsSlideTransition}
                  className={cn(
                    "p-6 sm:p-7 transition-[opacity,transform] duration-500 ease-out will-change-[opacity,transform] motion-reduce:transition-none",
                    !supportsSlideTransition && "hidden",
                    isRescheduling && supportsSlideTransition
                      ? "relative translate-x-0 opacity-100"
                      : "pointer-events-none absolute inset-x-0 top-0 translate-x-8 opacity-0",
                  )}
                >
                  <p className="text-xs tracking-[0.3em] text-accent uppercase">
                    Reschedule appointment
                  </p>
                  <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-display text-2xl uppercase">Choose a new schedule</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        The original booking remains active until the shop approves this request.
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="border-primary/40 bg-primary/5 text-primary uppercase"
                    >
                      From {appt.reference}
                    </Badge>
                  </div>

                  <section className="mt-5 rounded-xl border border-border/70 bg-muted/30 p-5">
                    <div className="grid gap-4 text-sm sm:grid-cols-3">
                      <div>
                        <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
                          Personal details
                        </p>
                        <p className="mt-1 font-medium">{appt.customerName}</p>
                        <p className="text-muted-foreground">{appt.phone}</p>
                      </div>
                      <div>
                        <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
                          Motorcycle
                        </p>
                        <p className="mt-1 font-medium">{appt.motorcycle}</p>
                        <p className="text-muted-foreground">Plate {appt.plateNumber}</p>
                      </div>
                      <div>
                        <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
                          Selected services
                        </p>
                        <ul className="mt-1 space-y-1 text-muted-foreground">
                          {appt.services.map((service) => (
                            <li key={service.name} className="flex justify-between gap-3">
                              <span>{service.name}</span>
                              <span>{formatPHP(service.price)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </section>

                  {rescheduleAvailability.isLoading ? (
                    <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" /> Loading available schedules...
                    </p>
                  ) : rescheduleAvailability.isError || rescheduleAvailability.data?.error ? (
                    <p className="mt-6 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      {rescheduleAvailability.data?.error ??
                        "We could not load available schedules. Please try again."}
                    </p>
                  ) : (
                    <div className="mt-6 space-y-5 border-t border-border/70 pt-5">
                      <div>
                        <p className="text-xs font-semibold tracking-[0.2em] text-primary uppercase">
                          New preferred schedule
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Select an available date first, then choose the time that works best for
                          you.
                        </p>
                      </div>
                      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,0.75fr)]">
                        <div>
                          <Label>New preferred date</Label>
                          <div
                            className={cn(
                              "mt-2 w-full overflow-x-auto rounded-lg border border-border bg-card/50 p-2",
                              rescheduleErrors.date && "border-destructive",
                            )}
                          >
                            <Calendar
                              mode="single"
                              selected={newDate ? parseISO(newDate) : undefined}
                              onSelect={(selected) => {
                                if (!selected) return;
                                setNewDate(format(selected, "yyyy-MM-dd"));
                                setNewStartTime("");
                                setRescheduleErrors(({ date: _, time: __, ...current }) => current);
                              }}
                              disabled={(day) => !rescheduleDateSet.has(format(day, "yyyy-MM-dd"))}
                              modifiers={{
                                fullyBooked: rescheduleFullyBookedDates.map((value) =>
                                  parseISO(value),
                                ),
                              }}
                              modifiersClassNames={{
                                fullyBooked:
                                  "bg-destructive/15 text-destructive line-through opacity-100",
                              }}
                              classNames={{
                                nav: "justify-between gap-1",
                                month_caption:
                                  "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
                              }}
                            />
                          </div>
                          <FieldError message={rescheduleErrors.date} className="mt-2" />
                        </div>

                        <div>
                          <Label>New preferred time</Label>
                          {newDate ? (
                            <div
                              className={cn(
                                "mt-2 grid grid-cols-2 gap-2",
                                rescheduleErrors.time && "rounded-lg ring-1 ring-destructive",
                              )}
                            >
                              {rescheduleSlots.map((slot) => (
                                <button
                                  type="button"
                                  key={slot.id}
                                  disabled={slot.disabled}
                                  onClick={() => {
                                    setNewStartTime(slot.startTime);
                                    setRescheduleErrors(({ time: _, ...current }) => current);
                                  }}
                                  className={cn(
                                    "rounded-lg border px-3 py-2.5 text-center transition-colors",
                                    slot.disabled && "cursor-not-allowed opacity-40",
                                    newStartTime === slot.startTime
                                      ? "border-primary bg-primary/15"
                                      : "border-border bg-card/50 hover:border-primary/50",
                                  )}
                                >
                                  <span className="font-display block">
                                    {formatTime(slot.startTime)}
                                  </span>
                                  <span className="block text-[11px] text-muted-foreground">
                                    {slot.disabled ? "Unavailable" : "Available"}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-2 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                              Select a date to view available times.
                            </p>
                          )}
                          <FieldError message={rescheduleErrors.time} className="mt-2" />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="reschedule-reason-flip">Reason for Rescheduling</Label>
                        <Textarea
                          id="reschedule-reason-flip"
                          value={rescheduleReason}
                          maxLength={500}
                          onChange={(event) => {
                            setRescheduleReason(event.target.value);
                            setRescheduleErrors(({ reason: _, ...current }) => current);
                          }}
                          placeholder="Tell the shop why you need a different schedule."
                          aria-invalid={Boolean(rescheduleErrors.reason)}
                          className="mt-2"
                        />
                        <FieldError message={rescheduleErrors.reason} className="mt-2" />
                      </div>

                      <div
                        className={cn(
                          "flex items-start gap-3 rounded-md text-sm",
                          rescheduleErrors.terms && "border border-destructive p-3",
                        )}
                      >
                        <Checkbox
                          id="reschedule-terms-flip"
                          checked={rescheduleTermsAccepted}
                          onCheckedChange={(value) => {
                            setRescheduleTermsAccepted(value === true);
                            setRescheduleErrors(({ terms: _, ...current }) => current);
                          }}
                          className="mt-0.5"
                        />
                        <div className="leading-6">
                          <label htmlFor="reschedule-terms-flip">
                            I have read and agree to the{" "}
                          </label>
                          <Dialog>
                            <DialogTrigger asChild>
                              <button
                                type="button"
                                className="font-bold text-primary underline decoration-primary/70 underline-offset-4 transition-colors hover:text-primary/80"
                              >
                                Terms and Conditions
                              </button>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-2xl">
                              <DialogHeader>
                                <DialogTitle className="font-display text-2xl uppercase">
                                  Terms and Conditions
                                </DialogTitle>
                                <DialogDescription>
                                  Please read the complete booking terms before submitting your
                                  request.
                                </DialogDescription>
                              </DialogHeader>
                              <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border/70 bg-card/50 p-4 text-sm leading-6 whitespace-pre-line text-muted-foreground">
                                {bookingTerms.data || DEFAULT_BOOKING_TERMS}
                              </div>
                              <DialogFooter>
                                <DialogClose asChild>
                                  <Button type="button" variant="outline">
                                    Close
                                  </Button>
                                </DialogClose>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>
                          <span>.</span>
                        </div>
                      </div>
                      <FieldError message={rescheduleErrors.terms} />
                      <FieldError message={rescheduleErrors.request} />
                      {isRescheduling && supportsSlideTransition && (
                        <TurnstileChallenge
                          resetKey={rescheduleRequestId ?? ""}
                          onToken={setRescheduleTurnstileToken}
                        />
                      )}

                      <div className="flex flex-wrap justify-between gap-3 border-t border-border/70 pt-5">
                        <Button
                          type="button"
                          variant="outline"
                          className="font-display uppercase"
                          onClick={() => {
                            setIsRescheduling(false);
                            setRescheduleErrors({});
                          }}
                        >
                          Back to appointment
                        </Button>
                        <Button
                          type="button"
                          className="font-display uppercase"
                          onClick={openRescheduleReview}
                          disabled={
                            rescheduleMutation.isPending ||
                            (turnstileEnabled && !rescheduleTurnstileToken)
                          }
                        >
                          Continue to confirmation
                        </Button>
                      </div>
                    </div>
                  )}

                  <AlertDialog open={rescheduleReviewOpen} onOpenChange={setRescheduleReviewOpen}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Confirm new connected booking?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Your new booking will be scheduled for{" "}
                          {newDate ? formatDateLong(newDate) : "your selected date"} at{" "}
                          {newStartTime ? formatTime(newStartTime) : "your selected time"}. A new
                          reference code will be reserved now and the shop will approve the
                          connected booking before it becomes active.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Go back</AlertDialogCancel>
                        <AlertDialogAction
                          disabled={
                            rescheduleMutation.isPending ||
                            (turnstileEnabled && !rescheduleTurnstileToken)
                          }
                          onClick={submitRescheduleRequest}
                        >
                          {rescheduleMutation.isPending && <Loader2 className="animate-spin" />}{" "}
                          Confirm request
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-widest text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}
