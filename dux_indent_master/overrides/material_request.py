import frappe
from frappe import _
from frappe.utils import cstr

from erpnext.stock.doctype.material_request.material_request import MaterialRequest


class CompanyOptionalMaterialRequest(MaterialRequest):
    """Allow Purchase Material Requests to remain Company-neutral until PO creation."""

    def validate(self):
        if not self._is_company_optional_purchase():
            return super().validate()

        self.flags.company_optional_validation = True
        self.company = self._get_validation_company()
        try:
            return super().validate()
        finally:
            self._clear_temporary_company_values()
            self.flags.company_optional_validation = False

    def set_missing_values(self, for_validate=False):
        if self.flags.company_optional_validation:
            result = super().set_missing_values(for_validate)
            self._set_temporary_item_warehouses()
            return result

        if not self._is_company_optional_purchase():
            return super().set_missing_values(for_validate)

        self.flags.company_optional_validation = True
        self.company = self._get_validation_company()
        try:
            result = super().set_missing_values(for_validate)
            self._set_temporary_item_warehouses()
            return result
        finally:
            self._clear_temporary_company_values()
            self.flags.company_optional_validation = False

    def _is_company_optional_purchase(self):
        return not self.company and cstr(self.material_request_type) == "Purchase"

    def _get_validation_company(self):
        company = (
            frappe.defaults.get_user_default("Company")
            or frappe.defaults.get_global_default("company")
            or frappe.db.get_value("Company", {}, "name", order_by="name asc")
        )
        if not company:
            frappe.throw(
                _("Create at least one Company before saving a Material Request.")
            )
        return company

    def _set_temporary_item_warehouses(self):
        for row in self.get("items") or []:
            if not row.meta.has_field("warehouse") or row.get("warehouse"):
                continue
            warehouse = frappe.db.get_value(
                "Item Default",
                {"parent": row.item_code, "company": self.company},
                "default_warehouse",
            )
            if not warehouse and frappe.get_meta("Company").has_field("default_warehouse"):
                warehouse = frappe.get_cached_value(
                    "Company", self.company, "default_warehouse"
                )
            if not warehouse:
                warehouse = frappe.db.get_value(
                    "Warehouse",
                    {
                        "company": self.company,
                        "is_group": 0,
                        "warehouse_name": "Stores",
                    },
                    "name",
                )
            if not warehouse:
                warehouse = frappe.db.get_value(
                    "Warehouse",
                    {"company": self.company, "is_group": 0},
                    "name",
                    order_by="name asc",
                )
            if warehouse:
                row.warehouse = warehouse

    def _clear_temporary_company_values(self):
        self.company = None
        for fieldname in ("set_warehouse", "set_from_warehouse"):
            if self.meta.has_field(fieldname):
                self.set(fieldname, None)
        for row in self.get("items") or []:
            for fieldname in (
                "warehouse",
                "from_warehouse",
                "cost_center",
                "expense_account",
                "project",
            ):
                if row.meta.has_field(fieldname):
                    row.set(fieldname, None)
