import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil, RotateCcw } from "lucide-react";
import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { toast } from "sonner";

import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
import { activeStatusTone, formatPHP } from "@/lib/shop";

type Product = {
  id: string;
  name: string;
  category: "part" | "accessory";
  brand: string | null;
  description: string | null;
  price: number;
  image_url: string | null;
  in_stock: boolean;
  stock_quantity: number;
  is_featured: boolean;
  is_active: boolean;
};

const blank = {
  name: "",
  brand: "",
  description: "",
  price: "",
  image_url: "",
  stock_quantity: "",
  is_featured: false,
  is_active: true,
};

const ALL_BRANDS = "__all_brands__";
const NO_BRAND = "__no_brand__";
const NEW_BRAND = "__new_brand__";

export interface ProductManagerHandle {
  openNew: () => void;
}

/** Shop inventory only. Motorcycle records use MotorcycleCatalogManager. */
export const ProductManager = forwardRef<ProductManagerHandle, { category: "part" | "accessory" }>(
  function ProductManager({ category }, ref) {
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState<Product | null>(null);
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({ ...blank });
    const [formErrors, setFormErrors] = useState<
      Partial<Record<"name" | "price" | "stockQuantity" | "imageUrl" | "imageFile", string>>
    >({});
    const [isCustomBrand, setIsCustomBrand] = useState(false);
    const [filterBrand, setFilterBrand] = useState(ALL_BRANDS);
    const [filterStock, setFilterStock] = useState<"all" | "in_stock" | "out">("all");
    const [imageSource, setImageSource] = useState<"url" | "local">("url");
    const [uploadedFile, setUploadedFile] = useState<File | null>(null);
    const [uploadPreview, setUploadPreview] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [archiveTarget, setArchiveTarget] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({ openNew }));

    const items = useQuery({
      queryKey: ["admin-products", category],
      queryFn: async (): Promise<Product[]> => {
        const { data, error } = await supabase
          .from("products")
          .select("*")
          .in("category", category === "part" ? ["part", "accessory"] : [category])
          .eq("is_archived", false)
          .order("sort_order");
        if (error) throw error;
        return (data ?? []) as Product[];
      },
    });

    const brands = useMemo(
      () =>
        Array.from(
          new Set(
            (items.data ?? []).flatMap((item) => (item.brand?.trim() ? [item.brand.trim()] : [])),
          ),
        ).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
      [items.data],
    );

    const filteredItems = useMemo(
      () =>
        (items.data ?? []).filter(
          (item) =>
            (filterBrand === ALL_BRANDS || item.brand === filterBrand) &&
            (filterStock === "all" ||
              (filterStock === "in_stock" ? item.in_stock : !item.in_stock)),
        ),
      [filterBrand, filterStock, items.data],
    );

    const save = useMutation({
      mutationFn: async (): Promise<Product> => {
        let imageUrl = form.image_url.trim() || null;
        if (imageSource === "local" && uploadedFile) {
          setUploading(true);
          try {
            imageUrl = await uploadImage(uploadedFile);
          } finally {
            setUploading(false);
          }
        }

        const stockQuantity = Number(form.stock_quantity);
        const payload = {
          name: form.name.trim(),
          brand: form.brand.trim() || null,
          description: form.description.trim() || null,
          image_url: imageUrl,
          stock_quantity: stockQuantity,
          in_stock: stockQuantity > 0,
          is_featured: form.is_featured,
          is_active: form.is_active,
          category: editing?.category ?? category,
        };
        const result = editing
          ? await supabase.from("products").update(payload).eq("id", editing.id).select().single()
          : await supabase
              .from("products")
              .insert({ ...payload, price: Number(form.price) })
              .select()
              .single();
        if (result.error) throw result.error;
        return result.data as Product;
      },
      onSuccess: () => {
        toast.success(editing ? "Product updated." : "Product added.");
        closeEditor();
        invalidateProductQueries(queryClient);
      },
      onError: (error: Error) => {
        console.error("Could not save product:", error);
        setFormErrors({ name: `Could not save this product: ${error.message}` });
      },
    });

    const archive = useMutation({
      mutationFn: async (id: string) => {
        const { error } = await supabase
          .from("products")
          .update({ is_archived: true })
          .eq("id", id);
        if (error) throw error;
      },
      onSuccess: () => {
        toast.success("Product archived.");
        invalidateProductQueries(queryClient);
      },
      onError: (error: Error) => {
        console.error("Could not archive product:", error);
        toast.error(`Could not archive this product: ${error.message}`);
      },
    });

    function openNew() {
      setEditing(null);
      setForm({ ...blank });
      setFormErrors({});
      setIsCustomBrand(false);
      setImageSource("url");
      setUploadedFile(null);
      setUploadPreview(null);
      setOpen(true);
    }

    function closeEditor() {
      setOpen(false);
      setEditing(null);
      setForm({ ...blank });
      setFormErrors({});
      setUploadedFile(null);
      setUploadPreview(null);
    }

    function openEdit(item: Product) {
      setEditing(item);
      setForm({
        name: item.name,
        brand: item.brand ?? "",
        description: item.description ?? "",
        price: String(item.price),
        image_url: item.image_url ?? "",
        stock_quantity: String(item.stock_quantity),
        is_featured: item.is_featured,
        is_active: item.is_active,
      });
      setIsCustomBrand(Boolean(item.brand) && !brands.includes(item.brand ?? ""));
      setImageSource("url");
      setUploadedFile(null);
      setUploadPreview(null);
      setFormErrors({});
      setOpen(true);
    }

    function validateForm() {
      const errors: typeof formErrors = {};
      if (form.name.trim().length < 2) {
        errors.name = "Enter an item name with at least 2 characters.";
      }
      if (
        !editing &&
        (!form.price.trim() || !Number.isFinite(Number(form.price)) || Number(form.price) < 0)
      ) {
        errors.price = "Enter a valid price of PHP 0 or more.";
      }
      if (
        !form.stock_quantity.trim() ||
        !Number.isInteger(Number(form.stock_quantity)) ||
        Number(form.stock_quantity) < 0
      ) {
        errors.stockQuantity = "Enter a whole stock quantity of 0 or more.";
      }
      if (imageSource === "url" && form.image_url.trim()) {
        try {
          new URL(form.image_url.trim());
        } catch {
          errors.imageUrl = "Enter a valid image URL, including https://, or choose Local Storage.";
        }
      }
      if (imageSource === "local" && uploadedFile && !uploadedFile.type.startsWith("image/")) {
        errors.imageFile = "Choose a valid image file.";
      }
      setFormErrors(errors);
      return Object.keys(errors).length === 0;
    }

    function clearFormError(field: keyof typeof formErrors) {
      setFormErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }

    return (
      <>
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm">Brand</Label>
            <Select value={filterBrand} onValueChange={setFilterBrand}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="All brands" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_BRANDS}>All brands</SelectItem>
                {brands.map((brand) => (
                  <SelectItem key={brand} value={brand}>
                    {brand}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Stock</Label>
            <Select
              value={filterStock}
              onValueChange={(value) => setFilterStock(value as "all" | "in_stock" | "out")}
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stock</SelectItem>
                <SelectItem value="in_stock">In stock</SelectItem>
                <SelectItem value="out">Out of stock</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(filterBrand !== ALL_BRANDS || filterStock !== "all") && (
            <Button
              size="sm"
              variant="outline"
              className="self-end whitespace-nowrap"
              onClick={() => {
                setFilterBrand(ALL_BRANDS);
                setFilterStock("all");
              }}
            >
              <RotateCcw /> Reset
            </Button>
          )}
        </div>

        <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeEditor()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-display uppercase">
                {editing ? "Edit product" : "New product"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`product-name-${category}`}>Item name</Label>
                <Input
                  id={`product-name-${category}`}
                  value={form.name}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, name: event.target.value }));
                    clearFormError("name");
                  }}
                  aria-invalid={Boolean(formErrors.name)}
                />
                <FieldError message={formErrors.name} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`product-brand-${category}`}>Brand</Label>
                <Select
                  value={isCustomBrand ? NEW_BRAND : form.brand || NO_BRAND}
                  onValueChange={(value) => {
                    if (value === NEW_BRAND) {
                      setIsCustomBrand(true);
                      setForm((current) => ({ ...current, brand: "" }));
                    } else {
                      setIsCustomBrand(false);
                      setForm((current) => ({
                        ...current,
                        brand: value === NO_BRAND ? "" : value,
                      }));
                    }
                  }}
                >
                  <SelectTrigger id={`product-brand-${category}`}>
                    <SelectValue placeholder="Select a brand" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_BRAND}>No brand</SelectItem>
                    {brands.map((brand) => (
                      <SelectItem key={brand} value={brand}>
                        {brand}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_BRAND}>Add a new brand…</SelectItem>
                  </SelectContent>
                </Select>
                {isCustomBrand && (
                  <Input
                    value={form.brand}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, brand: event.target.value }))
                    }
                    placeholder="Enter a new brand"
                    aria-label="New brand"
                  />
                )}
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Image source</Label>
                  <Select
                    value={imageSource}
                    onValueChange={(value: "url" | "local") => {
                      setImageSource(value);
                      if (value === "url") {
                        setUploadedFile(null);
                        setUploadPreview(null);
                      } else {
                        setForm((current) => ({ ...current, image_url: "" }));
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="url">URL</SelectItem>
                      <SelectItem value="local">Local Storage</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {imageSource === "url" ? (
                  <div className="space-y-1.5">
                    <Label>Image URL</Label>
                    <Input
                      value={form.image_url}
                      onChange={(event) => {
                        setForm((current) => ({ ...current, image_url: event.target.value }));
                        clearFormError("imageUrl");
                      }}
                      placeholder="https://"
                      aria-invalid={Boolean(formErrors.imageUrl)}
                    />
                    <FieldError message={formErrors.imageUrl} />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label>Upload image</Label>
                    <Input
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        setUploadedFile(file);
                        clearFormError("imageFile");
                        if (!file) {
                          setUploadPreview(null);
                          return;
                        }
                        const reader = new FileReader();
                        reader.onloadend = () => setUploadPreview(reader.result as string);
                        reader.readAsDataURL(file);
                      }}
                      aria-invalid={Boolean(formErrors.imageFile)}
                    />
                    <FieldError message={formErrors.imageFile} />
                    {uploadPreview && (
                      <img
                        src={uploadPreview}
                        alt="Upload preview"
                        className="h-24 w-24 rounded-md object-cover"
                      />
                    )}
                  </div>
                )}
              </div>
              {editing ? (
                <p className="text-xs text-muted-foreground">
                  Current price: {formatPHP(editing.price)}. Change prices in Price Management.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <Label>Price (PHP)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={form.price}
                    onChange={(event) => {
                      setForm((current) => ({ ...current, price: event.target.value }));
                      clearFormError("price");
                    }}
                    placeholder="0.00"
                    aria-invalid={Boolean(formErrors.price)}
                  />
                  <FieldError message={formErrors.price} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Stock quantity</Label>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={form.stock_quantity}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, stock_quantity: event.target.value }));
                    clearFormError("stockQuantity");
                  }}
                  placeholder="0"
                  aria-invalid={Boolean(formErrors.stockQuantity)}
                />
                <FieldError message={formErrors.stockQuantity} />
              </div>
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Textarea
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </div>
              <div className="flex flex-wrap gap-6 pt-1">
                <div className="space-y-1.5">
                  <Label htmlFor="product-active">Status</Label>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      id="product-active"
                      checked={form.is_active}
                      onCheckedChange={(is_active) =>
                        setForm((current) => ({ ...current, is_active }))
                      }
                    />
                    <span
                      className={
                        form.is_active
                          ? "font-medium text-emerald-600 dark:text-emerald-300"
                          : "font-medium text-muted-foreground"
                      }
                    >
                      {form.is_active ? "Active" : "Inactive"}
                    </span>
                  </label>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="product-featured">Featured product</Label>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      id="product-featured"
                      checked={form.is_featured}
                      onCheckedChange={(is_featured) =>
                        setForm((current) => ({ ...current, is_featured }))
                      }
                    />
                    <span
                      className={
                        form.is_featured
                          ? "font-medium text-emerald-600 dark:text-emerald-300"
                          : "font-medium text-muted-foreground"
                      }
                    >
                      {form.is_featured ? "Featured" : "Unfeatured"}
                    </span>
                  </label>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeEditor}
                disabled={save.isPending || uploading}
              >
                Close
              </Button>
              <Button
                type="button"
                disabled={save.isPending || uploading}
                onClick={() => validateForm() && save.mutate()}
              >
                {save.isPending || uploading ? "Saving…" : "Save product"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Card className="border-border/70 bg-card/60">
          <CardContent className="overflow-x-auto p-0">
            <Table className="admin-data-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Featured</TableHead>
                  <TableHead className="text-center">Stock quantity</TableHead>
                  <TableHead className="text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell data-label="Item">
                      <span className="block text-sm">{item.name}</span>
                      <span className="text-xs capitalize text-muted-foreground">
                        {item.category}
                      </span>
                    </TableCell>
                    <TableCell data-label="Brand" className="text-sm">
                      {item.brand ?? "-"}
                    </TableCell>
                    <TableCell data-label="Price" className="text-sm text-primary">
                      {formatPHP(item.price)}
                    </TableCell>
                    <TableCell data-label="Status">
                      <Badge
                        variant="outline"
                        className={`uppercase ${activeStatusTone(item.is_active)}`}
                      >
                        {item.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Featured">
                      {item.is_featured ? (
                        <Badge className="bg-primary uppercase text-primary-foreground">
                          Featured
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell
                      data-label="Stock quantity"
                      className="text-center font-mono text-sm"
                    >
                      {item.stock_quantity.toLocaleString()}
                    </TableCell>
                    <TableCell
                      data-label="Actions"
                      className="space-x-1 whitespace-nowrap text-center"
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${item.name}`}
                        onClick={() => openEdit(item)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Archive ${item.name}`}
                        onClick={() => setArchiveTarget(item.id)}
                      >
                        <Archive className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {items.isError ? (
              <p className="p-8 text-center text-sm text-destructive">
                Could not load shop products. Please try again.
              </p>
            ) : !items.isLoading && filteredItems.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">Nothing here yet.</p>
            ) : null}
          </CardContent>
        </Card>

        <ArchiveConfirmationDialog
          open={Boolean(archiveTarget)}
          recordLabel="shop product"
          pending={archive.isPending}
          onOpenChange={(nextOpen) => !nextOpen && setArchiveTarget(null)}
          onConfirm={() => {
            if (archiveTarget) archive.mutate(archiveTarget);
            setArchiveTarget(null);
          }}
        />
      </>
    );
  },
);

function invalidateProductQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["admin-products"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["archived-products"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["products"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["featured-products"], exact: false });
}

async function uploadImage(file: File): Promise<string> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
  const path = `${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from("products").upload(path, file, {
    cacheControl: "3600",
    upsert: false,
  });
  if (error) throw error;
  return supabase.storage.from("products").getPublicUrl(path).data.publicUrl;
}
