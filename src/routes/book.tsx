import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Copy, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { z } from "zod";

import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { TurnstileChallenge } from "@/components/site/turnstile-challenge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import {
  type Availability,
  computeAvailableDates,
  computeAvailableSlots,
  computeFullyBookedDates,
} from "@/lib/availability";
import { createBooking, getAvailability, getRescheduleDetails } from "@/lib/booking.functions";
import {
  DEFAULT_BOOKING_TERMS,
  DEFAULT_BOOKING_HOURS,
  PHONE_VALIDATION_MESSAGE,
  SHOP,
  MAX_BOOKING_SERVICE_SELECTIONS,
  bookingDurationOverflowMinutes,
  formatDateLong,
  formatPHP,
  formatTime,
  normalizePhilippineMobile,
  sanitizePhilippineMobileInput,
} from "@/lib/shop";
import { cn } from "@/lib/utils";

const searchSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .optional(),
  serviceId: z.string().uuid().optional(),
  reschedule: z
    .string()
    .regex(/^FRM-[A-Z0-9]{6}$/)
    .optional(),
  phone: z
    .string()
    .trim()
    .refine(
      (value) => normalizePhilippineMobile(value) !== null,
      "Enter a valid Philippine mobile number.",
    )
    .transform((value) => normalizePhilippineMobile(value)!)
    .optional(),
});

const turnstileEnabled = Boolean(import.meta.env["VITE_TURNSTILE_SITE_KEY"]);
const MOBILE_BOOKING_STEPS = [
  "Personal information",
  "Motorcycle details",
  "Service selection",
  "Date & time",
  "Review",
] as const;

export const Route = createFileRoute("/book")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Book a Service Appointment | Fake Rider Motorparts" },
      {
        name: "description",
        content:
          "Reserve your motorcycle service slot online. Choose your services and schedule a convenient time, then save your reference code.",
      },
      { property: "og:title", content: "Book a Service Appointment | Fake Rider" },
      {
        property: "og:description",
        content: "Reserve your motorcycle service slot online in a few minutes.",
      },
    ],
  }),
  component: BookPage,
});

type Errors = Partial<{
  firstName: string;
  middleName: string;
  lastName: string;
  phone: string;
  motoBrand: string;
  motoModel: string;
  plateNumber: string;
  services: string;
  date: string;
  startTime: string;
  schedule: string;
  terms: string;
  rescheduleReason: string;
}>;

const validationFieldOrder: (keyof Errors)[] = [
  "lastName",
  "firstName",
  "middleName",
  "phone",
  "motoBrand",
  "motoModel",
  "plateNumber",
  "services",
  "rescheduleReason",
  "date",
  "startTime",
  "schedule",
  "terms",
];

const validationFocusTargets: Partial<Record<keyof Errors, string>> = {
  firstName: "#booking-first-name",
  middleName: "#booking-middle-name",
  lastName: "#booking-last-name",
  phone: "#booking-phone",
  motoBrand: "#booking-moto-brand",
  motoModel: "#booking-moto-model",
  plateNumber: "#booking-plate-number",
  services: "#booking-services",
  rescheduleReason: "#reschedule-reason",
  date: "#booking-date button[data-day]:not([disabled])",
  startTime: "#booking-start-time button:not([disabled])",
  schedule: "#booking-schedule",
  terms: "#booking-terms",
};

const validationSteps: Partial<Record<keyof Errors, number>> = {
  firstName: 1,
  middleName: 1,
  lastName: 1,
  phone: 1,
  motoBrand: 2,
  motoModel: 2,
  plateNumber: 2,
  services: 3,
  rescheduleReason: 4,
  date: 4,
  startTime: 4,
  schedule: 4,
  terms: 5,
};

function isDuplicateBookingMessage(message: string) {
  return /you already have an appointment for/i.test(message);
}

function BookPage() {
  const book = useServerFn(createBooking);
  const availabilityFn = useServerFn(getAvailability);
  const rescheduleDetailsFn = useServerFn(getRescheduleDetails);
  const search = useSearch({ from: "/book" });

  const [form, setForm] = useState({
    firstName: "",
    middleName: "",
    lastName: "",
    phone: "",
    motoBrand: "",
    motoModel: "",
    motoVariant: "",
    motoYear: String(new Date().getFullYear()),
    plateNumber: "",
    notes: "",
  });
  const [serviceIds, setServiceIds] = useState<string[]>(
    search.serviceId ? [search.serviceId] : [],
  );
  const [serviceCategory, setServiceCategory] = useState("all");
  const [date, setDate] = useState<string>(search.date ?? "");
  const [startTime, setStartTime] = useState<string>(search.startTime ?? "");
  const [terms, setTerms] = useState(false);
  const [mobileStep, setMobileStep] = useState(1);
  const [errors, setErrors] = useState<Errors>({});
  const [focusRequest, setFocusRequest] = useState<keyof Errors | null>(null);
  const [bookingConfirmationOpen, setBookingConfirmationOpen] = useState(false);
  const [multiDayContinuationOpen, setMultiDayContinuationOpen] = useState(false);
  const [multiDayContinuationAccepted, setMultiDayContinuationAccepted] = useState(false);
  const [multiDayConfirmationStep, setMultiDayConfirmationStep] = useState<number | null>(null);
  const [duplicateBookingMessage, setDuplicateBookingMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{
    reference: string;
    total: number;
    date: string;
    startTime: string;
    continuationSegments?: Array<{ date: string; startTime: string; durationMinutes: number }>;
  } | null>(null);
  const [referenceCopyStatus, setReferenceCopyStatus] = useState<"copied" | "error" | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [bookingRequestId, setBookingRequestId] = useState(() => crypto.randomUUID());
  const isReschedule = Boolean(search.reschedule && search.phone);
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [reschedulePrefillReady, setReschedulePrefillReady] = useState(!isReschedule);

  const rescheduleDetails = useQuery({
    queryKey: ["reschedule-details", search.reschedule, search.phone],
    queryFn: async () => {
      if (!search.reschedule || !search.phone) {
        throw new Error("Missing reschedule appointment details.");
      }
      return rescheduleDetailsFn({
        data: { reference: search.reschedule, phone: search.phone },
      });
    },
    enabled: isReschedule,
    retry: false,
  });

  const rescheduleError =
    rescheduleDetails.data && !rescheduleDetails.data.ok
      ? rescheduleDetails.data.error
      : rescheduleDetails.isError
        ? "We could not load your original appointment. Please return to the Appointment Tracker and try again."
        : null;
  const rescheduleReady =
    !isReschedule || (rescheduleDetails.data?.ok === true && reschedulePrefillReady);

  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("*")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("sort_order");
      if (error) throw error;
      return Array.from(new Map((data ?? []).map((s) => [s.name.trim(), s])).values());
    },
  });

  const shopSettings = useQuery({
    queryKey: ["public-shop-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shop_settings")
        .select("booking_terms,opening_time,closing_time")
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!isReschedule || !rescheduleDetails.data?.ok) return;
    const appointment = rescheduleDetails.data.appointment;
    setForm({
      firstName: appointment.firstName,
      middleName: appointment.middleName,
      lastName: appointment.lastName,
      phone: appointment.phone,
      motoBrand: appointment.motoBrand,
      motoModel: appointment.motoModel,
      motoVariant: appointment.motoVariant,
      motoYear: appointment.motoYear,
      plateNumber: appointment.plateNumber,
      notes: appointment.notes,
    });
    setServiceIds(appointment.serviceIds);
    setServiceCategory("all");
    setDate("");
    setStartTime("");
    setMobileStep(4);
    setReschedulePrefillReady(true);
  }, [isReschedule, rescheduleDetails.data]);

  const motorcycleCatalog = useQuery({
    queryKey: ["motorcycle-catalog"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("motorcycle_catalog")
        .select("brand,model")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("brand")
        .order("model");
      if (error) throw error;
      return Array.from(
        new Map((data ?? []).map((m) => [`${m.brand ?? ""}:${m.model.trim()}`, m])).values(),
      );
    },
  });

  const bookableMotorcycles = useMemo(
    () =>
      (motorcycleCatalog.data ?? []).filter((motorcycle) => {
        return motorcycle.brand && motorcycle.model;
      }),
    [motorcycleCatalog.data],
  );

  const brands = useMemo(() => {
    const set = new Set<string>();
    bookableMotorcycles.forEach((p) => p.brand && set.add(p.brand));
    return Array.from(set).sort();
  }, [bookableMotorcycles]);

  const catalogUnavailable =
    motorcycleCatalog.isError || (!motorcycleCatalog.isLoading && brands.length === 0);

  const modelsForBrand = useMemo(() => {
    const seen = new Set<string>();
    const list = bookableMotorcycles.filter((p) => p.brand === form.motoBrand);
    return list
      .filter((p) => {
        if (seen.has(p.model)) return false;
        seen.add(p.model);
        return true;
      })
      .map((p) => ({
        value: p.model,
        label: p.model.replace(new RegExp(`^${p.brand} `), ""),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [bookableMotorcycles, form.motoBrand]);

  const motorcycleSelectionReady = Boolean(form.motoBrand && form.motoModel);

  const availability = useQuery<Availability>({
    queryKey: [
      "availability",
      serviceIds,
      form.motoBrand,
      form.motoModel,
      isReschedule,
      serviceIds.length > 1,
    ],
    queryFn: () =>
      availabilityFn({
        data: {
          days: 45,
          serviceIds,
          rescheduling: isReschedule,
          allowMultiDayContinuation: !isReschedule && serviceIds.length > 1,
          motorcycle: { brand: form.motoBrand, model: form.motoModel },
          ...(isReschedule
            ? { rescheduleReference: search.reschedule, reschedulePhone: search.phone }
            : {}),
        },
      }),
    enabled: serviceIds.length > 0 && motorcycleSelectionReady,
  });

  const dates = useMemo(
    () => (availability.data ? computeAvailableDates(availability.data) : []),
    [availability.data],
  );

  const slots = useMemo(
    () => (availability.data && date ? computeAvailableSlots(availability.data, date) : []),
    [availability.data, date],
  );
  const availableSlots = useMemo(() => slots.filter((slot) => !slot.disabled), [slots]);

  const availableDateSet = useMemo(() => new Set(dates), [dates]);
  const fullyBookedDates = useMemo(
    () => (availability.data ? computeFullyBookedDates(availability.data) : []),
    [availability.data],
  );

  const selectedDate = date ? parseISO(date) : undefined;
  const availabilityError = availability.data?.error;

  const selectedServices = (services.data ?? []).filter((s) => serviceIds.includes(s.id));
  const serviceCategories = useMemo(
    () =>
      Array.from(
        new Set((services.data ?? []).map((service) => service.category).filter(Boolean)),
      ).sort(),
    [services.data],
  );
  const filteredServices = (services.data ?? []).filter(
    (service) => serviceCategory === "all" || service.category === serviceCategory,
  );
  const serviceEstimates =
    availability.data?.serviceEstimates ??
    selectedServices.map((service) => ({
      id: service.id,
      name: service.name,
      price: Number(service.price),
      durationMinutes: service.duration_minutes ?? 60,
      pricingSource: "default" as const,
    }));
  const estimatedServices = serviceIds
    .map((serviceId) => serviceEstimates.find((service) => service.id === serviceId))
    .filter((service): service is NonNullable<typeof service> => Boolean(service));
  const total = estimatedServices.reduce((sum, service) => sum + service.price, 0);
  const customerFullName = [form.firstName, form.middleName, form.lastName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  const totalDuration = estimatedServices.reduce(
    (sum, service) => sum + service.durationMinutes,
    estimatedServices.length > 0 ? 30 : 0,
  );
  const operatingHours =
    availability.data?.operatingHours ??
    (shopSettings.data
      ? {
          openingTime: shopSettings.data.opening_time
            ? String(shopSettings.data.opening_time).slice(0, 5)
            : DEFAULT_BOOKING_HOURS.openingTime,
          closingTime: shopSettings.data.closing_time
            ? String(shopSettings.data.closing_time).slice(0, 5)
            : DEFAULT_BOOKING_HOURS.closingTime,
        }
      : DEFAULT_BOOKING_HOURS);
  const serviceStepOverflowMinutes =
    !isReschedule && serviceIds.length > 1
      ? bookingDurationOverflowMinutes(operatingHours.openingTime, totalDuration, operatingHours)
      : 0;
  const needsServiceStepMultiDayConfirmation = serviceStepOverflowMinutes > 30;
  const multiDayOverflowMinutes =
    !isReschedule && date && startTime && serviceIds.length > 1
      ? bookingDurationOverflowMinutes(startTime, totalDuration, operatingHours)
      : 0;
  const needsMultiDayContinuationConfirmation = multiDayOverflowMinutes > 30;
  const bookingTerms = shopSettings.data?.booking_terms || DEFAULT_BOOKING_TERMS;

  useEffect(() => {
    if (!focusRequest) return;

    const target = validationFocusTargets[focusRequest];
    if (!target) return;

    // Let React reveal the appropriate mobile step before trying to focus its input.
    const timer = window.setTimeout(() => {
      const element = document.querySelector<HTMLElement>(target);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.focus({ preventScroll: true });
      setFocusRequest(null);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [focusRequest, mobileStep]);

  useEffect(() => {
    if (!availability.data || !date) return;

    if (!availableDateSet.has(date)) {
      setDate("");
      setStartTime("");
      return;
    }

    if (startTime) {
      const selectedSlot = computeAvailableSlots(availability.data, date).find(
        (slot) => slot.startTime === startTime,
      );
      if (!selectedSlot || selectedSlot.disabled) setStartTime("");
    }
  }, [availability.data, availableDateSet, date, startTime]);

  const mutation = useMutation({
    mutationFn: async () => {
      const submittedSchedule = { date, startTime };
      const res = await book({
        data: {
          firstName: form.firstName.trim(),
          middleName: form.middleName.trim(),
          lastName: form.lastName.trim(),
          phone: form.phone.trim(),
          motoBrand: form.motoBrand.trim(),
          motoModel: form.motoModel.trim(),
          motoVariant: form.motoVariant.trim(),
          motoYear: Number(form.motoYear),
          plateNumber: form.plateNumber.trim(),
          serviceIds,
          date,
          startTime,
          notes: form.notes.trim(),
          turnstileToken,
          idempotencyKey: bookingRequestId,
          termsAccepted: true as const,
          multiDayContinuationAccepted,
          ...(isReschedule ? { rescheduleReference: search.reschedule } : {}),
          ...(isReschedule ? { rescheduleReason: rescheduleReason.trim() } : {}),
        },
      });
      return { res, submittedSchedule };
    },
    onSuccess: ({ res, submittedSchedule }) => {
      if (!res.ok) {
        if (!isReschedule && isDuplicateBookingMessage(res.error)) {
          setBookingConfirmationOpen(false);
          setDuplicateBookingMessage(res.error);
          setErrors(({ schedule: _, ...current }) => current);
          setDate("");
          setStartTime("");
          setTurnstileToken("");
          setBookingRequestId(crypto.randomUUID());
          availability.refetch();
          return;
        }
        setErrors((current) => ({ ...current, schedule: res.error }));
        setTurnstileToken("");
        setBookingRequestId(crypto.randomUUID());
        availability.refetch();
        return;
      }
      setResult(
        "continuationSegments" in res
          ? {
              reference: res.reference,
              total: res.total,
              date: submittedSchedule.date,
              startTime: submittedSchedule.startTime,
              continuationSegments: res.continuationSegments,
            }
          : {
              reference: res.reference,
              total: res.total,
              date: submittedSchedule.date,
              startTime: submittedSchedule.startTime,
            },
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (err: Error) => {
      if (!isReschedule && isDuplicateBookingMessage(err.message)) {
        setBookingConfirmationOpen(false);
        setDuplicateBookingMessage(err.message);
        setErrors(({ schedule: _, ...current }) => current);
        setDate("");
        setStartTime("");
        return;
      }
      const msg = err.message.toLowerCase();
      let scheduleError: string;
      if (msg.includes("network") || msg.includes("fetch") || msg.includes("connect")) {
        scheduleError = "Network error. Please check your connection and try again.";
      } else if (msg.includes("timeout")) {
        scheduleError = "The request timed out. Please try again.";
      } else if (msg.includes("validation") || msg.includes("invalid")) {
        scheduleError = "Some fields have invalid values. Please review the form.";
      } else {
        scheduleError =
          "We could not submit your booking. Please review your details and try again.";
      }
      setErrors((current) => ({ ...current, schedule: scheduleError }));
      availability.refetch();
    },
  });

  function validationErrors(steps: number[]) {
    const e: Errors = {};
    if (isReschedule && !rescheduleReady) {
      e.schedule = rescheduleError ?? "Loading the original appointment details.";
      return e;
    }
    if (steps.includes(1)) {
      if (form.lastName.trim().length < 2) e.lastName = "Enter your last name.";
      if (form.firstName.trim().length < 2) e.firstName = "Enter your first name.";
      if (!normalizePhilippineMobile(form.phone)) e.phone = PHONE_VALIDATION_MESSAGE;
    }
    if (steps.includes(2)) {
      if (!form.motoBrand.trim()) e.motoBrand = "Required";
      if (!form.motoModel.trim()) e.motoModel = "Required";
      if (!isReschedule && catalogUnavailable) {
        e.motoBrand = "The motorcycle catalog is unavailable. Please try again shortly.";
      }
      if (
        !isReschedule &&
        !catalogUnavailable &&
        form.motoBrand &&
        !brands.includes(form.motoBrand)
      ) {
        e.motoBrand = "Select a brand from the motorcycle catalog.";
      }
      if (
        !isReschedule &&
        !catalogUnavailable &&
        form.motoModel &&
        !modelsForBrand.some((model) => model.value === form.motoModel)
      ) {
        e.motoModel = "Select a model from the motorcycle catalog.";
      }
      if (form.plateNumber.trim().length < 2) e.plateNumber = "Required";
    }
    if (steps.includes(3) && serviceIds.length === 0) e.services = "Select at least one service.";
    if (steps.includes(3) && serviceIds.length > MAX_BOOKING_SERVICE_SELECTIONS) {
      e.services = `Select up to ${MAX_BOOKING_SERVICE_SELECTIONS} services per appointment.`;
    }
    if (steps.includes(4) && !date) e.date = "Select your preferred date.";
    if (steps.includes(4) && date && !startTime) e.startTime = "Select your preferred time.";
    if (steps.includes(4) && isReschedule && !rescheduleReason.trim()) {
      e.rescheduleReason = "Tell us why you need to reschedule.";
    }
    if (steps.includes(5) && !terms) e.terms = "You must accept the terms and conditions.";
    return e;
  }

  function validate() {
    const e = validationErrors([1, 2, 3, 4, 5]);
    return showValidationErrors(e);
  }

  function showValidationErrors(e: Errors) {
    setErrors(e);
    const firstInvalidField = validationFieldOrder.find((field) => e[field]);
    if (!firstInvalidField) return true;

    setMobileStep(validationSteps[firstInvalidField] ?? 1);
    setFocusRequest(firstInvalidField);
    return false;
  }

  function continueMobileBooking() {
    const e = validationErrors([mobileStep]);
    if (!showValidationErrors(e)) return;
    const requiresMultiDayConfirmation =
      (mobileStep === 3 && needsServiceStepMultiDayConfirmation) ||
      (mobileStep === 4 && needsMultiDayContinuationConfirmation);
    if (requiresMultiDayConfirmation && !multiDayContinuationAccepted) {
      setMultiDayConfirmationStep(mobileStep);
      setMultiDayContinuationOpen(true);
      return;
    }
    setMobileStep((step) => Math.min(step + 1, 5));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function continueWithMultiDayBooking() {
    setMultiDayContinuationAccepted(true);
    setMultiDayContinuationOpen(false);
    setMobileStep((multiDayConfirmationStep ?? mobileStep) + 1);
    setMultiDayConfirmationStep(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goBackMobileBooking() {
    setErrors({});
    setMobileStep((step) => Math.max(step - 1, 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function submitBooking() {
    if (!rescheduleReady || !validate()) return;
    if (isReschedule) {
      mutation.mutate();
      return;
    }
    setBookingConfirmationOpen(true);
  }

  function confirmBooking() {
    if (!validate()) {
      setBookingConfirmationOpen(false);
      return;
    }
    setBookingConfirmationOpen(false);
    mutation.mutate();
  }

  function dismissDuplicateBookingDialog() {
    setDuplicateBookingMessage(null);
  }

  if (result) {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <main className="mx-auto w-full max-w-2xl px-4 py-16">
          <Card className="border-primary/40 bg-card/70">
            <CardContent className="p-8 text-center">
              <CheckCircle2 className="mx-auto h-14 w-14 text-primary" />
              <h1 className="mt-4 font-display text-3xl uppercase">
                {isReschedule ? "Reschedule request sent" : "Appointment Requested"}
              </h1>
              <p className="mt-2 text-muted-foreground">
                {isReschedule
                  ? "Your original appointment remains reserved while the shop reviews your requested new date and time."
                  : "Save your reference code. You will need it, together with your mobile number, to view or cancel your booking."}
              </p>
              <div className="mt-6 rounded-xl border border-dashed border-primary/50 bg-primary/5 p-6">
                <p className="text-xs tracking-[0.3em] text-muted-foreground uppercase">
                  Reference code
                </p>
                <p className="font-display text-4xl font-bold tracking-widest text-primary">
                  {result.reference}
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(result.reference);
                      setReferenceCopyStatus("copied");
                    } catch {
                      setReferenceCopyStatus("error");
                    }
                  }}
                >
                  <Copy /> {referenceCopyStatus === "copied" ? "Copied" : "Copy code"}
                </Button>
                {referenceCopyStatus === "error" && (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    Could not copy the code automatically. Please copy it manually.
                  </p>
                )}
              </div>
              <div className="mt-6 space-y-1 text-sm text-muted-foreground">
                <p>
                  {formatDateLong(result.date)} at {formatTime(result.startTime)}
                </p>
                <p>Estimated total: {formatPHP(result.total)}</p>
                <p>Status: pending confirmation by the shop</p>
                <p>The shop will review your request and confirm your appointment.</p>
                {(result.continuationSegments?.length ?? 0) > 0 && (
                  <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-left">
                    <p className="font-medium text-foreground">Continued service schedule</p>
                    <ul className="mt-2 space-y-1 text-xs">
                      {result.continuationSegments?.map((segment) => (
                        <li key={`${segment.date}-${segment.startTime}`}>
                          {formatDateLong(segment.date)} at {formatTime(segment.startTime)} (
                          {segment.durationMinutes} min)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div className="mt-7 flex flex-wrap justify-center gap-3">
                <Button asChild className="font-display uppercase">
                  <Link to="/my-appointment">View my appointment</Link>
                </Button>
                <Button asChild variant="outline" className="font-display uppercase">
                  <Link to="/">Back to home</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </main>
        <SiteFooter />
      </div>
    );
  }

  if (isReschedule && (rescheduleDetails.isLoading || rescheduleError || !reschedulePrefillReady)) {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <main className="mx-auto w-full max-w-2xl px-4 py-16">
          <Card className="border-border/70 bg-card/60">
            <CardContent className="p-8 text-center">
              {rescheduleDetails.isLoading ? (
                <>
                  <Loader2 className="mx-auto size-8 animate-spin text-primary" />
                  <h1 className="mt-4 font-display text-2xl uppercase">Loading appointment</h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Preparing your saved details and selected services for rescheduling.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="font-display text-2xl uppercase">Unable to reschedule online</h1>
                  <p className="mt-2 text-sm text-destructive">{rescheduleError}</p>
                  <Button asChild variant="outline" className="mt-6">
                    <Link to="/my-appointment">Back to Appointment Tracker</Link>
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </main>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-12">
        <p className="text-xs tracking-[0.3em] text-accent uppercase">
          {isReschedule ? "Reschedule appointment" : "Booking"}
        </p>
        <h1 className="font-display text-3xl font-bold uppercase sm:text-4xl md:text-5xl">
          {isReschedule ? "Choose a new service slot" : "Reserve your service slot"}
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          {isReschedule
            ? "Your saved appointment details are retained. Enter a reason and choose a new available date and time; your original slot stays reserved until the shop confirms."
            : "Schedule your motorcycle service online and secure an available appointment slot in advance."}
        </p>

        <div className="sticky top-20 z-20 -mx-4 mt-6 border-y border-border/70 bg-background/95 px-4 py-3 backdrop-blur">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Step {mobileStep} of 5</span>
            <span>{MOBILE_BOOKING_STEPS[mobileStep - 1]}</span>
          </div>
          <ol className="mt-3 grid grid-cols-5 gap-1.5 sm:gap-2" aria-label="Booking progress">
            {MOBILE_BOOKING_STEPS.map((step, index) => {
              const stepNumber = index + 1;
              const complete = stepNumber < mobileStep;
              const current = stepNumber === mobileStep;
              return (
                <li key={step} className="min-w-0">
                  <span
                    className={cn(
                      "flex h-8 w-full items-center justify-center rounded-full border text-xs font-medium sm:h-9",
                      complete && "border-primary bg-primary text-primary-foreground",
                      current && "border-primary text-primary",
                      !complete && !current && "border-border text-muted-foreground",
                    )}
                    aria-current={current ? "step" : undefined}
                    title={step}
                  >
                    {complete ? "✓" : stepNumber}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${((mobileStep - 1) / 5) * 100}%` }}
            />
          </div>
        </div>

        <form
          className="mt-10 space-y-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (mobileStep === 5) submitBooking();
            else continueMobileBooking();
          }}
        >
          <Section title="1. Personal information" className={cn(mobileStep !== 1 && "hidden")}>
            {isReschedule && (
              <p className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-muted-foreground">
                These details are verified against your original appointment when you submit.
              </p>
            )}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Field label="Last Name" error={errors.lastName}>
                <Input
                  id="booking-last-name"
                  value={form.lastName}
                  maxLength={40}
                  disabled={isReschedule}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      lastName: e.target.value.replace(/[^a-zA-Z\s]/g, ""),
                    })
                  }
                  placeholder="Dela Cruz"
                />
              </Field>
              <Field label="First Name" error={errors.firstName}>
                <Input
                  id="booking-first-name"
                  value={form.firstName}
                  maxLength={40}
                  disabled={isReschedule}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      firstName: e.target.value.replace(/[^a-zA-Z\s]/g, ""),
                    })
                  }
                  placeholder="Juan"
                />
              </Field>
              <Field label="Middle Name (Optional)" error={errors.middleName}>
                <Input
                  id="booking-middle-name"
                  value={form.middleName}
                  maxLength={40}
                  disabled={isReschedule}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      middleName: e.target.value.replace(/[^a-zA-Z\s]/g, ""),
                    })
                  }
                  placeholder="Santos"
                />
              </Field>
              <Field label="Mobile number" error={errors.phone}>
                <Input
                  id="booking-phone"
                  type="tel"
                  value={form.phone}
                  maxLength={11}
                  inputMode="tel"
                  autoComplete="tel"
                  disabled={isReschedule}
                  onChange={(e) => {
                    setForm({ ...form, phone: sanitizePhilippineMobileInput(e.target.value) });
                  }}
                  placeholder="09171234567"
                />
              </Field>
            </div>
            <WizardActions onContinue={continueMobileBooking} />
          </Section>

          <Section title="2. Motorcycle details" className={cn(mobileStep !== 2 && "hidden")}>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div className="md:col-span-2 lg:col-span-3">
                <p className="text-sm text-muted-foreground">
                  Select your motorcycle from the catalog. Choose a brand first to see its valid
                  models.
                </p>
                {catalogUnavailable && (
                  <p className="mt-1 text-sm text-destructive">
                    The motorcycle catalog is unavailable. Please try again shortly.
                  </p>
                )}
              </div>

              <Field label="Brand" error={errors.motoBrand}>
                <Select
                  value={form.motoBrand}
                  onValueChange={(v) => {
                    setForm({ ...form, motoBrand: v, motoModel: "" });
                    setDate("");
                    setStartTime("");
                  }}
                  disabled={isReschedule || motorcycleCatalog.isLoading || catalogUnavailable}
                >
                  <SelectTrigger id="booking-moto-brand">
                    <SelectValue placeholder="Select a brand" />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model" error={errors.motoModel}>
                <Select
                  value={form.motoModel}
                  onValueChange={(v) => {
                    setForm({ ...form, motoModel: v });
                    setDate("");
                    setStartTime("");
                  }}
                  disabled={
                    isReschedule ||
                    catalogUnavailable ||
                    !form.motoBrand ||
                    modelsForBrand.length === 0
                  }
                >
                  <SelectTrigger id="booking-moto-model">
                    <SelectValue
                      placeholder={form.motoBrand ? "Select a model" : "Select a brand first"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {modelsForBrand.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Plate number" error={errors.plateNumber}>
                <Input
                  id="booking-plate-number"
                  value={form.plateNumber}
                  maxLength={20}
                  disabled={isReschedule}
                  onChange={(e) => setForm({ ...form, plateNumber: e.target.value.toUpperCase() })}
                  placeholder="ABC 1234"
                />
              </Field>
            </div>
            <WizardActions onBack={goBackMobileBooking} onContinue={continueMobileBooking} />
          </Section>

          <Section
            title="3. Service selection"
            error={errors.services}
            className={cn(mobileStep !== 3 && "hidden")}
          >
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Label htmlFor="booking-service-category">Service category</Label>
              <Select
                value={serviceCategory}
                onValueChange={setServiceCategory}
                disabled={isReschedule}
              >
                <SelectTrigger id="booking-service-category" className="w-full sm:w-52">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent position="item-aligned" className="max-h-64">
                  <SelectItem value="all">All categories</SelectItem>
                  {serviceCategories.map((category) => (
                    <SelectItem key={category} value={category} className="capitalize">
                      {category.replace(/[-_]/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div
              id="booking-services"
              tabIndex={-1}
              className={cn(
                "grid gap-3 rounded-lg md:grid-cols-2",
                errors.services && "ring-1 ring-destructive",
              )}
            >
              {filteredServices.map((s) => {
                const checked = serviceIds.includes(s.id);
                return (
                  <button
                    type="button"
                    key={s.id}
                    disabled={isReschedule}
                    onClick={() => {
                      if (!checked && serviceIds.length >= MAX_BOOKING_SERVICE_SELECTIONS) {
                        setErrors((current) => ({
                          ...current,
                          services: `You can select up to ${MAX_BOOKING_SERVICE_SELECTIONS} services per appointment.`,
                        }));
                        return;
                      }
                      setServiceIds((prev) =>
                        checked ? prev.filter((id) => id !== s.id) : [...prev, s.id],
                      );
                      setErrors((current) => ({ ...current, services: undefined }));
                      setDate("");
                      setStartTime("");
                      setMultiDayContinuationAccepted(false);
                    }}
                    className={cn(
                      "flex items-center rounded-lg border p-4 text-left transition-colors",
                      checked
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card/50 hover:border-primary/50",
                      isReschedule && "cursor-not-allowed opacity-75",
                    )}
                  >
                    <span className="font-display block tracking-wide uppercase">{s.name}</span>
                  </button>
                );
              })}
            </div>
            {filteredServices.length === 0 && (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                No services are available in this category.
              </p>
            )}
            <p className="mt-3 text-sm text-muted-foreground">
              Not sure which service to choose?{" "}
              <Link
                to="/services"
                className="font-medium text-primary underline underline-offset-4"
              >
                Browse our services
              </Link>{" "}
              for details to understand what each service includes.
            </p>
            <WizardActions onBack={goBackMobileBooking} onContinue={continueMobileBooking} />
          </Section>

          <Section
            title="4. Date and time selection"
            error={errors.schedule}
            className={cn(mobileStep !== 4 && "hidden")}
          >
            {serviceIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Select a service first to view available dates and time slots.
              </p>
            ) : availability.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading available schedules...</p>
            ) : availability.isError || availabilityError ? (
              <p className="text-sm text-destructive">
                {availabilityError ??
                  "We could not load availability. Please refresh and try again."}
              </p>
            ) : (
              <>
                {isReschedule && (
                  <div className="mb-5">
                    <Label htmlFor="reschedule-reason">Reason for Rescheduling</Label>
                    <Textarea
                      id="reschedule-reason"
                      value={rescheduleReason}
                      maxLength={500}
                      onChange={(event) => setRescheduleReason(event.target.value)}
                      placeholder="Tell the shop why you need a different schedule."
                      aria-invalid={Boolean(errors.rescheduleReason)}
                      className="mt-2"
                    />
                    <FieldError message={errors.rescheduleReason} className="mt-1" />
                  </div>
                )}
                <p className="mb-2 text-sm text-muted-foreground">
                  Available dates have an assigned mechanic, an open shop schedule, and enough time
                  for your selected services. Other dates cannot be selected.
                </p>

                <div
                  id="booking-schedule"
                  tabIndex={-1}
                  className={cn(
                    "w-full rounded-xl border border-border bg-card/50 p-4 sm:p-5",
                    (errors.date || errors.startTime || errors.schedule) && "border-destructive",
                  )}
                >
                  <div className="grid gap-6 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.7fr)] lg:gap-8">
                    <div className="border-b border-border/70 pb-5 lg:border-r lg:border-b-0 lg:pr-8 lg:pb-0">
                      <div
                        id="booking-date"
                        tabIndex={-1}
                        className="flex justify-center lg:justify-start"
                      >
                        <Calendar
                          mode="single"
                          selected={selectedDate}
                          onSelect={(d) => {
                            if (!d) return;
                            const iso = format(d, "yyyy-MM-dd");
                            setDate(iso);
                            setStartTime("");
                          }}
                          disabled={(d) => !availableDateSet.has(format(d, "yyyy-MM-dd"))}
                          modifiers={{
                            fullyBooked: fullyBookedDates.map((value) => parseISO(value)),
                          }}
                          modifiersClassNames={{
                            fullyBooked:
                              "bg-destructive/15 text-destructive line-through opacity-100",
                          }}
                          className="p-0 min-[360px]:p-3"
                          classNames={{
                            nav: "justify-between gap-1",
                            month_caption:
                              "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
                          }}
                        />
                      </div>
                      {fullyBookedDates.length > 0 && (
                        <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground lg:justify-start">
                          <span className="h-3 w-3 rounded-sm bg-destructive/15 ring-1 ring-destructive/40" />
                          Fully booked dates cannot be selected.
                        </p>
                      )}
                    </div>

                    <div id="booking-start-time" tabIndex={-1}>
                      <h3 className="font-display text-lg uppercase">Available time slots</h3>
                      <p className="mt-1 mb-4 text-sm text-muted-foreground">
                        {date
                          ? formatDateLong(date)
                          : "Choose a calendar date to view available times."}
                      </p>
                      {date ? (
                        <div
                          className={cn(
                            "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4",
                            (errors.startTime || errors.schedule) &&
                              "rounded-lg ring-1 ring-destructive",
                          )}
                        >
                          {availableSlots.map((slot) => (
                            <button
                              type="button"
                              key={slot.id}
                              disabled={slot.disabled}
                              onClick={() => {
                                setStartTime(slot.startTime);
                              }}
                              className={cn(
                                "rounded-lg border p-3 text-center transition-colors",
                                slot.disabled && "cursor-not-allowed opacity-40",
                                startTime === slot.startTime
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border bg-card/50 hover:border-primary/50",
                              )}
                            >
                              <span className="font-display block">
                                {formatTime(slot.startTime)}
                              </span>
                              <span
                                className={cn(
                                  "block text-[11px] text-muted-foreground",
                                  startTime === slot.startTime && "text-primary-foreground/80",
                                )}
                              >
                                Available
                              </span>
                            </button>
                          ))}
                          {availableSlots.length === 0 && (
                            <p className="col-span-full rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                              No times remain available for this date. Select another available
                              date.
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                          Time slots will appear here after you choose a date.
                        </div>
                      )}
                      {date && startTime && (
                        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                          <p className="text-xs tracking-widest text-muted-foreground uppercase">
                            Selected schedule
                          </p>
                          <p className="mt-1 font-medium text-foreground">
                            {formatDateLong(date)} at {formatTime(startTime)}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <FieldError message={errors.date} className="mt-2" />
                <FieldError message={errors.startTime} className="mt-2" />
              </>
            )}
            <WizardActions onBack={goBackMobileBooking} onContinue={continueMobileBooking} />
          </Section>

          <Section
            title="5. Review"
            error={errors.terms}
            className={cn(mobileStep !== 5 && "hidden")}
          >
            <p className="mb-5 text-sm text-muted-foreground">
              Review the details below before confirming your appointment.
            </p>
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-3">
                <p className="text-xs tracking-widest text-muted-foreground uppercase">
                  Personal information
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <ReviewItem label="Customer" value={customerFullName} />
                  <ReviewItem label="Mobile number" value={form.phone} />
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-xs tracking-widest text-muted-foreground uppercase">
                  Motorcycle details
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <ReviewItem label="Brand" value={form.motoBrand} />
                  <ReviewItem label="Model" value={form.motoModel} />
                  <ReviewItem label="Plate number" value={form.plateNumber} />
                </div>
              </div>
            </div>
            <div className="mt-6 space-y-3">
              <p className="text-xs tracking-widest text-muted-foreground uppercase">
                Appointment schedule
              </p>
              <ReviewItem
                label="Date and time"
                value={`${formatDateLong(date)} at ${formatTime(startTime)}`}
              />
            </div>
            <div className="mt-6">
              <p className="text-xs tracking-widest text-muted-foreground uppercase">
                Selected services
              </p>
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border/70">
                {estimatedServices.map((service) => (
                  <li
                    key={service.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-3"
                  >
                    <div>
                      <p className="font-medium text-foreground">{service.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {service.durationMinutes} min · {servicePricingLabel(service.pricingSource)}
                      </p>
                    </div>
                    <span className="font-medium text-primary">{formatPHP(service.price)}</span>
                  </li>
                ))}
                <li className="flex flex-wrap items-center justify-between gap-3 bg-primary/5 p-3">
                  <span className="font-medium">Total</span>
                  <span className="font-display text-xl text-primary">{formatPHP(total)}</span>
                </li>
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Estimated appointment time: {totalDuration} minutes, including arrival and
                post-service buffers.
              </p>
              {multiDayContinuationAccepted && needsMultiDayContinuationConfirmation && (
                <p className="mt-2 text-xs text-primary">
                  The remaining service time will be reserved on the next available shop day.
                </p>
              )}
            </div>
            <div
              className={cn(
                "mt-5 flex items-start gap-3 rounded-md text-sm",
                errors.terms && "border border-destructive p-3",
              )}
            >
              <Checkbox
                id="booking-terms"
                checked={terms}
                onCheckedChange={(value) => setTerms(value === true)}
                className="mt-0.5"
              />
              <div className="leading-6">
                <label id="booking-terms-label" htmlFor="booking-terms">
                  I have read and agree to the{" "}
                </label>
                <Dialog>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      className="font-bold text-primary underline decoration-primary/70 underline-offset-4 transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                        Please read the complete booking terms before confirming your appointment.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border/70 bg-card/50 p-4 text-sm leading-6 whitespace-pre-line text-muted-foreground">
                      {bookingTerms}
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
            <p className="mt-5 text-xs text-muted-foreground">
              Final availability is checked again when you confirm your booking.
            </p>
            <div className="w-full space-y-4 md:w-auto">
              <TurnstileChallenge resetKey={bookingRequestId} onToken={setTurnstileToken} />
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={goBackMobileBooking}
                  className="w-full sm:w-auto"
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  size="lg"
                  disabled={
                    !rescheduleReady || mutation.isPending || (turnstileEnabled && !turnstileToken)
                  }
                  className="w-full font-display tracking-wide uppercase sm:w-auto"
                >
                  {mutation.isPending && <Loader2 className="animate-spin" />}{" "}
                  {isReschedule ? "Submit reschedule request" : "Confirm booking"}
                </Button>
              </div>
            </div>
          </Section>
        </form>
        {!isReschedule && (
          <>
            <AlertDialog open={bookingConfirmationOpen} onOpenChange={setBookingConfirmationOpen}>
              <AlertDialogContent className="sm:max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display text-2xl uppercase">
                    Confirm booking?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Your booking details are shown in the Review step. Submit the appointment only
                    if everything is correct.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm">
                  <p className="text-xs tracking-widest text-muted-foreground uppercase">
                    Appointment schedule
                  </p>
                  <p className="mt-1 font-medium text-foreground">
                    {formatDateLong(date)} at {formatTime(startTime)}
                  </p>
                </div>

                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel / Go back</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={mutation.isPending}
                    onClick={confirmBooking}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {mutation.isPending && <Loader2 className="animate-spin" />} Confirm Booking
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog
              open={multiDayContinuationOpen}
              onOpenChange={(open) => {
                setMultiDayContinuationOpen(open);
                if (!open) setMultiDayConfirmationStep(null);
              }}
            >
              <AlertDialogContent className="sm:max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display text-2xl uppercase">
                    Multi-day service
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The services you selected may require more than one day to complete. Do you want
                    to continue?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Close</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={continueWithMultiDayBooking}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    Continue
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Dialog
              open={Boolean(duplicateBookingMessage)}
              onOpenChange={(open) => !open && dismissDuplicateBookingDialog()}
            >
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle className="font-display text-2xl uppercase">
                    Appointment already exists
                  </DialogTitle>
                  <DialogDescription>{duplicateBookingMessage}</DialogDescription>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Choose a different available date and time before confirming your booking.
                </p>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="outline" onClick={dismissDuplicateBookingDialog}>
                      Close
                    </Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <p className="text-xs tracking-widest text-muted-foreground uppercase">{label}</p>
      <p className="mt-1 break-words text-foreground">{value}</p>
    </div>
  );
}

function servicePricingLabel(source: "default" | "model_override") {
  if (source === "model_override") return "model override";
  return "standard service rate";
}

function Section({
  title,
  error,
  className,
  children,
}: {
  title: string;
  error?: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-xl border border-border/70 bg-card/40 p-4 sm:p-6", className)}>
      <h2 className="font-display mb-4 text-xl tracking-wide uppercase">{title}</h2>
      {children}
      <FieldError message={error} className="mt-3" />
    </section>
  );
}

function WizardActions({ onBack, onContinue }: { onBack?: () => void; onContinue: () => void }) {
  return (
    <div className="mt-6 flex justify-between gap-3 border-t border-border/70 pt-4">
      {onBack ? (
        <Button type="button" variant="outline" onClick={onBack} className="flex-1 sm:flex-none">
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button
        type="button"
        onClick={onContinue}
        className="flex-1 font-display uppercase sm:flex-none"
      >
        Continue
      </Button>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div
      data-invalid={!!error}
      className="space-y-1.5 data-[invalid=true]:[&_[role=combobox]]:border-destructive data-[invalid=true]:[&_input]:border-destructive data-[invalid=true]:[&_textarea]:border-destructive"
    >
      <Label>{label}</Label>
      {children}
      <FieldError message={error} />
    </div>
  );
}
