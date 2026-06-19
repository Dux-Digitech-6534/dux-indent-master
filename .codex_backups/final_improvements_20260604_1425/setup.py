import frappe


def after_migrate():
    ensure_custom_fields()
    sync_dux_indent_item_warehouse()
    sync_dux_indent_delivery_tracking()


def ensure_custom_fields():
    custom_fields = {
        "Material Request": [
            {
                "fieldname": "custom_dux_indent_master",
                "label": "Dux Indent Master",
                "fieldtype": "Link",
                "options": "Dux Indent Master",
                "read_only": 1,
                "insert_after": "company",
            },
            {
                "fieldname": "custom_dux_indent_user",
                "label": "Dux Indent User",
                "fieldtype": "Link",
                "options": "User",
                "read_only": 1,
                "insert_after": "custom_dux_indent_master",
            },
            {
                "fieldname": "custom_dux_indent_department",
                "label": "Dux Indent Department",
                "fieldtype": "Link",
                "options": "Department",
                "read_only": 1,
                "insert_after": "custom_dux_indent_user",
            },
            {
                "fieldname": "custom_dux_indent_note_attachment",
                "label": "Dux Indent Note Attachment",
                "fieldtype": "Attach",
                "read_only": 1,
                "insert_after": "custom_dux_indent_department",
            },
            {
                "fieldname": "custom_dux_indent_design_attachment",
                "label": "Dux Indent Design Attachment",
                "fieldtype": "Attach",
                "read_only": 1,
                "insert_after": "custom_dux_indent_note_attachment",
            },
            {
                "fieldname": "custom_dux_indent_remark",
                "label": "Dux Indent Remark",
                "fieldtype": "Small Text",
                "read_only": 1,
                "insert_after": "custom_dux_indent_design_attachment",
            },
        ],
        "Material Request Item": [
            {
                "fieldname": "custom_dux_indent_master",
                "label": "Dux Indent Master",
                "fieldtype": "Link",
                "options": "Dux Indent Master",
                "read_only": 1,
                "insert_after": "warehouse",
            },
            {
                "fieldname": "custom_dux_indent_item",
                "label": "Dux Indent Item Row",
                "fieldtype": "Data",
                "read_only": 1,
                "insert_after": "custom_dux_indent_master",
            },
            {
                "fieldname": "custom_dux_indent_specification",
                "label": "Dux Indent Specification",
                "fieldtype": "Small Text",
                "read_only": 1,
                "insert_after": "custom_dux_indent_item",
            },
        ],
        "Delivery Challan": [
            {
                "fieldname": "custom_dux_indent_master",
                "label": "Dux Indent Master",
                "fieldtype": "Link",
                "options": "Dux Indent Master",
                "read_only": 1,
                "insert_after": "company",
            },
            {
                "fieldname": "custom_dux_indent_required_date",
                "label": "Dux Indent Required Date",
                "fieldtype": "Date",
                "read_only": 1,
                "insert_after": "custom_dux_indent_master",
            },
        ],
        "Delivery Challan Item": [
            {
                "fieldname": "custom_delivery_challan_qty",
                "label": "Delivery Challan Qty",
                "fieldtype": "Float",
                "read_only": 1,
                "in_list_view": 1,
                "insert_after": "qty",
            },
            {
                "fieldname": "custom_dux_indent_item",
                "label": "Dux Indent Item Row",
                "fieldtype": "Data",
                "read_only": 1,
                "insert_after": "remarks",
            },
            {
                "fieldname": "custom_dux_indent_specification",
                "label": "Specification",
                "fieldtype": "Small Text",
                "read_only": 1,
                "in_list_view": 1,
                "insert_after": "custom_dux_indent_item",
            },
        ],
    }

    for doctype, fields in custom_fields.items():
        if not frappe.db.exists("DocType", doctype):
            continue
        for field in fields:
            _ensure_custom_field(doctype, field)
        frappe.clear_cache(doctype=doctype)


def sync_dux_indent_item_warehouse():
    if not (
        frappe.db.has_column("Dux Indent Master Item", "warehouse")
        and frappe.db.has_column("Dux Indent Master Item", "source_warehouse")
    ):
        return

    frappe.db.sql(
        """
        update `tabDux Indent Master Item`
        set warehouse = source_warehouse
        where coalesce(warehouse, '') = ''
          and coalesce(source_warehouse, '') != ''
        """
    )


def sync_dux_indent_delivery_tracking():
    if not (
        frappe.db.has_column("Dux Indent Master Item", "delivery_challan_qty")
        and frappe.db.has_column("Dux Indent Master Item", "delivery_balance_qty")
    ):
        return

    from dux_indent_master.api import sync_all_delivery_challan_tracking

    sync_all_delivery_challan_tracking()


def _ensure_custom_field(doctype, field):
    name = f"{doctype}-{field['fieldname']}"
    values = {
        "dt": doctype,
        "fieldname": field["fieldname"],
        "label": field["label"],
        "fieldtype": field["fieldtype"],
        "options": field.get("options"),
        "read_only": field.get("read_only", 0),
        "insert_after": field.get("insert_after"),
        "hidden": field.get("hidden", 0),
        "in_list_view": field.get("in_list_view", 0),
        "reqd": field.get("reqd", 0),
        "allow_on_submit": field.get("allow_on_submit", 0),
        "default": field.get("default"),
    }

    if frappe.db.exists("Custom Field", name):
        doc = frappe.get_doc("Custom Field", name)
        changed = False
        for key, value in values.items():
            if doc.get(key) != value:
                doc.set(key, value)
                changed = True
        if changed:
            doc.save(ignore_permissions=True)
    else:
        frappe.get_doc({"doctype": "Custom Field", "name": name, **values}).insert(
            ignore_permissions=True
        )
