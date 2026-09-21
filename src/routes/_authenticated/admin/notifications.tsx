import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BellRing, CheckCheck, CheckCircle2, CircleX, Trash2 } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/notifications")({
  component: NotificationsPage,
});

function NotificationsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const list = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select(
          "*, appointments(status, reference_code, customer_name, phone, reschedule_count, pending_reschedule_request_id, pending_reschedule_date, pending_reschedule_start_time, pending_reschedule_reason)",
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
    onSuccess: refresh,
  });

  const markAll = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("is_read", false);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("All notifications marked as read.");
      refresh();
    },
    onError: () => toast.error("Could not update notifications."),
  });

  const viewAppointment = useMutation({
    mutationFn: async ({ id, isRead }: { id: string; isRead: boolean; appointmentId: string }) => {
      if (isRead) return;
      const { error } = await supabase.from("notifications").update({ is_read: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: async (_, notification) => {
      refresh();
      await navigate({
        to: "/admin/appointments",
        search: { appointmentId: notification.appointmentId },
      });
    },
    onError: () => toast.error("Could not open this appointment. Please try again."),
  });

  const deleteNotification = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("notifications").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Notification removed.");
      refresh();
    },
    onError: (err: Error) => {
      console.error("Delete notification failed:", err);
      toast.error(`Could not remove notification: ${err.message}`);
    },
  });

  const removeAllRead = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("notifications").delete().eq("is_read", true);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("All read notifications removed.");
      refresh();
    },
    onError: (err: Error) => {
      console.error("Remove read notifications failed:", err);
      toast.error(`Could not remove read notifications: ${err.message}`);
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
      toast.success(
        decision === "confirmed"
          ? "Appointment confirmed and an available crew member was assigned."
          : "Appointment rejected.",
      );
      refresh();
      queryClient.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["reports"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-appointments"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Appointment review failed:", err);
      toast.error(err.message || "Could not review this appointment.");
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
      toast.success(
        decision === "confirmed"
          ? "Reschedule request confirmed. A new linked booking was created with its own reference code."
          : "Reschedule request rejected. The original appointment remains reserved.",
      );
      refresh();
      queryClient.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["reports"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Reschedule review failed:", err);
      toast.error(err.message || "Could not review this reschedule request.");
    },
  });

  const rows = list.data ?? [];
  const unread = rows.filter((n) => !n.is_read).length;
  const read = rows.length - unread;

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Review new appointments and view booking updates, newest first."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="uppercase"
              disabled={unread === 0}
              onClick={() => markAll.mutate()}
            >
              <CheckCheck /> Mark all read
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

      <div className="space-y-3">
        {rows.map((n) => (
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
                    });
                  }}
                >
                  View appointment
                </Button>
                {!n.is_read && (
                  <Button size="sm" variant="ghost" onClick={() => markOne.mutate(n.id)}>
                    Mark read
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => deleteNotification.mutate(n.id)}
                  title="Remove notification"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {list.isError ? (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="p-10 text-center text-sm text-destructive">
              Could not load notifications. {(list.error as Error).message || "Please try again."}
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
