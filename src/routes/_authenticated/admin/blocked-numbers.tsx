import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, Ban, Plus } from "lucide-react";
import { useState } from "react";

import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
import {
  AdminPage,
  DataList,
  InlineAlert,
  ListCard,
  ListEmpty,
  ListToolbar,
  ResetFiltersButton,
  ToolbarSearch,
} from "@/components/admin/data-list";
import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
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
import { formatShortDate } from "@/lib/admin-date-range";
import {
  PHONE_VALIDATION_MESSAGE,
  phoneSchema,
  sanitizePhilippineMobileInput,
  toLocalPhilippineMobile,
} from "@/lib/shop";

type BlockedNumber = {
  id: string;
  phone: string;
  reason: string | null;
  created_at: string;
  created_by: string | null;
  is_archived: boolean;
};

export const Route = createFileRoute("/_authenticated/admin/blocked-numbers")({
  component: BlockedNumbersPage,
});

function BlockedNumbersPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState("");
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const blocked = useQuery({
    queryKey: ["blocked-numbers"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("blocked_numbers")
        .select("*")
        .eq("is_archived", false)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as BlockedNumber[];
    },
  });

  const add = useMutation({
    mutationFn: async (normalizedPhone: string) => {
      const existing = await supabase
        .from("blocked_numbers")
        .select("id,is_archived")
        .ilike("phone", normalizedPhone)
        .maybeSingle();
      if (existing.error) throw existing.error;

      if (existing.data) {
        if (!existing.data.is_archived) {
          throw new Error("This phone number is already blocked.");
        }

        const { error } = await supabase
          .from("blocked_numbers")
          .update({ is_archived: false, reason: reason.trim() || null })
          .eq("id", existing.data.id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase.from("blocked_numbers").insert({
        phone: normalizedPhone,
        reason: reason.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setPhone("");
      setReason("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["blocked-numbers"], exact: false });
      qc.invalidateQueries({ queryKey: ["archived-blocked-numbers"], exact: false });
    },
    onError: (err: Error) => {
      const msg = err.message.toLowerCase();
      if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("already blocked")) {
        setPhoneError("This phone number is already blocked.");
      } else {
        console.error("Block failed:", err);
        setPhoneError("Could not block this number. Please try again.");
      }
    },
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("blocked_numbers")
        .update({ is_archived: true })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, id) => {
      qc.setQueryData<BlockedNumber[]>(["blocked-numbers"], (numbers) =>
        numbers?.filter((number) => number.id !== id),
      );
      setArchiveError(null);
      qc.invalidateQueries({ queryKey: ["blocked-numbers"], exact: false });
      qc.invalidateQueries({ queryKey: ["archived-blocked-numbers"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Archive failed:", err);
      setArchiveError("Could not archive this blocked customer. Please try again.");
    },
  });

  const handleAdd = async () => {
    let normalizedPhone: string;
    try {
      normalizedPhone = phoneSchema.parse(phone);
    } catch {
      setPhoneError(PHONE_VALIDATION_MESSAGE);
      return;
    }
    add.mutate(normalizedPhone);
  };

  const searchTerm = search.trim().toLocaleLowerCase();
  const searchDigits = searchTerm.replace(/\D/g, "");
  const filtered = (blocked.data ?? []).filter(
    (b) =>
      !searchTerm ||
      (searchDigits && toLocalPhilippineMobile(b.phone).includes(searchDigits)) ||
      (b.reason ?? "").toLocaleLowerCase().includes(searchTerm),
  );

  const openBlockDialog = () => {
    setPhone("");
    setReason("");
    setPhoneError("");
    setOpen(true);
  };

  return (
    <AdminPage>
      <PageHeader
        title="Blocked Customers"
        description="Phone numbers blocked from booking online."
        action={
          <Button className="font-display uppercase" onClick={openBlockDialog}>
            <Plus /> Block number
          </Button>
        }
      />
      {archiveError && <InlineAlert>{archiveError}</InlineAlert>}

      <ListToolbar
        summary={
          blocked.data && `Showing ${filtered.length} of ${blocked.data.length} blocked numbers`
        }
      >
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder="Search number or reason"
          label="Search blocked numbers by phone number or reason"
        />
      </ListToolbar>

      <ListCard>
        <DataList
          label="Blocked numbers"
          rows={filtered}
          rowKey={(b) => b.id}
          loading={blocked.isLoading}
          error={
            blocked.isError
              ? {
                  message: "Could not load blocked numbers.",
                  onRetry: () => void blocked.refetch(),
                }
              : null
          }
          empty={
            <ListEmpty
              icon={Ban}
              title={search ? "No blocked numbers match your search." : "No blocked numbers."}
              description={
                search
                  ? "Try a different number or reason."
                  : "Numbers you block can't book online and will need to call the shop."
              }
              action={
                search ? (
                  <ResetFiltersButton onClick={() => setSearch("")} />
                ) : (
                  <Button size="sm" onClick={openBlockDialog}>
                    <Plus /> Block number
                  </Button>
                )
              }
            />
          }
          // Fixed-width columns first and the free-text reason last, so the
          // space between columns stays even however long a reason is.
          columns={[
            {
              key: "phone",
              header: "Phone",
              card: "title",
              className: "w-40",
              cell: (b) => (
                <span className="font-mono text-sm font-medium">
                  {toLocalPhilippineMobile(b.phone)}
                </span>
              ),
            },
            {
              key: "created",
              header: "Blocked on",
              className: "w-36",
              cell: (b) => <span className="text-sm">{formatShortDate(b.created_at)}</span>,
            },
            {
              key: "reason",
              header: "Reason",
              card: "wide",
              className: "pr-8",
              cell: (b) => (
                <span className="text-sm text-muted-foreground">
                  {b.reason || "No reason given"}
                </span>
              ),
            },
          ]}
          actionsClassName="w-32"
          actions={(b) => (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setArchiveTarget(b.id)}
              disabled={archive.isPending}
              aria-label={`Archive blocked number ${toLocalPhilippineMobile(b.phone)}`}
            >
              <Archive /> Archive
            </Button>
          )}
        />
      </ListCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display uppercase">Block a number</DialogTitle>
            <DialogDescription>
              Blocked numbers cannot book online. They’ll need to call the shop.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Phone number</Label>
              <Input
                type="tel"
                value={phone}
                maxLength={11}
                inputMode="numeric"
                autoComplete="tel"
                onChange={(e) => {
                  setPhone(sanitizePhilippineMobileInput(e.target.value));
                  setPhoneError("");
                }}
                placeholder="09171234567"
                aria-invalid={!!phoneError}
              />
              <FieldError message={phoneError} />
            </div>
            <div className="space-y-1.5">
              <Label>Reason (optional)</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="No-shows, abusive behaviour, etc."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={add.isPending || !phone.trim()}>
              {add.isPending ? "Blocking…" : "Block"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ArchiveConfirmationDialog
        open={Boolean(archiveTarget)}
        recordLabel="blocked customer"
        pending={archive.isPending}
        onOpenChange={(nextOpen) => !nextOpen && setArchiveTarget(null)}
        onConfirm={() => {
          if (archiveTarget) archive.mutate(archiveTarget);
          setArchiveTarget(null);
        }}
      />
    </AdminPage>
  );
}
