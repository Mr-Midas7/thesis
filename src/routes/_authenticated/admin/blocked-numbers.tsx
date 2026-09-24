import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, Plus } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/admin/page-header";
import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
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
        return "restored" as const;
      }

      const { error } = await supabase.from("blocked_numbers").insert({
        phone: normalizedPhone,
        reason: reason.trim() || null,
      });
      if (error) throw error;
      return "blocked" as const;
    },
    onSuccess: (result) => {
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

  return (
    <div>
      <PageHeader
        title="Blocked Customers"
        description="Phone numbers blocked from booking online."
        action={
          <Button
            className="font-display uppercase"
            onClick={() => {
              setPhone("");
              setReason("");
              setPhoneError("");
              setOpen(true);
            }}
          >
            <Plus /> Block number
          </Button>
        }
      />
      {archiveError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {archiveError}
        </p>
      )}

      <Card className="max-w-5xl border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <Table className="admin-data-table admin-balanced-table">
            <colgroup>
              <col style={{ width: "25%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "25%" }} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Phone</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-center">Blocked on</TableHead>
                <TableHead className="text-center">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {blocked.data?.map((b) => (
                <TableRow key={b.id}>
                  <TableCell data-label="Phone" className="font-mono text-sm">
                    {toLocalPhilippineMobile(b.phone)}
                  </TableCell>
                  <TableCell
                    data-label="Reason"
                    className="break-words text-sm text-muted-foreground"
                  >
                    {b.reason || "—"}
                  </TableCell>
                  <TableCell
                    data-label="Blocked on"
                    className="whitespace-nowrap text-center text-xs text-muted-foreground"
                  >
                    {new Date(b.created_at).toLocaleDateString("en-PH", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </TableCell>
                  <TableCell data-label="Action" className="text-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setArchiveTarget(b.id)}
                      disabled={archive.isPending}
                    >
                      <Archive className="h-4 w-4" /> Archive
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {blocked.data?.length === 0 && !blocked.isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No blocked numbers.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
    </div>
  );
}
