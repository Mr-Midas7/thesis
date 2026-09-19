import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useRef } from "react";

import { PageHeader } from "@/components/admin/page-header";
import {
  MotorcycleCatalogManager,
  MotorcycleCatalogManagerHandle,
} from "@/components/admin/motorcycle-catalog-manager";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/admin/motorcycles")({
  component: MotorcyclesAdmin,
});

function MotorcyclesAdmin() {
  const motorcycleCatalogRef = useRef<MotorcycleCatalogManagerHandle>(null);

  return (
    <div>
      <PageHeader
        title="Motorcycle Catalog"
        description="Manage motorcycle brands and models shown in the booking form."
        action={
          <Button
            className="font-display uppercase"
            onClick={() => motorcycleCatalogRef.current?.openNew()}
          >
            <Plus /> Add item
          </Button>
        }
      />
      <MotorcycleCatalogManager ref={motorcycleCatalogRef} />
    </div>
  );
}
