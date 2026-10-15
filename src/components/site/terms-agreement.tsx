import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

/** Terms checkbox with a readable Terms and Conditions dialog. */
export function TermsAgreement({
  id,
  checked,
  onCheckedChange,
  terms,
  invalid,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  terms: string;
  invalid?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-sm transition-colors",
        invalid ? "border-destructive bg-destructive/5" : "border-border/70 bg-muted/20",
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-invalid={invalid}
        className="mt-1"
      />
      <div className="leading-6">
        <label htmlFor={id}>I have read and agree to the </label>
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              className="font-bold text-primary underline decoration-primary/70 underline-offset-4 transition-colors hover:text-primary/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
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
                Please read the complete booking terms before submitting your request.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border/70 bg-card/50 p-4 text-sm leading-6 whitespace-pre-line text-muted-foreground">
              {terms}
            </div>
            <DialogFooter className="gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Close
                </Button>
              </DialogClose>
              <DialogClose asChild>
                <Button type="button" onClick={() => onCheckedChange(true)}>
                  I agree to the terms
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <span>.</span>
      </div>
    </div>
  );
}
