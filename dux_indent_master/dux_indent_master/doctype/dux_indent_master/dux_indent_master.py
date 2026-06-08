# Copyright (c) 2026, Dux Digitech and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, getdate

from dux_indent_master.api import _get_logged_in_user_details


class DuxIndentMaster(Document):
    def validate(self):
        self.set_logged_in_user_fields()
        self.set_item_balances()
        self.set_delivery_stock_display()
        self.validate_required_dates()
        self.validate_items()
        self.set_draft_status()

    def set_logged_in_user_fields(self):
        details = _get_logged_in_user_details()

        if self.meta.has_field("user_name") and not self.user_name:
            self.user_name = details.get("user")

        if self.meta.has_field("user_full_name") and (self.is_new() or not self.user_full_name):
            self.user_full_name = details.get("full_name")

        if self.meta.has_field("department_name") and not self.department_name:
            self.department_name = details.get("department")

    def set_item_balances(self):
        for row in self.get("items") or []:
            if row.meta.has_field("warehouse") and not row.get("warehouse") and row.get("source_warehouse"):
                row.warehouse = row.source_warehouse
            if row.meta.has_field("source_warehouse") and row.get("warehouse"):
                row.source_warehouse = row.warehouse
            if not row.required_date:
                row.required_date = self.required_date
            row.purchase_qty = flt(row.purchase_qty)
            row.qty_balanced = max(flt(row.qty) - flt(row.purchase_qty), 0)
            if row.meta.has_field("delivery_challan_qty"):
                row.delivery_challan_qty = flt(row.delivery_challan_qty)
            if row.meta.has_field("delivery_balance_qty"):
                row.delivery_balance_qty = max(flt(row.qty) - flt(row.delivery_challan_qty), 0)

    def set_delivery_stock_display(self):
        if self.is_new():
            return

        from dux_indent_master.api import _update_indent_delivery_and_stock_fields

        _update_indent_delivery_and_stock_fields(self)

    def validate_required_dates(self):
        if (
            self.transaction_date
            and self.required_date
            and getdate(self.required_date) < getdate(self.transaction_date)
        ):
            frappe.throw(_("Required Date cannot be before Transaction Date."))

        for row in self.get("items") or []:
            if (
                row.required_date
                and self.transaction_date
                and getdate(row.required_date) < getdate(self.transaction_date)
            ):
                frappe.throw(
                    _("Row {0}: Required Date cannot be before Transaction Date.").format(row.idx)
                )

    def validate_items(self):
        for row in self.get("items") or []:
            if not row.item_code:
                frappe.throw(_("Row {0}: Item is mandatory.").format(row.idx))
            if flt(row.qty) <= 0:
                frappe.throw(_("Row {0}: Qty must be greater than zero.").format(row.idx))

    def set_draft_status(self):
        if self.docstatus == 0:
            self.status = "Draft"

    def on_submit(self):
        self.update_purchase_status()
        self.db_set("status", self.status, update_modified=False)

    def on_cancel(self):
        self.db_set("status", "Cancelled", update_modified=False)

    def update_purchase_status(self):
        if self.docstatus == 0:
            self.status = "Draft"
            return

        if self.docstatus == 2:
            self.status = "Cancelled"
            return

        if self.meta.has_field("manually_closed") and self.get("manually_closed"):
            self.status = "Closed"
            return

        total_qty = sum(flt(row.qty) for row in self.get("items") or [])
        total_delivery_qty = sum(flt(row.get("delivery_challan_qty")) for row in self.get("items") or [])
        total_received_qty = sum(flt(row.get("received_qty")) for row in self.get("items") or [])
        total_ordered_qty = sum(flt(row.get("ordered_qty")) for row in self.get("items") or [])
        total_material_request_qty = sum(
            flt(row.get("material_request_qty") or row.get("purchase_qty"))
            for row in self.get("items") or []
        )

        if total_qty and total_delivery_qty >= total_qty:
            self.status = "Closed"
        elif total_delivery_qty > 0:
            self.status = "Partially Delivered"
        elif total_qty and total_received_qty >= total_qty:
            self.status = "Received"
        elif total_received_qty > 0:
            self.status = "Partially Received"
        elif total_qty and total_ordered_qty >= total_qty:
            self.status = "Ordered"
        elif total_ordered_qty > 0:
            self.status = "Partially Ordered"
        elif total_qty and total_material_request_qty >= total_qty:
            self.status = "Material Request Raised"
        elif total_material_request_qty > 0:
            self.status = "Partially Request Raised"
        else:
            self.status = "Approved"
