import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock,
  History,
  Info,
  Loader2,
  Pencil,
  Search,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { z } from "zod";

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
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import {
  BOOKING_DRAFT_LIFETIME_MINUTES,
  clearBookingDraft,
  loadBookingDraft,
  saveBookingDraft,
} from "@/lib/booking-draft";
import { createBooking, getAvailability, getRescheduleDetails } from "@/lib/booking.functions";
import {
  DEFAULT_BOOKING_TERMS,
  DEFAULT_BOOKING_HOURS,
  PHONE_VALIDATION_MESSAGE,
  MAX_BOOKING_SERVICE_SELECTIONS,
  bookingDurationOverflowMinutes,
  formatDateLong,
  formatPHP,
  formatTime,
  formatNamePartInput,
  isValidCalendarDate,
  normalizePhilippineMobile,
  sanitizePhilippineMobileInput,
} from "@/lib/shop";
import { cn } from "@/lib/utils";

const searchSchema = z.object({
  date: z.string().refine(isValidCalendarDate, "Enter a valid appointment date.").optional(),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Enter a valid appointment start time.")
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

function emptyBookingForm() {
  return {
    firstName: "",
    middleName: "",
    lastName: "",
    phone: "",
    email: "",
    motoBrand: "",
    motoModel: "",
    motoVariant: "",
    motoYear: String(new Date().getFullYear()),
    plateNumber: "",
    notes: "",
    wantsProducts: null as boolean | null,
  };
}

const bookingDraftSchema = z.object({
  form: z.object({
    firstName: z.string(),
    middleName: z.string(),
    lastName: z.string(),
    phone: z.string(),
    email: z.string(),
    motoBrand: z.string(),
    motoModel: z.string(),
    motoVariant: z.string(),
    motoYear: z.string(),
    plateNumber: z.string(),
    notes: z.string(),
    wantsProducts: z.boolean().nullable(),
  }),
  serviceIds: z.array(z.string()),
  date: z.string(),
  startTime: z.string(),
});
type BookingDraft = z.infer<typeof bookingDraftSchema>;

function parseBookingDraft(value: unknown) {
  const parsed = bookingDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const BOOKING_PAGES = ["Booking details", "Review & submit"] as const;

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
  email: string;
  motoBrand: string;
  motoModel: string;
  plateNumber: string;
  services: string;
  wantsProducts: string;
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
  "email",
  "motoBrand",
  "motoModel",
  "plateNumber",
  "services",
  "wantsProducts",
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
  email: "#booking-email",
  motoBrand: "#booking-moto-brand",
  motoModel: "#booking-moto-model",
  plateNumber: "#booking-plate-number",
  services: "#booking-services",
  wantsProducts: "#booking-products",
  rescheduleReason: "#reschedule-reason",
  date: "#booking-date button[data-day]:not([disabled])",
  startTime: "#booking-start-time button:not([disabled])",
  schedule: "#booking-schedule",
  terms: "#booking-terms",
};

function isDuplicateBookingMessage(message: string) {
  return /already (?:have|has) an appointment for/i.test(message);
}

function BookPage() {
  const book = useServerFn(createBooking);
  const availabilityFn = useServerFn(getAvailability);
  const rescheduleDetailsFn = useServerFn(getRescheduleDetails);
  const search = useSearch({ from: "/book" });

  const [form, setForm] = useState(emptyBookingForm);
  const [serviceIds, setServiceIds] = useState<string[]>(
    search.serviceId ? [search.serviceId] : [],
  );
  const [serviceCategory, setServiceCategory] = useState("all");
  const [serviceSearch, setServiceSearch] = useState("");
  const [date, setDate] = useState<string>(search.date ?? "");
  const [startTime, setStartTime] = useState<string>(search.startTime ?? "");
  const [terms, setTerms] = useState(false);
  const [bookingPage, setBookingPage] = useState<"details" | "review">("details");
  const [errors, setErrors] = useState<Errors>({});
  const [focusRequest, setFocusRequest] = useState<keyof Errors | null>(null);
  const [multiDayContinuationOpen, setMultiDayContinuationOpen] = useState(false);
  const [multiDayContinuationAccepted, setMultiDayContinuationAccepted] = useState(false);
  const [duplicateBookingMessage, setDuplicateBookingMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{
    reference: string;
    total: number;
    date: string;
    startTime: string;
    continuationSegments?: Array<{ date: string; startTime: string; durationMinutes: number }>;
  } | null>(null);
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
        data: {
          reference: search.reschedule,
          phone: normalizePhilippineMobile(search.phone)!,
        },
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
      email: appointment.email,
      motoBrand: appointment.motoBrand,
      motoModel: appointment.motoModel,
      motoVariant: appointment.motoVariant,
      motoYear: appointment.motoYear,
      plateNumber: appointment.plateNumber,
      notes: appointment.notes,
      wantsProducts: appointment.wantsProducts,
    });
    setServiceIds(appointment.serviceIds);
    setServiceCategory("all");
    setDate("");
    setStartTime("");
    setBookingPage("details");
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
          ...(search.reschedule && search.phone
            ? {
                rescheduleReference: search.reschedule,
                reschedulePhone: normalizePhilippineMobile(search.phone)!,
              }
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

  const availableDateSet = useMemo(() => new Set(dates), [dates]);
  const fullyBookedDates = useMemo(
    () => (availability.data ? computeFullyBookedDates(availability.data) : []),
    [availability.data],
  );

  const availabilityEnabled = serviceIds.length > 0 && motorcycleSelectionReady;
  const availabilityLoading =
    availabilityEnabled && (availability.isPending || availability.isFetching);
  const availabilityError = availability.data?.error;

  const selectedServices = (services.data ?? []).filter((s) => serviceIds.includes(s.id));
  const serviceCategories = useMemo(
    () =>
      Array.from(
        new Set((services.data ?? []).map((service) => service.category).filter(Boolean)),
      ).sort(),
    [services.data],
  );
  const normalizedServiceSearch = serviceSearch.trim().toLowerCase();
  const filteredServices = (services.data ?? []).filter(
    (service) =>
      (serviceCategory === "all" || service.category === serviceCategory) &&
      (!normalizedServiceSearch || service.name.toLowerCase().includes(normalizedServiceSearch)),
  );
  const serviceEstimates =
    availability.data?.serviceEstimates ??
    selectedServices.map((service) => ({
      id: service.id,
      name: service.name,
      price: Number(service.price),
      durationMinutes: service.duration_minutes ?? 60,
      pricingSource: "small_bike" as const,
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
    0,
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
  const needsServiceStepMultiDayConfirmation = serviceStepOverflowMinutes > 0;
  const multiDayOverflowMinutes =
    !isReschedule && date && startTime && serviceIds.length > 1
      ? bookingDurationOverflowMinutes(startTime, totalDuration, operatingHours)
      : 0;
  const needsMultiDayContinuationConfirmation = multiDayOverflowMinutes > 0;
  const bookingTerms = shopSettings.data?.booking_terms || DEFAULT_BOOKING_TERMS;
  // Prices depend on the motorcycle's size category, so only show a total once
  // the server has priced the selected services for the chosen motorcycle.
  const pricingReady = Boolean(availability.data?.serviceEstimates) && !availabilityError;
  const selectedModelLabel =
    modelsForBrand.find((model) => model.value === form.motoModel)?.label ?? form.motoModel;
  const sectionComplete = {
    personal:
      isReschedule ||
      (form.lastName.trim().length >= 2 &&
        form.firstName.trim().length >= 2 &&
        normalizePhilippineMobile(form.phone) !== null &&
        /^\S+@\S+\.\S+$/.test(form.email.trim())),
    motorcycle: motorcycleSelectionReady && form.plateNumber.trim().length >= 2,
    services: serviceIds.length > 0 && form.wantsProducts !== null,
    schedule: Boolean(date && startTime) && (!isReschedule || Boolean(rescheduleReason.trim())),
  };

  function clearErrors(...fields: (keyof Errors)[]) {
    setErrors((current) => {
      if (!fields.some((field) => current[field])) return current;
      const next = { ...current };
      for (const field of fields) delete next[field];
      return next;
    });
  }

  function updateForm<K extends keyof typeof form>(field: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    if (field in validationFocusTargets) clearErrors(field as keyof Errors);
  }

  // Restore an unfinished booking once the page is open in the browser. A
  // service, date or time in the link (from "Book this service") wins.
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  useEffect(() => {
    if (draftLoaded) return;
    const draft = isReschedule ? null : loadBookingDraft(parseBookingDraft);
    if (draft) {
      setForm(draft.form);
      if (!search.serviceId) setServiceIds(draft.serviceIds);
      if (!search.date) {
        setDate(draft.date);
        setStartTime(draft.startTime);
      }
      setDraftRestored(true);
    }
    setDraftLoaded(true);
  }, [draftLoaded, isReschedule, search.serviceId, search.date]);

  // Keep the draft up to date while the customer fills in the form.
  useEffect(() => {
    if (!draftLoaded || isReschedule || result) return;
    const draft: BookingDraft = { form, serviceIds, date, startTime };
    const hasInput =
      Object.entries(form).some(
        ([field, value]) => field !== "motoYear" && value !== "" && value !== null,
      ) ||
      serviceIds.length > 0 ||
      date !== "";
    if (hasInput) saveBookingDraft(draft);
    else clearBookingDraft();
  }, [draftLoaded, isReschedule, result, form, serviceIds, date, startTime]);

  function startOver() {
    clearBookingDraft();
    setDraftRestored(false);
    setForm(emptyBookingForm());
    setServiceIds([]);
    setServiceCategory("all");
    setServiceSearch("");
    resetSchedule();
    setTerms(false);
    setErrors({});
    setDuplicateBookingMessage(null);
    setBookingPage("details");
  }

  function resetSchedule() {
    setDate("");
    setStartTime("");
    setMultiDayContinuationAccepted(false);
  }

  function toggleService(serviceId: string) {
    const checked = serviceIds.includes(serviceId);
    if (!checked && serviceIds.length >= MAX_BOOKING_SERVICE_SELECTIONS) {
      setErrors((current) => ({
        ...current,
        services: `You can select up to ${MAX_BOOKING_SERVICE_SELECTIONS} services per appointment.`,
      }));
      return;
    }
    setServiceIds((prev) =>
      checked ? prev.filter((id) => id !== serviceId) : [...prev, serviceId],
    );
    clearErrors("services");
    resetSchedule();
  }

  function clearServices() {
    setServiceIds([]);
    resetSchedule();
  }

  useEffect(() => {
    if (!focusRequest) return;

    const target = validationFocusTargets[focusRequest];
    if (!target) return;

    // Let React show the appropriate booking page before trying to focus its input.
    const timer = window.setTimeout(() => {
      const element = document.querySelector<HTMLElement>(target);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.focus({ preventScroll: true });
      setFocusRequest(null);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [bookingPage, focusRequest]);

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
      if (form.wantsProducts === null) {
        throw new Error("Choose whether you would like to avail shop products.");
      }
      const submittedSchedule = { date, startTime };
      const res = await book({
        data: {
          firstName: form.firstName.trim(),
          middleName: form.middleName.trim(),
          lastName: form.lastName.trim(),
          phone: normalizePhilippineMobile(form.phone)!,
          email: form.email.trim().toLowerCase(),
          motoBrand: form.motoBrand.trim(),
          motoModel: form.motoModel.trim(),
          motoVariant: form.motoVariant.trim(),
          motoYear: Number(form.motoYear),
          plateNumber: form.plateNumber.trim(),
          serviceIds,
          date,
          startTime,
          notes: form.notes.trim(),
          wantsProducts: form.wantsProducts,
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
      clearBookingDraft();
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
      if (!isReschedule && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
        e.email = "Enter a valid email address.";
      }
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
    if (steps.includes(3) && form.wantsProducts === null) {
      e.wantsProducts = "Choose Yes or No for shop products.";
    }
    if (steps.includes(4) && availabilityLoading) {
      e.schedule = "Availability is still loading. Please wait a moment.";
    }
    if (steps.includes(4) && (availability.isError || availabilityError)) {
      e.schedule = availabilityError ?? "We could not verify availability. Please try again.";
    }
    if (steps.includes(4) && isReschedule && !rescheduleReason.trim()) {
      e.rescheduleReason = "Tell us why you need to reschedule.";
    }
    if (steps.includes(5) && !terms) e.terms = "You must accept the terms and conditions.";
    return e;
  }

  function validateBooking() {
    const e = validationErrors([1, 2, 3, 4, 5]);
    return showValidationErrors(e);
  }

  function showValidationErrors(e: Errors) {
    setErrors(e);
    const firstInvalidField = validationFieldOrder.find((field) => e[field]);
    if (!firstInvalidField) return true;

    setBookingPage(firstInvalidField === "terms" ? "review" : "details");
    setFocusRequest(firstInvalidField);
    return false;
  }

  function continueToReview() {
    const e = validationErrors([1, 2, 3, 4]);
    if (!showValidationErrors(e)) return;
    const requiresMultiDayConfirmation =
      needsServiceStepMultiDayConfirmation || needsMultiDayContinuationConfirmation;
    if (requiresMultiDayConfirmation && !multiDayContinuationAccepted) {
      setMultiDayContinuationOpen(true);
      return;
    }
    setBookingPage("review");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function continueWithMultiDayBooking() {
    setMultiDayContinuationAccepted(true);
    setMultiDayContinuationOpen(false);
    setBookingPage("review");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function returnToBookingDetails() {
    setErrors({});
    setBookingPage("details");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function submitBooking() {
    if (!rescheduleReady || !validateBooking()) return;
    mutation.mutate();
  }

  /** Return from the review page to a specific part of the booking form. */
  function editBookingSection(field: keyof Errors) {
    setErrors({});
    setBookingPage("details");
    setFocusRequest(field);
  }

  function dismissDuplicateBookingDialog() {
    setDuplicateBookingMessage(null);
  }

  function chooseAnotherDate() {
    dismissDuplicateBookingDialog();
    editBookingSection("schedule");
  }

  if (result) {
    const nextSteps = isReschedule
      ? [
          "The shop reviews your requested new date and time.",
          "Your original appointment stays reserved until the request is reviewed.",
          "Check the status of your request anytime on the My Appointment page.",
        ]
      : [
          "The shop reviews your booking request.",
          "Once it is approved, we will email your confirmed appointment details.",
          "Use your reference code on the My Appointment page to check the status, reschedule, or cancel.",
          "On the day, please arrive 10–15 minutes early for check-in.",
        ];

    return (
      <div className="min-h-screen">
        <SiteHeader />
        <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-16">
          <Card className="overflow-hidden border-primary/40 bg-card/70">
            <CardContent className="p-0">
              <div className="px-5 pt-8 pb-6 text-center sm:px-8">
                <CheckCircle2 className="mx-auto h-14 w-14 text-primary" aria-hidden="true" />
                <h1 className="mt-4 font-display text-3xl font-bold uppercase sm:text-4xl">
                  {isReschedule ? "Reschedule request sent" : "Appointment requested"}
                </h1>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                  {isReschedule
                    ? "Your original appointment remains reserved while the shop reviews your requested new date and time."
                    : "Save your reference code. Your request remains pending until the shop approves it, then we will email your confirmed appointment details."}
                </p>
                <div className="mt-6 rounded-xl border border-dashed border-primary/50 bg-primary/5 p-5">
                  <p className="text-xs tracking-[0.3em] text-muted-foreground uppercase">
                    Reference code
                  </p>
                  <p className="mt-1 font-display text-4xl font-bold tracking-widest text-primary">
                    {result.reference}
                  </p>
                  <CopyReferenceButton value={result.reference} className="mt-3" />
                </div>
              </div>

              <dl className="grid gap-px border-y border-border/70 bg-border/70 sm:grid-cols-3">
                <SuccessDetail label="Schedule">
                  {formatDateLong(result.date)}
                  <span className="block text-muted-foreground">
                    {formatTime(result.startTime)}
                  </span>
                </SuccessDetail>
                <SuccessDetail label="Estimated total">{formatPHP(result.total)}</SuccessDetail>
                <SuccessDetail label="Status">Pending shop confirmation</SuccessDetail>
              </dl>

              <div className="space-y-6 px-5 py-6 sm:px-8">
                {(result.continuationSegments?.length ?? 0) > 0 && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
                    <p className="font-medium text-foreground">Continued service schedule</p>
                    <ul className="mt-2 space-y-1 text-muted-foreground">
                      {result.continuationSegments?.map((segment) => (
                        <li key={`${segment.date}-${segment.startTime}`}>
                          {formatDateLong(segment.date)} at {formatTime(segment.startTime)} (
                          {segment.durationMinutes} min)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <h2 className="font-display text-lg tracking-wide uppercase">
                    What happens next
                  </h2>
                  <ol className="mt-3 space-y-3 text-sm">
                    {nextSteps.map((step, index) => (
                      <li key={step} className="flex gap-3">
                        <span
                          aria-hidden="true"
                          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-display text-sm text-primary"
                        >
                          {index + 1}
                        </span>
                        <span className="pt-0.5 text-muted-foreground">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                  <Button asChild size="lg" className="font-display tracking-wide uppercase">
                    <Link to="/my-appointment">Track my appointment</Link>
                  </Button>
                  <Button
                    asChild
                    size="lg"
                    variant="outline"
                    className="font-display tracking-wide uppercase"
                  >
                    <Link to="/">Back to homepage</Link>
                  </Button>
                </div>
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
                  <CircleAlert className="mx-auto size-8 text-destructive" aria-hidden="true" />
                  <h1 className="mt-4 font-display text-2xl uppercase">
                    Unable to reschedule online
                  </h1>
                  <p className="mt-2 text-sm text-destructive">{rescheduleError}</p>
                  <Button asChild variant="outline" className="mt-6">
                    <Link to="/my-appointment">
                      <ArrowLeft /> Back to My Appointment
                    </Link>
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

  const productChoiceLabel =
    form.wantsProducts === null
      ? "Not selected"
      : form.wantsProducts
        ? "Yes, if needed"
        : "No, service only";
  const showMultiDayNote =
    !isReschedule &&
    (needsServiceStepMultiDayConfirmation || needsMultiDayContinuationConfirmation);

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs tracking-[0.3em] text-accent uppercase">
              {isReschedule ? "Reschedule appointment" : "Book a service"}
            </p>
            <h1 className="font-display text-3xl font-bold uppercase sm:text-4xl md:text-5xl">
              {isReschedule ? "Choose a new service slot" : "Reserve your service slot"}
            </h1>
            <p className="mt-2 text-muted-foreground">
              {isReschedule
                ? "Your saved appointment details are retained. Enter a reason and choose a new available date and time; your original slot stays reserved until the shop confirms."
                : "Tell us about you and your motorcycle, pick your services, and choose an available time. You'll review everything before submitting."}
            </p>
          </div>
          <BookingSteps
            current={bookingPage === "details" ? 0 : 1}
            onSelectDetails={returnToBookingDetails}
          />
        </div>

        {draftRestored && (
          <div
            role="status"
            className="mt-6 flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="flex items-start gap-2">
              <History className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>
                We kept the details you entered earlier. An unfinished booking is cleared after{" "}
                {BOOKING_DRAFT_LIFETIME_MINUTES} minutes without changes.
              </span>
            </p>
            <Button type="button" variant="outline" size="sm" onClick={startOver}>
              Start over
            </Button>
          </div>
        )}

        <form
          className="mt-8"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (bookingPage === "review") submitBooking();
            else continueToReview();
          }}
        >
          <div
            className={cn(
              "grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start xl:gap-8",
              bookingPage !== "details" && "hidden",
            )}
          >
            <div className="min-w-0 space-y-6">
              <Section
                step={1}
                title="Personal information"
                description={
                  isReschedule
                    ? "These details come from your original appointment and are verified when you submit."
                    : "We use these details to confirm your booking and contact you about it."
                }
                complete={sectionComplete.personal}
              >
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field id="booking-last-name" label="Last name" error={errors.lastName}>
                    <Input
                      id="booking-last-name"
                      value={form.lastName}
                      maxLength={40}
                      autoComplete="family-name"
                      disabled={isReschedule}
                      aria-invalid={Boolean(errors.lastName)}
                      onChange={(e) => updateForm("lastName", formatNamePartInput(e.target.value))}
                      placeholder="Dela Cruz"
                    />
                  </Field>
                  <Field id="booking-first-name" label="First name" error={errors.firstName}>
                    <Input
                      id="booking-first-name"
                      value={form.firstName}
                      maxLength={40}
                      autoComplete="given-name"
                      disabled={isReschedule}
                      aria-invalid={Boolean(errors.firstName)}
                      onChange={(e) => updateForm("firstName", formatNamePartInput(e.target.value))}
                      placeholder="Juan"
                    />
                  </Field>
                  <Field
                    id="booking-middle-name"
                    label="Middle name (optional)"
                    error={errors.middleName}
                  >
                    <Input
                      id="booking-middle-name"
                      value={form.middleName}
                      maxLength={40}
                      autoComplete="additional-name"
                      disabled={isReschedule}
                      aria-invalid={Boolean(errors.middleName)}
                      onChange={(e) =>
                        updateForm("middleName", formatNamePartInput(e.target.value))
                      }
                      placeholder="Santos"
                    />
                  </Field>
                  <Field
                    id="booking-phone"
                    label="Mobile number"
                    hint="11 digits, starting with 09."
                    error={errors.phone}
                  >
                    <Input
                      id="booking-phone"
                      type="tel"
                      value={form.phone}
                      maxLength={11}
                      inputMode="tel"
                      autoComplete="tel"
                      disabled={isReschedule}
                      aria-invalid={Boolean(errors.phone)}
                      aria-describedby="booking-phone-hint"
                      onChange={(e) =>
                        updateForm("phone", sanitizePhilippineMobileInput(e.target.value))
                      }
                      placeholder="09171234567"
                    />
                  </Field>
                  <Field
                    id="booking-email"
                    label="Email address"
                    hint="We'll email your confirmed appointment details here."
                    error={errors.email}
                  >
                    <Input
                      id="booking-email"
                      type="email"
                      value={form.email}
                      maxLength={254}
                      autoComplete="email"
                      disabled={isReschedule}
                      aria-invalid={Boolean(errors.email)}
                      aria-describedby="booking-email-hint"
                      onChange={(e) => updateForm("email", e.target.value.toLowerCase())}
                      placeholder="juan@example.com"
                    />
                  </Field>
                </div>
              </Section>

              <Section
                step={2}
                title="Motorcycle details"
                description="Choose your motorcycle from our catalog. Service rates and available times depend on your model."
                complete={sectionComplete.motorcycle}
              >
                {catalogUnavailable && (
                  <p className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    The motorcycle catalog is unavailable. Please try again shortly.
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field id="booking-moto-brand" label="Brand" error={errors.motoBrand}>
                    <Select
                      value={form.motoBrand}
                      onValueChange={(v) => {
                        setForm((current) => ({ ...current, motoBrand: v, motoModel: "" }));
                        clearErrors("motoBrand", "motoModel");
                        resetSchedule();
                      }}
                      disabled={isReschedule || motorcycleCatalog.isLoading || catalogUnavailable}
                    >
                      <SelectTrigger id="booking-moto-brand">
                        <SelectValue
                          placeholder={
                            motorcycleCatalog.isLoading ? "Loading brands…" : "Select a brand"
                          }
                        />
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
                  <Field id="booking-moto-model" label="Model" error={errors.motoModel}>
                    <Select
                      value={form.motoModel}
                      onValueChange={(v) => {
                        updateForm("motoModel", v);
                        resetSchedule();
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
                  <Field id="booking-plate-number" label="Plate number" error={errors.plateNumber}>
                    <Input
                      id="booking-plate-number"
                      value={form.plateNumber}
                      maxLength={20}
                      disabled={isReschedule}
                      aria-invalid={Boolean(errors.plateNumber)}
                      onChange={(e) => updateForm("plateNumber", e.target.value.toUpperCase())}
                      placeholder="ABC 1234"
                    />
                  </Field>
                </div>
              </Section>

              <Section
                step={3}
                title="Services"
                description={
                  isReschedule
                    ? "Your original services are kept for this reschedule request."
                    : `Select the services you need. You can choose up to ${MAX_BOOKING_SERVICE_SELECTIONS} per appointment.`
                }
                complete={sectionComplete.services}
              >
                {!isReschedule && (
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="relative min-w-0 flex-1">
                      <Search
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <Input
                        id="booking-service-search"
                        type="search"
                        value={serviceSearch}
                        onChange={(e) => setServiceSearch(e.target.value)}
                        // Enter should filter, not submit the whole booking form.
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.preventDefault();
                        }}
                        placeholder="Search services"
                        aria-label="Search services"
                        className="pl-9"
                      />
                    </div>
                    <Select value={serviceCategory} onValueChange={setServiceCategory}>
                      <SelectTrigger
                        id="booking-service-category"
                        aria-label="Service category"
                        className="w-full sm:w-52"
                      >
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
                )}

                <div id="booking-services" tabIndex={-1} className="focus:outline-none">
                  {selectedServices.length > 0 && (
                    <div
                      className={cn("flex flex-wrap items-center gap-2", !isReschedule && "mt-4")}
                    >
                      <span className="mr-1 text-xs font-medium tracking-widest text-muted-foreground uppercase">
                        Selected ({selectedServices.length})
                      </span>
                      {selectedServices.map((service) =>
                        isReschedule ? (
                          <span
                            key={service.id}
                            className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium"
                          >
                            {service.name}
                          </span>
                        ) : (
                          <button
                            type="button"
                            key={service.id}
                            onClick={() => toggleService(service.id)}
                            aria-label={`Remove ${service.name}`}
                            className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-1 pr-2 pl-3 text-xs font-medium transition-colors hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          >
                            {service.name}
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        ),
                      )}
                      {!isReschedule && selectedServices.length > 1 && (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          onClick={clearServices}
                          className="h-auto px-1 text-xs md:h-auto"
                        >
                          Clear all
                        </Button>
                      )}
                    </div>
                  )}

                  {!isReschedule && (
                    <div
                      className={cn(
                        "mt-4 max-h-[26rem] overflow-y-auto rounded-lg border border-border/70 bg-background/40 p-2 sm:max-h-[30rem]",
                        errors.services && "border-destructive",
                      )}
                    >
                      {services.isLoading ? (
                        <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading
                          services…
                        </p>
                      ) : filteredServices.length === 0 ? (
                        <div className="p-4 text-center text-sm text-muted-foreground">
                          <p>
                            {normalizedServiceSearch
                              ? `No services match “${serviceSearch.trim()}”.`
                              : "No services are available in this category."}
                          </p>
                          {(normalizedServiceSearch || serviceCategory !== "all") && (
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              onClick={() => {
                                setServiceSearch("");
                                setServiceCategory("all");
                              }}
                            >
                              Show all services
                            </Button>
                          )}
                        </div>
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                          {filteredServices.map((s) => {
                            const checked = serviceIds.includes(s.id);
                            return (
                              <button
                                type="button"
                                key={s.id}
                                aria-pressed={checked}
                                onClick={() => toggleService(s.id)}
                                className={cn(
                                  "flex min-h-12 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                  checked
                                    ? "border-primary bg-primary/10"
                                    : "border-border/70 bg-card/60 hover:border-primary/50",
                                )}
                              >
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    "flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
                                    checked
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-input bg-background",
                                  )}
                                >
                                  {checked && <Check className="size-3.5" />}
                                </span>
                                <span className="font-display text-sm leading-tight tracking-wide uppercase">
                                  {s.name}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <FieldError message={errors.services} className="mt-2" />
                {!isReschedule && (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Not sure which service you need?{" "}
                    <Link
                      to="/services"
                      className="font-medium text-primary underline underline-offset-4"
                    >
                      Browse our services
                    </Link>{" "}
                    to see what each one includes.
                  </p>
                )}

                <div className="mt-6 border-t border-border/70 pt-5">
                  <p id="booking-products-label" className="text-sm font-medium">
                    Shop products
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Would you like to use shop-provided products for your service?
                  </p>
                  <div
                    id="booking-products"
                    tabIndex={-1}
                    className="mt-3 grid gap-2 focus:outline-none sm:max-w-md sm:grid-cols-2"
                    role="radiogroup"
                    aria-labelledby="booking-products-label"
                    aria-invalid={Boolean(errors.wantsProducts)}
                  >
                    {[
                      { value: true, label: "Yes," },
                      { value: false, label: "No, service only" },
                    ].map((option) => {
                      const selected = form.wantsProducts === option.value;
                      return (
                        <button
                          type="button"
                          key={option.label}
                          role="radio"
                          aria-checked={selected}
                          disabled={isReschedule}
                          onClick={() => updateForm("wantsProducts", option.value)}
                          className={cn(
                            "flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            selected
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border bg-card/50 hover:border-primary/50",
                            errors.wantsProducts && !selected && "border-destructive/60",
                            isReschedule && "cursor-not-allowed opacity-75",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-full border",
                              selected ? "border-primary" : "border-input",
                            )}
                          >
                            {selected && <span className="size-2 rounded-full bg-primary" />}
                          </span>
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <FieldError message={errors.wantsProducts} className="mt-2" />
                </div>
              </Section>

              <Section
                id="booking-schedule"
                step={4}
                title="Date and time"
                description="Pick an available date, then choose a start time."
                complete={sectionComplete.schedule}
                error={errors.schedule}
              >
                {isReschedule && (
                  <div className="mb-5">
                    <Label htmlFor="reschedule-reason">Reason for rescheduling</Label>
                    <Textarea
                      id="reschedule-reason"
                      value={rescheduleReason}
                      maxLength={500}
                      onChange={(event) => {
                        setRescheduleReason(event.target.value);
                        clearErrors("rescheduleReason");
                      }}
                      placeholder="Tell the shop why you need a different schedule."
                      aria-invalid={Boolean(errors.rescheduleReason)}
                      className="mt-2"
                    />
                    <FieldError message={errors.rescheduleReason} className="mt-1" />
                  </div>
                )}
                {serviceIds.length === 0 ? (
                  <ScheduleHint>
                    Select at least one service to see available dates and times.
                  </ScheduleHint>
                ) : !motorcycleSelectionReady ? (
                  <ScheduleHint>
                    Select your motorcycle brand and model to see available dates and times.
                  </ScheduleHint>
                ) : availabilityLoading ? (
                  <ScheduleHint loading>Checking available schedules…</ScheduleHint>
                ) : availability.isError || availabilityError ? (
                  <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {availabilityError ??
                      "We could not load availability. Please refresh and try again."}
                  </p>
                ) : (
                  <>
                    <p className="mb-4 text-sm text-muted-foreground">
                      Available dates have an assigned mechanic, an open shop schedule, and enough
                      time for your selected services.
                    </p>
                    <div
                      className={cn(
                        "w-full rounded-xl border border-border bg-card/50 p-3 sm:p-5",
                        (errors.date || errors.startTime) && "border-destructive",
                      )}
                    >
                      <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:gap-8">
                        <div className="border-b border-border/70 pb-5 md:border-r md:border-b-0 md:pr-8 md:pb-0">
                          <div
                            id="booking-date"
                            tabIndex={-1}
                            className="flex justify-center focus:outline-none md:justify-start"
                          >
                            <BookingCalendar
                              selected={date}
                              availableDates={availableDateSet}
                              fullyBookedDates={fullyBookedDates}
                              onSelect={(iso) => {
                                setDate(iso);
                                setStartTime("");
                                clearErrors("date", "startTime", "schedule");
                              }}
                            />
                          </div>
                          {fullyBookedDates.length > 0 && (
                            <FullyBookedLegend className="mt-3 justify-center md:justify-start" />
                          )}
                        </div>

                        <div
                          id="booking-start-time"
                          tabIndex={-1}
                          className="min-w-0 focus:outline-none"
                        >
                          <h3 className="font-display text-lg uppercase">Available times</h3>
                          <p className="mt-1 mb-4 text-sm text-muted-foreground">
                            {date
                              ? formatDateLong(date)
                              : "Choose a date to see the available start times."}
                          </p>
                          {date ? (
                            <TimeSlotPicker
                              slots={slots}
                              value={startTime}
                              onChange={(value) => {
                                setStartTime(value);
                                clearErrors("startTime", "schedule");
                              }}
                              invalid={Boolean(errors.startTime)}
                              gridClassName="sm:grid-cols-3 md:grid-cols-2 xl:grid-cols-3"
                            />
                          ) : (
                            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                              Time slots will appear here after you choose a date.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <FieldError message={errors.date} className="mt-2" />
                    <FieldError message={errors.startTime} className="mt-2" />
                    {date && startTime && (
                      <div className="mt-4 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                        <CalendarDays className="size-5 shrink-0 text-primary" aria-hidden="true" />
                        <div>
                          <p className="text-xs tracking-widest text-muted-foreground uppercase">
                            Selected schedule
                          </p>
                          <p className="font-medium text-foreground">
                            {formatDateLong(date)} at {formatTime(startTime)}
                          </p>
                        </div>
                      </div>
                    )}
                    {showMultiDayNote && (
                      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                        <Info
                          className="mt-0.5 size-3.5 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        Your selected services may need more than one day. The remaining service
                        time will be reserved on the next available shop day.
                      </p>
                    )}
                  </>
                )}
              </Section>
            </div>

            <aside aria-label="Booking summary" className="lg:sticky lg:top-28">
              <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm sm:p-5">
                <h2 className="font-display text-xl tracking-wide uppercase">Booking summary</h2>
                <div className="mt-4 space-y-4 text-sm">
                  <SummaryRow label="Your details" done={sectionComplete.personal}>
                    {customerFullName || (
                      <span className="text-muted-foreground">Not entered yet</span>
                    )}
                  </SummaryRow>
                  <SummaryRow label="Motorcycle" done={sectionComplete.motorcycle}>
                    {motorcycleSelectionReady ? (
                      `${form.motoBrand} ${selectedModelLabel}`
                    ) : (
                      <span className="text-muted-foreground">Not selected yet</span>
                    )}
                  </SummaryRow>
                  <SummaryRow label="Services" done={sectionComplete.services}>
                    {estimatedServices.length > 0 ? (
                      <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
                        {estimatedServices.map((service) => (
                          <li key={service.id} className="flex justify-between gap-3">
                            <span className="min-w-0">{service.name}</span>
                            {pricingReady && (
                              <span className="shrink-0 text-muted-foreground">
                                {formatPHP(service.price)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-muted-foreground">None selected yet</span>
                    )}
                  </SummaryRow>
                  <SummaryRow label="Date and time" done={Boolean(date && startTime)}>
                    {date && startTime ? (
                      `${formatDateLong(date)} at ${formatTime(startTime)}`
                    ) : (
                      <span className="text-muted-foreground">Not selected yet</span>
                    )}
                  </SummaryRow>
                </div>

                <div className="mt-5 border-t border-border/70 pt-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">Estimated total</span>
                    <span className="font-display text-2xl text-primary">
                      {pricingReady ? formatPHP(total) : "—"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pricingReady
                      ? "Labor/service charge only. Parts are quoted separately."
                      : "Choose your motorcycle and services to see an estimate."}
                  </p>
                </div>

                <Button
                  type="submit"
                  size="lg"
                  disabled={!rescheduleReady}
                  className="mt-5 w-full font-display tracking-wide uppercase"
                >
                  {isReschedule ? "Review reschedule request" : "Review booking"}
                  <ArrowRight aria-hidden="true" />
                </Button>
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  Nothing is submitted until you confirm on the next step.
                </p>
              </div>
            </aside>
          </div>

          <div
            className={cn(
              "grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start xl:gap-8",
              bookingPage !== "review" && "hidden",
            )}
          >
            <div className="min-w-0 space-y-5">
              <div>
                <h2 className="font-display text-2xl tracking-wide uppercase sm:text-3xl">
                  {isReschedule ? "Review your reschedule request" : "Review your booking"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Check your details below. You can edit any section before submitting.
                </p>
              </div>

              {errors.schedule && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {errors.schedule}
                </p>
              )}

              <div className="flex flex-col gap-4 rounded-xl border border-primary/40 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex items-start gap-3">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <CalendarDays className="size-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-xs tracking-widest text-muted-foreground uppercase">
                      {isReschedule ? "Requested new schedule" : "Appointment"}
                    </p>
                    <p className="font-display text-xl uppercase sm:text-2xl">
                      {date ? formatDateLong(date) : "Date not selected"}
                    </p>
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Clock className="size-4" aria-hidden="true" />
                      {startTime ? formatTime(startTime) : "Time not selected"}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => editBookingSection("schedule")}
                  className="self-start sm:self-center"
                >
                  <Pencil aria-hidden="true" /> Change date and time
                </Button>
              </div>
              {multiDayContinuationAccepted && needsMultiDayContinuationConfirmation && (
                <p className="-mt-2 flex items-start gap-2 text-xs text-primary">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  The remaining service time will be reserved on the next available shop day.
                </p>
              )}

              <div className="grid gap-5 md:grid-cols-2">
                <ReviewGroup
                  title="Personal information"
                  {...(isReschedule
                    ? {}
                    : {
                        onEdit: () => editBookingSection("lastName"),
                        editLabel: "Edit personal information",
                      })}
                >
                  <dl className="space-y-3">
                    <ReviewItem label="Name" value={customerFullName} />
                    <ReviewItem label="Mobile number" value={form.phone} />
                    {form.email && <ReviewItem label="Email address" value={form.email} />}
                  </dl>
                </ReviewGroup>
                <ReviewGroup
                  title="Motorcycle"
                  {...(isReschedule
                    ? {}
                    : {
                        onEdit: () => editBookingSection("motoBrand"),
                        editLabel: "Edit motorcycle details",
                      })}
                >
                  <dl className="space-y-3">
                    <ReviewItem
                      label="Brand and model"
                      value={[form.motoBrand, selectedModelLabel].filter(Boolean).join(" ")}
                    />
                    <ReviewItem label="Plate number" value={form.plateNumber} />
                  </dl>
                </ReviewGroup>
              </div>

              <ReviewGroup
                title="Services"
                {...(isReschedule
                  ? {}
                  : { onEdit: () => editBookingSection("services"), editLabel: "Edit services" })}
              >
                <ul className="divide-y divide-border/70">
                  {estimatedServices.map((service) => (
                    <li
                      key={service.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 first:pt-0"
                    >
                      <div>
                        <p className="font-medium text-foreground">{service.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {service.durationMinutes} min ·{" "}
                          {servicePricingLabel(service.pricingSource)}
                        </p>
                      </div>
                      <span className="font-medium text-primary">{formatPHP(service.price)}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-baseline justify-between gap-3 border-t border-border/70 pt-3">
                  <span className="font-medium">Estimated total</span>
                  <span className="font-display text-2xl text-primary">{formatPHP(total)}</span>
                </div>
                <dl className="mt-4 border-t border-border/70 pt-3">
                  <ReviewItem label="Shop products" value={productChoiceLabel} />
                </dl>
              </ReviewGroup>

              {isReschedule && (
                <ReviewGroup
                  title="Reason for rescheduling"
                  onEdit={() => editBookingSection("rescheduleReason")}
                  editLabel="Edit reason for rescheduling"
                >
                  <p className="text-sm break-words whitespace-pre-line">{rescheduleReason}</p>
                </ReviewGroup>
              )}

              <div className="rounded-xl border border-border/70 bg-muted/30 p-4 text-sm sm:p-5">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <Info className="size-4 text-primary" aria-hidden="true" /> Before you submit
                </p>
                <ul className="mt-2 list-disc space-y-1.5 pl-6 leading-5 text-muted-foreground">
                  <li>
                    Your estimated total covers the labor/service charge for the selected services
                    only. Parts &amp; Accessories, replacement parts, tools, materials, or other
                    work required during service are not included. If anything additional is needed,
                    we’ll explain the cost and get your approval before applying any extra charge.
                  </li>
                  <li>
                    Please arrive 10–15 minutes early for check-in, motorcycle verification, and
                    service preparation.
                  </li>
                </ul>
              </div>
            </div>

            <aside aria-label="Confirm and submit" className="lg:sticky lg:top-28">
              <div className="space-y-4 rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm sm:p-5">
                <h2 className="font-display text-xl tracking-wide uppercase">Confirm and submit</h2>
                <div className="flex items-baseline justify-between gap-3 border-b border-border/70 pb-4">
                  <span className="text-sm font-medium">Estimated total</span>
                  <span className="font-display text-2xl text-primary">{formatPHP(total)}</span>
                </div>
                <div>
                  <TermsAgreement
                    id="booking-terms"
                    checked={terms}
                    onCheckedChange={(value) => {
                      setTerms(value);
                      clearErrors("terms");
                    }}
                    terms={bookingTerms}
                    invalid={Boolean(errors.terms)}
                  />
                  <FieldError message={errors.terms} className="mt-2" />
                </div>
                <TurnstileChallenge
                  resetKey={bookingRequestId}
                  onToken={setTurnstileToken}
                  label={
                    isReschedule
                      ? "Complete the security check to submit your reschedule request."
                      : "Complete the security check to submit your booking."
                  }
                />
                <Button
                  type="submit"
                  size="lg"
                  disabled={
                    !rescheduleReady || mutation.isPending || (turnstileEnabled && !turnstileToken)
                  }
                  className="w-full font-display tracking-wide uppercase"
                >
                  {mutation.isPending ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  {mutation.isPending
                    ? "Submitting request…"
                    : isReschedule
                      ? "Submit reschedule request"
                      : "Submit booking request"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={returnToBookingDetails}
                  className="w-full"
                >
                  <ArrowLeft aria-hidden="true" /> Back to booking details
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Your request stays pending until the shop confirms it.
                </p>
              </div>
            </aside>
          </div>
        </form>
        {!isReschedule && (
          <>
            <AlertDialog
              open={multiDayContinuationOpen}
              onOpenChange={(open) => {
                setMultiDayContinuationOpen(open);
              }}
            >
              <AlertDialogContent className="sm:max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display text-2xl uppercase">
                    Multi-day service
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The services you selected may require more than one day to complete. If you
                    continue, the remaining service time will be reserved on the next available shop
                    day.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Adjust selection</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={continueWithMultiDayBooking}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    Continue to review
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
                  Choose a different available date for these services, or view your existing
                  appointment on the My Appointment page.
                </p>
                <DialogFooter className="gap-2">
                  <Button asChild variant="outline">
                    <Link to="/my-appointment">Go to My Appointment</Link>
                  </Button>
                  <Button type="button" onClick={chooseAnotherDate}>
                    Choose another date
                  </Button>
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

function BookingSteps({
  current,
  onSelectDetails,
}: {
  current: number;
  onSelectDetails: () => void;
}) {
  return (
    <ol aria-label="Booking progress" className="flex w-full items-center gap-3 md:w-auto">
      {BOOKING_PAGES.map((page, index) => {
        const complete = index < current;
        const isCurrent = index === current;
        const marker = (
          <>
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full border font-display text-sm",
                complete && "border-primary bg-primary text-primary-foreground",
                isCurrent && "border-primary bg-primary/10 text-primary",
                !complete && !isCurrent && "border-border text-muted-foreground",
              )}
            >
              {complete ? <Check className="size-4" aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={cn(
                "text-sm whitespace-nowrap",
                isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {page}
              {complete && <span className="sr-only"> (completed)</span>}
            </span>
          </>
        );
        return (
          <li
            key={page}
            className={cn("flex items-center gap-3", index > 0 && "flex-1 md:flex-none")}
          >
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px min-w-6 flex-1 md:w-10 md:flex-none",
                  complete || isCurrent ? "bg-primary" : "bg-border",
                )}
              />
            )}
            {complete ? (
              <button
                type="button"
                onClick={onSelectDetails}
                className="flex items-center gap-2 rounded-md hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {marker}
              </button>
            ) : (
              <span
                aria-current={isCurrent ? "step" : undefined}
                className="flex items-center gap-2"
              >
                {marker}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ScheduleHint({ children, loading }: { children: React.ReactNode; loading?: boolean }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
      {loading ? (
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Info className="size-4 shrink-0 text-primary" aria-hidden="true" />
      )}
      {children}
    </p>
  );
}

function SummaryRow({
  label,
  done,
  children,
}: {
  label: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          done ? "bg-primary text-primary-foreground" : "border border-border",
        )}
      >
        {done && <Check className="size-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs tracking-widest text-muted-foreground uppercase">{label}</p>
        <div className="mt-0.5 break-words text-foreground">{children}</div>
      </div>
    </div>
  );
}

function SuccessDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card px-5 py-4 text-center sm:text-left">
      <dt className="text-xs tracking-widest text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{children}</dd>
    </div>
  );
}

function ReviewGroup({
  title,
  onEdit,
  editLabel,
  children,
}: {
  title: string;
  onEdit?: () => void;
  editLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card/40 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-sans text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          {title}
        </h3>
        {onEdit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEdit}
            aria-label={editLabel}
            className="-my-1 h-8 px-2 text-primary md:h-8"
          >
            <Pencil aria-hidden="true" /> Edit
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium break-words text-foreground">{value || "—"}</dd>
    </div>
  );
}

function servicePricingLabel(source: "small_bike" | "large_bike") {
  if (source === "large_bike") return "Large Bike rate";
  return "Small Bike rate";
}

function Section({
  id,
  step,
  title,
  description,
  complete,
  error,
  className,
  children,
}: {
  id?: string;
  step?: number;
  title: string;
  description?: string;
  complete?: boolean;
  error?: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      aria-labelledby={titleId}
      className={cn(
        "rounded-xl border border-border/70 bg-card/40 p-4 focus:outline-none sm:p-6",
        className,
      )}
    >
      <div className="mb-5 flex items-start gap-3">
        {step !== undefined && (
          <span
            aria-hidden="true"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full font-display text-base transition-colors",
              complete
                ? "bg-primary text-primary-foreground"
                : "bg-primary/10 text-primary ring-1 ring-primary/30",
            )}
          >
            {complete ? <Check className="size-4" /> : step}
          </span>
        )}
        <div className="min-w-0">
          <h2 id={titleId} className="font-display text-xl tracking-wide uppercase">
            {title}
            {complete && <span className="sr-only"> (complete)</span>}
          </h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children}
      <FieldError message={error} className="mt-3" />
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div
      data-invalid={!!error}
      className="space-y-1.5 data-[invalid=true]:[&_[role=combobox]]:border-destructive data-[invalid=true]:[&_input]:border-destructive data-[invalid=true]:[&_textarea]:border-destructive"
    >
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <FieldError message={error} />
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
