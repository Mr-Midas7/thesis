import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BellRing, CheckCheck, CheckCircle2, CircleX, Clock3, Play, Trash2 } from "lucide-react";
import { useState } from "react";

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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/notifications")({
  component: NotificationsPage,
});

const SERVICE_PROGRESS_NOTIFICATION_TYPES = new Set(["service_arrival", "service_completion"]);

function isServiceProgressNotification(type: string) {
  return SERVICE_PROGRESS_NOTIFICATION_TYPES.has(type);
}

function NotificationsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [noShowTarget, setNoShowTarget] = useState<{
    appointmentId: string;
    referenceCode: string;
  } | null>(null);

  const list = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select(
          "*, appointments(status, reference_code, customer_name, phone, reschedule_count, pending_reschedule_request_id, pending_reschedule_date, pending_reschedule_start_time, pending_reschedule_reason, arrival_notification_snooze_count, service_started_at, service_ended_at)",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    queryClient.invalidateQueries({ queryKey: ["unread-notifications"] });
  }

  const markOne = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("notifications").update({ is_read: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      refresh();
    },
    onError: () => setActionError("Could not mark this notification as read. Please try again."),
  });

  const markAll = useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return;
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      refresh();
    },
    onError: () => setActionError("Could not update notifications. Please try again."),
  });

  const viewAppointment = useMutation({
    mutationFn: async ({
      id,
      isRead,
      keepActive,
    }: {
      id: string;
      isRead: boolean;
      appointmentId: string;
      keepActive: boolean;
    }) => {
      if (isRead || keepActive) return;
      const { error } = await supabase.from("notifications").update({ is_read: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: async (_, notification) => {
      setActionError(null);
      refresh();
      await navigate({
        to: "/admin/appointments",
        search: { appointmentId: notification.appointmentId },
      });
    },
    onError: () => setActionError("Could not open this appointment. Please try again."),
  });

  const deleteNotification = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("notifications").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      refresh();
    },
    onError: (err: Error) => {
      console.error("Delete notification failed:", err);
      setActionError("Could not remove this notification. Please try again.");
    },
  });

  const removeAllRead = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("notifications").delete().eq("is_read", true);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      refresh();
    },
    onError: (err: Error) => {
      console.error("Remove read notifications failed:", err);
      setActionError("Could not remove the read notifications. Please try again.");
    },
  });

  const reviewPendingAppointment = useMutation({
    mutationFn: async ({
      appointmentId,
      decision,
    }: {
      appointmentId: string;
      decision: "confirmed" | "rejected";
    }) => {
      const { error } = await supabase.rpc("review_pending_appointment", {
        p_appointment_id: appointmentId,
        p_decision: decision,
      });
      if (error) throw error;
    },
    onSuccess: (_, { decision }) => {
      setActionError(null);
      refresh();
      queryClient.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["reports"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-appointments"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Appointment review failed:", err);
      setActionError("Could not review this appointment. Please try again.");
    },
  });

  const reviewRescheduleRequest = useMutation({
    mutationFn: async ({
      appointmentId,
      decision,
    }: {
      appointmentId: string;
      decision: "confirmed" | "rejected";
    }) => {
      const { error } = await supabase.rpc("review_reschedule_request", {
        p_appointment_id: appointmentId,
        p_decision: decision,
      });
      if (error) throw error;
    },
    onSuccess: (_, { decision }) => {
      setActionError(null);
      refresh();
      queryClient.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["reports"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Reschedule review failed:", err);
      setActionError("Could not review this reschedule request. Please try again.");
    },
  });

  const updateServiceProgress = useMutation({
    mutationFn: async ({
      appointmentId,
      action,
    }: {
      appointmentId: string;
      action: "start" | "snooze_arrival" | "no_show" | "complete" | "snooze_completion";
    }) => {
      const { error } = await supabase.rpc("manage_appointment_service_progress", {
        p_appointment_id: appointmentId,
        p_action: action,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      refresh();
      queryClient.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["reports"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Service progress update failed:", err);
      setActionError("Could not update service progress. Refresh the page and try again.");
    },
  });

  const rows = list.data ?? [];
  const unread = rows.filter((n) => !n.is_read).length;
  const read = rows.length - unread;
  const nonProgressUnreadIds = rows
    .filter((n) => !n.is_read && !isServiceProgressNotification(n.type))
    .map((n) => n.id);

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Review appointments, booking updates, and active service progress alerts."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="uppercase"
              disabled={nonProgressUnreadIds.length === 0 || markAll.isPending}
              onClick={() => markAll.mutate(nonProgressUnreadIds)}
            >
              <CheckCheck /> Mark other read
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="uppercase"
                  disabled={read === 0 || removeAllRead.isPending}
                >
                  <Trash2 /> Remove all read
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove all read notifications?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes {read} notification{read === 1 ? "" : "s"} that have already been
                    read. Unread notifications will remain unchanged.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={removeAllRead.isPending}
                    onClick={() => removeAllRead.mutate()}
                  >
                    {removeAllRead.isPending && <Trash2 className="animate-pulse" />} Remove all
                    read
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />

      {actionError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {actionError}
        </p>
      )}

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(nextOpen) => !nextOpen && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this notification?</AlertDialogTitle>
            <AlertDialogDescription>
              This notification will be permanently removed from the admin inbox.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteNotification.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteNotification.isPending}
              onClick={() => {
                if (deleteTarget) deleteNotification.mutate(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Remove notification
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(noShowTarget)}
        onOpenChange={(nextOpen) => !nextOpen && setNoShowTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this appointment as no-show?</AlertDialogTitle>
            <AlertDialogDescription>
              {noShowTarget
                ? `This will mark ${noShowTarget.referenceCode} as no-show. This cannot be changed back to a pre-service status.`
                : "This will mark the appointment as no-show."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateServiceProgress.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={updateServiceProgress.isPending}
              onClick={() => {
                if (noShowTarget) {
                  updateServiceProgress.mutate({
                    appointmentId: noShowTarget.appointmentId,
                    action: "no_show",
                  });
                }
                setNoShowTarget(null);
              }}
            >
              Mark no-show
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-3">
        {rows.map((n) => {
          const isServiceProgress = isServiceProgressNotification(n.type);
          const canStartService =
            n.type === "service_arrival" &&
            n.appointments?.status === "confirmed" &&
            !n.appointments.service_started_at;
          const canCompleteService =
            n.type === "service_completion" &&
            n.appointments?.status === "in_progress" &&
            Boolean(n.appointments.service_started_at) &&
            !n.appointments.service_ended_at;
          const arrivalSnoozes = n.appointments?.arrival_notification_snooze_count ?? 0;

          return (
            <Card
              key={n.id}
              className={cn(
                "border-border/70 bg-card/60",
                !n.is_read && "border-primary/50 bg-primary/5",
              )}
            >
              <CardContent className="flex flex-wrap items-start gap-4 p-4">
                <BellRing
                  className={cn(
                    "mt-0.5 h-5 w-5",
                    n.is_read ? "text-muted-foreground" : "text-primary",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{n.title}</p>
                  {n.message && <p className="mt-1 text-sm text-muted-foreground">{n.message}</p>}
                  <p className="mt-1 text-[11px] tracking-wider text-muted-foreground uppercase">
                    {new Date(n.created_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {n.appointment_id && canStartService && (
                    <>
                      <Button
                        size="sm"
                        className="bg-emerald-600 text-white hover:bg-emerald-700"
                        disabled={updateServiceProgress.isPending}
                        onClick={() =>
                          updateServiceProgress.mutate({
                            appointmentId: n.appointment_id!,
                            action: "start",
                          })
                        }
                      >
                        <Play className="h-4 w-4" /> In Progress
                      </Button>
                      {arrivalSnoozes >= 3 ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={updateServiceProgress.isPending}
                          onClick={() =>
                            setNoShowTarget({
                              appointmentId: n.appointment_id!,
                              referenceCode: n.appointments?.reference_code ?? "this appointment",
                            })
                          }
                        >
                          <CircleX className="h-4 w-4" /> No-Show
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={updateServiceProgress.isPending}
                          onClick={() =>
                            updateServiceProgress.mutate({
                              appointmentId: n.appointment_id!,
                              action: "snooze_arrival",
                            })
                          }
                        >
                          <Clock3 className="h-4 w-4" /> Snooze 5 min
                        </Button>
                      )}
                    </>
                  )}
                  {n.appointment_id && canCompleteService && (
                    <>
                      <Button
                        size="sm"
                        className="bg-emerald-600 text-white hover:bg-emerald-700"
                        disabled={updateServiceProgress.isPending}
                        onClick={() =>
                          updateServiceProgress.mutate({
                            appointmentId: n.appointment_id!,
                            action: "complete",
                          })
                        }
                      >
                        <CheckCircle2 className="h-4 w-4" /> Completed
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updateServiceProgress.isPending}
                        onClick={() =>
                          updateServiceProgress.mutate({
                            appointmentId: n.appointment_id!,
                            action: "snooze_completion",
                          })
                        }
                      >
                        <Clock3 className="h-4 w-4" /> Snooze 5 min
                      </Button>
                    </>
                  )}
                  {n.appointment_id &&
                    n.type !== "reschedule_request" &&
                    n.appointments?.status === "pending" &&
                    !n.appointments.pending_reschedule_request_id && (
                      <>
                        <Button
                          size="sm"
                          className="bg-emerald-600 text-white hover:bg-emerald-700"
                          disabled={reviewPendingAppointment.isPending}
                          onClick={() =>
                            reviewPendingAppointment.mutate({
                              appointmentId: n.appointment_id!,
                              decision: "confirmed",
                            })
                          }
                        >
                          <CheckCircle2 className="h-4 w-4" /> Confirmed
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={reviewPendingAppointment.isPending}
                          onClick={() =>
                            reviewPendingAppointment.mutate({
                              appointmentId: n.appointment_id!,
                              decision: "rejected",
                            })
                          }
                        >
                          <CircleX className="h-4 w-4" /> Rejected
                        </Button>
                      </>
                    )}
                  {n.appointment_id &&
                    n.type === "reschedule_request" &&
                    n.appointments?.pending_reschedule_request_id && (
                      <>
                        <Button
                          size="sm"
                          className="bg-emerald-600 text-white hover:bg-emerald-700"
                          disabled={
                            reviewRescheduleRequest.isPending ||
                            (n.appointments.reschedule_count ?? 0) >= 3
                          }
                          onClick={() =>
                            reviewRescheduleRequest.mutate({
                              appointmentId: n.appointment_id!,
                              decision: "confirmed",
                            })
                          }
                        >
                          <CheckCircle2 className="h-4 w-4" /> Confirm
                        </Button>
                        {(n.appointments.reschedule_count ?? 0) >= 3 && (
                          <p className="basis-full text-xs text-destructive">
                            Maximum of 3 reschedules reached. This request can only be rejected.
                          </p>
                        )}
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={reviewRescheduleRequest.isPending}
                          onClick={() =>
                            reviewRescheduleRequest.mutate({
                              appointmentId: n.appointment_id!,
                              decision: "rejected",
                            })
                          }
                        >
                          <CircleX className="h-4 w-4" /> Reject
                        </Button>
                      </>
                    )}
                  {n.type === "customer_cancellation_threshold" && n.appointments?.phone && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const customerPhone = n.appointments?.phone;
                        if (!customerPhone) return;
                        if (!n.is_read) markOne.mutate(n.id);
                        void navigate({
                          to: "/admin/customers",
                          search: { phone: customerPhone },
                        });
                      }}
                    >
                      Review customer history
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!n.appointment_id || viewAppointment.isPending}
                    onClick={() => {
                      if (!n.appointment_id) return;
                      viewAppointment.mutate({
                        id: n.id,
                        isRead: n.is_read,
                        appointmentId: n.appointment_id,
                        keepActive: isServiceProgress,
                      });
                    }}
                  >
                    View appointment
                  </Button>
                  {!n.is_read && !isServiceProgress && (
                    <Button size="sm" variant="ghost" onClick={() => markOne.mutate(n.id)}>
                      Mark read
                    </Button>
                  )}
                  {!isServiceProgress && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={deleteNotification.isPending}
                      onClick={() => setDeleteTarget(n.id)}
                      title="Remove notification"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {list.isError ? (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="p-10 text-center text-sm text-destructive">
              Could not load notifications. Please try again.
            </CardContent>
          </Card>
        ) : (
          rows.length === 0 && (
            <Card className="border-border/70 bg-card/60">
              <CardContent className="p-10 text-center text-sm text-muted-foreground">
                {list.isLoading ? "Loading notifications..." : "No notifications yet."}
              </CardContent>
            </Card>
          )
        )}
      </div>
    </div>
  );
}
