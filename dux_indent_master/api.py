import json
import secrets
from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import cstr, flt, fmt_money, formatdate, now, nowdate, nowtime

from dux_indent_master.security import (
    INDENT_DOCTYPE,
    assert_restricted_indent_access,
    deny_restricted_non_indent_operation,
    is_restricted_portal_user,
)


@frappe.whitelist()
def get_logged_in_user_details():
    return _get_logged_in_user_details()


def _validate_restricted_indent_reference(indent_name=None, indent_item_row_name=None):
    if not is_restricted_portal_user():
        return
    if not indent_name:
        if indent_item_row_name:
            frappe.throw(_("A Material Indent is required for this item row."), frappe.PermissionError)
        return
    indent = frappe.get_doc(INDENT_DOCTYPE, indent_name)
    assert_restricted_indent_access(indent)
    indent.check_permission("read")
    if indent_item_row_name and indent_item_row_name not in {
        row.name for row in indent.get("items") or []
    }:
        frappe.throw(
            _("The selected item row does not belong to your Material Indent."),
            frappe.PermissionError,
        )


@frappe.whitelist()
def get_default_warehouse(item_code=None, company=None):
    if not item_code:
        return ""

    warehouse = ""
    if company:
        warehouse = frappe.db.get_value(
            "Item Default",
            {"parent": item_code, "company": company},
            "default_warehouse",
        )

    if not warehouse and company and frappe.get_meta("Company").has_field("default_warehouse"):
        warehouse = frappe.db.get_value("Company", company, "default_warehouse")

    return warehouse or ""


@frappe.whitelist()
def get_item_stock_qty(item_code=None, warehouse=None):
    if not item_code or not warehouse:
        return 0

    actual_qty = frappe.db.get_value(
        "Bin",
        {"item_code": item_code, "warehouse": warehouse},
        "actual_qty",
    )
    return flt(actual_qty)


@frappe.whitelist()
def get_indent_item_stock_qty_details(
    item_code=None,
    warehouse=None,
    indent_name=None,
    indent_item_row_name=None,
):
    _validate_restricted_indent_reference(indent_name, indent_item_row_name)
    bin_actual_qty = flt(get_item_stock_qty(item_code, warehouse))
    submitted_delivery_qty = flt(
        get_indent_item_submitted_delivery_qty(indent_name, indent_item_row_name)
    )

    return {
        "bin_actual_qty": bin_actual_qty,
        "actual_qty": bin_actual_qty,
        "stock_qty": bin_actual_qty,
        "submitted_delivery_qty": submitted_delivery_qty,
        "adjusted_stock_qty": bin_actual_qty,
    }


@frappe.whitelist()
def get_indent_item_submitted_delivery_qty(indent_name=None, indent_item_row_name=None):
    _validate_restricted_indent_reference(indent_name, indent_item_row_name)
    if not indent_name or not indent_item_row_name:
        return 0

    return flt(_get_submitted_delivery_qty_map(indent_name).get(indent_item_row_name))


@frappe.whitelist()
def close_indent(indent_name=None):
    if not indent_name or not frappe.db.exists("Dux Indent Master", indent_name):
        frappe.throw(_("Dux Indent Master is required."))

    indent = frappe.get_doc("Dux Indent Master", indent_name)
    assert_restricted_indent_access(indent)
    indent.check_permission("write")
    if indent.docstatus != 1:
        frappe.throw(_("Only submitted Dux Indent Master can be closed."))
    if indent.status == "Cancelled":
        frappe.throw(_("Cancelled Dux Indent Master cannot be closed."))
    if _is_indent_closed(indent):
        frappe.throw(_("This Dux Indent Master is already closed."))

    indent.status = "Closed"
    _set_if_field(indent, "manually_closed", 1)
    _set_if_field(indent, "closed_by", frappe.session.user)
    _set_if_field(indent, "closed_on", now())
    _save_indent(indent)

    return {"indent_name": indent.name, "status": "Closed"}


@frappe.whitelist()
def recalculate_indent_delivery_and_stock(indent_name=None):
    if not indent_name:
        frappe.throw(_("Dux Indent Master name is required."))
    if not frappe.db.exists("Dux Indent Master", indent_name):
        frappe.throw(_("Dux Indent Master {0} does not exist.").format(indent_name))
    indent = frappe.get_doc(INDENT_DOCTYPE, indent_name)
    assert_restricted_indent_access(indent)
    indent.check_permission("write")

    _sync_delivery_challan_tracking(indent_name)
    indent = frappe.get_doc("Dux Indent Master", indent_name)

    return {
        "indent_name": indent.name,
        "status": indent.status,
        "items": [
            {
                "row_name": row.name,
                "item_code": row.item_code,
                "warehouse": _get_row_warehouse(row),
                "delivery_challan_qty": flt(row.get("delivery_challan_qty")),
                "delivery_balance_qty": flt(row.get("delivery_balance_qty")),
                "stock_qty": flt(row.get("stock_qty")),
            }
            for row in indent.get("items") or []
        ],
    }


@frappe.whitelist()
def recalculate_indent_status(indent_name=None):
    if not indent_name:
        frappe.throw(_("Dux Indent Master name is required."))
    if not frappe.db.exists("Dux Indent Master", indent_name):
        frappe.throw(_("Dux Indent Master {0} does not exist.").format(indent_name))

    indent = frappe.get_doc("Dux Indent Master", indent_name)
    assert_restricted_indent_access(indent)
    indent.check_permission("write")
    _recalculate_indent_transaction_fields(indent)
    indent.update_purchase_status()
    _save_indent(indent)
    indent.reload()

    return {
        "indent_name": indent.name,
        "status": indent.status,
        "items": [
            {
                "row_name": row.name,
                "item_code": row.item_code,
                "material_request_qty": flt(row.get("material_request_qty") or row.get("purchase_qty")),
                "ordered_qty": flt(row.get("ordered_qty")),
                "received_qty": flt(row.get("received_qty")),
                "delivery_challan_qty": flt(row.get("delivery_challan_qty")),
                "delivery_balance_qty": flt(row.get("delivery_balance_qty")),
                "stock_qty": flt(row.get("stock_qty")),
            }
            for row in indent.get("items") or []
        ],
    }


@frappe.whitelist()
def debug_last_material_request_specification(indent_name=None):
    if not indent_name:
        frappe.throw(_("Dux Indent Master name is required."))
    indent = frappe.get_doc(INDENT_DOCTYPE, indent_name)
    assert_restricted_indent_access(indent)
    indent.check_permission("read")

    if not (
        frappe.db.exists("DocType", "Material Request")
        and frappe.db.has_column("Material Request", "custom_dux_indent_master")
    ):
        return []

    specification_expression = (
        "item.custom_dux_indent_specification"
        if frappe.db.has_column("Material Request Item", "custom_dux_indent_specification")
        else "null"
    )

    return frappe.db.sql(
        f"""
        select
            mr.name as material_request,
            mr.docstatus,
            item.name as material_request_item,
            item.item_code,
            item.qty,
            item.custom_dux_indent_item,
            {specification_expression} as custom_dux_indent_specification
        from `tabMaterial Request` mr
        inner join `tabMaterial Request Item` item on item.parent = mr.name
        where mr.custom_dux_indent_master = %s
        order by mr.creation desc, item.idx asc
        limit 20
        """,
        indent_name,
        as_dict=True,
    )


@frappe.whitelist()
def create_material_request_from_indent(indent_name, selected_items):
    indent = frappe.get_doc("Dux Indent Master", indent_name)
    assert_restricted_indent_access(indent)
    indent.check_permission("read")
    if indent.docstatus == 2:
        frappe.throw(_("Cannot create Material Request from a cancelled Dux Indent Master."))
    if indent.docstatus != 1:
        frappe.throw(_("Submit Dux Indent Master before creating a Material Request."))
    _validate_indent_open_for_transactions(indent)
    if _has_material_purchase(indent):
        frappe.throw(_("Material Request can be created only once for a Dux Indent Master."))

    quantities = _parse_selected_items(selected_items)
    if not quantities:
        frappe.throw(_("Select at least one item with purchase quantity."))

    rows_by_name = {row.name: row for row in indent.get("items") or []}
    mr = frappe.new_doc("Material Request")
    mr.material_request_type = "Purchase"
    # frappe.new_doc() auto-fills "company" from the user's default Company;
    # Company/Warehouse are picked only on the Purchase Order, so clear it.
    mr.company = None
    mr.transaction_date = nowdate()

    if mr.meta.has_field("schedule_date"):
        mr.schedule_date = indent.required_date

    _set_if_field(mr, "custom_dux_indent_master", indent.name)
    _set_if_field(mr, "custom_dux_indent_user", indent.user_name)
    _set_if_field(mr, "custom_dux_indent_department", indent.department_name)
    _set_if_field(mr, "custom_dux_indent_note_attachment", indent.note_attachment)
    _set_if_field(mr, "custom_dux_indent_design_attachment", indent.design_attachment)
    _set_if_field(mr, "custom_dux_indent_remark", indent.remark)
    _set_if_field(mr, "custom_site_project", indent.get("custom_site_project"))
    _set_if_field(mr, "custom_town", indent.get("custom_town"))

    total_qty = 0
    for row_name, purchase_qty in quantities.items():
        row = rows_by_name.get(row_name)
        if not row:
            frappe.throw(_("Invalid Dux Indent item row: {0}").format(row_name))

        if purchase_qty <= 0:
            frappe.throw(_("Purchase quantity must be greater than zero for {0}.").format(row.item_code))

        item = mr.append(
            "items",
            {
                "item_code": row.item_code,
                "qty": purchase_qty,
                "schedule_date": row.required_date or indent.required_date,
            },
        )
        if row.uom:
            item.uom = row.uom
        _set_if_field(item, "custom_dux_indent_master", indent.name)
        _set_if_field(item, "custom_dux_indent_item", row.name)
        _set_material_request_item_specification(item, row.specification)
        total_qty += purchase_qty

    mr.insert()

    _upsert_material_purchase_row(indent, mr.name, "Draft", mr.transaction_date, total_qty)
    _recalculate_indent_transaction_fields(indent)
    indent.update_purchase_status()
    _save_indent(indent)

    return {"material_request": mr.name}


@frappe.whitelist()
def create_delivery_challan_from_indent(indent_name, selected_items=None, company=None, warehouse=None):
    if not indent_name or not frappe.db.exists("Dux Indent Master", indent_name):
        frappe.throw(_("Save Dux Indent Master before creating a Delivery Challan."))

    if not frappe.db.exists("DocType", "Delivery Challan"):
        frappe.throw(_("Delivery Challan DocType is not available on this site."))

    indent = frappe.get_doc("Dux Indent Master", indent_name)
    assert_restricted_indent_access(indent)
    indent.check_permission("read")
    if indent.docstatus == 2:
        frappe.throw(_("Cannot create Delivery Challan from a cancelled Dux Indent Master."))
    _validate_indent_open_for_transactions(indent)

    _sync_delivery_challan_tracking(indent.name)
    indent.reload()
    _validate_indent_open_for_transactions(indent)

    draft_qty = _get_draft_delivery_qty_map(indent.name)
    requested_qty = _parse_selected_items(selected_items) if selected_items is not None else None
    indent_rows = {row.name: row for row in indent.get("items") or []}
    if requested_qty is not None:
        invalid_rows = [row_name for row_name in requested_qty if row_name not in indent_rows]
        if invalid_rows:
            frappe.throw(_("One or more selected rows do not belong to this indent."))
        if not requested_qty:
            frappe.throw(_("Enter Delivery Challan quantity for at least one item."))

    rows = []
    for row in indent.get("items") or []:
        if not row.item_code:
            continue
        balance_qty = _get_delivery_creation_balance_qty(row, draft_qty)
        if requested_qty is None:
            if balance_qty > 0:
                rows.append((row, balance_qty, None))
            continue
        if row.name not in requested_qty:
            continue
        qty = flt(requested_qty[row.name])
        if qty <= 0:
            frappe.throw(_("Delivery Challan Qty must be greater than zero for {0}.").format(row.item_code))
        if qty > flt(balance_qty):
            frappe.throw(
                _("Delivery Challan Qty {0} cannot exceed indent balance Qty {1} for {2}.").format(
                    qty, balance_qty, row.item_code
                )
            )
        rows.append((row, balance_qty, qty))

    if not rows:
        frappe.throw(_("No delivery balance quantity is available for Delivery Challan."))

    company = cstr(company).strip() or indent.company_name
    if not company:
        frappe.throw(_("Select a Company for the Delivery Challan."))
    warehouse = cstr(warehouse).strip()
    if not warehouse:
        frappe.throw(_("Select a Warehouse for the Delivery Challan."))
    transit_warehouse = _get_delivery_challan_transit_warehouse(company)
    _validate_delivery_source_warehouse(
        warehouse=warehouse,
        company=company,
        transit_warehouse=transit_warehouse,
    )

    delivery_rows = []
    for row, balance_qty, requested in rows:
        qty = flt(requested) if requested is not None else flt(balance_qty)
        if qty <= 0:
            continue
        delivery_rows.append((row, qty, warehouse))

    if not delivery_rows:
        frappe.throw(_("No delivery balance quantity is available for Delivery Challan."))
    _validate_delivery_source_stock(delivery_rows)

    delivery_challan = frappe.new_doc("Delivery Challan")
    delivery_challan.company = company
    delivery_challan.posting_date = nowdate()
    delivery_challan.posting_time = nowtime()
    delivery_challan.source_warehouse = warehouse
    delivery_challan.target_warehouse = warehouse
    delivery_challan.transit_warehouse = transit_warehouse
    _set_delivery_challan_remark(delivery_challan, indent)
    _set_if_field(delivery_challan, "custom_dux_indent_master", indent.name)
    _set_if_field(delivery_challan, "custom_dux_indent_required_date", indent.required_date)

    total_qty = 0
    for row, qty, warehouse in delivery_rows:
        if qty <= 0:
            frappe.throw(_("Delivery Challan Qty must be greater than zero for {0}.").format(row.item_code))

        item = delivery_challan.append(
            "items",
            {
                "item_code": row.item_code,
                "qty": qty,
                "uom": row.uom,
                "source_warehouse": warehouse,
                "target_warehouse": warehouse,
                "transit_warehouse": transit_warehouse,
                "remarks": row.specification,
            },
        )
        _set_if_field(item, "custom_delivery_challan_qty", qty)
        _set_if_field(item, "custom_dux_indent_item", row.name)
        _set_if_field(item, "custom_dux_indent_specification", row.specification)
        total_qty += qty

    delivery_challan.insert()
    _upsert_delivery_challan_row(
        indent,
        delivery_challan.name,
        "Draft",
        delivery_challan.posting_date,
        total_qty,
    )
    indent.update_purchase_status()
    _save_indent(indent)

    return {"doctype": delivery_challan.doctype, "name": delivery_challan.name}


def _get_material_request_delivery_qty_map(mr_name, docstatus, exclude_delivery_challan=None):
    if not (
        frappe.db.exists("DocType", "Delivery Challan")
        and frappe.db.has_column("Delivery Challan", "custom_material_request")
        and frappe.db.has_column("Delivery Challan Item", "custom_material_request_item")
    ):
        return {}

    conditions = ["dc.custom_material_request = %s", "dc.docstatus = %s"]
    values = [mr_name, docstatus]
    if exclude_delivery_challan:
        conditions.append("dc.name != %s")
        values.append(exclude_delivery_challan)

    qty_expression = _get_delivery_challan_qty_expression("item")
    rows = frappe.db.sql(
        f"""
        select
            item.custom_material_request_item as mr_item,
            sum({qty_expression}) as qty
        from `tabDelivery Challan Item` item
        inner join `tabDelivery Challan` dc on dc.name = item.parent
        where {" and ".join(conditions)}
          and coalesce(item.custom_material_request_item, '') != ''
        group by item.custom_material_request_item
        """,
        values,
        as_dict=True,
    )
    return {row.mr_item: flt(row.qty) for row in rows}


def _get_mr_delivery_creation_balance_qty(row, submitted_qty, draft_qty):
    delivered = flt(submitted_qty.get(row.name)) + flt(draft_qty.get(row.name))
    return max(flt(row.qty) - delivered, 0)


@frappe.whitelist()
def create_delivery_challan_from_material_request(mr_name, selected_items=None, company=None, warehouse=None):
    deny_restricted_non_indent_operation()
    if not mr_name or not frappe.db.exists("Material Request", mr_name):
        frappe.throw(_("Save Material Request before creating a Delivery Challan."))

    if not frappe.db.exists("DocType", "Delivery Challan"):
        frappe.throw(_("Delivery Challan DocType is not available on this site."))

    mr = frappe.get_doc("Material Request", mr_name)
    if mr.docstatus == 2:
        frappe.throw(_("Cannot create Delivery Challan from a cancelled Material Request."))
    if mr.docstatus != 1:
        frappe.throw(_("Submit Material Request before creating a Delivery Challan."))
    if cstr(mr.get("status")) == "Stopped":
        frappe.throw(_("This Material Request is Stopped."))

    submitted_qty = _get_material_request_delivery_qty_map(mr.name, docstatus=1)
    draft_qty = _get_material_request_delivery_qty_map(mr.name, docstatus=0)

    requested_qty = _parse_selected_items(selected_items) if selected_items is not None else None
    mr_rows = {row.name: row for row in mr.get("items") or []}
    if requested_qty is not None:
        invalid_rows = [row_name for row_name in requested_qty if row_name not in mr_rows]
        if invalid_rows:
            frappe.throw(_("One or more selected rows do not belong to this Material Request."))
        if not requested_qty:
            frappe.throw(_("Enter Delivery Challan quantity for at least one item."))

    rows = []
    for row in mr.get("items") or []:
        if not row.item_code:
            continue
        balance_qty = _get_mr_delivery_creation_balance_qty(row, submitted_qty, draft_qty)
        if requested_qty is None:
            if balance_qty > 0:
                rows.append((row, balance_qty, None))
            continue
        if row.name not in requested_qty:
            continue
        qty = flt(requested_qty[row.name])
        if qty <= 0:
            frappe.throw(_("Delivery Challan Qty must be greater than zero for {0}.").format(row.item_code))
        if qty > flt(balance_qty):
            frappe.throw(
                _("Delivery Challan Qty {0} cannot exceed Material Request balance Qty {1} for {2}.").format(
                    qty, balance_qty, row.item_code
                )
            )
        rows.append((row, balance_qty, qty))

    if not rows:
        frappe.throw(_("No delivery balance quantity is available for Delivery Challan."))

    company = cstr(company).strip()
    if not company:
        frappe.throw(_("Select a Company for the Delivery Challan."))
    if not frappe.db.exists("Company", company):
        frappe.throw(_("Invalid Company."))
    warehouse = cstr(warehouse).strip()
    if not warehouse:
        frappe.throw(_("Select a Warehouse for the Delivery Challan."))
    transit_warehouse = _get_delivery_challan_transit_warehouse(company)
    _validate_delivery_source_warehouse(
        warehouse=warehouse,
        company=company,
        transit_warehouse=transit_warehouse,
    )

    delivery_rows = []
    for row, balance_qty, requested in rows:
        qty = flt(requested) if requested is not None else flt(balance_qty)
        if qty <= 0:
            continue
        delivery_rows.append((row, qty, warehouse))

    if not delivery_rows:
        frappe.throw(_("No delivery balance quantity is available for Delivery Challan."))
    _validate_delivery_source_stock(delivery_rows)

    delivery_challan = frappe.new_doc("Delivery Challan")
    delivery_challan.company = company
    delivery_challan.posting_date = nowdate()
    delivery_challan.posting_time = nowtime()
    delivery_challan.source_warehouse = warehouse
    delivery_challan.target_warehouse = warehouse
    delivery_challan.transit_warehouse = transit_warehouse
    remark_text = _("Created from Material Request {0}").format(mr.name)
    for fieldname in ("remark", "remarks", "custom_remark"):
        if delivery_challan.meta.has_field(fieldname):
            delivery_challan.set(fieldname, remark_text)
            break
    _set_if_field(delivery_challan, "custom_material_request", mr.name)

    total_qty = 0
    for row, qty, row_warehouse in delivery_rows:
        if qty <= 0:
            frappe.throw(_("Delivery Challan Qty must be greater than zero for {0}.").format(row.item_code))

        item = delivery_challan.append(
            "items",
            {
                "item_code": row.item_code,
                "qty": qty,
                "uom": row.uom,
                "source_warehouse": row_warehouse,
                "target_warehouse": row_warehouse,
                "transit_warehouse": transit_warehouse,
                "remarks": row.get("custom_dux_indent_specification"),
            },
        )
        _set_if_field(item, "custom_delivery_challan_qty", qty)
        _set_if_field(item, "custom_material_request_item", row.name)
        total_qty += qty

    delivery_challan.insert()

    return {"doctype": delivery_challan.doctype, "name": delivery_challan.name}


def on_delivery_challan_validate(doc, method=None):
    _set_delivery_challan_item_quantities(doc)
    _validate_delivery_challan_qty_limits(doc)


def on_delivery_challan_before_submit(doc, method=None):
    _set_delivery_challan_item_quantities(doc)
    _validate_delivery_challan_qty_limits(doc)


def on_delivery_challan_submit(doc, method=None):
    indent_name = doc.get("custom_dux_indent_master")
    if indent_name:
        _sync_delivery_challan_tracking(indent_name)


def on_delivery_challan_before_cancel(doc, method=None):
    ignored_doctypes = set(doc.get("ignore_linked_doctypes") or [])
    ignored_doctypes.add("Dux Indent Master")
    doc.set("ignore_linked_doctypes", list(ignored_doctypes))


def on_delivery_challan_cancel(doc, method=None):
    indent_name = doc.get("custom_dux_indent_master")
    if indent_name:
        _sync_delivery_challan_tracking(indent_name, ignore_links=True)


def on_material_request_submit(doc, method=None):
    _apply_material_request_qty(doc, multiplier=1, status="Submitted")


def on_material_request_cancel(doc, method=None):
    ignored_doctypes = set(doc.get("ignore_linked_doctypes") or [])
    ignored_doctypes.add("Dux Indent Master")
    doc.set("ignore_linked_doctypes", list(ignored_doctypes))
    _apply_material_request_qty(doc, multiplier=-1, status="Cancelled")


def on_purchase_order_submit(doc, method=None):
    _recalculate_linked_indent_statuses(_get_purchase_order_indent_names(doc))


def on_purchase_order_cancel(doc, method=None):
    _recalculate_linked_indent_statuses(_get_purchase_order_indent_names(doc), ignore_links=True)


def _warehouse_belongs_to_company(warehouse, company):
    if not warehouse:
        return False

    warehouse_details = frappe.db.get_value(
        "Warehouse",
        warehouse,
        ["company", "is_group"],
        as_dict=True,
    )
    return bool(
        warehouse_details
        and warehouse_details.company == company
        and not warehouse_details.is_group
    )


def _resolve_purchase_order_warehouse(doc, material_request, company):
    """Resolve a non-group Warehouse belonging to the new PO Company.

    Prefer the Warehouse explicitly selected on the Purchase Order. A Town is
    only a fallback because Town names are not guaranteed to match Warehouse
    names (for example, Town "Test" legitimately uses "Stores - DD").
    """
    candidates = []

    def add_candidate(warehouse):
        warehouse = cstr(warehouse).strip()
        if warehouse and warehouse not in candidates:
            candidates.append(warehouse)

    add_candidate(doc.get("set_warehouse"))
    for row in doc.get("items") or []:
        add_candidate(row.get("warehouse"))

    item_codes = {
        row.get("item_code")
        for row in [*(doc.get("items") or []), *(material_request.get("items") or [])]
        if row.get("item_code")
    }
    for item_code in sorted(item_codes):
        add_candidate(get_default_warehouse(item_code=item_code, company=company))

    custom_town = doc.get("custom_town")
    if custom_town:
        town = frappe.db.get_value(
            "Town At Project",
            custom_town,
            ["company_name", "town_name"],
            as_dict=True,
        )
        if town and town.company_name == company and town.town_name:
            add_candidate(
                frappe.db.get_value(
                    "Warehouse",
                    {
                        "company": company,
                        "warehouse_name": town.town_name,
                        "is_group": 0,
                    },
                    "name",
                )
            )

    add_candidate(
        frappe.db.get_value(
            "Warehouse",
            {"company": company, "warehouse_name": "Stores", "is_group": 0},
            "name",
        )
    )

    for warehouse in candidates:
        if _warehouse_belongs_to_company(warehouse, company):
            return warehouse

    frappe.throw(
        _(
            "Cannot change Material Request {0} to Company {1} because a valid "
            "Warehouse for Company {1} was not found. Select a Target Warehouse "
            "on Purchase Order {2}."
        ).format(material_request.name, company, doc.name)
    )


def _get_material_request_company_conflict(material_request, current_purchase_order=None):
    """Return the first submitted Company-A transaction linked to the MR."""
    references = (
        ("Purchase Order Item", "Purchase Order"),
        ("Purchase Receipt Item", "Purchase Receipt"),
        ("Purchase Invoice Item", "Purchase Invoice"),
        ("Stock Entry Detail", "Stock Entry"),
    )

    for child_doctype, parent_doctype in references:
        parent_names = set(
            frappe.get_all(
                child_doctype,
                filters={
                    "material_request": material_request.name,
                    "docstatus": 1,
                },
                pluck="parent",
            )
        )
        if parent_doctype == "Purchase Order" and current_purchase_order:
            parent_names.discard(current_purchase_order)
        if not parent_names:
            continue

        conflicts = frappe.get_all(
            parent_doctype,
            filters={
                "name": ["in", sorted(parent_names)],
                "docstatus": 1,
                "company": material_request.company,
            },
            pluck="name",
            order_by="name asc",
            limit_page_length=1,
        )
        if conflicts:
            return parent_doctype, conflicts[0]

    return None


def _get_company_accounting_default(company, company_field, doctype, label, required):
    value = frappe.get_cached_value("Company", company, company_field)
    if not value:
        if required:
            frappe.throw(
                _(
                    "Cannot change Material Request to Company {0} because its "
                    "default {1} is not configured."
                ).format(company, label)
            )
        return None

    details = frappe.db.get_value(
        doctype,
        value,
        ["company", "is_group"],
        as_dict=True,
    )
    if not details or details.company != company or details.is_group:
        frappe.throw(
            _(
                "Cannot change Material Request to Company {0} because {1} {2} "
                "is not a valid non-group value for that Company."
            ).format(company, label, value)
        )
    return value


def sync_material_request_company(doc, method=None):
    """Keep a mapped Material Request's Company - and its company-dependent
    fields - in sync with this Purchase Order's Company. Runs on every PO
    validate so it applies from the Dux Portal and the native ERPNext desk
    alike, and updates the Material Request in place (no cancel/amend)."""
    company = doc.get("company")
    if not company:
        return

    mr_names = sorted(
        {
            cstr(row.get("material_request")).strip()
            for row in doc.get("items") or []
            if cstr(row.get("material_request")).strip()
        }
    )
    if not mr_names:
        return

    for mr_name in mr_names:
        mr = frappe.get_doc("Material Request", mr_name)
        if mr.company == company:
            continue

        conflict = _get_material_request_company_conflict(mr, doc.name)
        if conflict:
            conflict_doctype, conflict_name = conflict
            frappe.throw(
                _(
                    "Cannot change Material Request {0} from Company {1} to Company {2} "
                    "because submitted {3} {4} already exists under Company {1}."
                ).format(mr.name, mr.company, company, conflict_doctype, conflict_name)
            )

        new_warehouse = _resolve_purchase_order_warehouse(doc, mr, company)
        cost_center_rows = [
            row for row in mr.items
            if row.meta.has_field("cost_center")
        ]
        expense_account_rows = [
            row for row in mr.items
            if row.meta.has_field("expense_account")
        ]
        needs_cost_center = any(
            row.get("cost_center") or row.meta.get_field("cost_center").reqd
            for row in cost_center_rows
        )
        needs_expense_account = any(
            row.get("expense_account") or row.meta.get_field("expense_account").reqd
            for row in expense_account_rows
        )
        new_cost_center = _get_company_accounting_default(
            company,
            "cost_center",
            "Cost Center",
            _("Cost Center"),
            needs_cost_center,
        )
        new_expense_account = _get_company_accounting_default(
            company,
            "default_expense_account",
            "Account",
            _("Expense Account"),
            needs_expense_account,
        )

        old_company = mr.company
        mr.company = company
        for row in mr.items:
            if row.meta.has_field("warehouse"):
                row.warehouse = new_warehouse
            if (
                row.meta.has_field("from_warehouse")
                and mr.material_request_type == "Material Transfer"
            ):
                row.from_warehouse = new_warehouse
            if row.meta.has_field("cost_center"):
                row.cost_center = new_cost_center
            if row.meta.has_field("expense_account"):
                row.expense_account = new_expense_account
        mr.save(ignore_permissions=True)
        mr.add_comment(
            "Info",
            _(
                "Company changed from {0} to {1} while creating Purchase Order "
                "{2} by {3}."
            ).format(old_company, company, doc.name, frappe.session.user),
        )

        _set_if_field(doc, "cost_center", new_cost_center)
        _set_if_field(doc, "set_warehouse", new_warehouse)
        for row in doc.get("items") or []:
            if row.meta.has_field("warehouse"):
                row.warehouse = new_warehouse
            if row.meta.has_field("cost_center"):
                row.cost_center = new_cost_center
            if row.meta.has_field("expense_account"):
                row.expense_account = new_expense_account


def on_purchase_receipt_submit(doc, method=None):
    _recalculate_linked_indent_statuses(_get_purchase_receipt_indent_names(doc))


def on_purchase_receipt_cancel(doc, method=None):
    _recalculate_linked_indent_statuses(_get_purchase_receipt_indent_names(doc), ignore_links=True)


def _apply_material_request_qty(doc, multiplier, status):
    grouped = defaultdict(list)
    for item in doc.get("items") or []:
        indent_name = item.get("custom_dux_indent_master")
        row_name = item.get("custom_dux_indent_item")
        if indent_name and row_name:
            grouped[indent_name].append(item)

    for indent_name, items in grouped.items():
        indent = frappe.get_doc("Dux Indent Master", indent_name)
        rows_by_name = {row.name: row for row in indent.get("items") or []}
        total_qty = 0

        for item in items:
            row = rows_by_name.get(item.custom_dux_indent_item)
            if not row:
                continue

            qty = flt(item.qty)
            total_qty += qty
            row.purchase_qty = max(flt(row.purchase_qty) + (multiplier * qty), 0)
            row.qty_balanced = max(flt(row.qty) - flt(row.purchase_qty), 0)

            if multiplier > 0:
                row.material_request = doc.name
                row.material_request_item = item.name
            elif row.material_request == doc.name:
                row.material_request = None
                row.material_request_item = None

        _upsert_material_purchase_row(indent, doc.name, status, doc.transaction_date, total_qty)
        _recalculate_indent_transaction_fields(indent)
        indent.update_purchase_status()
        _save_indent(indent, ignore_links=status == "Cancelled")


def _recalculate_linked_indent_statuses(indent_names, ignore_links=False):
    for indent_name in sorted(filter(None, set(indent_names or []))):
        if not frappe.db.exists("Dux Indent Master", indent_name):
            continue

        indent = frappe.get_doc("Dux Indent Master", indent_name)
        _recalculate_indent_transaction_fields(indent)
        indent.update_purchase_status()
        _save_indent(indent, ignore_links=ignore_links)


def _recalculate_indent_transaction_fields(indent):
    material_request_qty = _get_material_request_qty_map(indent.name)
    ordered_qty = _get_ordered_qty_map(indent.name)
    received_qty = _get_received_qty_map(indent.name)
    submitted_delivery_qty = _get_submitted_delivery_qty_map(indent.name)
    summaries = _get_delivery_challan_summaries(indent.name)

    _remove_missing_delivery_challan_rows(indent, summaries)
    for summary in summaries:
        _upsert_delivery_challan_row(
            indent,
            summary.delivery_challan,
            _get_delivery_challan_tracking_status(summary.docstatus, summary.status),
            summary.posting_date,
            summary.total_qty,
        )

    for row in indent.get("items") or []:
        request_qty = flt(material_request_qty.get(row.name))
        if row.meta.has_field("material_request_qty"):
            row.material_request_qty = request_qty
        if row.meta.has_field("purchase_qty"):
            row.purchase_qty = request_qty
        if row.meta.has_field("qty_balanced"):
            row.qty_balanced = max(flt(row.qty) - request_qty, 0)
        if row.meta.has_field("ordered_qty"):
            row.ordered_qty = flt(ordered_qty.get(row.name))
        if row.meta.has_field("received_qty"):
            row.received_qty = flt(received_qty.get(row.name))

    _update_indent_delivery_and_stock_fields(indent, submitted_qty=submitted_delivery_qty)


def _get_material_request_qty_map(indent_name):
    if not (
        frappe.db.exists("DocType", "Material Request")
        and frappe.db.has_column("Material Request", "custom_dux_indent_master")
        and frappe.db.has_column("Material Request Item", "custom_dux_indent_item")
    ):
        return {}

    rows = frappe.db.sql(
        """
        select
            item.custom_dux_indent_item as indent_item,
            sum(coalesce(item.qty, 0)) as qty
        from `tabMaterial Request Item` item
        inner join `tabMaterial Request` mr on mr.name = item.parent
        where mr.custom_dux_indent_master = %s
          and mr.docstatus < 2
          and coalesce(item.custom_dux_indent_item, '') != ''
        group by item.custom_dux_indent_item
        """,
        indent_name,
        as_dict=True,
    )
    return {row.indent_item: flt(row.qty) for row in rows}


def _get_ordered_qty_map(indent_name):
    if not (
        frappe.db.exists("DocType", "Purchase Order")
        and frappe.db.has_column("Purchase Order Item", "material_request_item")
        and frappe.db.has_column("Material Request Item", "custom_dux_indent_master")
        and frappe.db.has_column("Material Request Item", "custom_dux_indent_item")
    ):
        return {}

    rows = frappe.db.sql(
        """
        select
            mri.custom_dux_indent_item as indent_item,
            sum(coalesce(poi.qty, 0)) as qty
        from `tabPurchase Order Item` poi
        inner join `tabPurchase Order` po on po.name = poi.parent
        inner join `tabMaterial Request Item` mri on mri.name = poi.material_request_item
        where po.docstatus = 1
          and mri.custom_dux_indent_master = %s
          and coalesce(mri.custom_dux_indent_item, '') != ''
        group by mri.custom_dux_indent_item
        """,
        indent_name,
        as_dict=True,
    )
    return {row.indent_item: flt(row.qty) for row in rows}


def _get_received_qty_map(indent_name):
    if not (
        frappe.db.exists("DocType", "Purchase Receipt")
        and frappe.db.has_column("Material Request Item", "custom_dux_indent_master")
        and frappe.db.has_column("Material Request Item", "custom_dux_indent_item")
    ):
        return {}

    qty_by_row = defaultdict(float)
    has_direct_material_request_item = frappe.db.has_column(
        "Purchase Receipt Item", "material_request_item"
    )

    if has_direct_material_request_item:
        rows = frappe.db.sql(
            """
            select
                mri.custom_dux_indent_item as indent_item,
                sum(coalesce(pri.qty, 0)) as qty
            from `tabPurchase Receipt Item` pri
            inner join `tabPurchase Receipt` pr on pr.name = pri.parent
            inner join `tabMaterial Request Item` mri on mri.name = pri.material_request_item
            where pr.docstatus = 1
              and mri.custom_dux_indent_master = %s
              and coalesce(mri.custom_dux_indent_item, '') != ''
            group by mri.custom_dux_indent_item
            """,
            indent_name,
            as_dict=True,
        )
        for row in rows:
            qty_by_row[row.indent_item] += flt(row.qty)

    if (
        frappe.db.has_column("Purchase Receipt Item", "purchase_order_item")
        and frappe.db.has_column("Purchase Order Item", "material_request_item")
    ):
        direct_link_condition = (
            "and coalesce(pri.material_request_item, '') = ''"
            if has_direct_material_request_item
            else ""
        )
        rows = frappe.db.sql(
            f"""
            select
                mri.custom_dux_indent_item as indent_item,
                sum(coalesce(pri.qty, 0)) as qty
            from `tabPurchase Receipt Item` pri
            inner join `tabPurchase Receipt` pr on pr.name = pri.parent
            inner join `tabPurchase Order Item` poi on poi.name = pri.purchase_order_item
            inner join `tabMaterial Request Item` mri on mri.name = poi.material_request_item
            where pr.docstatus = 1
              {direct_link_condition}
              and mri.custom_dux_indent_master = %s
              and coalesce(mri.custom_dux_indent_item, '') != ''
            group by mri.custom_dux_indent_item
            """,
            indent_name,
            as_dict=True,
        )
        for row in rows:
            qty_by_row[row.indent_item] += flt(row.qty)

    return dict(qty_by_row)


def _get_purchase_order_indent_names(doc):
    indent_names = set()
    for item in doc.get("items") or []:
        indent_name, indent_item = _get_material_request_item_indent_link(
            item.get("material_request_item")
        )
        if indent_name and indent_item:
            indent_names.add(indent_name)
    return indent_names


def _get_purchase_receipt_indent_names(doc):
    indent_names = set()
    for item in doc.get("items") or []:
        indent_name = None
        indent_item = None

        if item.get("material_request_item"):
            indent_name, indent_item = _get_material_request_item_indent_link(
                item.get("material_request_item")
            )

        if (
            not indent_name
            and item.get("purchase_order_item")
            and frappe.db.has_column("Purchase Order Item", "material_request_item")
        ):
            material_request_item = frappe.db.get_value(
                "Purchase Order Item",
                item.get("purchase_order_item"),
                "material_request_item",
            )
            indent_name, indent_item = _get_material_request_item_indent_link(material_request_item)

        if indent_name and indent_item:
            indent_names.add(indent_name)
    return indent_names


def _get_material_request_item_indent_link(material_request_item):
    if not material_request_item:
        return None, None
    if not (
        frappe.db.has_column("Material Request Item", "custom_dux_indent_master")
        and frappe.db.has_column("Material Request Item", "custom_dux_indent_item")
    ):
        return None, None

    row = frappe.db.get_value(
        "Material Request Item",
        material_request_item,
        ["custom_dux_indent_master", "custom_dux_indent_item"],
        as_dict=True,
    )
    if not row:
        return None, None
    return row.custom_dux_indent_master, row.custom_dux_indent_item


def _is_indent_closed(indent):
    return indent.status == "Closed" or bool(indent.get("manually_closed"))


def _validate_indent_open_for_transactions(indent):
    if _is_indent_closed(indent):
        frappe.throw(_("This Dux Indent Master is closed. You cannot create new transactions."))


def sync_all_delivery_challan_tracking():
    indent_names = set(
        frappe.get_all(
            "Dux Indent Master",
            filters={"docstatus": ["!=", 2]},
            pluck="name",
        )
    )
    if frappe.db.exists("DocType", "Delivery Challan") and frappe.db.has_column(
        "Delivery Challan", "custom_dux_indent_master"
    ):
        indent_names.update(
            row.custom_dux_indent_master
            for row in frappe.db.sql(
                """
                select distinct dc.custom_dux_indent_master
                from `tabDelivery Challan` dc
                inner join `tabDux Indent Master` dim
                    on dim.name = dc.custom_dux_indent_master
                where coalesce(dc.custom_dux_indent_master, '') != ''
                  and dim.docstatus != 2
                """,
                as_dict=True,
            )
        )

    for indent_name in sorted(filter(None, indent_names)):
        _sync_delivery_challan_tracking(indent_name)


def _validate_delivery_challan_qty_limits(doc):
    indent_name = doc.get("custom_dux_indent_master")
    if not indent_name:
        return

    frappe.db.sql(
        "select name from `tabDux Indent Master` where name = %s for update",
        indent_name,
    )
    indent = frappe.get_doc("Dux Indent Master", indent_name)
    indent_rows = {row.name: row for row in indent.get("items") or []}
    submitted_qty = _get_submitted_delivery_qty_map(indent_name, exclude_delivery_challan=doc.name)
    draft_qty = _get_draft_delivery_qty_map(indent_name, exclude_delivery_challan=doc.name)
    incoming_qty = _get_delivery_challan_item_qty_map(doc)

    for row_name, qty in incoming_qty.items():
        indent_row = indent_rows.get(row_name)
        if not indent_row:
            frappe.throw(_("Invalid Dux Indent item row in Delivery Challan: {0}").format(row_name))

        allowed_qty = flt(indent_row.qty)
        total_qty = flt(submitted_qty.get(row_name)) + flt(draft_qty.get(row_name)) + flt(qty)
        if total_qty > allowed_qty:
            frappe.throw(
                _("Delivery Challan Qty {0} cannot exceed indent Qty {1} for {2}.").format(
                    total_qty, allowed_qty, indent_row.item_code
                )
            )


def _validate_delivery_challan_stock_limits(doc):
    if not doc.get("custom_dux_indent_master"):
        return

    quantities = defaultdict(float)
    for row in doc.get("items") or []:
        warehouse = row.get("source_warehouse") or doc.get("source_warehouse")
        if not row.item_code or not warehouse:
            continue
        quantities[(row.item_code, warehouse)] += _get_delivery_challan_item_qty(row)

    if not quantities:
        return

    available_stock_qty = _get_available_delivery_stock_qty_map(
        set(quantities),
        exclude_delivery_challan=doc.name,
    )
    for (item_code, warehouse), qty in quantities.items():
        available_qty = max(flt(available_stock_qty.get((item_code, warehouse))), 0)
        if flt(qty) > available_qty:
            frappe.throw(
                _(
                    "Delivery Challan Qty {0} cannot exceed available stock {1} "
                    "for item {2} in warehouse {3}."
                ).format(qty, available_qty, item_code, warehouse),
                title=_("Insufficient Stock"),
            )


def _get_available_delivery_stock_qty_map(stock_keys, exclude_delivery_challan=None):
    stock_keys = set(stock_keys or [])
    if not stock_keys:
        return {}

    actual_stock_qty = _get_stock_qty_map(stock_keys)
    reserved_stock_qty = _get_open_delivery_stock_reservation_map(
        stock_keys,
        exclude_delivery_challan=exclude_delivery_challan,
    )
    return {
        stock_key: max(
            flt(actual_stock_qty.get(stock_key)) - flt(reserved_stock_qty.get(stock_key)),
            0,
        )
        for stock_key in stock_keys
    }


def _get_stock_qty_map(stock_keys):
    stock_keys = set(stock_keys or [])
    if not stock_keys:
        return {}

    sorted_stock_keys = sorted(
        (item_code, warehouse)
        for item_code, warehouse in stock_keys
        if item_code and warehouse
    )
    if not sorted_stock_keys:
        return {}

    stock_qty = {stock_key: 0 for stock_key in stock_keys}
    conditions = []
    values = []
    for item_code, warehouse in sorted_stock_keys:
        conditions.append("(item_code = %s and warehouse = %s)")
        values.extend([item_code, warehouse])

    # Serialize DC creation/submission for the same stock bins. The lock remains
    # active until the request transaction commits, after the draft/submit state
    # used by the reservation query has also been persisted.
    rows = frappe.db.sql(
        f"""
        select item_code, warehouse, actual_qty
        from `tabBin`
        where {" or ".join(conditions)}
        order by item_code, warehouse
        for update
        """,
        values,
        as_dict=True,
    )
    for row in rows:
        stock_key = (row.item_code, row.warehouse)
        if stock_key in stock_qty:
            stock_qty[stock_key] = flt(row.actual_qty)
    return stock_qty


def _get_open_delivery_stock_reservation_map(stock_keys, exclude_delivery_challan=None):
    stock_keys = set(stock_keys or [])
    if not stock_keys or not frappe.db.exists("DocType", "Delivery Challan"):
        return {}

    conditions = ["dc.docstatus < 2"]
    values = []
    if frappe.db.has_column("Delivery Challan", "dispatch_stock_entry"):
        conditions.append("coalesce(dc.dispatch_stock_entry, '') = ''")
    if exclude_delivery_challan:
        conditions.append("dc.name != %s")
        values.append(exclude_delivery_challan)

    rows = frappe.db.sql(
        f"""
        select
            item.item_code,
            item.source_warehouse as warehouse,
            sum(coalesce(item.qty, 0)) as qty
        from `tabDelivery Challan Item` item
        inner join `tabDelivery Challan` dc on dc.name = item.parent
        where {" and ".join(conditions)}
          and coalesce(item.item_code, '') != ''
          and coalesce(item.source_warehouse, '') != ''
        group by item.item_code, item.source_warehouse
        """,
        values,
        as_dict=True,
    )
    return {
        (row.item_code, row.warehouse): flt(row.qty)
        for row in rows
        if (row.item_code, row.warehouse) in stock_keys
    }


def _sync_delivery_challan_tracking(indent_name, ignore_links=False):
    if not frappe.db.exists("Dux Indent Master", indent_name):
        return

    indent = frappe.get_doc("Dux Indent Master", indent_name)
    if indent.docstatus == 2:
        return

    summaries = _get_delivery_challan_summaries(indent_name)
    _remove_missing_delivery_challan_rows(indent, summaries)
    for summary in summaries:
        _upsert_delivery_challan_row(
            indent,
            summary.delivery_challan,
            _get_delivery_challan_tracking_status(summary.docstatus, summary.status),
            summary.posting_date,
            summary.total_qty,
        )

    submitted_qty = _get_submitted_delivery_qty_map(indent_name)
    _update_indent_delivery_and_stock_fields(indent, submitted_qty=submitted_qty)

    indent.update_purchase_status()
    _save_indent(indent, ignore_links=ignore_links)


def _get_delivery_challan_summaries(indent_name):
    if not (
        frappe.db.exists("DocType", "Delivery Challan")
        and frappe.db.has_column("Delivery Challan", "custom_dux_indent_master")
    ):
        return []

    qty_expression = _get_delivery_challan_qty_expression("item")
    return frappe.db.sql(
        f"""
        select
            dc.name as delivery_challan,
            dc.posting_date,
            dc.status,
            dc.docstatus,
            sum({qty_expression}) as total_qty
        from `tabDelivery Challan` dc
        left join `tabDelivery Challan Item` item on item.parent = dc.name
        where dc.custom_dux_indent_master = %s
        group by dc.name, dc.posting_date, dc.status, dc.docstatus
        order by dc.creation asc
        """,
        indent_name,
        as_dict=True,
    )


def _get_submitted_delivery_qty_map(indent_name, exclude_delivery_challan=None):
    if not (
        frappe.db.exists("DocType", "Delivery Challan")
        and frappe.db.has_column("Delivery Challan", "custom_dux_indent_master")
        and frappe.db.has_column("Delivery Challan Item", "custom_dux_indent_item")
    ):
        return {}

    conditions = ["dc.custom_dux_indent_master = %s", "dc.docstatus = 1"]
    values = [indent_name]
    if exclude_delivery_challan:
        conditions.append("dc.name != %s")
        values.append(exclude_delivery_challan)

    qty_expression = _get_delivery_challan_qty_expression("item")
    rows = frappe.db.sql(
        f"""
        select
            item.custom_dux_indent_item as indent_item,
            sum({qty_expression}) as qty
        from `tabDelivery Challan Item` item
        inner join `tabDelivery Challan` dc on dc.name = item.parent
        where {" and ".join(conditions)}
          and coalesce(item.custom_dux_indent_item, '') != ''
        group by item.custom_dux_indent_item
        """,
        values,
        as_dict=True,
    )
    return {row.indent_item: flt(row.qty) for row in rows}


def _get_draft_delivery_qty_map(indent_name, exclude_delivery_challan=None):
    if not (
        frappe.db.exists("DocType", "Delivery Challan")
        and frappe.db.has_column("Delivery Challan", "custom_dux_indent_master")
        and frappe.db.has_column("Delivery Challan Item", "custom_dux_indent_item")
    ):
        return {}

    conditions = ["dc.custom_dux_indent_master = %s", "dc.docstatus = 0"]
    values = [indent_name]
    if exclude_delivery_challan:
        conditions.append("dc.name != %s")
        values.append(exclude_delivery_challan)

    qty_expression = _get_delivery_challan_qty_expression("item")
    rows = frappe.db.sql(
        f"""
        select
            item.custom_dux_indent_item as indent_item,
            sum({qty_expression}) as qty
        from `tabDelivery Challan Item` item
        inner join `tabDelivery Challan` dc on dc.name = item.parent
        where {" and ".join(conditions)}
          and coalesce(item.custom_dux_indent_item, '') != ''
        group by item.custom_dux_indent_item
        """,
        values,
        as_dict=True,
    )
    return {row.indent_item: flt(row.qty) for row in rows}


def _get_delivery_challan_item_qty_map(doc):
    quantities = defaultdict(float)
    for item in doc.get("items") or []:
        row_name = item.get("custom_dux_indent_item")
        if row_name:
            quantities[row_name] += _get_delivery_challan_item_qty(item)
    return dict(quantities)


def _set_delivery_challan_item_quantities(doc):
    if not doc.get("custom_dux_indent_master"):
        return

    for item in doc.get("items") or []:
        _set_if_field(item, "custom_delivery_challan_qty", flt(item.qty))


def _get_delivery_challan_item_qty(item):
    return flt(item.get("custom_delivery_challan_qty")) or flt(item.qty)


def _get_delivery_challan_qty_expression(alias):
    if frappe.db.has_column("Delivery Challan Item", "custom_delivery_challan_qty"):
        return f"coalesce({alias}.custom_delivery_challan_qty, {alias}.qty, 0)"
    return f"coalesce({alias}.qty, 0)"


def _get_delivery_challan_tracking_status(docstatus, status):
    if docstatus == 2:
        return "Cancelled"
    if docstatus == 1:
        return "Accepted" if status == "Accepted" else "Submitted"
    return "Draft"


def _parse_selected_items(selected_items):
    if isinstance(selected_items, str):
        selected_items = json.loads(selected_items or "[]")

    quantities = defaultdict(float)
    for item in selected_items or []:
        row_name = item.get("item_row") or item.get("row_name") or item.get("name")
        qty = flt(item.get("qty") or item.get("purchase_qty"))
        if row_name and qty:
            quantities[row_name] += qty
    return dict(quantities)


def _upsert_material_purchase_row(indent, material_request, status, transaction_date, total_qty):
    existing = None
    for row in indent.get("material_purchase") or []:
        if row.material_purchase_id == material_request:
            existing = row
            break

    if not existing:
        existing = indent.append("material_purchase", {})

    existing.material_purchase_id = material_request
    existing.status = status
    existing.transaction_date = transaction_date
    existing.total_qty = total_qty


def _has_material_purchase(indent):
    if any(row.material_purchase_id for row in indent.get("material_purchase") or []):
        return True

    if frappe.db.has_column("Material Request", "custom_dux_indent_master"):
        return bool(
            frappe.db.exists(
                "Material Request",
                {"custom_dux_indent_master": indent.name},
            )
        )

    return False


def _upsert_delivery_challan_row(indent, delivery_challan, status, transaction_date, total_qty):
    if not indent.meta.has_field("delivery_challans"):
        return

    existing = None
    for row in indent.get("delivery_challans") or []:
        if row.delivery_challan_id == delivery_challan:
            existing = row
            break

    if not existing:
        existing = indent.append("delivery_challans", {})

    existing.delivery_challan_id = delivery_challan
    existing.status = status
    existing.transaction_date = transaction_date
    existing.total_qty = flt(total_qty)


def _remove_missing_delivery_challan_rows(indent, summaries):
    if not indent.meta.has_field("delivery_challans"):
        return

    summary_names = {summary.delivery_challan for summary in summaries}
    indent.set(
        "delivery_challans",
        [
            row
            for row in indent.get("delivery_challans") or []
            if row.delivery_challan_id and row.delivery_challan_id in summary_names
        ],
    )


def _update_indent_delivery_and_stock_fields(indent, submitted_qty=None):
    if not indent or indent.is_new():
        return

    submitted_qty = submitted_qty or _get_submitted_delivery_qty_map(indent.name)
    for row in indent.get("items") or []:
        delivery_challan_qty = flt(submitted_qty.get(row.name))
        if row.meta.has_field("delivery_challan_qty"):
            row.delivery_challan_qty = delivery_challan_qty
        if row.meta.has_field("delivery_balance_qty"):
            row.delivery_balance_qty = max(flt(row.qty) - delivery_challan_qty, 0)
        if row.meta.has_field("stock_qty"):
            row.stock_qty = _get_indent_display_stock_qty(row)


def _set_if_field(doc, fieldname, value):
    if doc.meta.has_field(fieldname):
        doc.set(fieldname, value)


def _set_material_request_item_specification(item, specification):
    _set_if_field(item, "custom_dux_indent_specification", specification)

    for fieldname in _get_safe_material_request_specification_fields(item):
        item.set(fieldname, specification)


def _get_safe_material_request_specification_fields(item):
    safe_fields = []
    for fieldname in ("specification", "item_specification", "custom_specification"):
        df = item.meta.get_field(fieldname)
        if (
            df
            and fieldname != "custom_dux_indent_specification"
            and not df.hidden
            and df.fieldtype in ("Data", "Small Text", "Text", "Text Editor")
        ):
            safe_fields.append(fieldname)
    return safe_fields


def _get_indent_display_stock_qty(row):
    warehouse = _get_row_warehouse(row)
    if not row.item_code or not warehouse:
        return 0

    # stock_qty is display-only Bin actual_qty. Do not subtract delivery qty here.
    # Actual stock movement must be handled by Delivery Challan/Stock Entry process separately.
    return flt(get_item_stock_qty(row.item_code, warehouse))


def _set_delivery_challan_remark(delivery_challan, indent):
    remark = indent.remark or _("Created from Dux Indent Master {0}").format(indent.name)
    for fieldname in ("remark", "remarks", "custom_remark"):
        if delivery_challan.meta.has_field(fieldname):
            delivery_challan.set(fieldname, remark)
            return


def _save_indent(indent, ignore_links=False):
    if getattr(indent, "docstatus", None) == 2:
        return

    indent.flags.ignore_validate_update_after_submit = True
    indent.flags.ignore_closed_validation = True
    if ignore_links:
        indent.flags.ignore_links = True
    indent.save(ignore_permissions=True)


def _get_logged_in_user_details(user=None):
    user = user or frappe.session.user
    if not user or user == "Guest":
        return {
            "user": user,
            "full_name": user,
            "employee": None,
            "employee_name": None,
            "department": None,
        }

    full_name = frappe.db.get_value("User", user, "full_name") or user
    employee = _get_employee_for_user(user)

    return {
        "user": user,
        "full_name": full_name,
        "employee": employee.name if employee else None,
        "employee_name": employee.employee_name if employee else None,
        "department": employee.department if employee else None,
    }


def _get_employee_for_user(user):
    employee_meta = frappe.get_meta("Employee")
    lookup_fields = ["user_id", "company_email", "prefered_email"]

    for fieldname in lookup_fields:
        if not employee_meta.has_field(fieldname):
            continue

        employee = frappe.db.get_value(
            "Employee",
            {fieldname: user},
            ["name", "employee_name", "department"],
            as_dict=True,
        )
        if employee:
            return employee

    return None


def _get_row_warehouse(row):
    return row.get("warehouse") or row.get("source_warehouse")


def _get_delivery_balance_qty(row):
    if row.meta.has_field("delivery_balance_qty") and row.get("delivery_balance_qty") is not None:
        return flt(row.delivery_balance_qty)
    return max(flt(row.qty) - flt(row.get("delivery_challan_qty")), 0)


def _get_delivery_creation_balance_qty(row, draft_qty):
    return max(_get_delivery_balance_qty(row) - flt(draft_qty.get(row.name)), 0)


def _get_delivery_challan_transit_warehouse(company):
    method = (
        "delivery_challan_custom.delivery_challan_custom.doctype.delivery_challan."
        "delivery_challan.get_transit_warehouse"
    )
    return frappe.get_attr(method)(company)


def _validate_delivery_source_warehouse(warehouse, company, transit_warehouse):
    details = frappe.db.get_value(
        "Warehouse",
        warehouse,
        ["company", "is_group", "warehouse_name", "warehouse_type"],
        as_dict=True,
    )
    if not details:
        frappe.throw(_("Warehouse {0} does not exist.").format(warehouse))
    if details.is_group:
        frappe.throw(_("Please select a non-group Source Warehouse: {0}.").format(warehouse))
    if details.company != company:
        frappe.throw(
            _("Source Warehouse {0} does not belong to Company {1}.").format(
                warehouse, company
            )
        )

    is_transit = (
        warehouse == transit_warehouse
        or cstr(details.warehouse_type).strip().lower() == "transit"
        or "transit" in cstr(details.warehouse_name).strip().lower()
    )
    if is_transit:
        frappe.throw(
            _(
                "{0} is a Transit Warehouse and cannot be used as the Source "
                "Warehouse for a new Delivery Challan. Stock in this warehouse "
                "is already in transit; receive it against its existing Delivery "
                "Challan or select a non-transit source warehouse."
            ).format(warehouse)
        )


def _validate_delivery_source_stock(delivery_rows):
    required_by_stock_key = defaultdict(float)
    for row, qty, row_warehouse in delivery_rows:
        required_by_stock_key[(row.item_code, row_warehouse)] += flt(qty)

    for (item_code, warehouse), required_qty in sorted(required_by_stock_key.items()):
        available_qty = flt(get_item_stock_qty(item_code, warehouse))
        if available_qty + 1e-9 < flt(required_qty):
            frappe.throw(
                _(
                    "Insufficient dispatchable stock for {0} in {1}. "
                    "Required: {2}, Available: {3}. Stock in a Transit Warehouse "
                    "belongs to an existing Delivery Challan and is not available "
                    "for a new dispatch."
                ).format(item_code, warehouse, required_qty, available_qty)
            )


PO_APPROVAL_TOKEN_TTL = 14 * 24 * 60 * 60  # 14 days
PO_APPROVAL_EMAIL_TEMPLATE = "Po approval email"
PO_APPROVAL_ROLE = "PO Approver"


def _get_po_department(doc):
    for row in doc.get("items") or []:
        material_request = row.get("material_request")
        if not material_request:
            continue
        department = frappe.db.get_value(
            "Material Request", material_request, "custom_dux_indent_department"
        )
        if department:
            return department
    return "-"


def _get_po_item_summary(doc):
    names = [row.item_name or row.item_code for row in (doc.get("items") or []) if row.item_code]
    if not names:
        return "-"
    if len(names) <= 2:
        return ", ".join(names)
    return f"{names[0]}, {names[1]} +{len(names) - 2} more"


def _create_po_approval_action_token(po_name, user, action):
    token = secrets.token_urlsafe(32)
    frappe.cache().set_value(
        f"po_approval_token:{token}",
        frappe.as_json({"po_name": po_name, "user": user, "action": action}),
        expires_in_sec=PO_APPROVAL_TOKEN_TTL,
    )
    return token


def send_po_approval_emails(doc):
    """Email every PO Approver a personalised one-click Approve/Reject link."""
    if not frappe.db.exists("Email Template", PO_APPROVAL_EMAIL_TEMPLATE):
        frappe.log_error(
            title="PO approval email skipped",
            message=f"Email Template '{PO_APPROVAL_EMAIL_TEMPLATE}' not found.",
        )
        return

    approvers = frappe.get_all(
        "Has Role",
        filters={"role": PO_APPROVAL_ROLE, "parenttype": "User"},
        pluck="parent",
    )
    if not approvers:
        return

    active_users = set(
        frappe.get_all(
            "User",
            filters={"name": ["in", approvers], "enabled": 1},
            pluck="name",
        )
    )
    if not active_users:
        return

    template = frappe.get_doc("Email Template", PO_APPROVAL_EMAIL_TEMPLATE)
    base_url = frappe.utils.get_url()
    view_url = f"{base_url}/app/purchase-order/{doc.name}"

    company_name = doc.company
    po_date = formatdate(doc.transaction_date, "dd-MM-yyyy") if doc.transaction_date else "-"
    vendor_name = doc.supplier_name or doc.supplier
    department = _get_po_department(doc)
    requested_by = frappe.db.get_value("User", doc.owner, "full_name") or doc.owner
    item_description = _get_po_item_summary(doc)
    quantity = fmt_money(doc.total_qty or 0, precision=2)
    delivery_date = formatdate(doc.schedule_date, "dd-MM-yyyy") if doc.schedule_date else "-"
    total_amount = fmt_money(doc.grand_total or 0, currency=doc.currency, precision=2)

    for user in active_users:
        try:
            approver_name = frappe.db.get_value("User", user, "full_name") or user
            approve_token = _create_po_approval_action_token(doc.name, user, "Approve")
            reject_token = _create_po_approval_action_token(doc.name, user, "Reject")
            context = {
                "COMPANY_NAME": company_name,
                "APPROVER_NAME": approver_name,
                "PO_NUMBER": doc.name,
                "PO_DATE": po_date,
                "VENDOR_NAME": vendor_name,
                "DEPARTMENT": department,
                "REQUESTED_BY": requested_by,
                "ITEM_DESCRIPTION": item_description,
                "QUANTITY": quantity,
                "DELIVERY_DATE": delivery_date,
                "TOTAL_AMOUNT": total_amount,
                "APPROVE_URL": (
                    f"{base_url}/api/method/dux_indent_master.api.handle_po_approval_action"
                    f"?token={approve_token}"
                ),
                "REJECT_URL": (
                    f"{base_url}/api/method/dux_indent_master.api.handle_po_approval_action"
                    f"?token={reject_token}"
                ),
                "VIEW_PO_URL": view_url,
            }
            message = frappe.render_template(template.response_html or template.response, context)
            subject = frappe.render_template(
                template.subject or "Purchase Order Approval Required: {{PO_NUMBER}}", context
            )
            frappe.sendmail(
                recipients=[user],
                subject=subject,
                message=message,
                reference_doctype=doc.doctype,
                reference_name=doc.name,
                now=True,
            )
        except Exception:
            frappe.log_error(
                title="PO approval email failed",
                message=f"Could not email PO Approver {user} for {doc.name}.\n{frappe.get_traceback()}",
            )


def on_purchase_order_workflow_state_change(doc, method=None):
    """Send PO Approver notification emails the moment a PO enters Pending Approval.

    Wrapped defensively: a notification failure must never block the actual
    workflow transition/save the user is performing.
    """
    try:
        if doc.get("workflow_state") != "Pending Approval":
            return
        previous = doc.get_doc_before_save()
        previous_state = previous.get("workflow_state") if previous else None
        if previous_state == "Pending Approval":
            return
        send_po_approval_emails(doc)
    except Exception:
        frappe.log_error(
            title="PO approval email trigger failed",
            message=f"Could not send approval emails for {doc.name}.\n{frappe.get_traceback()}",
        )


def _po_approval_page(title, message, is_error=False):
    color = "#dc2626" if is_error else "#16a34a"
    html = (
        "<div style=\"font-family:Arial,Helvetica,sans-serif;max-width:480px;"
        "margin:80px auto;text-align:center;padding:32px;border:1px solid #e2e8f0;"
        f"border-radius:8px;\"><h2 style=\"color:{color};margin-bottom:12px;\">{title}"
        f"</h2><p style=\"color:#374151;font-size:14px;\">{message}</p></div>"
    )
    frappe.respond_as_web_page(title, html, indicator_color=color, success=not is_error)


def _resolve_po_approval_token(token):
    """Look up + validate a token. Returns (doc, user, action) or None (page already rendered)."""
    cache_key = f"po_approval_token:{token}"
    raw = frappe.cache().get_value(cache_key)
    data = frappe.parse_json(raw) if raw else None

    if not data:
        _po_approval_page(
            "Link Expired",
            "This approval link has expired or was already used. Please open the "
            "Purchase Order directly to take action.",
            is_error=True,
        )
        return None

    po_name, user, action = data.get("po_name"), data.get("user"), data.get("action")
    if not frappe.db.exists("Purchase Order", po_name):
        _po_approval_page("Not Found", "This Purchase Order no longer exists.", is_error=True)
        return None

    if PO_APPROVAL_ROLE not in frappe.get_roles(user):
        _po_approval_page(
            "Not Authorized",
            "This action is no longer available for this account.",
            is_error=True,
        )
        return None

    doc = frappe.get_doc("Purchase Order", po_name)
    if doc.get("workflow_state") != "Pending Approval":
        frappe.cache().delete_value(cache_key)
        _po_approval_page(
            "Already Actioned",
            f"Purchase Order {po_name} has already been "
            f"{doc.get('workflow_state') or 'processed'}. No further action is needed.",
        )
        return None

    return doc, user, action


@frappe.whitelist(allow_guest=True)
def handle_po_approval_action(token):
    """Land here when a PO Approver clicks Approve/Reject from the email.

    Approve acts immediately. Reject shows a small form first so the
    approver can record why, before the rejection is actually applied.
    """
    resolved = _resolve_po_approval_token(token)
    if not resolved:
        return
    doc, user, action = resolved

    if action == "Reject":
        html = f"""
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:80px auto;
            padding:32px;border:1px solid #e2e8f0;border-radius:8px;">
            <h2 style="color:#dc2626;margin:0 0 12px;">Reject Purchase Order {frappe.utils.escape_html(doc.name)}</h2>
            <p style="color:#374151;font-size:14px;margin:0 0 16px;">
                Please share a reason for rejecting this Purchase Order (optional).
            </p>
            <form method="POST" action="/api/method/dux_indent_master.api.submit_po_rejection">
                <input type="hidden" name="token" value="{frappe.utils.escape_html(token)}">
                <textarea name="remark" rows="4" placeholder="Reason for rejection"
                    style="width:100%;font-family:inherit;font-size:13px;padding:8px;
                    border:1px solid #cbd5e1;border-radius:4px;box-sizing:border-box;"></textarea>
                <button type="submit" style="margin-top:14px;background-color:#dc2626;
                    color:#ffffff;border:none;font-size:13px;font-weight:bold;padding:10px 22px;
                    border-radius:4px;cursor:pointer;">Confirm Reject</button>
            </form>
        </div>
        """
        frappe.respond_as_web_page("Reject Purchase Order", html, indicator_color="orange")
        return

    frappe.set_user(user)
    from frappe.model.workflow import apply_workflow

    try:
        apply_workflow(doc, action)
        frappe.db.commit()
    except Exception as e:
        frappe.db.rollback()
        _po_approval_page("Action Failed", cstr(e), is_error=True)
        return

    frappe.cache().delete_value(f"po_approval_token:{token}")
    _po_approval_page(
        "Purchase Order Approved", f"Purchase Order {doc.name} has been approved successfully."
    )


@frappe.whitelist(allow_guest=True, methods=["POST"])
def submit_po_rejection(token, remark=None):
    """Land here when the Reject form (with remark) is submitted."""
    resolved = _resolve_po_approval_token(token)
    if not resolved:
        return
    doc, user, action = resolved
    if action != "Reject":
        _po_approval_page("Not Authorized", "This action is no longer valid.", is_error=True)
        return

    frappe.set_user(user)
    from frappe.model.workflow import apply_workflow

    remark = cstr(remark).strip()

    try:
        apply_workflow(doc, "Reject")
        if remark and doc.meta.has_field("custom_rejection_remark"):
            frappe.db.set_value(
                doc.doctype, doc.name, "custom_rejection_remark", remark, update_modified=False
            )
        frappe.db.commit()
    except Exception as e:
        frappe.db.rollback()
        _po_approval_page("Action Failed", cstr(e), is_error=True)
        return

    frappe.cache().delete_value(f"po_approval_token:{token}")
    message = f"Purchase Order {doc.name} has been rejected."
    if remark:
        message += f" Remark: {frappe.utils.escape_html(remark)}"
    _po_approval_page("Purchase Order Rejected", message)
