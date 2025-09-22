import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/hooks/use-toast";
import { trpc } from "@/lib/trpc";

// Form schema for updating private tokens
const UpdatePrivateTokenFormSchema = z.object({
  description: z.string().optional(),
  manualPrice: z
    .number()
    .min(0.000001, "Price must be greater than 0")
    .optional(),
  priceDescription: z.string().optional(),
});

type UpdatePrivateTokenFormData = z.infer<typeof UpdatePrivateTokenFormSchema>;

interface UpdatePrivateTokenFormProps {
  isOpen: boolean;
  onClose: () => void;
  token: {
    id: string;
    symbol: string;
    name: string;
  } | null;
  onSuccess?: () => void;
}

export function UpdatePrivateTokenForm({
  isOpen,
  onClose,
  token,
  onSuccess,
}: UpdatePrivateTokenFormProps) {
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const form = useForm<UpdatePrivateTokenFormData>({
    resolver: zodResolver(UpdatePrivateTokenFormSchema),
    defaultValues: {
      description: "",
      manualPrice: undefined,
      priceDescription: "",
    },
  });

  // TRPC mutation for updating token
  const updateToken = trpc.tokens.update.useMutation({
    onSuccess: () => {
      toast({
        title: "✅ Token updated successfully!",
        description: "The private token has been updated.",
      });

      // Invalidate relevant queries since token price updates could affect portfolio values and unpriceable tokens
      utils.holdings.getUnpriceableTokens.invalidate();
      utils.users.getPortfolioValue.invalidate();
      utils.accounts.getSummaries.invalidate();

      if (onSuccess) {
        onSuccess();
      }

      onClose();
      form.reset();
    },
    onError: (error) => {
      toast({
        title: "Error updating token",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Reset form when token changes
  useEffect(() => {
    if (token && isOpen) {
      form.reset({
        description: "",
        manualPrice: undefined,
        priceDescription: "",
      });
    }
  }, [token, isOpen, form]);

  const onSubmit = async (data: UpdatePrivateTokenFormData) => {
    if (!token) return;

    try {
      console.log("Updating private token:", token.id, data);

      await updateToken.mutateAsync({
        id: token.id,
        data: {
          description: data.description || undefined,
          manualPrice: data.manualPrice || undefined,
          priceDescription: data.priceDescription || undefined,
        },
      });
    } catch (error) {
      console.error("Token update failed:", error);
      // Error is already handled by mutation onError
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] sm:max-w-[500px] mx-4 sm:mx-auto">
        <DialogHeader>
          <DialogTitle>Update {token?.symbol}</DialogTitle>
          <DialogDescription>
            Update the description and current price for your private token.
            Changes will be reflected in your portfolio calculations.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Token Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Token Description</Label>
            <Textarea
              {...form.register("description")}
              placeholder="e.g., Private equity investment in Series A"
              className="min-h-[80px]"
            />
            <p className="text-xs text-muted-foreground">
              Update the description for your records and portfolio notes.
            </p>
          </div>

          {/* Current Price Update */}
          <div className="space-y-2">
            <Label htmlFor="manualPrice">New Current Price (USD)</Label>
            <Input
              type="number"
              step="0.000001"
              min="0.000001"
              placeholder="e.g., 1250.00"
              {...form.register("manualPrice", { valueAsNumber: true })}
              className={
                form.formState.errors.manualPrice ? "border-destructive" : ""
              }
            />
            {form.formState.errors.manualPrice && (
              <p className="text-sm text-destructive">
                {form.formState.errors.manualPrice.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Leave empty to keep current price. This will add a new price entry
              with today's date.
            </p>
          </div>

          {/* Price Notes */}
          <div className="space-y-2">
            <Label htmlFor="priceDescription">Price Update Notes</Label>
            <Input
              {...form.register("priceDescription")}
              placeholder="e.g., Updated based on Q4 2025 valuation"
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Optional notes about the price update (required if updating
              price).
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={updateToken.isLoading}
              className="flex items-center gap-2"
            >
              {updateToken.isLoading && (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-background border-t-foreground" />
              )}
              Update Token
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
