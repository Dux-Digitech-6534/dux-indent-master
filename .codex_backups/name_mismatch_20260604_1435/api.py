import json
from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import flt, nowdate, nowtime


@frappe.whitelist()
def get_logged_in_user_details():
    return _get_logged_in_user_details()


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
    bin_actual_qty = flt(get_item_stock_qty(item_code, warehouse))
    submitted_delivery_qty = flt(
        get_indent_item_submitted_delivery_qty(indent_name, indent_item_row_name)
    )

    return {
        "bin_actual_qty": bin_actual_qty,
        "submitted_delivery_qty": submitted_delivery_qty,
        "adjusted_stock_qty": max(bin_actual_qty - submitted_delivery_qty, 0),
    }


@frappe.whitelist()
def get_indent_item_submitted_delivery_qty(indent_name=None, indent_item_row_name=None):
    if not indent_name or not indent_item_row_name:
        return 0

    return flt(_get_submitted_delivery_qty_map(indent_name).get(indent_item_row_name))


@frappe.whitelist()
def recalculate_indent_delivery_and_stock(indent_name=None):
    if not indent_name:
        frappe.throw(_("Dux Indent Master name is required."))
    if not frappe.db.exists("Dux Indent Master", indent_name):
        frappe.throw(_("Dux Indent Master {0} does not exist.").format(indent_name))

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
def debug_last_material_request_specification(indent_name=None):
    if not indent_name:
        frappe.throw(_("Dux Indent Master name is required."))

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
    if indent.docstatus == 2:
        frappe.throw(_("Cannot create Material Request from a cancelled Dux Indent Master."))
    if indent.docstatus != 1:
        frappe.throw(_("Submit Dux Indent Master before creating a Material Request."))
    if _has_material_purchase(indent):
        frappe.throw(_("Material Purchase can be created only once for a Dux Indent Master."))

    quantities = _parse_selected_items(selected_items)
    if not quantities:
        frappe.throw(_("Select at least one item with purchase quantity."))

    rows_by_name = {row.name: row for row in indent.get("items") or []}
    mr = frappe.new_doc("Material Request")
    mr.material_request_type = "Purchase"
    mr.company = indent.company_name
    mr.transaction_date = nowdate()
    warehouses = []

    if mr.meta.has_field("schedule_date"):
        mr.schedule_date = indent.required_date

    _set_if_field(mr, "custom_dux_indent_master", indent.name)
    _set_if_field(mr, "custom_dux_indent_user", indent.user_name)
    _set_if_field(mr, "custom_dux_indent_department", indent.department_name)
    _set_if_field(mr, "custom_dux_indent_note_attachment", indent.note_attachment)
    _set_if_field(mr, "custom_dux_indent_design_attachment", indent.design_attachment)
    _set_if_field(mr, "custom_dux_indent_remark", indent.remark)

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
        warehouse = _get_row_warehouse(row)
        _set_if_field(item, "warehouse", warehouse)
        if warehouse:
            warehouses.append(warehouse)
        _set_if_field(item, "custom_dux_indent_master", indent.name)
        _set_if_field(item, "custom_dux_indent_item", row.name)
        _set_material_request_item_specification(item, row.specification)
        total_qty += purchase_qty

    unique_warehouses = set(warehouses)
    if len(unique_warehouses) == 1:
        _set_if_field(mr, "set_warehouse", next(iter(unique_warehouses)))

    mr.insert()

    _upsert_material_purchase_row(indent, mr.name, "Draft", mr.transaction_date, total_qty)
    indent.update_purchase_status()
    _save_indent(indent)

    return {"material_request": mr.name}


@frappe.whitelist()
def create_delivery_challan_from_indent(indent_name):
    if not indent_name or not frappe.db.exists("Dux Indent Master", indent_name):
        frappe.throw(_("Save Dux Indent Master before creating a Delivery Challan."))

    if not frappe.db.exists("DocType", "Delivery Challan"):
        frappe.throw(_("Delivery Challan DocType is not available on this site."))

    indent = frappe.get_doc("Dux Indent Master", indent_name)
    if indent.docstatus == 2:
        frappe.throw(_("Cannot create Delivery Challan from a cancelled Dux Indent Master."))

    _sync_delivery_challan_tracking(indent.name)
    indent.reload()

    draft_qty = _get_draft_delivery_qty_map(indent.name)
    rows = [
        (row, _get_delivery_creation_balance_qty(row, draft_qty))
        for row in indent.get("items") or []
        if row.item_code and _get_delivery_creation_balance_qty(row, draft_qty) > 0
    ]
    if not rows:
        frappe.throw(_("No delivery balance quantity is available for Delivery Challan."))

    warehouses = [_get_row_warehouse(row) for row, balance_qty in rows]
    missing_warehouse_rows = [
        row.idx or row.item_code for (row, balance_qty), warehouse in zip(rows, warehouses) if not warehouse
    ]
    if missing_warehouse_rows:
        frappe.throw(
            _("Warehouse is mandatory for Delivery Challan rows: {0}.").format(
                ", ".join(str(row) for row in missing_warehouse_rows)
            )
        )

    company = indent.company_name
    transit_warehouse = _get_delivery_challan_transit_warehouse(company)
    default_warehouse = warehouses[0]

    delivery_challan = frappe.new_doc("Delivery Challan")
    delivery_challan.company = company
    delivery_challan.posting_date = nowdate()
    delivery_challan.posting_time = nowtime()
    delivery_challan.source_warehouse = default_warehouse
    delivery_challan.target_warehouse = default_warehouse
    delivery_challan.transit_warehouse = transit_warehouse
    _set_delivery_challan_remark(delivery_challan, indent)
    _set_if_field(delivery_challan, "custom_dux_indent_master", indent.name)
    _set_if_field(delivery_challan, "custom_dux_indent_required_date", indent.required_date)

    total_qty = 0
    for (row, balance_qty), warehouse in zip(rows, warehouses):
        qty = flt(balance_qty)
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


def on_delivery_challan_validate(doc, method=None):
    _set_delivery_challan_item_quantities(doc)


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
        indent.update_purchase_status()
        _save_indent(indent, ignore_links=status == "Cancelled")


def sync_all_delivery_challan_tracking():
    indent_names = set(frappe.get_all("Dux Indent Master", pluck="name"))
    if frappe.db.exists("DocType", "Delivery Challan") and frappe.db.has_column(
        "Delivery Challan", "custom_dux_indent_master"
    ):
        indent_names.update(
            row.custom_dux_indent_master
            for row in frappe.db.sql(
                """
                select distinct custom_dux_indent_master
                from `tabDelivery Challan`
                where coalesce(custom_dux_indent_master, '') != ''
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

    indent = frappe.get_doc("Dux Indent Master", indent_name)
    indent_rows = {row.name: row for row in indent.get("items") or []}
    existing_qty = _get_submitted_delivery_qty_map(indent_name, exclude_delivery_challan=doc.name)
    incoming_qty = _get_delivery_challan_item_qty_map(doc)

    for row_name, qty in incoming_qty.items():
        indent_row = indent_rows.get(row_name)
        if not indent_row:
            frappe.throw(_("Invalid Dux Indent item row in Delivery Challan: {0}").format(row_name))

        allowed_qty = flt(indent_row.qty)
        total_qty = flt(existing_qty.get(row_name)) + flt(qty)
        if total_qty > allowed_qty:
            frappe.throw(
                _("Delivery Challan Qty {0} cannot exceed indent Qty {1} for {2}.").format(
                    total_qty, allowed_qty, indent_row.item_code
                )
            )


def _sync_delivery_challan_tracking(indent_name, ignore_links=False):
    if not frappe.db.exists("Dux Indent Master", indent_name):
        return

    indent = frappe.get_doc("Dux Indent Master", indent_name)
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


def _get_draft_delivery_qty_map(indent_name):
    if not (
        frappe.db.exists("DocType", "Delivery Challan")
        and frappe.db.has_column("Delivery Challan", "custom_dux_indent_master")
        and frappe.db.has_column("Delivery Challan Item", "custom_dux_indent_item")
    ):
        return {}

    qty_expression = _get_delivery_challan_qty_expression("item")
    rows = frappe.db.sql(
        f"""
        select
            item.custom_dux_indent_item as indent_item,
            sum({qty_expression}) as qty
        from `tabDelivery Challan Item` item
        inner join `tabDelivery Challan` dc on dc.name = item.parent
        where dc.custom_dux_indent_master = %s
          and dc.docstatus = 0
          and coalesce(item.custom_dux_indent_item, '') != ''
        group by item.custom_dux_indent_item
        """,
        indent_name,
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


def update_indent_delivery_and_stock_fields(indent, submitted_qty=None):
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
            row.stock_qty = _get_indent_display_stock_qty(row, delivery_challan_qty)


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


def _get_indent_display_stock_qty(row, delivered_qty):
    warehouse = _get_row_warehouse(row)
    if not row.item_code or not warehouse:
        return 0

    return max(flt(get_item_stock_qty(row.item_code, warehouse)) - flt(delivered_qty), 0)


def _set_delivery_challan_remark(delivery_challan, indent):
    remark = indent.remark or _("Created from Dux Indent Master {0}").format(indent.name)
    for fieldname in ("remark", "remarks", "custom_remark"):
        if delivery_challan.meta.has_field(fieldname):
            delivery_challan.set(fieldname, remark)
            return


def _save_indent(indent, ignore_links=False):
    indent.flags.ignore_validate_update_after_submit = True
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
