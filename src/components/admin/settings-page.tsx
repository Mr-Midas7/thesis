import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import {
  Building2,
  CalendarClock,
  Eye,
  EyeOff,
  ImageUp,
  Loader2,
  LockKeyhole,
  Save,
  Store,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/admin/page-header";
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
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { recordAdminActivityEvent } from "@/lib/admin-activity";
import {
  DEFAULT_BOOKING_HOURS,
  DEFAULT_BOOKING_TERMS,
  isValidBookingHours,
  SHOP,
} from "@/lib/shop";
import { cn } from "@/lib/utils";

type SettingsTab = "shop" | "appointments" | "account";

type ShopSettingsForm = {
  address: string;
  contactNumber: string;
  contactEmail: string;
  bookingTerms: string;
  openingTime: string;
  closingTime: string;
  minimumBookingLeadHours: number;
  maxAdvanceBookingDays: number;
  defaultAppointmentDurationMinutes: number;
  allowSameDayAppointments: boolean;
  cancellationNoticeHours: number;
  reschedulingNoticeHours: number;
};

type AccountForm = {
  name: string;
  email: string;
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
  avatarUrl: string | null;
};

type SettingsErrorField =
  | "contactEmail"
  | "operatingHours"
  | "minimumBookingLeadHours"
  | "maxAdvanceBookingDays"
  | "defaultAppointmentDurationMinutes"
  | "cancellationNoticeHours"
  | "reschedulingNoticeHours";

type AccountErrorField =
  "name" | "email" | "currentPassword" | "newPassword" | "confirmNewPassword" | "profilePicture";

const defaultSettings: ShopSettingsForm = {
  address: SHOP.address,
  contactNumber: SHOP.phone,
  contactEmail: SHOP.email,
  bookingTerms: DEFAULT_BOOKING_TERMS,
  openingTime: DEFAULT_BOOKING_HOURS.openingTime,
  closingTime: DEFAULT_BOOKING_HOURS.closingTime,
  minimumBookingLeadHours: SHOP.noticeHours,
  maxAdvanceBookingDays: 30,
  defaultAppointmentDurationMinutes: 90,
  allowSameDayAppointments: false,
  cancellationNoticeHours: SHOP.noticeHours,
  reschedulingNoticeHours: SHOP.noticeHours,
};

const settingFieldLabels: Array<[keyof ShopSettingsForm, string]> = [
  ["address", "Address"],
  ["contactNumber", "Contact number"],
  ["contactEmail", "Contact email"],
  ["bookingTerms", "Booking terms & conditions"],
  ["openingTime", "Opening time"],
  ["closingTime", "Closing time"],
  ["minimumBookingLeadHours", "Minimum booking lead time"],
  ["maxAdvanceBookingDays", "Maximum advance booking"],
  ["defaultAppointmentDurationMinutes", "Default appointment duration"],
  ["allowSameDayAppointments", "Same-day appointments"],
  ["cancellationNoticeHours", "Cancellation rule"],
  ["reschedulingNoticeHours", "Rescheduling rule"],
];

const tabLabels: Record<Exclude<SettingsTab, "account">, string> = {
  shop: "Shop information",
  appointments: "Appointment settings",
};

const settingKeysByTab: Record<Exclude<SettingsTab, "account">, Array<keyof ShopSettingsForm>> = {
  shop: ["address", "contactNumber", "contactEmail", "bookingTerms"],
  appointments: [
    "openingTime",
    "closingTime",
    "minimumBookingLeadHours",
    "maxAdvanceBookingDays",
    "defaultAppointmentDurationMinutes",
    "allowSameDayAppointments",
    "cancellationNoticeHours",
    "reschedulingNoticeHours",
  ],
};

function fromDatabase(row: {
  address: string;
  contact_number: string;
  contact_email: string;
  booking_terms: string;
  opening_time: string;
  closing_time: string;
  minimum_booking_lead_hours: number;
  max_advance_booking_days: number;
  default_appointment_duration_minutes: number;
  allow_same_day_appointments: boolean;
  cancellation_notice_hours: number;
  rescheduling_notice_hours: number;
}): ShopSettingsForm {
  return {
    address: row.address,
    contactNumber: row.contact_number,
    contactEmail: row.contact_email,
    bookingTerms: row.booking_terms,
    openingTime: row.opening_time.slice(0, 5),
    closingTime: row.closing_time.slice(0, 5),
    minimumBookingLeadHours: row.minimum_booking_lead_hours,
    maxAdvanceBookingDays: row.max_advance_booking_days,
    defaultAppointmentDurationMinutes: row.default_appointment_duration_minutes,
    allowSameDayAppointments: row.allow_same_day_appointments,
    cancellationNoticeHours: row.cancellation_notice_hours,
    reschedulingNoticeHours: row.rescheduling_notice_hours,
  };
}

function changedSettingFields(
  previous: ShopSettingsForm,
  next: ShopSettingsForm,
  section: Exclude<SettingsTab, "account">,
) {
  return settingFieldLabels
    .filter(([key]) => settingKeysByTab[section].includes(key) && previous[key] !== next[key])
    .map(([, label]) => label);
}

async function uploadAsset(file: File, folder: string) {
  if (!file.type.match(/^image\/(jpeg|png|webp)$/)) {
    throw new Error("Choose a JPG, PNG, or WebP image.");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("Images must be 5 MB or smaller.");

  const extension = file.type.split("/")[1] ?? "png";
  const path = `${folder}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from("shop-assets").upload(path, file, {
    cacheControl: "3600",
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
  return supabase.storage.from("shop-assets").getPublicUrl(path).data.publicUrl;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<SettingsTab>("shop");
  const [settings, setSettings] = useState<ShopSettingsForm>(defaultSettings);
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<AccountForm>({
    name: "",
    email: "",
    currentPassword: "",
    newPassword: "",
    confirmNewPassword: "",
    avatarUrl: null,
  });
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  const [settingsErrors, setSettingsErrors] = useState<
    Partial<Record<SettingsErrorField, string | undefined>>
  >({});
  const [accountErrors, setAccountErrors] = useState<
    Partial<Record<AccountErrorField, string | undefined>>
  >({});
  const [pendingSave, setPendingSave] = useState<SettingsTab | null>(null);

  const savedSettings = useQuery({
    queryKey: ["shop-settings"],
    queryFn: async (): Promise<ShopSettingsForm> => {
      const { data, error } = await supabase
        .from("shop_settings")
        .select("*")
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return data ? fromDatabase(data) : defaultSettings;
    },
  });

  useEffect(() => {
    if (savedSettings.data) setSettings(savedSettings.data);
  }, [savedSettings.data]);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      const currentUser = data.user;
      setUser(currentUser ?? null);
      if (!currentUser) return;
      setAccount({
        name:
          (typeof currentUser.user_metadata["full_name"] === "string" &&
            currentUser.user_metadata["full_name"]) ||
          currentUser.email?.split("@")[0] ||
          "Administrator",
        email: currentUser.email ?? "",
        currentPassword: "",
        newPassword: "",
        confirmNewPassword: "",
        avatarUrl:
          typeof currentUser.user_metadata["avatar_url"] === "string"
            ? currentUser.user_metadata["avatar_url"]
            : null,
      });
    });
  }, []);

  useEffect(
    () => () => {
      if (avatarPreview?.startsWith("blob:")) URL.revokeObjectURL(avatarPreview);
    },
    [avatarPreview],
  );

  const saveSettings = useMutation({
    mutationFn: async (section: Exclude<SettingsTab, "account">) => {
      const previous = savedSettings.data ?? defaultSettings;
      const next = settings;
      const updates =
        section === "shop"
          ? {
              address: next.address.trim(),
              contact_number: next.contactNumber.trim(),
              contact_email: next.contactEmail.trim().toLowerCase(),
              booking_terms: next.bookingTerms.trim(),
            }
          : {
              opening_time: next.openingTime,
              closing_time: next.closingTime,
              minimum_booking_lead_hours: next.minimumBookingLeadHours,
              max_advance_booking_days: next.maxAdvanceBookingDays,
              default_appointment_duration_minutes: next.defaultAppointmentDurationMinutes,
              allow_same_day_appointments: next.allowSameDayAppointments,
              cancellation_notice_hours: next.cancellationNoticeHours,
              rescheduling_notice_hours: next.reschedulingNoticeHours,
            };
      const { error } = await supabase
        .from("shop_settings")
        .upsert({ id: true, ...updates }, { onConflict: "id" });
      if (error) throw error;
      const persisted = {
        ...previous,
        ...Object.fromEntries(settingKeysByTab[section].map((key) => [key, next[key]])),
      } as ShopSettingsForm;
      return {
        persisted,
        section,
        changedFields: changedSettingFields(previous, persisted, section),
      };
    },
    onSuccess: async ({ persisted, section, changedFields }) => {
      setSettings((current) => ({
        ...current,
        ...Object.fromEntries(settingKeysByTab[section].map((key) => [key, persisted[key]])),
      }));
      queryClient.setQueryData(["shop-settings"], persisted);
      queryClient.invalidateQueries({ queryKey: ["public-shop-settings"] });
      if (changedFields.length) {
        try {
          await recordAdminActivityEvent({
            action: "updated",
            resourceType: "Settings",
            targetLabel: tabLabels[section],
            summary: `${tabLabels[section]} updated.`,
            changedFields,
          });
          queryClient.invalidateQueries({ queryKey: ["admin-activity-logs"] });
        } catch (error) {
          console.error("Settings activity log failed", error);
        }
      }
      toast.success(`${tabLabels[section]} saved.`);
    },
    onError: (error: Error, section) => {
      const message = error.message || "Could not save settings.";
      if (message.includes("contact email")) setSettingsErrors({ contactEmail: message });
      else if (section === "appointments") setSettingsErrors({ minimumBookingLeadHours: message });
      else setSettingsErrors({ contactEmail: message });
    },
  });

  const saveAccount = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Your account could not be loaded. Please refresh the page.");
      if (!account.name.trim()) throw new Error("Enter the administrator name.");
      if (!/^\S+@\S+\.\S+$/.test(account.email.trim())) {
        throw new Error("Enter a valid email address.");
      }
      if (account.newPassword || account.confirmNewPassword || account.currentPassword) {
        if (!account.currentPassword) throw new Error("Enter your current password first.");
        if (account.newPassword.length < 8)
          throw new Error("Your new password needs at least 8 characters.");
        if (account.newPassword !== account.confirmNewPassword) {
          throw new Error("The new passwords do not match.");
        }
        const { error } = await supabase.auth.signInWithPassword({
          email: user.email ?? "",
          password: account.currentPassword,
        });
        if (error) throw new Error("Your current password is incorrect.");
      }

      const oldName =
        (typeof user.user_metadata["full_name"] === "string" && user.user_metadata["full_name"]) ||
        user.email?.split("@")[0] ||
        "Administrator";
      const changedFields = [
        ...(oldName !== account.name.trim() ? ["Administrator name"] : []),
        ...(user.email !== account.email.trim().toLowerCase() ? ["Email address"] : []),
        ...(avatarFile ? ["Profile picture"] : []),
        ...(account.newPassword ? ["Password"] : []),
      ];
      const avatarUrl = avatarFile
        ? await uploadAsset(avatarFile, `admin-profiles/${user.id}`)
        : account.avatarUrl;
      const { data, error } = await supabase.auth.updateUser({
        email: account.email.trim().toLowerCase(),
        ...(account.newPassword ? { password: account.newPassword } : {}),
        data: { full_name: account.name.trim(), avatar_url: avatarUrl },
      });
      if (error) throw error;
      return { user: data.user, avatarUrl, changedFields };
    },
    onSuccess: async ({ user: updatedUser, avatarUrl, changedFields }) => {
      setUser(updatedUser);
      setAvatarFile(null);
      setAvatarPreview(null);
      setAccount((current) => ({
        ...current,
        email: updatedUser.email ?? current.email,
        avatarUrl,
        currentPassword: "",
        newPassword: "",
        confirmNewPassword: "",
      }));
      if (changedFields.length) {
        try {
          await recordAdminActivityEvent({
            action: "updated",
            resourceType: "Account Settings",
            targetLabel: "Administrator profile",
            summary: "Administrator account settings updated.",
            changedFields,
          });
          queryClient.invalidateQueries({ queryKey: ["admin-activity-logs"] });
        } catch (error) {
          console.error("Account settings activity log failed", error);
        }
      }
      toast.success("Account changes saved. Email updates may require confirmation.");
    },
    onError: (error: Error) => {
      const message = error.message || "Could not save account changes.";
      if (message.includes("JPG, PNG") || message.includes("Images must be")) {
        setAccountErrors({ profilePicture: message });
      } else if (message.includes("administrator name")) setAccountErrors({ name: message });
      else if (message.includes("email")) setAccountErrors({ email: message });
      else if (message.includes("current password")) setAccountErrors({ currentPassword: message });
      else if (message.includes("new password needs")) setAccountErrors({ newPassword: message });
      else if (message.includes("passwords do not match")) {
        setAccountErrors({ confirmNewPassword: message });
      } else setAccountErrors({ currentPassword: message });
    },
  });

  function setSetting<K extends keyof ShopSettingsForm>(key: K, value: ShopSettingsForm[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function validateSettings(section: Exclude<SettingsTab, "account">) {
    const nextErrors: Partial<Record<SettingsErrorField, string | undefined>> = {};

    if (section === "shop") {
      if (!/^\S+@\S+\.\S+$/.test(settings.contactEmail.trim())) {
        nextErrors.contactEmail = "Enter a valid shop contact email.";
      }
    }

    if (section === "appointments") {
      if (!isValidBookingHours(settings.openingTime, settings.closingTime)) {
        nextErrors.operatingHours =
          "Choose 30-minute times with an opening time before the closing time.";
      }
      if (settings.minimumBookingLeadHours < 0 || settings.minimumBookingLeadHours > 168) {
        nextErrors.minimumBookingLeadHours = "Enter a value from 0 to 168 hours.";
      }
      if (settings.maxAdvanceBookingDays < 1 || settings.maxAdvanceBookingDays > 365) {
        nextErrors.maxAdvanceBookingDays = "Enter a value from 1 to 365 days.";
      }
      if (
        settings.defaultAppointmentDurationMinutes < 15 ||
        settings.defaultAppointmentDurationMinutes > 600
      ) {
        nextErrors.defaultAppointmentDurationMinutes = "Enter a value from 15 to 600 minutes.";
      }
      if (settings.cancellationNoticeHours < 0 || settings.cancellationNoticeHours > 168) {
        nextErrors.cancellationNoticeHours = "Enter a value from 0 to 168 hours.";
      }
      if (settings.reschedulingNoticeHours < 0 || settings.reschedulingNoticeHours > 168) {
        nextErrors.reschedulingNoticeHours = "Enter a value from 0 to 168 hours.";
      }
    }

    setSettingsErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function requestSave(section: SettingsTab) {
    if (section === "account") {
      if (validateAccount()) setPendingSave(section);
      return;
    }
    if (validateSettings(section)) setPendingSave(section);
  }

  function confirmSave() {
    if (!pendingSave) return;
    if (pendingSave === "account") saveAccount.mutate();
    else saveSettings.mutate(pendingSave);
    setPendingSave(null);
  }

  function validateAccount() {
    const nextErrors: Partial<Record<AccountErrorField, string | undefined>> = {};
    if (account.name.trim().length < 2) {
      nextErrors.name = "Enter an administrator name with at least 2 characters.";
    }
    if (!/^\S+@\S+\.\S+$/.test(account.email.trim())) {
      nextErrors.email = "Enter a valid email address.";
    }

    const changingPassword = Boolean(
      account.currentPassword || account.newPassword || account.confirmNewPassword,
    );
    if (changingPassword) {
      if (!account.currentPassword) nextErrors.currentPassword = "Enter your current password.";
      if (account.newPassword.length < 8) {
        nextErrors.newPassword = "Your new password needs at least 8 characters.";
      }
      if (account.newPassword !== account.confirmNewPassword) {
        nextErrors.confirmNewPassword = "The new passwords do not match.";
      }
    }

    setAccountErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function chooseImage(
    event: React.ChangeEvent<HTMLInputElement>,
    setFile: (file: File | null) => void,
    setPreview: (preview: string | null) => void,
  ) {
    const file = event.target.files?.[0] ?? null;
    setFile(file);
    setPreview(file ? URL.createObjectURL(file) : null);
  }

  const avatar = avatarPreview ?? account.avatarUrl;
  const pendingSaveLabel =
    pendingSave === "account"
      ? "account changes"
      : pendingSave
        ? tabLabels[pendingSave]
        : "settings";

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Settings"
        description="Manage customer-facing shop details, booking rules, and your administrator account."
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as SettingsTab)}>
        <TabsList className="grid h-auto w-full grid-cols-3 bg-secondary/50 p-1 md:inline-flex md:w-auto">
          <TabsTrigger value="shop" className="w-full gap-2 md:w-auto">
            <Store className="h-4 w-4" /> Shop information
          </TabsTrigger>
          <TabsTrigger value="appointments" className="w-full gap-2 md:w-auto">
            <CalendarClock className="h-4 w-4" /> Appointments
          </TabsTrigger>
          <TabsTrigger value="account" className="w-full gap-2 md:w-auto">
            <UserRound className="h-4 w-4" /> Account
          </TabsTrigger>
        </TabsList>

        {savedSettings.isError ? (
          <Card className="mt-6 border-destructive/40 bg-card/60">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
              <p className="text-destructive">
                Could not load the saved settings. Please try again.
              </p>
              <Button type="button" variant="outline" onClick={() => void savedSettings.refetch()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : savedSettings.isLoading ? (
          <Card className="mt-6 border-border/70 bg-card/60">
            <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading saved settings…
            </CardContent>
          </Card>
        ) : (
          <>
            <TabsContent value="shop" className="mt-6 space-y-5">
              <Card className="border-border/70 bg-card/60">
                <CardContent className="p-5 sm:p-6">
                  <div className="grid gap-5 md:grid-cols-2">
                    <Field label="Contact email">
                      <Input
                        type="email"
                        value={settings.contactEmail}
                        onChange={(e) => {
                          setSetting("contactEmail", e.target.value);
                          setSettingsErrors((current) => ({ ...current, contactEmail: undefined }));
                        }}
                        aria-invalid={!!settingsErrors.contactEmail}
                      />
                      <FieldError message={settingsErrors.contactEmail} />
                    </Field>
                    <Field label="Contact number">
                      <Input
                        value={settings.contactNumber}
                        onChange={(e) => setSetting("contactNumber", e.target.value)}
                      />
                    </Field>
                    <div className="rounded-lg border border-border bg-secondary/30 p-4 text-xs leading-relaxed text-muted-foreground">
                      <Building2 className="mb-2 h-4 w-4 text-primary" />
                      This information can appear on customer-facing appointment pages and receipts.
                    </div>
                    <Field label="Shop address" className="md:col-span-2">
                      <Textarea
                        value={settings.address}
                        onChange={(e) => setSetting("address", e.target.value)}
                      />
                    </Field>
                    <Field label="Booking terms & conditions" className="md:col-span-2">
                      <Textarea
                        value={settings.bookingTerms}
                        onChange={(e) => setSetting("bookingTerms", e.target.value)}
                        className="min-h-36"
                      />
                    </Field>
                  </div>
                </CardContent>
              </Card>
              <SaveButton
                loading={saveSettings.isPending}
                onClick={() => requestSave("shop")}
                label="Save shop information"
              />
            </TabsContent>

            <TabsContent value="appointments" className="mt-6 space-y-5">
              <div className="grid gap-5 md:grid-cols-2">
                <SettingsCard
                  title="Booking window"
                  icon={<CalendarClock className="h-5 w-5 text-primary" />}
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Shop opens">
                      <Input
                        type="time"
                        step="1800"
                        value={settings.openingTime}
                        onChange={(event) => {
                          setSetting("openingTime", event.target.value);
                          setSettingsErrors((current) => ({
                            ...current,
                            operatingHours: undefined,
                          }));
                        }}
                        aria-invalid={!!settingsErrors.operatingHours}
                      />
                    </Field>
                    <Field label="Shop closes">
                      <Input
                        type="time"
                        step="1800"
                        value={settings.closingTime}
                        onChange={(event) => {
                          setSetting("closingTime", event.target.value);
                          setSettingsErrors((current) => ({
                            ...current,
                            operatingHours: undefined,
                          }));
                        }}
                        aria-invalid={!!settingsErrors.operatingHours}
                      />
                    </Field>
                  </div>
                  <FieldError message={settingsErrors.operatingHours} />
                  <p className="text-xs text-muted-foreground">
                    Customer appointment starts and service durations must fit within these hours.
                  </p>
                  <Field label="Minimum booking lead time">
                    <NumberInput
                      value={settings.minimumBookingLeadHours}
                      suffix="hours before appointment"
                      min={0}
                      max={168}
                      invalid={!!settingsErrors.minimumBookingLeadHours}
                      onChange={(value) => {
                        setSetting("minimumBookingLeadHours", value);
                        setSettingsErrors((current) => ({
                          ...current,
                          minimumBookingLeadHours: undefined,
                        }));
                      }}
                    />
                    <FieldError message={settingsErrors.minimumBookingLeadHours} />
                  </Field>
                  <Field label="Maximum advance booking">
                    <NumberInput
                      value={settings.maxAdvanceBookingDays}
                      suffix="days"
                      min={1}
                      max={365}
                      invalid={!!settingsErrors.maxAdvanceBookingDays}
                      onChange={(value) => {
                        setSetting("maxAdvanceBookingDays", value);
                        setSettingsErrors((current) => ({
                          ...current,
                          maxAdvanceBookingDays: undefined,
                        }));
                      }}
                    />
                    <FieldError message={settingsErrors.maxAdvanceBookingDays} />
                  </Field>
                  <Field label="Default appointment duration">
                    <NumberInput
                      value={settings.defaultAppointmentDurationMinutes}
                      suffix="minutes"
                      min={15}
                      max={600}
                      invalid={!!settingsErrors.defaultAppointmentDurationMinutes}
                      onChange={(value) => {
                        setSetting("defaultAppointmentDurationMinutes", value);
                        setSettingsErrors((current) => ({
                          ...current,
                          defaultAppointmentDurationMinutes: undefined,
                        }));
                      }}
                    />
                    <FieldError message={settingsErrors.defaultAppointmentDurationMinutes} />
                  </Field>
                </SettingsCard>
                <SettingsCard
                  title="Appointment policies"
                  icon={<CalendarClock className="h-5 w-5 text-primary" />}
                >
                  <ToggleRow
                    label="Enable same-day appointments"
                    description="Customers can book later today when the lead time allows it."
                    checked={settings.allowSameDayAppointments}
                    onCheckedChange={(value) => setSetting("allowSameDayAppointments", value)}
                  />
                  <Field label="Cancellation rule">
                    <NumberInput
                      value={settings.cancellationNoticeHours}
                      suffix="hours notice required"
                      min={0}
                      max={168}
                      invalid={!!settingsErrors.cancellationNoticeHours}
                      onChange={(value) => {
                        setSetting("cancellationNoticeHours", value);
                        setSettingsErrors((current) => ({
                          ...current,
                          cancellationNoticeHours: undefined,
                        }));
                      }}
                    />
                    <FieldError message={settingsErrors.cancellationNoticeHours} />
                  </Field>
                  <Field label="Rescheduling rule">
                    <NumberInput
                      value={settings.reschedulingNoticeHours}
                      suffix="hours notice required"
                      min={0}
                      max={168}
                      invalid={!!settingsErrors.reschedulingNoticeHours}
                      onChange={(value) => {
                        setSetting("reschedulingNoticeHours", value);
                        setSettingsErrors((current) => ({
                          ...current,
                          reschedulingNoticeHours: undefined,
                        }));
                      }}
                    />
                    <FieldError message={settingsErrors.reschedulingNoticeHours} />
                  </Field>
                </SettingsCard>
              </div>
              <p className="rounded-lg border border-border bg-card/60 p-4 text-sm text-muted-foreground">
                The booking window and cancellation notice are enforced on customer bookings.
                Individual service durations still determine the reserved service time.
              </p>
              <SaveButton
                loading={saveSettings.isPending}
                onClick={() => requestSave("appointments")}
                label="Save appointment settings"
              />
            </TabsContent>

            <TabsContent value="account" className="mt-6 space-y-5">
              <Card className="border-border/70 bg-card/60">
                <CardContent className="p-5 sm:p-6">
                  <div className="mb-6 flex flex-wrap items-center gap-4 border-b border-border/70 pb-5">
                    <div className="grid h-16 w-16 overflow-hidden rounded-full border border-border bg-secondary/50">
                      {avatar ? (
                        <img
                          src={avatar}
                          alt="Profile preview"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <UserRound className="m-auto h-7 w-7 text-primary" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">Profile picture</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Use a square JPG, PNG, or WebP image.
                      </p>
                    </div>
                    <UploadButton
                      label="Change photo"
                      invalid={!!accountErrors.profilePicture}
                      onChange={(event) => {
                        chooseImage(event, setAvatarFile, setAvatarPreview);
                        setAccountErrors((current) => ({ ...current, profilePicture: undefined }));
                      }}
                    />
                    <FieldError
                      message={accountErrors.profilePicture}
                      className="w-full basis-full"
                    />
                  </div>
                  <div className="grid gap-5 md:grid-cols-2">
                    <Field label="Administrator name">
                      <Input
                        value={account.name}
                        onChange={(e) => {
                          setAccount((current) => ({ ...current, name: e.target.value }));
                          setAccountErrors((current) => ({ ...current, name: undefined }));
                        }}
                        aria-invalid={!!accountErrors.name}
                      />
                      <FieldError message={accountErrors.name} />
                    </Field>
                    <Field label="Email address">
                      <Input
                        type="email"
                        value={account.email}
                        onChange={(e) => {
                          setAccount((current) => ({ ...current, email: e.target.value }));
                          setAccountErrors((current) => ({ ...current, email: undefined }));
                        }}
                        aria-invalid={!!accountErrors.email}
                      />
                      <FieldError message={accountErrors.email} />
                    </Field>
                  </div>
                </CardContent>
              </Card>
              <SettingsCard
                title="Change password"
                icon={<LockKeyhole className="h-5 w-5 text-primary" />}
              >
                <p className="-mt-2 text-xs text-muted-foreground">
                  Leave these fields blank to keep your current password.
                </p>
                <div className="grid gap-5 md:grid-cols-3">
                  <Field label="Current password">
                    <div className="relative">
                      <Input
                        type={showCurrentPassword ? "text" : "password"}
                        autoComplete="current-password"
                        value={account.currentPassword}
                        onChange={(e) => {
                          setAccount((current) => ({
                            ...current,
                            currentPassword: e.target.value,
                          }));
                          setAccountErrors((current) => ({
                            ...current,
                            currentPassword: undefined,
                          }));
                        }}
                        aria-invalid={!!accountErrors.currentPassword}
                        className="pr-11"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute top-0 right-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowCurrentPassword((visible) => !visible)}
                        aria-label={
                          showCurrentPassword ? "Hide current password" : "Show current password"
                        }
                        aria-pressed={showCurrentPassword}
                      >
                        {showCurrentPassword ? <EyeOff /> : <Eye />}
                      </Button>
                    </div>
                    <FieldError message={accountErrors.currentPassword} />
                  </Field>
                  <Field label="New password">
                    <div className="relative">
                      <Input
                        type={showNewPassword ? "text" : "password"}
                        autoComplete="new-password"
                        value={account.newPassword}
                        onChange={(e) => {
                          setAccount((current) => ({ ...current, newPassword: e.target.value }));
                          setAccountErrors((current) => ({ ...current, newPassword: undefined }));
                        }}
                        aria-invalid={!!accountErrors.newPassword}
                        className="pr-11"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute top-0 right-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowNewPassword((visible) => !visible)}
                        aria-label={showNewPassword ? "Hide new password" : "Show new password"}
                        aria-pressed={showNewPassword}
                      >
                        {showNewPassword ? <EyeOff /> : <Eye />}
                      </Button>
                    </div>
                    <FieldError message={accountErrors.newPassword} />
                  </Field>
                  <Field label="Confirm new password">
                    <div className="relative">
                      <Input
                        type={showConfirmNewPassword ? "text" : "password"}
                        autoComplete="new-password"
                        value={account.confirmNewPassword}
                        onChange={(e) => {
                          setAccount((current) => ({
                            ...current,
                            confirmNewPassword: e.target.value,
                          }));
                          setAccountErrors((current) => ({
                            ...current,
                            confirmNewPassword: undefined,
                          }));
                        }}
                        aria-invalid={!!accountErrors.confirmNewPassword}
                        className="pr-11"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute top-0 right-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowConfirmNewPassword((visible) => !visible)}
                        aria-label={
                          showConfirmNewPassword
                            ? "Hide confirmed password"
                            : "Show confirmed password"
                        }
                        aria-pressed={showConfirmNewPassword}
                      >
                        {showConfirmNewPassword ? <EyeOff /> : <Eye />}
                      </Button>
                    </div>
                    <FieldError message={accountErrors.confirmNewPassword} />
                  </Field>
                </div>
              </SettingsCard>
              <SaveButton
                loading={saveAccount.isPending}
                onClick={() => requestSave("account")}
                label="Save account changes"
              />
            </TabsContent>
          </>
        )}
      </Tabs>
      <AlertDialog
        open={pendingSave !== null}
        onOpenChange={(open) => !open && setPendingSave(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save {pendingSaveLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirm that you want to apply these changes. The updated settings will take effect
              immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSave}>Save changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SettingsCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/70 bg-card/60">
      <CardContent className="p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3 border-b border-border/70 pb-4">
          {icon}
          <h2 className="font-display text-lg tracking-wide uppercase">{title}</h2>
        </div>
        <div className="space-y-5">{children}</div>
      </CardContent>
    </Card>
  );
}

function NumberInput({
  value,
  suffix,
  min,
  max,
  invalid,
  onChange,
}: {
  value: number;
  suffix: string;
  min: number;
  max: number;
  invalid?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        aria-invalid={invalid}
        className="w-24 shrink-0"
      />
      <span className="min-w-0 text-xs leading-snug text-muted-foreground">{suffix}</span>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} className="mt-1 shrink-0" />
    </div>
  );
}

function UploadButton({
  label,
  invalid,
  onChange,
}: {
  label: string;
  invalid?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <Label
      className={cn(
        "inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent",
        invalid && "border-destructive ring-1 ring-destructive/30",
      )}
    >
      <ImageUp className="h-4 w-4" /> {label}
      <Input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        aria-invalid={invalid}
        onChange={onChange}
      />
    </Label>
  );
}

function SaveButton({
  loading,
  onClick,
  label,
}: {
  loading: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <div className="flex justify-stretch sm:justify-end">
      <Button
        type="button"
        disabled={loading}
        onClick={onClick}
        className="w-full sm:min-w-52 sm:w-auto"
      >
        {loading ? <Loader2 className="animate-spin" /> : <Save />} {label}
      </Button>
    </div>
  );
}
