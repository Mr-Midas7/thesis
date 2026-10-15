import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useRef } from "react";

import { AdminPage } from "@/components/admin/data-list";
import { PageHeader } from "@/components/admin/page-header";
import { ProductManager, ProductManagerHandle } from "@/components/admin/product-manager";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/admin/parts")({
  component: PartsAdmin,
});

function PartsAdmin() {
  const productManagerRef = useRef<ProductManagerHandle>(null);

  return (
    <AdminPage>
      <PageHeader
        title="Parts & Accessories"
        description="Items shown in the public shop showcase."
        action={
          <Button
            className="font-display uppercase"
            onClick={() => productManagerRef.current?.openNew()}
          >
            <Plus /> Add item
          </Button>
        }
      />
      <ProductManager ref={productManagerRef} category="part" />
    </AdminPage>
  );
}
