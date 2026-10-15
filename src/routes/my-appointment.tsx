import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CalendarX,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Clock,
  Info,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  type AppointmentAction,
  type AppointmentVerification,
  AppointmentVerificationDialog,
} from "@/components/site/appointment-verification-dialog";
import {
  BookingCalendar,
  FullyBookedLegend,
  TimeSlotPicker,
} from "@/components/site/booking-schedule";
import { CopyReferenceButton } from "@/components/site/copy-reference-button";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { TermsAgreement } from "@/components/site/terms-agreement";
import { TurnstileChallenge } from "@/components/site/turnstile-challenge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  SHOP,
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
// Ask for a fresh code a little before the server-side expiry, so a request
// is never sent with a token that expires on the way.
const VERIFICATION_EXPIRY_MARGIN_MS = 60_000;

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
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [rescheduleTermsAccepted, setRescheduleTermsAccepted] = useState(false);
  const [rescheduleErrors, setRescheduleErrors] = useState<{
    date?: string;
    time?: string;
    reason?: string;
    terms?: string;
    request?: string;
  }>({});
  const [rescheduleReviewOpen, setRescheduleReviewOpen] = useState(false);
  // Which action is waiting for email verification, and why it is being asked again.
  const [verificationRequest, setVerificationRequest] = useState<{
    action: AppointmentAction;
    notice: string | null;
  } | null>(null);
  // A reschedule spans several requests (schedules, then submit), so its token is
  // kept while the customer picks a new schedule. Cancelling uses its token at once.
  const [rescheduleVerification, setRescheduleVerification] = useState<
    (AppointmentVerification & { reference: string }) | null
  >(null);
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
    mutationFn: ({ referenceCode, token }: { referenceCode: string; token: string }) =>
      cancel({
        data: {
          reference: normalizeReferenceCode(referenceCode),
          verificationToken: token,
        },
      }),
    onSuccess: (res, { referenceCode }) => {
      if (!res.ok) {
        if ("verificationRequired" in res) {
          setVerificationRequest({ action: "cancel", notice: res.error });
          return;
        }
        setAppointmentPreviewError(res.error);
        return;
      }
      setStatusNotice("Your appointment has been cancelled.");
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
          ...(rescheduleVerification ? { verificationToken: rescheduleVerification.token } : {}),
        },
      });
      return result;
    },
    onSuccess: (result) => {
      if (!result.ok) {
        if ("verificationRequired" in result) {
          setRescheduleVerification(null);
          setRescheduleReviewOpen(false);
          setVerificationRequest({ action: "reschedule", notice: result.error });
          return;
        }
        setRescheduleErrors((current) => ({ ...current, request: result.error }));
        return;
      }
      setRescheduleVerification(null);
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

  function hasRescheduleVerification() {
    return Boolean(
      appt &&
      rescheduleVerification?.reference === appt.reference &&
      Date.parse(rescheduleVerification.expiresAt) - Date.now() > VERIFICATION_EXPIRY_MARGIN_MS,
    );
  }

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
    if (!hasRescheduleVerification()) {
      setVerificationRequest({ action: "reschedule", notice: null });
      return;
    }
    openRescheduleForm();
  }

  function openRescheduleForm() {
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
    if (!hasRescheduleVerification()) {
      setRescheduleReviewOpen(false);
      setVerificationRequest({
        action: "reschedule",
        notice:
          "Your email verification has expired. Verify again to submit your request; your chosen schedule is kept.",
      });
      return;
    }
    rescheduleMutation.mutate();
  }

  function handleVerified(action: AppointmentAction, verification: AppointmentVerification) {
    if (!appt) return;
    setVerificationRequest(null);
    if (action === "cancel") {
      cancelMutation.mutate({ referenceCode: appt.reference, token: verification.token });
      return;
    }
    setRescheduleVerification({ ...verification, reference: appt.reference });
    if (isRescheduling) {
      // Verified again mid-way: keep the chosen schedule and return to the review step.
      setRescheduleErrors(({ request: _, ...current }) => current);
      setRescheduleReviewOpen(true);
      return;
    }
    openRescheduleForm();
  }

  function closeAppointmentPreview() {
    setAppt(null);
    setVerificationRequest(null);
    setRescheduleVerification(null);
    setIsRescheduling(false);
    setNewDate("");
    setNewStartTime("");
    setRescheduleReason("");
    setRescheduleRequestId(null);
    setRescheduleTurnstileToken("");
    setRescheduleConfirmation(null);
    setRescheduleErrors({});
    setAppointmentPreviewError(null);
    setStatusNotice(null);
    setReference("");
    setErrors({});
  }

  /** Look up a linked appointment (for example, a rescheduled booking's new reference). */
  function lookupReference(referenceCode: string) {
    setReference(referenceCode);
    setErrors({});
    setAppointmentPreviewError(null);
    setStatusNotice(null);
    setRescheduleConfirmation(null);
    setVerificationRequest(null);
    setRescheduleVerification(null);
    setIsRescheduling(false);
    search.mutate(referenceCode);
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

  const canManageAppointment = Boolean(
    appt &&
    ["pending", "confirmed", "rescheduled"].includes(appt.status) &&
    !appt.hasReplacement &&
    !appt.rescheduleRequestPending,
  );
  const canRescheduleAppointment = Boolean(
    appt &&
    canManageAppointment &&
    ["pending", "confirmed"].includes(appt.status) &&
    appt.rescheduleCount < 3,
  );
  const statusHint = appt ? appointmentStatusHint(appt.status) : null;

  // The reschedule form is rendered in exactly one place: the sliding panel in
  // modern browsers, or inline below the appointment details as a fallback.
  const rescheduleForm = appt ? (
    rescheduleAvailability.isLoading ? (
      <p className="mt-6 flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking available schedules…
      </p>
    ) : rescheduleAvailability.isError || rescheduleAvailability.data?.error ? (
      <p className="mt-6 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {rescheduleAvailability.data?.error ??
          "We could not load available schedules. Please try again."}
      </p>
    ) : (
      <div className="mt-6 space-y-6">
        <div
          className={cn(
            "rounded-xl border border-border bg-card/50 p-3 sm:p-5",
            (rescheduleErrors.date || rescheduleErrors.time) && "border-destructive",
          )}
        >
          <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:gap-8">
            <div className="border-b border-border/70 pb-5 md:border-r md:border-b-0 md:pr-8 md:pb-0">
              <p className="text-sm font-medium">New date</p>
              <div className="mt-2 flex justify-center md:justify-start">
                <BookingCalendar
                  selected={newDate}
                  availableDates={rescheduleDateSet}
                  fullyBookedDates={rescheduleFullyBookedDates}
                  onSelect={(iso) => {
                    setNewDate(iso);
                    setNewStartTime("");
                    setRescheduleErrors(({ date: _, time: __, ...current }) => current);
                  }}
                />
              </div>
              {rescheduleFullyBookedDates.length > 0 && (
                <FullyBookedLegend className="mt-3 justify-center md:justify-start" />
              )}
              <FieldError message={rescheduleErrors.date} className="mt-2" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">New time</p>
              <p className="mt-1 mb-4 text-sm text-muted-foreground">
                {newDate
                  ? formatDateLong(newDate)
                  : "Choose a date to see the available start times."}
              </p>
              {newDate ? (
                <TimeSlotPicker
                  slots={rescheduleSlots}
                  value={newStartTime}
                  onChange={(value) => {
                    setNewStartTime(value);
                    setRescheduleErrors(({ time: _, ...current }) => current);
                  }}
                  invalid={Boolean(rescheduleErrors.time)}
                  gridClassName="sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3"
                />
              ) : (
                <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  Time slots will appear here after you choose a date.
                </p>
              )}
              <FieldError message={rescheduleErrors.time} className="mt-2" />
            </div>
          </div>
        </div>

        <div>
          <Label htmlFor="reschedule-reason">Reason for rescheduling</Label>
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

        <div>
          <TermsAgreement
            id="reschedule-terms"
            checked={rescheduleTermsAccepted}
            onCheckedChange={(value) => {
              setRescheduleTermsAccepted(value);
              setRescheduleErrors(({ terms: _, ...current }) => current);
            }}
            terms={bookingTerms.data || DEFAULT_BOOKING_TERMS}
            invalid={Boolean(rescheduleErrors.terms)}
          />
          <FieldError message={rescheduleErrors.terms} className="mt-2" />
        </div>
        {rescheduleErrors.request && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {rescheduleErrors.request}
          </p>
        )}
        {isRescheduling && (
          <TurnstileChallenge
            resetKey={rescheduleRequestId ?? ""}
            onToken={setRescheduleTurnstileToken}
            label="Complete the security check to continue."
          />
        )}

        <div className="flex flex-col-reverse gap-3 border-t border-border/70 pt-5 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setIsRescheduling(false);
              setRescheduleErrors({});
            }}
            className="w-full sm:w-auto"
          >
            <ArrowLeft aria-hidden="true" /> Back to appointment
          </Button>
          <Button
            type="button"
            onClick={openRescheduleReview}
            disabled={
              rescheduleMutation.isPending || (turnstileEnabled && !rescheduleTurnstileToken)
            }
            className="w-full font-display tracking-wide uppercase sm:w-auto"
          >
            Review reschedule request <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    )
  ) : null;

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <p className="text-xs tracking-[0.3em] text-accent uppercase">Appointment tracker</p>
        <h1 className="font-display text-3xl font-bold uppercase sm:text-4xl md:text-5xl">
          My appointment
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Enter your booking reference code to check your appointment status, reschedule, or cancel.
          To protect your booking, changes are confirmed with a code sent to your booking email.
        </p>

        <form
          noValidate
          className="mt-8 rounded-xl border border-border/70 bg-card/50 p-4 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (validate()) {
              setRescheduleConfirmation(null);
              setStatusNotice(null);
              setVerificationRequest(null);
              setRescheduleVerification(null);
              setIsRescheduling(false);
              search.mutate(reference);
            }
          }}
        >
          <Label htmlFor="appointment-reference">Reference code</Label>
          <div className="mt-1.5 flex flex-col gap-3 sm:flex-row">
            <Input
              id="appointment-reference"
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
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!errors.reference}
              aria-describedby="appointment-reference-hint"
              className="h-11 font-display text-lg tracking-widest uppercase md:h-10 md:text-lg"
            />
            <Button
              type="submit"
              size="lg"
              disabled={search.isPending}
              className="w-full shrink-0 font-display tracking-wide uppercase sm:w-auto"
            >
              {search.isPending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Search aria-hidden="true" />
              )}
              {search.isPending ? "Searching…" : "Find appointment"}
            </Button>
          </div>
          <FieldError message={errors.reference} className="mt-2" />
          <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p id="appointment-reference-hint">
              Your code looks like FRM-ABC123 and was shown when you booked.
            </p>
            <Button
              type="button"
              variant="link"
              className="h-auto self-start px-0 text-xs md:h-auto"
              onClick={() => setReferenceRecoveryOpen(true)}
            >
              <CircleHelp className="size-3.5" aria-hidden="true" /> Forgot your reference code?
            </Button>
          </div>
        </form>

        {/* Kept outside the lookup form so its own form submit cannot also trigger a lookup. */}
        <Dialog
          open={referenceRecoveryOpen}
          onOpenChange={(open) => {
            setReferenceRecoveryOpen(open);
            if (!open) resetReferenceRecovery();
          }}
        >
          {/* minmax(0,1fr) keeps the dialog's single grid column from growing wider
              than the dialog when its content has long, non-wrapping text. */}
          <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Recover your reference code</DialogTitle>
              <DialogDescription>
                {recoveryStep === "email"
                  ? "Enter the email address used for your booking. We will send a verification code before emailing your reference code."
                  : "Enter the verification code we sent to your booking email address."}
              </DialogDescription>
            </DialogHeader>
            <form
              noValidate
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
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto px-0 text-xs md:h-auto"
                      disabled={requestRecoveryCodeMutation.isPending}
                      onClick={() => requestRecoveryCodeMutation.mutate()}
                    >
                      {requestRecoveryCodeMutation.isPending && (
                        <Loader2 className="animate-spin" />
                      )}
                      Resend code
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto px-0 text-xs md:h-auto"
                      onClick={() => {
                        setRecoveryStep("email");
                        setRecoveryCode("");
                        setRecoveryErrors({});
                        setRecoveryError(null);
                        setRecoveryMessage(null);
                      }}
                    >
                      Use a different email
                    </Button>
                  </div>
                </div>
              )}
              {recoveryError && (
                <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
                  <CircleAlert className="size-4" aria-hidden="true" />
                  <AlertDescription>{recoveryError}</AlertDescription>
                </Alert>
              )}
              {recoveryMessage && (
                <div role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <p className="text-sm font-medium">{recoveryMessage}</p>
                </div>
              )}
              {/* The footer's gap already spaces the buttons; drop the extra
                  horizontal margin and let them wrap rather than overflow. */}
              <DialogFooter className="sm:flex-wrap sm:space-x-0">
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Close
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={
                    requestRecoveryCodeMutation.isPending || verifyRecoveryCodeMutation.isPending
                  }
                >
                  {(requestRecoveryCodeMutation.isPending ||
                    verifyRecoveryCodeMutation.isPending) && <Loader2 className="animate-spin" />}
                  {recoveryStep === "email" ? "Send verification code" : "Email my reference code"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

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

        {statusNotice && (
          <p
            role="status"
            className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-foreground"
          >
            <CircleCheck className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
            {statusNotice}
          </p>
        )}

        {rescheduleConfirmation && (
          <section
            role="status"
            className="mt-8 rounded-xl border border-primary/40 bg-primary/5 p-5 text-center sm:p-6"
          >
            <CircleCheck className="mx-auto size-10 text-primary" aria-hidden="true" />
            <h2 className="mt-3 font-display text-2xl uppercase">Reschedule request sent</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Requested for {formatDateLong(rescheduleConfirmation.date)} at{" "}
              {formatTime(rescheduleConfirmation.startTime)}. Your current appointment stays
              reserved until the shop reviews your request.
            </p>
            <p className="mt-5 text-xs tracking-[0.24em] text-muted-foreground uppercase">
              New reference code
            </p>
            <p className="mt-1 font-display text-3xl tracking-widest text-primary">
              {rescheduleConfirmation.reference}
            </p>
            <CopyReferenceButton value={rescheduleConfirmation.reference} className="mt-3" />
            <p className="mt-3 text-xs text-muted-foreground">
              Save this code. The linked booking becomes active once the shop approves your request.
            </p>
          </section>
        )}

        {!appt && !appointmentPreviewError && !rescheduleConfirmation && !search.isPending && (
          <>
            <ul aria-label="What you can do here" className="mt-8 grid gap-3 sm:grid-cols-3">
              {[
                {
                  icon: Search,
                  title: "Check status",
                  text: "See whether your appointment is pending, confirmed, or completed.",
                },
                {
                  icon: RefreshCw,
                  title: "Reschedule",
                  text: "Request a new date and time for a pending or confirmed appointment.",
                },
                {
                  icon: CalendarX,
                  title: "Cancel",
                  text: "Cancel online if your plans change, subject to the shop's notice period.",
                },
              ].map((item) => (
                <li
                  key={item.title}
                  className="flex items-start gap-3 rounded-lg border border-border/70 bg-background/50 p-4"
                >
                  <item.icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
                  <div>
                    <p className="font-display text-base tracking-wide uppercase">{item.title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Don&apos;t have a booking yet?{" "}
              <Link to="/book" className="font-medium text-primary underline underline-offset-4">
                Book a service appointment
              </Link>
            </p>
          </>
        )}

        {appt && (
          <Card className="mt-8 overflow-hidden border-border/70 bg-card/60">
            <CardContent className="p-0">
              <div className="relative isolate overflow-hidden">
                <div
                  aria-hidden={isRescheduling && supportsSlideTransition}
                  inert={isRescheduling && supportsSlideTransition}
                  className={cn(
                    "transition-[opacity,transform] duration-500 ease-out will-change-[opacity,transform] motion-reduce:transition-none",
                    isRescheduling && supportsSlideTransition
                      ? "pointer-events-none absolute inset-x-0 top-0 -translate-x-8 opacity-0"
                      : "relative translate-x-0 opacity-100",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 bg-muted/30 px-5 py-4 sm:px-6">
                    <div>
                      <p className="text-xs tracking-widest text-muted-foreground uppercase">
                        Reference code
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-3">
                        <p className="font-display text-2xl tracking-widest text-primary">
                          {appt.reference}
                        </p>
                        <CopyReferenceButton value={appt.reference} />
                      </div>
                    </div>
                    <Badge variant="outline" className={cn("uppercase", statusTone(appt.status))}>
                      {statusLabel(appt.status)}
                    </Badge>
                  </div>

                  <div className="space-y-6 p-5 sm:p-6">
                    <div className="flex items-start gap-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                        <CalendarDays className="size-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs tracking-widest text-muted-foreground uppercase">
                          Scheduled for
                        </p>
                        <p className="font-display text-xl uppercase sm:text-2xl">
                          {formatDateLong(appt.date)}
                        </p>
                        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <Clock className="size-4" aria-hidden="true" />
                          {formatTime(appt.startTime)}
                        </p>
                        {statusHint && <p className="mt-2 text-sm">{statusHint}</p>}
                      </div>
                    </div>

                    {appt.rescheduledFromReference && (
                      <Notice tone="info">
                        This appointment was rescheduled from{" "}
                        <strong>{appt.rescheduledFromReference}</strong>.
                      </Notice>
                    )}

                    {appt.rescheduledToReference && (
                      <Notice tone="accent">
                        <p>
                          This appointment has been rescheduled. Your new reference is{" "}
                          <strong>{appt.rescheduledToReference}</strong>.
                        </p>
                        <Button
                          type="button"
                          variant="link"
                          className="mt-1 h-auto px-0 md:h-auto"
                          onClick={() => lookupReference(appt.rescheduledToReference!)}
                        >
                          View new appointment <ArrowRight aria-hidden="true" />
                        </Button>
                      </Notice>
                    )}

                    {appt.rescheduleRequestPending &&
                      appt.requestedRescheduleDate &&
                      appt.requestedRescheduleStartTime && (
                        <Notice tone="accent" title="Reschedule request awaiting review">
                          Your request to move this appointment to{" "}
                          {formatDateLong(appt.requestedRescheduleDate)} at{" "}
                          {formatTime(appt.requestedRescheduleStartTime)} is awaiting the
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
                        </Notice>
                      )}

                    {appt.rescheduleRequestRejected && (
                      <Notice tone="destructive" title="Reschedule request not approved">
                        {appt.rescheduleRequestRejectionMessage ||
                          "Your requested reschedule was not approved. Your original appointment remains unchanged and reserved."}
                      </Notice>
                    )}

                    {!isRescheduling &&
                      !appt.hasReplacement &&
                      !appt.rescheduleRequestPending &&
                      appt.rescheduleCount >= 3 && (
                        <Notice tone="destructive" title="Maximum reschedule limit reached">
                          This appointment has already been rescheduled 3 times and cannot be
                          rescheduled again.
                        </Notice>
                      )}

                    <dl className="grid gap-4 sm:grid-cols-2">
                      <Row label="Customer" value={appt.customerName} />
                      <Row label="Mobile number" value={appt.phone} />
                      <Row label="Motorcycle" value={appt.motorcycle} />
                      <Row label="Plate number" value={appt.plateNumber} />
                    </dl>

                    <div>
                      <p className="text-xs tracking-widest text-muted-foreground uppercase">
                        Services
                      </p>
                      <ul className="mt-2 divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
                        {appt.services.map((s) => (
                          <li
                            key={s.name}
                            className="flex justify-between gap-3 px-3 py-2.5 text-sm"
                          >
                            <span>{s.name}</span>
                            <span className="shrink-0 text-primary">{formatPHP(s.price)}</span>
                          </li>
                        ))}
                        <li className="flex items-baseline justify-between gap-3 bg-primary/5 px-3 py-3">
                          <span className="text-sm font-medium">Estimated total</span>
                          <span className="font-display text-xl text-primary">
                            {formatPHP(appt.total)}
                          </span>
                        </li>
                      </ul>
                    </div>

                    {appt.notes && (
                      <div>
                        <p className="text-xs tracking-widest text-muted-foreground uppercase">
                          Notes
                        </p>
                        <p className="mt-1 text-sm whitespace-pre-line">{appt.notes}</p>
                      </div>
                    )}

                    {isRescheduling && !supportsSlideTransition && (
                      <div className="border-t border-border/70 pt-6">
                        <RescheduleHeading reference={appt.reference} />
                        {rescheduleForm}
                      </div>
                    )}
                  </div>

                  {!isRescheduling && (
                    <div className="flex flex-col-reverse gap-3 border-t border-border/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button type="button" variant="ghost" className="w-full sm:w-auto">
                            <X aria-hidden="true" /> Close details
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Close appointment details?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Your appointment will not be changed. You can look it up again anytime
                              with your reference code.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep viewing</AlertDialogCancel>
                            <AlertDialogAction onClick={closeAppointmentPreview}>
                              Close details
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>

                      {canManageAppointment && !appt.emailHint && (
                        <p className="flex max-w-md items-start gap-2 text-sm text-muted-foreground">
                          <Info
                            className="mt-0.5 size-4 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                          <span>
                            To cancel or reschedule, please call the shop at{" "}
                            <a
                              href={`tel:${SHOP.phone.replace(/\s/g, "")}`}
                              className="font-medium whitespace-nowrap text-foreground underline underline-offset-4"
                            >
                              {SHOP.phone}
                            </a>
                            . Online changes are confirmed with a code sent to the booking&apos;s
                            email, and this booking has none on file.
                          </span>
                        </p>
                      )}

                      {canManageAppointment && appt.emailHint && (
                        <div className="flex flex-col-reverse gap-3 sm:flex-row">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={cancelMutation.isPending}
                            onClick={() =>
                              setVerificationRequest({ action: "cancel", notice: null })
                            }
                            className="w-full border-destructive/40 font-display tracking-wide text-destructive uppercase hover:bg-destructive/10 hover:text-destructive sm:w-auto"
                          >
                            {cancelMutation.isPending ? (
                              <Loader2 className="animate-spin" aria-hidden="true" />
                            ) : (
                              <CalendarX aria-hidden="true" />
                            )}
                            {cancelMutation.isPending ? "Cancelling…" : "Cancel appointment"}
                          </Button>
                          {canRescheduleAppointment && (
                            <Button
                              type="button"
                              onClick={beginReschedule}
                              className="w-full font-display tracking-wide uppercase sm:w-auto"
                            >
                              <RefreshCw aria-hidden="true" /> Reschedule appointment
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div
                  aria-hidden={!isRescheduling || !supportsSlideTransition}
                  inert={!isRescheduling || !supportsSlideTransition}
                  className={cn(
                    "p-5 transition-[opacity,transform] duration-500 ease-out will-change-[opacity,transform] motion-reduce:transition-none sm:p-6",
                    !supportsSlideTransition && "hidden",
                    isRescheduling && supportsSlideTransition
                      ? "relative translate-x-0 opacity-100"
                      : "pointer-events-none absolute inset-x-0 top-0 translate-x-8 opacity-0",
                  )}
                >
                  <RescheduleHeading reference={appt.reference} />

                  <section className="mt-5 grid gap-4 rounded-xl border border-border/70 bg-muted/30 p-4 text-sm sm:grid-cols-2">
                    <SummaryBlock label="Current schedule">
                      <p className="font-medium">{formatDateLong(appt.date)}</p>
                      <p className="text-muted-foreground">{formatTime(appt.startTime)}</p>
                    </SummaryBlock>
                    <SummaryBlock label="Customer">
                      <p className="font-medium">{appt.customerName}</p>
                      <p className="text-muted-foreground">{appt.phone}</p>
                    </SummaryBlock>
                    <SummaryBlock label="Motorcycle">
                      <p className="font-medium">{appt.motorcycle}</p>
                      <p className="text-muted-foreground">Plate {appt.plateNumber}</p>
                    </SummaryBlock>
                    <SummaryBlock label="Services">
                      <ul className="space-y-0.5">
                        {appt.services.map((service) => (
                          <li key={service.name} className="flex justify-between gap-3">
                            <span>{service.name}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {formatPHP(service.price)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </SummaryBlock>
                  </section>
                  <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                    <Info className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    Your personal details, motorcycle, and services stay the same. Only the date and
                    time change.
                  </p>

                  {supportsSlideTransition && rescheduleForm}
                </div>
              </div>
            </CardContent>

            <AlertDialog open={rescheduleReviewOpen} onOpenChange={setRescheduleReviewOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Submit reschedule request?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The shop will review your request before anything changes. Your current
                    appointment stays reserved until then, and a new reference code will be reserved
                    for the new schedule.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <dl className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Current</dt>
                    <dd className="text-right">
                      {formatDateLong(appt.date)}, {formatTime(appt.startTime)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Requested</dt>
                    <dd className="text-right font-medium">
                      {newDate ? formatDateLong(newDate) : "Date not selected"}
                      {newStartTime ? `, ${formatTime(newStartTime)}` : ""}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Reason</dt>
                    <dd className="text-right break-words">
                      {rescheduleReason.trim() || "Not provided"}
                    </dd>
                  </div>
                </dl>
                <AlertDialogFooter>
                  <AlertDialogCancel>Go back and edit</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={
                      rescheduleMutation.isPending ||
                      (turnstileEnabled && !rescheduleTurnstileToken)
                    }
                    onClick={submitRescheduleRequest}
                  >
                    {rescheduleMutation.isPending && <Loader2 className="animate-spin" />}
                    Submit reschedule request
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {appt.emailHint && (
              <AppointmentVerificationDialog
                open={verificationRequest !== null}
                action={verificationRequest?.action ?? "cancel"}
                reference={appt.reference}
                emailHint={appt.emailHint}
                schedule={`${formatDateLong(appt.date)} at ${formatTime(appt.startTime)}`}
                notice={verificationRequest?.notice ?? null}
                onOpenChange={(open) => {
                  if (!open) setVerificationRequest(null);
                }}
                onVerified={(verification) =>
                  handleVerified(verificationRequest?.action ?? "cancel", verification)
                }
              />
            )}
          </Card>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

function appointmentStatusHint(status: string) {
  switch (status) {
    case "pending":
      return "Waiting for the shop to confirm your request.";
    case "confirmed":
      return "Your appointment is confirmed. Please arrive 10–15 minutes early.";
    case "in_progress":
      return "Your motorcycle is currently being serviced.";
    case "completed":
      return "This service has been completed.";
    case "cancelled":
      return "This appointment has been cancelled.";
    default:
      return null;
  }
}

function RescheduleHeading({ reference }: { reference: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs tracking-[0.3em] text-accent uppercase">Reschedule appointment</p>
        <h2 className="mt-1 font-display text-2xl uppercase">Choose a new schedule</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your current appointment stays reserved until the shop approves this request.
        </p>
      </div>
      <Badge variant="outline" className="border-primary/40 bg-primary/5 text-primary uppercase">
        From {reference}
      </Badge>
    </div>
  );
}

function SummaryBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] tracking-wider text-muted-foreground uppercase">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "info" | "accent" | "destructive";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "destructive" ? "status" : undefined}
      className={cn(
        "rounded-lg border p-3 text-sm text-muted-foreground",
        tone === "info" && "border-primary/30 bg-primary/5",
        tone === "accent" && "border-accent/30 bg-accent/5",
        tone === "destructive" && "border-destructive/40 bg-destructive/5",
      )}
    >
      {title && (
        <p
          className={cn(
            "mb-1 font-medium",
            tone === "destructive" ? "text-destructive" : "text-foreground",
          )}
        >
          {title}
        </p>
      )}
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-widest text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{value}</dd>
    </div>
  );
}
