import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  Ban,
  Bell,
  Bike,
  CalendarDays,
  CalendarX,
  ClipboardList,
  Clock,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  Package,
  Settings,
  Tags,
  UserCheck,
  Users,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import logo from "@/assets/logo-shp.png.asset.json";
import { ThemeToggle } from "@/components/site/theme-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { supabase } from "@/integrations/supabase/client";
import { recordAdminActivityEvent } from "@/lib/admin-activity";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminLayout,
});

const groups = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", url: "/admin", icon: LayoutDashboard },
      { title: "Appointments Management", url: "/admin/appointments", icon: CalendarDays },
    ],
  },
  {
    label: "Shop",
    items: [
      { title: "Services", url: "/admin/services", icon: Wrench },
      { title: "Parts & Accessories", url: "/admin/parts", icon: Package },
      { title: "Motorcycle Catalog", url: "/admin/motorcycles", icon: Bike },
    ],
  },
  {
    label: "Business",
    items: [
      { title: "Prices Management", url: "/admin/prices", icon: Tags },
      { title: "Customer List", url: "/admin/customers", icon: Users },
    ],
  },
  {
    label: "Staff",
    items: [
      { title: "Mechanics", url: "/admin/mechanics", icon: UserCheck },
      { title: "Availability", url: "/admin/availability", icon: CalendarDays },
      { title: "Blocked Customers", url: "/admin/blocked-numbers", icon: Ban },
    ],
  },
  {
    label: "Shop Schedule",
    items: [{ title: "Schedule Blocks", url: "/admin/schedule-blocks", icon: CalendarX }],
  },
  {
    label: "Records",
    items: [
      { title: "Reports", url: "/admin/reports", icon: ClipboardList },
      { title: "Archive", url: "/admin/archive", icon: Archive },
      { title: "Activity Log", url: "/admin/activity-log", icon: History },
    ],
  },
  {
    label: "Settings",
    items: [{ title: "Settings", url: "/admin/settings", icon: Settings }],
  },
];

const ADMIN_INACTIVITY_TIMEOUT_MINUTES = 15;
const ADMIN_INACTIVITY_TIMEOUT_MS = ADMIN_INACTIVITY_TIMEOUT_MINUTES * 60_000;
const ADMIN_INACTIVITY_WARNING_MS = 60_000;
const ADMIN_INACTIVITY_CHECK_INTERVAL_MS = 1_000;
const NOTIFICATION_POLL_INTERVAL_MS = 30_000;
const ADMIN_SESSION_HEARTBEAT_INTERVAL_MS = 30_000;

function AdminLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const lastActivityAtRef = useRef(Date.now());
  // Mirrors inactivityDeadline for the window listeners, which must not
  // re-subscribe every time the warning opens or closes.
  const inactivityWarningOpenRef = useRef(false);
  const inactivitySignOutStartedRef = useRef(false);
  const signingOutRef = useRef(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [inactivityDeadline, setInactivityDeadline] = useState<number | null>(null);

  const role = useQuery({
    queryKey: ["my-role"],
    queryFn: async () => {
      const { data } = await supabase.from("user_roles").select("role");
      return (data ?? []).map((r) => r.role);
    },
  });

  const unread = useQuery({
    queryKey: ["unread-notifications"],
    queryFn: async () => {
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("is_read", false);
      return count ?? 0;
    },
    refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    const channel = supabase
      .channel("admin-notifications")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => {
        queryClient.invalidateQueries({ queryKey: ["unread-notifications"] });
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({ queryKey: ["admin-appointments"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const signOut = useCallback(
    async (reason: "manual" | "inactivity" | "public") => {
      if (signingOutRef.current) return;
      signingOutRef.current = true;
      setIsSigningOut(true);
      setSignOutError(null);

      void recordAdminActivityEvent({
        action: "signed out",
        resourceType: "Authentication",
        targetLabel: "Admin console",
        summary:
          reason === "inactivity"
            ? `Administrator was automatically signed out after ${ADMIN_INACTIVITY_TIMEOUT_MINUTES} minutes of inactivity.`
            : reason === "public"
              ? "Administrator signed out before visiting the public site."
              : "Administrator signed out of the admin console.",
      }).catch(() => {
        // Sign-out should always complete, even if the audit service is unavailable.
      });

      try {
        // Release the database lease before clearing the local Supabase session.
        // If the request cannot complete (for example, the browser is offline),
        // the short server-side lease expires automatically.
        const { error: releaseError } = await supabase.rpc("release_admin_session");
        if (releaseError)
          console.warn("Could not release the administrator session:", releaseError);

        const { error } = await supabase.auth.signOut({ scope: "local" });
        if (error) throw error;

        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || data.session) {
          throw new Error("The administrator session could not be cleared.");
        }

        await queryClient.cancelQueries();
        queryClient.clear();
        await navigate({ to: reason === "inactivity" ? "/auth" : "/", replace: true });
      } catch (error) {
        console.error("Could not sign out of the admin console:", error);
        setSignOutError("Could not sign out. Please try again.");
      } finally {
        signingOutRef.current = false;
        setIsSigningOut(false);
      }
    },
    [navigate, queryClient],
  );

  const staySignedIn = useCallback(() => {
    if (signingOutRef.current) return;
    lastActivityAtRef.current = Date.now();
    inactivityWarningOpenRef.current = false;
    inactivitySignOutStartedRef.current = false;
    setInactivityDeadline(null);
    setSignOutError(null);
  }, []);

  const isAdmin = (role.data ?? []).includes("admin");

  useEffect(() => {
    if (!isAdmin) return;

    let isMounted = true;
    let isRenewing = false;
    const renewSession = async () => {
      if (isRenewing || signingOutRef.current) return;
      isRenewing = true;
      try {
        const { data: renewed, error } = await supabase.rpc("renew_admin_session");
        if (!isMounted || (!error && renewed)) return;

        // A lease can be lost after it expires, after a server-side logout, or
        // when another approved session handover completes.
        await supabase.auth.signOut({ scope: "local" });
        await queryClient.cancelQueries();
        queryClient.clear();
        await navigate({ to: "/auth", replace: true });
      } finally {
        isRenewing = false;
      }
    };

    void renewSession();
    const intervalId = window.setInterval(
      () => void renewSession(),
      ADMIN_SESSION_HEARTBEAT_INTERVAL_MS,
    );
    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [isAdmin, navigate, queryClient]);

  useEffect(() => {
    if (!isAdmin) return;

    let isActive = true;
    let isSyncing = false;
    const syncServiceProgressNotifications = async () => {
      if (isSyncing) return;
      isSyncing = true;
      try {
        const { data, error } = await supabase.rpc("sync_service_progress_notifications");
        if (!isActive || error || !data) return;
        queryClient.invalidateQueries({ queryKey: ["unread-notifications"] });
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({ queryKey: ["admin-appointments"] });
      } finally {
        isSyncing = false;
      }
    };

    void syncServiceProgressNotifications();
    const intervalId = window.setInterval(
      () => void syncServiceProgressNotifications(),
      NOTIFICATION_POLL_INTERVAL_MS,
    );

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [isAdmin, queryClient]);

  useEffect(() => {
    if (!isAdmin) return;

    lastActivityAtRef.current = Date.now();
    inactivityWarningOpenRef.current = false;
    inactivitySignOutStartedRef.current = false;

    const recordActivity = () => {
      // Once the warning is showing, only an explicit choice keeps the session,
      // so a stray mouse movement cannot dismiss it unseen.
      if (inactivityWarningOpenRef.current || signingOutRef.current) return;
      lastActivityAtRef.current = Date.now();
    };

    // Compare timestamps instead of relying on one long timer: browsers delay
    // timers in background tabs, and the countdown must stay accurate when the
    // administrator returns to the tab.
    const checkInactivity = () => {
      if (signingOutRef.current) return;
      const deadline = lastActivityAtRef.current + ADMIN_INACTIVITY_TIMEOUT_MS;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Try once per timeout. If sign-out fails, the warning stays open with
        // the error so the administrator can retry or keep working.
        if (inactivitySignOutStartedRef.current) return;
        inactivitySignOutStartedRef.current = true;
        inactivityWarningOpenRef.current = true;
        setInactivityDeadline(deadline);
        void signOut("inactivity");
      } else if (remaining <= ADMIN_INACTIVITY_WARNING_MS && !inactivityWarningOpenRef.current) {
        inactivityWarningOpenRef.current = true;
        setInactivityDeadline(deadline);
      }
    };

    const activityEvents = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"] as const;
    for (const eventName of activityEvents) {
      // Capture also sees scrolling inside dialogs and panels, which does not bubble.
      window.addEventListener(eventName, recordActivity, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", checkInactivity);
    const intervalId = window.setInterval(checkInactivity, ADMIN_INACTIVITY_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", checkInactivity);
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, recordActivity, { capture: true });
      }
    };
  }, [isAdmin, signOut]);

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar collapsible="icon">
          <SidebarContent>
            <div className="flex-shrink-0">
              <div className="flex items-center gap-2 px-3 py-4">
                <img src={logo.url} alt="Fake Rider logo" className="h-16 w-auto object-contain" />
                <span className="-ml-4 font-display text-sm leading-tight tracking-wide uppercase">
                  Fake Rider
                  <span className="block text-[10px] text-muted-foreground">Admin console</span>
                </span>
              </div>
            </div>
            {groups.map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel className="text-[10px] tracking-[0.2em] uppercase">
                  {group.label}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => (
                      <SidebarMenuItem key={item.url}>
                        <SidebarMenuButton
                          asChild
                          isActive={path === item.url}
                          tooltip={item.title}
                        >
                          <Link to={item.url} className="flex items-center gap-2">
                            <item.icon className="h-4 w-4" />
                            <span className="truncate text-xs uppercase">{item.title}</span>
                            {item.url === "/admin/notifications" && (unread.data ?? 0) > 0 && (
                              <Badge className="ml-auto h-5 min-w-5 justify-center bg-primary px-1 text-[10px] text-primary-foreground">
                                {unread.data}
                              </Badge>
                            )}
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
        </Sidebar>

        <div className="flex min-h-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex min-h-14 items-center gap-2 border-b border-border bg-background/90 px-3 py-1.5 backdrop-blur md:h-14 md:px-4 md:py-0">
            <SidebarTrigger className="shrink-0" />
            <button
              type="button"
              onClick={() => void signOut("public")}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:w-auto md:gap-2 md:px-2"
              disabled={isSigningOut}
            >
              <Home className="h-4 w-4" />
              <span className="hidden text-xs uppercase md:inline">Public site</span>
              <span className="sr-only md:hidden">View public site</span>
            </button>
            <ThemeToggle className="shrink-0" />
            <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
              <Link
                to="/admin/notifications"
                className="relative inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:h-9 md:w-9"
                aria-label="View notifications"
              >
                <Bell className="h-5 w-5 text-muted-foreground" />
                {(unread.data ?? 0) > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {unread.data}
                  </span>
                )}
              </Link>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void signOut("manual")}
                className="font-display uppercase"
                disabled={isSigningOut}
              >
                <LogOut /> <span className="hidden sm:inline">Exit</span>
              </Button>
            </div>
          </header>

          <main className="flex-1 p-4 md:p-6">
            {signOutError && (
              <p role="alert" className="mb-4 text-sm text-destructive">
                {signOutError}
              </p>
            )}
            {role.isLoading ? (
              <p className="text-sm text-muted-foreground">Checking your access...</p>
            ) : isAdmin ? (
              <Outlet />
            ) : (
              <div className="mx-auto max-w-md rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
                <h1 className="font-display text-xl uppercase">No admin access</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  This account is signed in but has no administrator role for the shop console.
                </p>
                <Button
                  className="mt-5 font-display uppercase"
                  variant="outline"
                  onClick={() => void signOut("manual")}
                  disabled={isSigningOut}
                >
                  Exit
                </Button>
              </div>
            )}
          </main>
        </div>
      </div>
      <InactivityWarningDialog
        deadline={inactivityDeadline}
        isSigningOut={isSigningOut}
        error={signOutError}
        onStay={staySignedIn}
        onSignOut={() => void signOut("manual")}
      />
    </SidebarProvider>
  );
}

function InactivityWarningDialog({
  deadline,
  isSigningOut,
  error,
  onStay,
  onSignOut,
}: {
  deadline: number | null;
  isSigningOut: boolean;
  error: string | null;
  onStay: () => void;
  onSignOut: () => void;
}) {
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());

  // The countdown ticks here so the admin page behind the dialog does not
  // re-render every second.
  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [deadline]);

  const secondsLeft = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1_000));

  return (
    <AlertDialog
      open={deadline !== null}
      onOpenChange={(open) => {
        if (!open && !isSigningOut) onStay();
      }}
    >
      <AlertDialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          stayButtonRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center justify-center gap-2 font-display uppercase sm:justify-start">
            <Clock className="h-5 w-5 text-primary" aria-hidden="true" /> Stay signed in?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isSigningOut
              ? "Signing you out…"
              : secondsLeft > 0
                ? `You haven't used the admin console for a while. For your security, you'll be signed out in ${secondsLeft} ${secondsLeft === 1 ? "second" : "seconds"}, and any unsaved changes will be lost.`
                : "Your session timed out because of inactivity."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <Button variant="outline" onClick={onSignOut} disabled={isSigningOut}>
            <LogOut /> Sign out now
          </Button>
          <AlertDialogAction ref={stayButtonRef} onClick={onStay} disabled={isSigningOut}>
            Stay signed in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
