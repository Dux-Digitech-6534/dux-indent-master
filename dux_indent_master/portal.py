from __future__ import annotations

from copy import deepcopy

import frappe
from frappe import _
from frappe.utils import cint, cstr, flt, getdate, nowdate

from dux_indent_master.api import _get_logged_in_user_details


SYSTEM_FIELDS = {"name", "owner", "creation", "modified", "modified_by", "docstatus"}
MAX_PAGE_LENGTH = 50


# These are ERPNext's own document mappers. Keeping the methods in an
# allowlist lets the portal expose the native procurement flow without
# accepting arbitrary method names from the browser.
DOCUMENT_MAPPINGS = {
    "purchase_order": {
        "material_request": {
            "label": "Material Request",
            "method": "erpnext.stock.doctype.material_request.material_request.make_purchase_order",
            "multiple": True,
            "company_filter": True,
            "allow_child_item_selection": True,
            "child_fieldname": "items",
            "child_columns": ["item_code", "item_name", "qty", "ordered_qty"],
            "date_field": "transaction_date",
            "setters": {"schedule_date": None},
            "filters": {
                "docstatus": 1,
                "material_request_type": "Purchase",
                "status": ["!=", "Stopped"],
                "per_ordered": ["<", 100],
            },
        },
    },
    "purchase_receipt": {
        "purchase_order": {
            "label": "Purchase Order",
            "method": "erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_receipt",
            "filters": {
                "docstatus": 1,
                "status": ["not in", ["Closed", "On Hold"]],
                "per_received": ["<", 99.99],
            },
        },
    },
    "purchase_invoice": {
        "purchase_order": {
            "label": "Purchase Order",
            "method": "erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_invoice",
            "filters": {
                "docstatus": 1,
                "status": ["not in", ["Closed", "On Hold"]],
                "per_billed": ["<", 99.99],
            },
        },
        "purchase_receipt": {
            "label": "Purchase Receipt",
            "method": "erpnext.stock.doctype.purchase_receipt.purchase_receipt.make_purchase_invoice",
            "filters": {
                "docstatus": 1,
                "status": ["not in", ["Closed", "Completed", "Return Issued"]],
                "is_return": 0,
            },
        },
    },
}


def _column(label, *fieldnames):
    return {"label": label, "fieldnames": fieldnames}


def _has_portal_display_value(value):
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


DOCUMENT_CONFIG = {
    "material_request": {
        "label": "Material Request",
        "doctype": "Material Request",
        "icon": "clipboard",
        "description": "Plan and request materials for procurement or stock movement.",
        "columns": [
            _column("Material Request", "name"),
            _column("Transaction Date", "transaction_date"),
            _column("Required By", "schedule_date"),
            _column("Company", "company"),
            _column("Requested By", "custom_dux_indent_user", "owner"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Material Request", "name"),
            _column("Type", "material_request_type"),
            _column("Transaction Date", "transaction_date"),
            _column("Required By", "schedule_date"),
            _column("Company", "company"),
            _column("Warehouse", "set_warehouse"),
            _column("Dux Indent Master", "custom_dux_indent_master"),
            _column("Requested By", "custom_dux_indent_user", "owner"),
            _column("Department", "custom_dux_indent_department"),
            _column("Status", "status"),
            _column("Remarks", "custom_dux_indent_remark"),
        ],
        "child_tables": [
            {
                "fieldname": "items",
                "label": "Items",
                "fields": [
                    _column("Item", "item_code"),
                    _column("Item Name", "item_name"),
                    _column("Quantity", "qty"),
                    _column("UOM", "uom"),
                    _column("Warehouse", "warehouse"),
                    _column("Required Date", "schedule_date"),
                    _column("Specification", "custom_dux_indent_specification", "description"),
                ],
            }
        ],
        "date_field": "transaction_date",
        "company_field": "company",
        "search_fields": ["name", "custom_dux_indent_master", "custom_dux_indent_user"],
    },
    "purchase_order": {
        "label": "Purchase Order",
        "doctype": "Purchase Order",
        "icon": "document",
        "description": "Supplier purchase commitments and order tracking.",
        "columns": [
            _column("Purchase Order", "name"),
            _column("Supplier", "supplier"),
            _column("Transaction Date", "transaction_date"),
            _column("Required By", "schedule_date"),
            _column("Grand Total", "grand_total"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Purchase Order", "name"),
            _column("Supplier", "supplier"),
            _column("Transaction Date", "transaction_date"),
            _column("Required By", "schedule_date"),
            _column("Company", "company"),
            _column("Currency", "currency"),
            _column("Grand Total", "grand_total"),
            _column("Status", "status"),
            _column("Project", "project"),
        ],
        "child_tables": [
            {
                "fieldname": "items",
                "label": "Items",
                "fields": [
                    _column("Item", "item_code"),
                    _column("Quantity", "qty"),
                    _column("UOM", "uom"),
                    _column("Rate", "rate"),
                    _column("Amount", "amount"),
                    _column("Warehouse", "warehouse"),
                ],
            }
        ],
        "date_field": "transaction_date",
        "company_field": "company",
        "search_fields": ["name", "supplier", "supplier_name"],
    },
    "purchase_receipt": {
        "label": "Purchase Receipt",
        "doctype": "Purchase Receipt",
        "icon": "receipt",
        "description": "Receive purchased materials and update stock.",
        "columns": [
            _column("Purchase Receipt", "name"),
            _column("Supplier", "supplier"),
            _column("Posting Date", "posting_date"),
            _column("Company", "company"),
            _column("Grand Total", "grand_total"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Purchase Receipt", "name"),
            _column("Supplier", "supplier"),
            _column("Posting Date", "posting_date"),
            _column("Company", "company"),
            _column("Currency", "currency"),
            _column("Grand Total", "grand_total"),
            _column("Status", "status"),
            _column("Project", "project"),
        ],
        "child_tables": [
            {
                "fieldname": "items",
                "label": "Items",
                "fields": [
                    _column("Item", "item_code"),
                    _column("Item Name", "item_name"),
                    _column("Accepted Qty", "qty"),
                    _column("Rejected Qty", "rejected_qty"),
                    _column("UOM", "uom"),
                    _column("Warehouse", "warehouse"),
                    _column("Purchase Order", "purchase_order"),
                ],
            }
        ],
        "date_field": "posting_date",
        "company_field": "company",
        "search_fields": ["name", "supplier", "supplier_name"],
    },
    "purchase_invoice": {
        "label": "Purchase Invoice",
        "doctype": "Purchase Invoice",
        "icon": "rupee",
        "description": "Supplier invoices and purchase accounting.",
        "columns": [
            _column("Purchase Invoice", "name"),
            _column("Supplier", "supplier"),
            _column("Bill No", "bill_no"),
            _column("Posting Date", "posting_date"),
            _column("Due Date", "due_date"),
            _column("Grand Total", "grand_total"),
            _column("Outstanding", "outstanding_amount"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Purchase Invoice", "name"),
            _column("Supplier", "supplier"),
            _column("Bill No", "bill_no"),
            _column("Posting Date", "posting_date"),
            _column("Due Date", "due_date"),
            _column("Company", "company"),
            _column("Currency", "currency"),
            _column("Grand Total", "grand_total"),
            _column("Outstanding", "outstanding_amount"),
            _column("Status", "status"),
        ],
        "child_tables": [
            {
                "fieldname": "items",
                "label": "Items",
                "fields": [
                    _column("Item", "item_code"),
                    _column("Item Name", "item_name"),
                    _column("Quantity", "qty"),
                    _column("UOM", "uom"),
                    _column("Rate", "rate"),
                    _column("Amount", "amount"),
                    _column("Purchase Receipt", "purchase_receipt"),
                ],
            }
        ],
        "date_field": "posting_date",
        "company_field": "company",
        "search_fields": ["name", "supplier", "bill_no"],
    },
    "stock_entry": {
        "label": "Stock Entry",
        "doctype": "Stock Entry",
        "icon": "layers",
        "description": "Material transfers, receipts, issues and stock adjustments.",
        "columns": [
            _column("Stock Entry", "name"),
            _column("Stock Entry Type", "stock_entry_type", "purpose"),
            _column("Posting Date", "posting_date"),
            _column("Company", "company"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Stock Entry", "name"),
            _column("Stock Entry Type", "stock_entry_type", "purpose"),
            _column("Posting Date", "posting_date"),
            _column("Company", "company"),
            _column("From Warehouse", "from_warehouse"),
            _column("To Warehouse", "to_warehouse"),
            _column("Project", "project"),
            _column("Status", "status"),
            _column("Remarks", "remarks"),
        ],
        "child_tables": [
            {
                "fieldname": "items",
                "label": "Items",
                "fields": [
                    _column("Item", "item_code"),
                    _column("Quantity", "qty"),
                    _column("UOM", "uom"),
                    _column("Source Warehouse", "s_warehouse"),
                    _column("Target Warehouse", "t_warehouse"),
                ],
            }
        ],
        "date_field": "posting_date",
        "company_field": "company",
        "search_fields": ["name", "stock_entry_type", "purpose"],
    },
    "payment_entry": {
        "label": "Payment Entry",
        "doctype": "Payment Entry",
        "icon": "rupee",
        "description": "Supplier payments and accounting entries.",
        "columns": [
            _column("Payment Entry", "name"),
            _column("Payment Type", "payment_type"),
            _column("Party", "party", "party_name"),
            _column("Posting Date", "posting_date"),
            _column("Paid Amount", "paid_amount"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Payment Entry", "name"),
            _column("Payment Type", "payment_type"),
            _column("Party Type", "party_type"),
            _column("Party", "party", "party_name"),
            _column("Posting Date", "posting_date"),
            _column("Mode of Payment", "mode_of_payment"),
            _column("Reference No", "reference_no"),
            _column("Paid Amount", "paid_amount"),
            _column("Received Amount", "received_amount"),
            _column("Status", "status"),
        ],
        "child_tables": [
            {
                "fieldname": "references",
                "label": "References",
                "fields": [
                    _column("Reference Type", "reference_doctype"),
                    _column("Reference", "reference_name"),
                    _column("Total Amount", "total_amount"),
                    _column("Outstanding", "outstanding_amount"),
                    _column("Allocated", "allocated_amount"),
                ],
            }
        ],
        "date_field": "posting_date",
        "company_field": "company",
        "search_fields": ["name", "party", "reference_no"],
    },
    "delivery_challan": {
        "label": "Delivery Challan",
        "doctype": "Delivery Challan",
        "icon": "truck",
        "description": "Dispatch challans for controlled material movement.",
        "columns": [
            _column("Delivery Challan", "name"),
            _column("Project / Site", "project"),
            _column("Dispatch Date", "posting_date"),
            _column("Source Warehouse", "source_warehouse"),
            _column("Vehicle Number", "vehicle_no"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Delivery Challan", "name"),
            _column("Company", "company"),
            _column("Posting Date", "posting_date"),
            _column("Project / Site", "project"),
            _column("Source Warehouse", "source_warehouse"),
            _column("Target Warehouse", "target_warehouse"),
            _column("Transit Warehouse", "transit_warehouse"),
            _column("Vehicle Number", "vehicle_no"),
            _column("Driver Name", "driver_name"),
            _column("Dux Indent Master", "custom_dux_indent_master"),
            _column("Dispatch Stock Entry", "dispatch_stock_entry"),
            _column("Status", "status"),
            _column("Remarks", "remarks"),
        ],
        "child_tables": [
            {
                "fieldname": "items",
                "label": "Items",
                "fields": [
                    _column("Item", "item_code"),
                    _column("Description", "description"),
                    _column("Quantity", "qty"),
                    _column("Received Qty", "received_qty"),
                    _column("Pending Qty", "pending_qty"),
                    _column("UOM", "uom"),
                    _column("Source Warehouse", "source_warehouse"),
                    _column("Status", "row_status"),
                ],
            }
        ],
        "date_field": "posting_date",
        "company_field": "company",
        "search_fields": ["name", "project", "vehicle_no", "custom_dux_indent_master"],
    },
    "delivery_receipts": {
        "label": "Delivery Challan Receipts",
        "doctype": "Delivery Challan",
        "icon": "receipt",
        "description": "Receive and reconcile dispatched Delivery Challans.",
        "columns": [
            _column("Delivery Challan", "name"),
            _column("Project / Site", "project"),
            _column("Posting Date", "posting_date"),
            _column("Source Warehouse", "source_warehouse"),
            _column("Received By", "received_by"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Delivery Challan", "name"),
            _column("Project / Site", "project"),
            _column("Posting Date", "posting_date"),
            _column("Dispatch Date/Time", "dispatch_datetime"),
            _column("Receipt Date/Time", "receipt_datetime"),
            _column("Dispatched By", "dispatched_by"),
            _column("Received By", "received_by"),
            _column("Source Warehouse", "source_warehouse"),
            _column("Target Warehouse", "target_warehouse"),
            _column("Status", "status"),
        ],
        "child_tables": [
            {
                "fieldname": "items",
                "label": "Receipt Items",
                "fields": [
                    _column("Item", "item_code"),
                    _column("Dispatched Qty", "qty"),
                    _column("Received Qty", "received_qty"),
                    _column("Pending Qty", "pending_qty"),
                    _column("UOM", "uom"),
                    _column("Status", "row_status"),
                ],
            }
        ],
        "date_field": "posting_date",
        "company_field": "company",
        "search_fields": ["name", "project", "received_by"],
        "default_filters": {"status": ["in", ["In Transit", "Partially Received", "Received", "Closed with Shortage"]]},
        "allow_create": False,
    },
    "dux_indent_master": {
        "label": "Dux Indent Master",
        "doctype": "Dux Indent Master",
        "icon": "clipboard",
        "description": "Indent planning, procurement progress, stock and delivery tracking.",
        "columns": [
            _column("Indent ID", "name"),
            _column("Transaction Date", "transaction_date"),
            _column("Required Date", "required_date"),
            _column("Company", "company_name"),
            _column("Requested By", "user_full_name", "user_name"),
            _column("Department", "department_name"),
            _column("Status", "status"),
        ],
        "detail_fields": [
            _column("Indent ID", "name"),
            _column("Transaction Date", "transaction_date"),
            _column("Required Date", "required_date"),
            _column("Company", "company_name"),
            _column("Requested By", "user_full_name", "user_name"),
            _column("Department", "department_name"),
            _column("Status", "status"),
            _column("Manually Closed", "manually_closed"),
            _column("Closed By", "closed_by"),
            _column("Closed On", "closed_on"),
            _column("Remark", "remark"),
            _column("Note Attachment", "note_attachment"),
            _column("Design Attachment", "design_attachment"),
        ],
        "child_tables": [
            {
                "fieldname": "items",
                "label": "Indent Items",
                "fields": [
                    _column("Item", "item_code"),
                    _column("Quantity", "qty"),
                    _column("UOM", "uom"),
                    _column("Required Date", "required_date"),
                    _column("Stock Qty", "stock_qty"),
                    _column("Warehouse", "warehouse", "source_warehouse"),
                    _column("MR Qty", "material_request_qty", "purchase_qty"),
                    _column("Ordered Qty", "ordered_qty"),
                    _column("Received Qty", "received_qty"),
                    _column("DC Qty", "delivery_challan_qty"),
                    _column("DC Balance", "delivery_balance_qty"),
                    _column("Specification", "specification"),
                ],
            },
            {
                "fieldname": "material_purchase",
                "label": "Material Requests",
                "fields": [
                    _column("Material Request", "material_purchase_id"),
                    _column("Transaction Date", "transaction_date"),
                    _column("Total Qty", "total_qty"),
                    _column("Status", "status"),
                ],
            },
            {
                "fieldname": "delivery_challans",
                "label": "Delivery Challans",
                "fields": [
                    _column("Delivery Challan", "delivery_challan_id"),
                    _column("Transaction Date", "transaction_date"),
                    _column("Total Qty", "total_qty"),
                    _column("Status", "status"),
                ],
            },
        ],
        "date_field": "transaction_date",
        "company_field": "company_name",
        "search_fields": ["name", "user_full_name", "user_name", "department_name"],
    },
    "supplier": {
        "label": "Supplier",
        "doctype": "Supplier",
        "icon": "building",
        "description": "Supplier master records, tax identity and buying defaults.",
        "columns": [
            _column("Supplier", "name"),
            _column("Supplier Name", "supplier_name"),
            _column("Supplier Group", "supplier_group"),
            _column("Supplier Type", "supplier_type"),
            _column("Tax ID", "tax_id"),
            _column("Disabled", "disabled"),
        ],
        "detail_fields": [
            _column("Supplier", "name"),
            _column("Supplier Name", "supplier_name"),
            _column("Supplier Group", "supplier_group"),
            _column("Supplier Type", "supplier_type"),
            _column("Country", "country"),
            _column("Tax ID", "tax_id"),
            _column("Default Currency", "default_currency"),
            _column("Default Price List", "default_price_list"),
            _column("Disabled", "disabled"),
        ],
        "date_field": "creation",
        "search_fields": ["name", "supplier_name", "tax_id"],
    },
    "item": {
        "label": "Item",
        "doctype": "Item",
        "icon": "box",
        "description": "Item master, UOM, stock attributes and valuation defaults.",
        "columns": [
            _column("Item Code", "name"),
            _column("Item Name", "item_name"),
            _column("Item Group", "item_group"),
            _column("Stock UOM", "stock_uom"),
            _column("Valuation Rate", "valuation_rate"),
            _column("Disabled", "disabled"),
        ],
        "detail_fields": [
            _column("Item Code", "name"),
            _column("Item Name", "item_name"),
            _column("Item Group", "item_group"),
            _column("Stock UOM", "stock_uom"),
            _column("Is Stock Item", "is_stock_item"),
            _column("Valuation Rate", "valuation_rate"),
            _column("Default Material Request Type", "default_material_request_type"),
            _column("Brand", "brand"),
            _column("Disabled", "disabled"),
            _column("Description", "description"),
        ],
        "date_field": "creation",
        "search_fields": ["name", "item_name", "item_group"],
    },
}


LINK_CONFIG = {
    "buying_settings": {
        "label": "Buying Settings",
        "icon": "settings",
        "description": "Configure purchase defaults and buying controls.",
        "kind": "single",
        "doctype": "Buying Settings",
    },
    "accounts_payable": {
        "label": "Accounts Payable",
        "icon": "chart",
        "description": "Supplier outstanding report.",
        "kind": "report",
        "report": "Accounts Payable",
        "ref_doctype": "Purchase Invoice",
    },
    "purchase_register": {
        "label": "Purchase Register",
        "icon": "chart",
        "description": "Purchase invoice register.",
        "kind": "report",
        "report": "Purchase Register",
        "ref_doctype": "Purchase Invoice",
    },
    "itemwise_purchase_register": {
        "label": "Item-wise Purchase Register",
        "icon": "chart",
        "description": "Purchase analysis by item.",
        "kind": "report",
        "report": "Item-wise Purchase Register",
        "ref_doctype": "Purchase Invoice",
    },
}


# Portal-native forms intentionally expose an allowlisted, operational subset
# of each DocType. Native document controllers remain authoritative when these
# values are saved or submitted.
FORM_CONFIG = {
    "material_request": {
        "sections": [
            {
                "label": "Request Details",
                "fields": [
                    "material_request_type",
                    "transaction_date",
                    "schedule_date",
                    "company",
                    "set_warehouse",
                    "set_from_warehouse",
                    "custom_dux_indent_remark",
                ],
                "field_overrides": {
                    "schedule_date": {"min_date_field": "transaction_date"},
                    "custom_dux_indent_remark": {"label": "Remark", "force_editable": True},
                },
            },
            {
                "label": "Indent Reference",
                "fields": ["custom_dux_indent_master", "custom_dux_indent_user", "custom_dux_indent_department"],
                "collapsible": True,
                "collapsed": True,
                "position": "after_tables",
            },
        ],
        "tables": [
            {
                "fieldname": "items",
                "fields": ["item_code", "schedule_date", "qty", "uom", "custom_dux_indent_specification", "description"],
                "field_overrides": {
                    "schedule_date": {"label": "Required Date", "force_read_only": True},
                    "custom_dux_indent_specification": {"label": "Specification", "force_editable": True},
                },
            },
        ],
    },
    "purchase_order": {
        "sections": [
            {"label": "Supplier & Schedule", "fields": ["naming_series", "supplier", "transaction_date", "schedule_date", "company", "set_warehouse", "custom_priority"]},
            {"label": "Currency & Terms", "fields": ["currency", "conversion_rate", "buying_price_list", "tc_name", "terms"]},
        ],
        "tables": [
            {"fieldname": "items", "fields": ["item_code", "schedule_date", "qty", "uom", "conversion_factor", "rate", "description"]},
        ],
    },
    "purchase_receipt": {
        "sections": [
            {"label": "Supplier & Posting", "fields": ["naming_series", "supplier", "posting_date", "posting_time", "set_posting_time", "company", "set_warehouse", "rejected_warehouse", "is_return"]},
            {"label": "Delivery Note & Currency", "fields": ["supplier_delivery_note", "currency", "conversion_rate", "buying_price_list"]},
        ],
        "tables": [
            {"fieldname": "items", "fields": ["item_code", "item_name", "received_qty", "qty", "rejected_qty", "uom", "conversion_factor", "rate", "purchase_order", "purchase_order_item", "description"]},
            {"fieldname": "taxes", "fields": ["category", "add_deduct_tax", "charge_type", "account_head", "description", "rate", "tax_amount"]},
        ],
    },
    "purchase_invoice": {
        "sections": [
            {"label": "Supplier & Posting", "fields": ["naming_series", "supplier", "posting_date", "posting_time", "set_posting_time", "due_date", "company", "bill_no", "bill_date"]},
            {"label": "Payment & Currency", "fields": ["currency", "conversion_rate", "is_paid", "apply_tds", "mode_of_payment", "credit_to"]},
            {"label": "Stock & Warehouse", "fields": ["update_stock", "set_warehouse", "rejected_warehouse"]},
        ],
        "tables": [
            {"fieldname": "items", "fields": ["item_code", "item_name", "qty", "uom", "conversion_factor", "rate", "expense_account", "purchase_order", "po_detail", "purchase_receipt", "pr_detail", "description"]},
            {"fieldname": "taxes", "fields": ["category", "add_deduct_tax", "charge_type", "account_head", "description", "rate", "tax_amount"]},
        ],
    },
    "stock_entry": {
        "sections": [
            {"label": "Stock Movement", "fields": ["naming_series", "stock_entry_type", "company", "posting_date", "posting_time", "set_posting_time", "from_warehouse", "to_warehouse"]},
            {"label": "Reference", "fields": ["project", "remarks"]},
        ],
        "tables": [
            {"fieldname": "items", "fields": ["item_code", "item_name", "qty", "uom", "conversion_factor", "basic_rate", "expense_account", "cost_center", "description"]},
        ],
    },
    "payment_entry": {
        "sections": [
            {"label": "Payment Details", "fields": ["naming_series", "payment_type", "posting_date", "company", "mode_of_payment", "party_type", "party", "party_name"]},
            {"label": "Accounts & Amount", "fields": ["paid_from", "paid_to", "paid_amount", "received_amount", "source_exchange_rate", "target_exchange_rate"]},
            {"label": "Reference", "fields": ["reference_no", "reference_date", "remarks"]},
        ],
        "tables": [
            {"fieldname": "references", "fields": ["reference_doctype", "reference_name", "total_amount", "outstanding_amount", "allocated_amount"]},
        ],
    },
    "delivery_challan": {
        "sections": [
            {"label": "Delivery Details", "fields": ["naming_series", "company", "posting_date", "posting_time", "source_warehouse", "transit_warehouse", "target_warehouse"]},
            {"label": "Indent Reference", "fields": ["custom_dux_indent_master", "custom_dux_indent_required_date", "remarks"]},
        ],
        "tables": [
            {"fieldname": "items", "fields": ["item_code", "item_name", "qty", "uom", "received_qty", "custom_delivery_challan_qty", "custom_dux_indent_specification", "description"]},
        ],
    },
    "dux_indent_master": {
        "sections": [
            {"label": "Indent Details", "fields": ["naming_series", "user_full_name", "department_name", "company_name", "transaction_date", "required_date"]},
            {"label": "Notes & Attachments", "fields": ["note_attachment", "design_attachment", "remark"]},
        ],
        "tables": [
            {"fieldname": "items", "fields": ["item_code", "required_date", "qty", "uom", "warehouse", "specification", "stock_qty"]},
        ],
    },
    "supplier": {
        "sections": [
            {"label": "Supplier Details", "fields": ["supplier_name", "supplier_group", "supplier_type", "country", "tax_id", "default_currency", "default_price_list", "website", "disabled"]},
        ],
        "tables": [],
    },
    "item": {
        "sections": [
            {"label": "Item Details", "fields": ["item_code", "item_name", "item_group", "stock_uom", "brand", "custom_category", "description"]},
            {"label": "Stock & Valuation", "fields": ["is_stock_item", "include_item_in_manufacturing", "valuation_rate", "standard_rate", "default_material_request_type", "disabled"]},
        ],
        "tables": [
            {"fieldname": "uoms", "fields": ["uom", "conversion_factor"]},
            {"fieldname": "item_defaults", "fields": ["company", "default_warehouse", "default_price_list"]},
        ],
    },
}

FORM_CONFIG["delivery_receipts"] = deepcopy(FORM_CONFIG["delivery_challan"])


MENU_GROUPS = [
    {
        "label": "Transactions",
        "items": [
            "material_request",
            "purchase_order",
            "purchase_receipt",
            "purchase_invoice",
            "stock_entry",
            "payment_entry",
            "delivery_challan",
            "delivery_receipts",
            "dux_indent_master",
        ],
    },
    {"label": "Masters & Settings", "items": ["supplier", "item", "buying_settings"]},
    {
        "label": "Reports",
        "items": ["accounts_payable", "purchase_register", "itemwise_purchase_register"],
    },
]


@frappe.whitelist()
def get_portal_bootstrap():
    _require_authenticated_user()
    menu = []
    available_items = {}

    for key, config in DOCUMENT_CONFIG.items():
        if _can_read_doctype(config["doctype"]):
            available_items[key] = {
                "key": key,
                "label": _(config["label"]),
                "icon": config["icon"],
                "description": _(config["description"]),
                "kind": "document",
                "doctype": config["doctype"],
                "can_create": bool(
                    config.get("allow_create", True)
                    and frappe.has_permission(config["doctype"], ptype="create")
                ),
            }

    for key, config in LINK_CONFIG.items():
        if _link_is_available(config):
            available_items[key] = {"key": key, **deepcopy(config)}

    for group in MENU_GROUPS:
        items = [available_items[key] for key in group["items"] if key in available_items]
        if items:
            menu.append({"label": _(group["label"]), "items": items})

    details = _get_logged_in_user_details()
    company = frappe.defaults.get_user_default("Company") or frappe.defaults.get_global_default("company")

    return {
        "user": {
            "id": frappe.session.user,
            "full_name": details.get("full_name") or frappe.session.user,
            "department": details.get("department"),
            "initials": _get_initials(details.get("full_name") or frappe.session.user),
        },
        "company": company,
        "menu": menu,
        "page_length": 20,
    }


@frappe.whitelist()
def get_dashboard():
    _require_authenticated_user()

    kpis = [
        _dashboard_kpi(
            "pending_material_requests",
            "Pending Material Requests",
            "material_request",
            {"docstatus": 0},
        ),
        _dashboard_kpi(
            "open_purchase_orders",
            "Open Purchase Orders",
            "purchase_order",
            {"docstatus": 1, "status": ["not in", ["Completed", "Closed", "Cancelled"]]},
        ),
        _dashboard_kpi(
            "pending_purchase_receipts",
            "Pending Purchase Receipts",
            "purchase_receipt",
            {"docstatus": 0},
        ),
        _dashboard_kpi(
            "active_dux_indents",
            "Active Dux Indents",
            "dux_indent_master",
            {"docstatus": ["!=", 2], "status": ["not in", ["Closed", "Cancelled"]]},
        ),
    ]

    recent = []
    for key in (
        "dux_indent_master",
        "material_request",
        "purchase_order",
        "purchase_receipt",
        "delivery_challan",
    ):
        config = DOCUMENT_CONFIG[key]
        if not _can_read_doctype(config["doctype"]):
            continue
        meta = frappe.get_meta(config["doctype"])
        fields = ["name", "modified", "docstatus"]
        if _field_exists(meta, "status"):
            fields.append("status")
        date_field = config.get("date_field")
        if date_field and _field_exists(meta, date_field):
            fields.append(date_field)

        for row in frappe.get_list(
            config["doctype"],
            fields=fields,
            order_by="modified desc",
            limit_page_length=4,
        ):
            recent.append(
                {
                    "key": key,
                    "doctype": config["doctype"],
                    "document_type": _(config["label"]),
                    "name": row.name,
                    "date": row.get(date_field) if date_field else row.modified,
                    "modified": row.modified,
                    "status": row.get("status") or _docstatus_label(row.docstatus),
                }
            )

    recent.sort(key=lambda row: str(row.get("modified") or ""), reverse=True)

    return {
        "kpis": [kpi for kpi in kpis if kpi],
        "recent": recent[:8],
        "approvals": _get_open_workflow_actions(),
        "generated_on": nowdate(),
    }


@frappe.whitelist()
def get_document_list(
    route_key,
    search=None,
    status=None,
    from_date=None,
    to_date=None,
    start=0,
    page_length=20,
):
    _require_authenticated_user()
    config = _get_document_config(route_key)
    doctype = config["doctype"]
    _require_doctype_permission(doctype, "read")

    meta = frappe.get_meta(doctype)
    columns = _resolve_columns(meta, config["columns"])
    fields = _unique([column["fieldname"] for column in columns] + ["name", "docstatus", "modified"])
    filters = deepcopy(config.get("default_filters") or {})

    status_field = "status" if _field_exists(meta, "status") else None
    if status and status != "All" and status_field:
        filters[status_field] = status

    date_field = config.get("date_field")
    if date_field and _field_exists(meta, date_field):
        if from_date:
            getdate(from_date)
            filters[date_field] = [">=", from_date]
        if to_date:
            getdate(to_date)
            if date_field in filters:
                filters[date_field] = ["between", [from_date, to_date]]
            else:
                filters[date_field] = ["<=", to_date]

    or_filters = []
    search = (search or "").strip()
    if search:
        for fieldname in _unique(["name", *(config.get("search_fields") or [])]):
            if _field_exists(meta, fieldname):
                or_filters.append([doctype, fieldname, "like", f"%{search}%"])

    start = max(cint(start), 0)
    page_length = min(max(cint(page_length) or 20, 1), MAX_PAGE_LENGTH)
    rows = frappe.get_list(
        doctype,
        fields=fields,
        filters=filters,
        or_filters=or_filters,
        order_by="modified desc",
        start=start,
        page_length=page_length,
    )

    status_options = []
    if status_field:
        status_df = meta.get_field(status_field)
        if status_df and status_df.options:
            status_options = [option for option in status_df.options.splitlines() if option]

    return {
        "key": route_key,
        "label": _(config["label"]),
        "description": _(config["description"]),
        "doctype": doctype,
        "columns": columns,
        "rows": rows,
        "total": _permission_aware_count(doctype, filters, or_filters),
        "start": start,
        "page_length": page_length,
        "status_options": status_options,
        "can_create": bool(
            config.get("allow_create", True) and frappe.has_permission(doctype, ptype="create")
        ),
    }


def _mapping_cache():
    cache = frappe.cache
    return cache() if callable(cache) else cache


def _mapping_cache_key(token):
    token = str(token or "")
    if not token or len(token) > 64 or not token.isalnum():
        frappe.throw(_("Invalid mapped document token."), frappe.PermissionError)
    return f"dux_procurement_mapping::{frappe.session.user}::{token}"


def _store_mapped_document(route_key, doc):
    token = frappe.generate_hash(length=32)
    key = _mapping_cache_key(token)
    cache = _mapping_cache()
    payload = frappe.as_json({"route_key": route_key, "doc": doc.as_dict()})
    try:
        cache.set_value(key, payload, expires_in_sec=3600)
    except TypeError:
        # Compatibility with older Frappe RedisWrapper signatures.
        cache.set_value(key, payload)
        try:
            cache.expire(key, 3600)
        except (AttributeError, TypeError):
            pass
    return token


def _load_mapped_document(route_key, token):
    payload = _mapping_cache().get_value(_mapping_cache_key(token))
    payload = frappe.parse_json(payload) if isinstance(payload, str) else payload
    if not isinstance(payload, dict) or payload.get("route_key") != route_key:
        frappe.throw(_("This mapped document has expired. Please select the source document again."))
    doc = frappe.get_doc(payload.get("doc"))
    expected_doctype = _get_document_config(route_key)["doctype"]
    if doc.doctype != expected_doctype or doc.docstatus != 0:
        frappe.throw(_("Invalid mapped document."), frappe.PermissionError)
    return doc


def _delete_mapped_document(token):
    if token:
        _mapping_cache().delete_value(_mapping_cache_key(token))


def _source_is_available(source_route_key, doc):
    if doc.docstatus != 1:
        return False
    status = doc.get("status") or ""
    if source_route_key == "material_request":
        return bool(
            doc.get("material_request_type") == "Purchase"
            and status != "Stopped"
            and flt(doc.get("per_ordered")) < 100
        )
    if source_route_key == "purchase_order":
        return status not in ("Closed", "On Hold")
    if source_route_key == "purchase_receipt":
        return bool(
            status not in ("Closed", "Completed", "Return Issued")
            and not cint(doc.get("is_return"))
            and flt(doc.get("per_billed")) < 100
        )
    return False


def _create_actions_for_document(source_route_key, doc):
    if not _source_is_available(source_route_key, doc):
        return []

    actions = []
    for target_route_key, source_mappings in DOCUMENT_MAPPINGS.items():
        mapping = source_mappings.get(source_route_key)
        if not mapping:
            continue
        target_config = _get_document_config(target_route_key)
        if not target_config.get("allow_create", True) or not frappe.has_permission(
            target_config["doctype"], ptype="create"
        ):
            continue

        if target_route_key == "purchase_receipt":
            if flt(doc.get("per_received")) >= 100:
                continue
            if not any(not cint(row.get("delivered_by_supplier")) for row in doc.get("items") or []):
                continue
        if target_route_key == "purchase_invoice" and flt(doc.get("per_billed")) >= 100:
            continue

        actions.append(
            {
                "label": _(target_config["label"]),
                "target_route_key": target_route_key,
                "target_doctype": target_config["doctype"],
                "source_route_key": source_route_key,
            }
        )
    return actions


def _get_items_from_actions(route_key, is_new):
    if not is_new:
        return []
    actions = []
    for source_route_key, mapping in (DOCUMENT_MAPPINGS.get(route_key) or {}).items():
        source_config = _get_document_config(source_route_key)
        if not _can_read_doctype(source_config["doctype"]):
            continue
        actions.append(
            {
                "label": _(mapping["label"]),
                "source_route_key": source_route_key,
                "source_doctype": source_config["doctype"],
                "target_route_key": route_key,
                "filters": deepcopy(mapping.get("filters") or {}),
                "multiple": bool(mapping.get("multiple")),
                "company_filter": bool(mapping.get("company_filter")),
                "allow_child_item_selection": bool(mapping.get("allow_child_item_selection")),
                "child_fieldname": mapping.get("child_fieldname"),
                "child_columns": deepcopy(mapping.get("child_columns") or []),
                "date_field": mapping.get("date_field"),
                "setters": deepcopy(mapping.get("setters") or {}),
            }
        )
    return actions


def _can_update_after_submit(doc, form_config=None):
    if doc.docstatus != 1 or not frappe.has_permission(doc.doctype, ptype="write", doc=doc):
        return False
    if doc.doctype == "Dux Indent Master" and (
        doc.get("status") == "Closed" or cint(doc.get("manually_closed"))
    ):
        return False
    form_config = form_config or _get_form_config(_route_key_for_doctype(doc.doctype))
    meta = doc.meta
    for section in form_config["sections"]:
        for fieldname in section["fields"]:
            df = meta.get_field(fieldname)
            if df and df.allow_on_submit and not df.read_only:
                return True
    return any(
        meta.get_field(table["fieldname"])
        and meta.get_field(table["fieldname"]).allow_on_submit
        for table in form_config.get("tables") or []
    )


def _portal_allows_submitted_update(route_key):
    return route_key not in ("material_request", "purchase_order")


def _route_key_for_doctype(doctype):
    for route_key, config in DOCUMENT_CONFIG.items():
        if config["doctype"] == doctype and route_key in FORM_CONFIG:
            return route_key
    frappe.throw(_("A portal form is not configured for {0}.").format(doctype))


def _document_lifecycle_actions(route_key, doc):
    actions = []
    status = doc.get("status") or ""
    can_write = frappe.has_permission(doc.doctype, ptype="write", doc=doc)
    can_submit = frappe.has_permission(doc.doctype, ptype="submit", doc=doc)

    if doc.docstatus == 1:
        if route_key == "material_request" and can_write:
            if status == "Stopped":
                actions.append({"action": "mr_reopen", "label": _("Re-open"), "style": "secondary"})
            elif flt(doc.get("per_received")) < 100:
                actions.append({"action": "mr_stop", "label": _("Stop"), "style": "warning"})

        if route_key == "purchase_order" and can_submit:
            pending = flt(doc.get("per_billed")) < 100 or flt(doc.get("per_received")) < 100
            if status in ("Closed", "Delivered"):
                actions.append({"action": "po_reopen", "label": _("Re-open"), "style": "secondary"})
            elif pending:
                if status == "On Hold":
                    actions.append({"action": "po_resume", "label": _("Resume"), "style": "secondary"})
                else:
                    actions.append(
                        {
                            "action": "po_hold",
                            "label": _("Hold"),
                            "style": "warning",
                            "requires_reason": True,
                        }
                    )
                actions.append({"action": "po_close", "label": _("Close"), "style": "warning"})

        if route_key == "purchase_receipt" and can_submit:
            if status == "Closed":
                actions.append({"action": "pr_reopen", "label": _("Reopen"), "style": "secondary"})
            else:
                actions.append({"action": "pr_close", "label": _("Close"), "style": "warning"})

        if doc.meta.is_submittable and frappe.has_permission(doc.doctype, ptype="cancel", doc=doc):
            actions.append({"action": "cancel", "label": _("Cancel"), "style": "danger"})

    if (
        doc.docstatus == 2
        and doc.meta.is_submittable
        and doc.meta.has_field("amended_from")
        and frappe.has_permission(doc.doctype, ptype="amend", doc=doc)
        and frappe.has_permission(doc.doctype, ptype="create")
        and not frappe.db.exists(doc.doctype, {"amended_from": doc.name})
    ):
        actions.append({"action": "amend", "label": _("Amend"), "style": "primary"})

    return actions


def _get_document_activity(doc):
    """Return the same activity sources used by Frappe's native form timeline."""
    from frappe.desk.form.load import get_docinfo

    marker = object()
    previous_docinfo = frappe.response.get("docinfo", marker)
    get_docinfo(doc=doc)
    docinfo = frappe.response.pop("docinfo", frappe._dict())
    if previous_docinfo is not marker:
        frappe.response["docinfo"] = previous_docinfo

    share_logs = frappe.get_all(
        "Comment",
        fields=["name", "creation", "content", "owner", "comment_type"],
        filters={
            "reference_doctype": doc.doctype,
            "reference_name": doc.name,
            "comment_type": ["in", ["Shared", "Unshared"]],
        },
        order_by="creation desc",
    )

    frappe.utils.add_user_info(
        {user for user in (doc.owner, doc.modified_by) if user},
        docinfo.user_info,
    )
    return {
        "owner": doc.owner,
        "creation": doc.creation,
        "modified_by": doc.modified_by,
        "modified": doc.modified,
        "user_info": docinfo.user_info,
        "comments": docinfo.comments,
        "communications": docinfo.communications,
        "automated_messages": docinfo.automated_messages,
        "versions": docinfo.versions,
        "share_logs": share_logs,
        "assignment_logs": docinfo.assignment_logs,
        "attachment_logs": docinfo.attachment_logs,
        "info_logs": docinfo.info_logs,
        "like_logs": docinfo.like_logs,
        "workflow_logs": docinfo.workflow_logs,
        "views": docinfo.views,
        "energy_point_logs": docinfo.energy_point_logs,
        "additional_timeline_content": docinfo.additional_timeline_content,
        "milestones": docinfo.milestones,
        "attachments": docinfo.attachments,
        "assignments": docinfo.assignments,
        "tags": docinfo.tags,
    }


@frappe.whitelist()
def get_document_detail(route_key, name):
    _require_authenticated_user()
    config = _get_document_config(route_key)
    doctype = config["doctype"]
    doc = frappe.get_doc(doctype, name)
    doc.check_permission("read")
    meta = doc.meta

    fields = []
    for column in _resolve_columns(meta, config.get("detail_fields") or config["columns"]):
        value = doc.get(column["fieldname"])
        if _has_portal_display_value(value):
            fields.append({**column, "value": value})

    child_tables = []
    for table_config in config.get("child_tables") or []:
        table_field = meta.get_field(table_config["fieldname"])
        if not table_field or table_field.fieldtype != "Table" or not table_field.options:
            continue

        child_meta = frappe.get_meta(table_field.options)
        child_columns = _resolve_columns(child_meta, table_config["fields"])
        child_rows = []
        for row in doc.get(table_config["fieldname"]) or []:
            child_rows.append(
                {column["fieldname"]: row.get(column["fieldname"]) for column in child_columns}
            )

        child_columns = [
            column
            for column in child_columns
            if any(
                _has_portal_display_value(row.get(column["fieldname"]))
                for row in child_rows
            )
        ]

        child_tables.append(
            {
                "fieldname": table_config["fieldname"],
                "label": _(table_config["label"]),
                "doctype": table_field.options,
                "columns": child_columns,
                "rows": child_rows,
            }
        )

    can_write = bool(frappe.has_permission(doctype, ptype="write", doc=doc))
    can_update_after_submit = bool(
        _portal_allows_submitted_update(route_key)
        and _can_update_after_submit(doc, _get_form_config(route_key))
    )
    return {
        "key": route_key,
        "doctype": doctype,
        "name": doc.name,
        "label": _(config["label"]),
        "description": _(config["description"]),
        "status": doc.get("status") or _docstatus_label(doc.docstatus),
        "docstatus": doc.docstatus,
        "fields": fields,
        "child_tables": child_tables,
        "can_write": can_write,
        "can_edit": bool(doc.docstatus == 0 and can_write),
        "can_submit": bool(
            doc.docstatus == 0
            and meta.is_submittable
            and frappe.has_permission(doctype, ptype="submit", doc=doc)
        ),
        "can_update_after_submit": can_update_after_submit,
        "can_create": bool(
            config.get("allow_create", True) and frappe.has_permission(doctype, ptype="create")
        ),
        "create_actions": _create_actions_for_document(route_key, doc),
        "lifecycle_actions": _document_lifecycle_actions(route_key, doc),
        "activity": _get_document_activity(doc),
    }


@frappe.whitelist()
def get_document_form(route_key, name=None):
    """Return an allowlisted portal form schema plus new/existing values."""
    _require_authenticated_user()
    config = _get_document_config(route_key)
    form_config = _get_form_config(route_key)
    doctype = config["doctype"]

    if name:
        doc = frappe.get_doc(doctype, name)
        doc.check_permission("read")
        can_update_after_submit = bool(
            _portal_allows_submitted_update(route_key)
            and _can_update_after_submit(doc, form_config)
        )
        can_save = bool(
            (doc.docstatus == 0 and frappe.has_permission(doctype, ptype="write", doc=doc))
            or can_update_after_submit
        )
    else:
        if not config.get("allow_create", True):
            frappe.throw(_("New documents are not available for this portal view."), frappe.PermissionError)
        _require_doctype_permission(doctype, "create")
        doc = frappe.new_doc(doctype)
        can_save = True

    return _serialize_document_form(route_key, doc, name=name, can_save=can_save)


def _serialize_document_form(route_key, doc, name=None, can_save=True, mapping_token=None):
    config = _get_document_config(route_key)
    form_config = _get_form_config(route_key)
    doctype = config["doctype"]

    meta = doc.meta
    submitted_update = bool(name and doc.docstatus == 1)
    sections = []
    for section in form_config["sections"]:
        field_overrides = section.get("field_overrides") or {}
        fields = []
        for fieldname in section["fields"]:
            field = _serialize_form_field(
                meta,
                fieldname,
                doc,
                can_save,
                submitted_update=submitted_update,
                field_override=field_overrides.get(fieldname),
            )
            if field:
                fields.append(field)
        if fields:
            sections.append(
                {
                    "label": _(section["label"]),
                    "fields": fields,
                    "collapsible": bool(section.get("collapsible")),
                    "collapsed": bool(section.get("collapsed")),
                    "position": section.get("position") or "before_tables",
                }
            )

    tables = []
    for table_config in form_config.get("tables") or []:
        table_df = meta.get_field(table_config["fieldname"])
        if not table_df or table_df.fieldtype != "Table" or not table_df.options:
            continue

        child_meta = frappe.get_meta(table_df.options)
        table_can_save = bool(
            can_save and (not submitted_update or table_df.allow_on_submit)
        )
        child_fields = []
        field_overrides = table_config.get("field_overrides") or {}
        for fieldname in table_config["fields"]:
            field = _serialize_form_field(
                child_meta,
                fieldname,
                None,
                table_can_save,
                field_override=field_overrides.get(fieldname),
            )
            if field:
                child_fields.append(field)
        if not child_fields:
            continue

        rows = []
        for row in doc.get(table_config["fieldname"]) or []:
            rows.append(
                {
                    "_row_name": row.name,
                    **{field["fieldname"]: row.get(field["fieldname"]) for field in child_fields},
                }
            )

        tables.append(
            {
                "fieldname": table_config["fieldname"],
                "label": _(table_df.label or table_config["fieldname"]),
                "doctype": table_df.options,
                "reqd": bool(table_df.reqd),
                "fields": child_fields,
                "rows": rows,
            }
        )

    return {
        "key": route_key,
        "doctype": doctype,
        "name": doc.name if name else None,
        "label": _(config["label"]),
        "description": _(config["description"]),
        "is_new": not bool(name),
        "docstatus": doc.docstatus,
        "status": doc.get("status") or _docstatus_label(doc.docstatus),
        "sections": sections,
        "tables": tables,
        "can_save": can_save,
        "can_update_after_submit": bool(submitted_update and can_save),
        "mapping_token": mapping_token,
        "get_items_from": _get_items_from_actions(route_key, is_new=not bool(name)),
        "can_submit": bool(
            name
            and doc.docstatus == 0
            and meta.is_submittable
            and frappe.has_permission(doctype, ptype="submit", doc=doc)
        ),
    }


def _parse_mapping_source_names(source_names):
    if isinstance(source_names, str):
        parsed = frappe.parse_json(source_names)
        source_names = parsed if isinstance(parsed, list) else [source_names]
    if not isinstance(source_names, (list, tuple)):
        source_names = [source_names]

    unique_names = []
    for source_name in source_names:
        source_name = cstr(source_name).strip()
        if source_name and source_name not in unique_names:
            unique_names.append(source_name)
    if not unique_names:
        frappe.throw(_("Please select at least one source document."))
    if len(unique_names) > MAX_PAGE_LENGTH:
        frappe.throw(_("You can select up to {0} source documents at a time.").format(MAX_PAGE_LENGTH))
    return unique_names


def _parse_filtered_children(filtered_children):
    if not filtered_children:
        return []
    if isinstance(filtered_children, str):
        filtered_children = frappe.parse_json(filtered_children)
    if not isinstance(filtered_children, (list, tuple)):
        frappe.throw(_("Invalid source item selection."))
    return list(dict.fromkeys(cstr(name).strip() for name in filtered_children if cstr(name).strip()))


def _build_mapped_document_form(
    target_route_key,
    source_route_key,
    source_names,
    filtered_children=None,
    company=None,
):
    """Build one unsaved target by merging sources through ERPNext's native mapper."""
    _require_authenticated_user()
    target_config = _get_document_config(target_route_key)
    _get_form_config(target_route_key)
    mapping = (DOCUMENT_MAPPINGS.get(target_route_key) or {}).get(source_route_key)
    if not mapping:
        frappe.throw(_("This document mapping is not available."), frappe.PermissionError)

    if not target_config.get("allow_create", True):
        frappe.throw(_("New documents are not available for this portal view."), frappe.PermissionError)
    _require_doctype_permission(target_config["doctype"], "create")

    source_config = _get_document_config(source_route_key)
    source_names = _parse_mapping_source_names(source_names)
    filtered_children = _parse_filtered_children(filtered_children)
    company = cstr(company).strip()
    selected_company = None
    source_docs = []
    allowed_child_names = set()
    for source_name in source_names:
        source_doc = frappe.get_doc(source_config["doctype"], source_name)
        source_doc.check_permission("read")
        if not _source_is_available(source_route_key, source_doc):
            frappe.throw(
                _("{0} has no pending quantity available for this action.").format(source_name)
            )

        source_company = cstr(source_doc.get("company")).strip()
        if selected_company is None:
            selected_company = source_company
        elif source_company != selected_company:
            frappe.throw(_("All selected source documents must belong to the same Company."))
        if mapping.get("company_filter") and company and source_company != company:
            frappe.throw(_("Selected Material Requests must belong to Company {0}.").format(company))

        if filtered_children:
            child_fieldname = mapping.get("child_fieldname")
            allowed_child_names.update(
                row.name for row in (source_doc.get(child_fieldname) or []) if row.name
            )
        source_docs.append(source_doc)

    if filtered_children and not set(filtered_children).issubset(allowed_child_names):
        frappe.throw(_("One or more selected source items do not belong to the selected documents."))

    mapper = frappe.get_attr(mapping["method"])
    mapper_args = {"filtered_children": filtered_children} if filtered_children else None
    target_doc = None
    for source_doc in source_docs:
        target_doc = mapper(source_doc.name, target_doc=target_doc, args=mapper_args)
    if not target_doc or target_doc.doctype != target_config["doctype"]:
        frappe.throw(_("ERPNext could not create the mapped document."))
    if not target_doc.get("items"):
        frappe.throw(_("All source items are already processed."))

    target_doc.flags.ignore_permissions = False
    token = _store_mapped_document(target_route_key, target_doc)
    return _serialize_document_form(
        target_route_key,
        target_doc,
        name=None,
        can_save=True,
        mapping_token=token,
    )


@frappe.whitelist()
def get_mapped_document_form(target_route_key, source_route_key, source_name):
    """Build an unsaved target from one source using ERPNext's native mapper."""
    return _build_mapped_document_form(
        target_route_key,
        source_route_key,
        [source_name],
    )


@frappe.whitelist()
def get_mapped_documents_form(
    target_route_key,
    source_route_key,
    source_names,
    filtered_children=None,
    company=None,
):
    """Build an unsaved target from multiple selected source documents/items."""
    mapping = (DOCUMENT_MAPPINGS.get(target_route_key) or {}).get(source_route_key) or {}
    if mapping.get("company_filter") and not cstr(company).strip():
        frappe.throw(_("Please select Company before fetching Material Requests."))
    return _build_mapped_document_form(
        target_route_key,
        source_route_key,
        source_names,
        filtered_children=filtered_children,
        company=company,
    )


@frappe.whitelist()
def save_portal_document(route_key, values, name=None, mapping_token=None):
    """Create or update a portal document without bypassing native controllers."""
    _require_authenticated_user()
    config = _get_document_config(route_key)
    form_config = _get_form_config(route_key)
    doctype = config["doctype"]
    values = frappe.parse_json(values) if isinstance(values, str) else values
    if not isinstance(values, dict):
        frappe.throw(_("Invalid form payload."))

    if name:
        doc = frappe.get_doc(doctype, name)
        doc.check_permission("write")
        if doc.docstatus == 2:
            frappe.throw(_("Cancelled documents cannot be edited. Please amend the document."))
        if doc.docstatus == 1 and (
            not _portal_allows_submitted_update(route_key)
            or not _can_update_after_submit(doc, form_config)
        ):
            frappe.throw(_("Submitted documents are read-only. Cancel and amend the document to change it."))
        is_new = False
    elif mapping_token:
        if not config.get("allow_create", True):
            frappe.throw(_("New documents are not available for this portal view."), frappe.PermissionError)
        _require_doctype_permission(doctype, "create")
        doc = _load_mapped_document(route_key, mapping_token)
        is_new = True
    else:
        if not config.get("allow_create", True):
            frappe.throw(_("New documents are not available for this portal view."), frappe.PermissionError)
        _require_doctype_permission(doctype, "create")
        doc = frappe.new_doc(doctype)
        is_new = True

    _apply_portal_form_values(
        doc,
        form_config,
        values,
        preserve_row_order=bool(mapping_token and not name),
        submitted_update=bool(name and doc.docstatus == 1),
    )
    if doc.docstatus == 0:
        _prepare_portal_document(doc)

    if is_new:
        doc.insert()
        _delete_mapped_document(mapping_token)
    else:
        doc.save()

    return {
        "doctype": doctype,
        "name": doc.name,
        "status": doc.get("status") or _docstatus_label(doc.docstatus),
        "docstatus": doc.docstatus,
        "can_submit": bool(
            doc.docstatus == 0
            and doc.meta.is_submittable
            and frappe.has_permission(doctype, ptype="submit", doc=doc)
        ),
    }


@frappe.whitelist()
def submit_portal_document(route_key, name):
    """Submit a saved portal draft using the native document controller."""
    _require_authenticated_user()
    config = _get_document_config(route_key)
    _get_form_config(route_key)
    doc = frappe.get_doc(config["doctype"], name)
    doc.check_permission("submit")
    if not doc.meta.is_submittable or doc.docstatus != 0:
        frappe.throw(_("Only a saved draft document can be submitted."))
    doc.submit()
    return {
        "doctype": doc.doctype,
        "name": doc.name,
        "status": doc.get("status") or _docstatus_label(doc.docstatus),
        "docstatus": doc.docstatus,
    }


@frappe.whitelist()
def update_portal_document_status(route_key, name, action, reason=None):
    """Run an allowlisted native ERPNext Stop/Hold/Close/Re-open action."""
    _require_authenticated_user()
    config = _get_document_config(route_key)
    _get_form_config(route_key)
    doc = frappe.get_doc(config["doctype"], name)
    doc.check_permission("read")
    available = {item["action"]: item for item in _document_lifecycle_actions(route_key, doc)}
    if action not in available or action in ("cancel", "amend"):
        frappe.throw(_("This status action is not available for the current document."), frappe.PermissionError)

    if action in ("mr_stop", "mr_reopen"):
        doc.check_permission("write")
        from erpnext.stock.doctype.material_request.material_request import update_status

        update_status(name, "Stopped" if action == "mr_stop" else "Submitted")
    elif action in ("po_hold", "po_resume", "po_close", "po_reopen"):
        doc.check_permission("submit")
        if action == "po_hold":
            if not str(reason or "").strip():
                frappe.throw(_("Reason for hold is required."))
            doc.add_comment("Comment", _("Reason for hold: {0}").format(str(reason).strip()))
        from erpnext.buying.doctype.purchase_order.purchase_order import update_status

        status = {
            "po_hold": "On Hold",
            "po_resume": "Draft",
            "po_close": "Closed",
            "po_reopen": "Submitted",
        }[action]
        update_status(status, name)
    elif action in ("pr_close", "pr_reopen"):
        doc.check_permission("submit")
        from erpnext.stock.doctype.purchase_receipt.purchase_receipt import (
            update_purchase_receipt_status,
        )

        update_purchase_receipt_status(name, "Closed" if action == "pr_close" else "Submitted")

    doc.reload()
    return {
        "doctype": doc.doctype,
        "name": doc.name,
        "status": doc.get("status") or _docstatus_label(doc.docstatus),
        "docstatus": doc.docstatus,
    }


@frappe.whitelist()
def cancel_portal_document(route_key, name):
    """Cancel a submitted document through its native controller."""
    _require_authenticated_user()
    config = _get_document_config(route_key)
    _get_form_config(route_key)
    doc = frappe.get_doc(config["doctype"], name)
    doc.check_permission("cancel")
    if not doc.meta.is_submittable or doc.docstatus != 1:
        frappe.throw(_("Only a submitted document can be cancelled."))
    if not any(item["action"] == "cancel" for item in _document_lifecycle_actions(route_key, doc)):
        frappe.throw(_("Cancel is not available for this document."), frappe.PermissionError)
    doc.cancel()
    return {
        "doctype": doc.doctype,
        "name": doc.name,
        "status": doc.get("status") or _docstatus_label(doc.docstatus),
        "docstatus": doc.docstatus,
    }


@frappe.whitelist()
def get_amended_document_form(route_key, name):
    """Return an editable amendment copy of a cancelled portal document."""
    _require_authenticated_user()
    config = _get_document_config(route_key)
    _get_form_config(route_key)
    doc = frappe.get_doc(config["doctype"], name)
    doc.check_permission("read")
    if not any(item["action"] == "amend" for item in _document_lifecycle_actions(route_key, doc)):
        frappe.throw(_("Amend is not available for this document."), frappe.PermissionError)

    amended_doc = frappe.copy_doc(doc, ignore_no_copy=True)
    amended_doc.docstatus = 0
    amended_doc.amended_from = doc.name
    amended_doc.flags.ignore_permissions = False
    token = _store_mapped_document(route_key, amended_doc)
    return _serialize_document_form(
        route_key,
        amended_doc,
        name=None,
        can_save=True,
        mapping_token=token,
    )


@frappe.whitelist()
def get_portal_item_defaults(item_code, company=None, warehouse=None):
    """Provide safe item defaults used by new child rows in portal forms."""
    _require_authenticated_user()
    _require_doctype_permission("Item", "read")
    item = frappe.get_doc("Item", item_code)
    item.check_permission("read")
    from dux_indent_master.api import get_default_warehouse, get_item_stock_qty

    selected_warehouse = warehouse or get_default_warehouse(item_code, company)
    return {
        "item_name": item.item_name,
        "description": item.description,
        "stock_uom": item.stock_uom,
        "uom": item.stock_uom,
        "conversion_factor": 1,
        "rate": flt(item.last_purchase_rate),
        "basic_rate": flt(item.last_purchase_rate),
        "warehouse": selected_warehouse,
        "source_warehouse": selected_warehouse,
        "stock_qty": get_item_stock_qty(item_code, selected_warehouse),
    }


def _get_document_config(route_key):
    config = DOCUMENT_CONFIG.get(route_key)
    if not config:
        frappe.throw(_("Invalid portal route."), frappe.DoesNotExistError)
    return config


def _get_form_config(route_key):
    form_config = FORM_CONFIG.get(route_key)
    if not form_config:
        frappe.throw(_("A portal form is not configured for this route."), frappe.DoesNotExistError)
    return form_config


def _serialize_form_field(
    meta, fieldname, doc, can_save, submitted_update=False, field_override=None
):
    df = meta.get_field(fieldname)
    if not df or df.fieldtype in ("Table", "Table MultiSelect", "Section Break", "Column Break", "Tab Break", "HTML", "Button"):
        return None

    fieldtype = {
        "Text Editor": "Small Text",
        "Code": "Small Text",
        "Attach": "Data",
        "Attach Image": "Data",
    }.get(df.fieldtype, df.fieldtype)

    value = doc.get(fieldname) if doc else None
    field_override = field_override or {}
    force_editable = bool(field_override.get("force_editable"))
    force_read_only = bool(field_override.get("force_read_only"))
    editable = bool(
        can_save
        and (not submitted_update or df.allow_on_submit)
        and not force_read_only
        and (not df.read_only or force_editable or _is_portal_editable_warehouse(df))
    )
    return {
        "fieldname": fieldname,
        "label": _(field_override.get("label") or df.label or fieldname),
        "fieldtype": fieldtype,
        "options": df.options,
        "ignore_user_permissions": bool(df.ignore_user_permissions),
        "reqd": bool(df.reqd),
        "read_only": not editable,
        "allow_on_submit": bool(df.allow_on_submit),
        "depends_on": df.depends_on,
        "mandatory_depends_on": df.mandatory_depends_on,
        "read_only_depends_on": df.read_only_depends_on,
        "default": df.default,
        "description": _(df.description) if df.description else None,
        "min_date_field": field_override.get("min_date_field"),
        "value": value,
    }


def _is_portal_editable_warehouse(df):
    return bool(
        df
        and df.fieldtype == "Link"
        and df.options == "Warehouse"
        and df.fieldname != "transit_warehouse"
    )


def _apply_portal_form_values(
    doc,
    form_config,
    values,
    preserve_row_order=False,
    submitted_update=False,
):
    meta = doc.meta
    for section in form_config["sections"]:
        field_overrides = section.get("field_overrides") or {}
        for fieldname in section["fields"]:
            df = meta.get_field(fieldname)
            field_override = field_overrides.get(fieldname) or {}
            if (
                not df
                or (submitted_update and not df.allow_on_submit)
                or field_override.get("force_read_only")
                or (
                    df.read_only
                    and not field_override.get("force_editable")
                    and not _is_portal_editable_warehouse(df)
                )
                or df.fieldtype in ("Table", "Table MultiSelect")
            ):
                continue
            if fieldname in values:
                doc.set(fieldname, values.get(fieldname))

    for table_config in form_config.get("tables") or []:
        fieldname = table_config["fieldname"]
        if fieldname not in values:
            continue
        table_df = meta.get_field(fieldname)
        if not table_df or table_df.fieldtype != "Table" or not table_df.options:
            continue
        if submitted_update and not table_df.allow_on_submit:
            continue

        incoming_rows = values.get(fieldname) or []
        if not isinstance(incoming_rows, list):
            frappe.throw(_("Invalid rows for {0}.").format(_(table_df.label or fieldname)))
        if len(incoming_rows) > 500:
            frappe.throw(_("A maximum of 500 rows is allowed in {0}.").format(_(table_df.label or fieldname)))

        child_meta = frappe.get_meta(table_df.options)
        existing_row_list = [row.as_dict() for row in doc.get(fieldname) or []]
        existing_rows = {row.get("name"): row for row in existing_row_list if row.get("name")}
        doc.set(fieldname, [])

        for row_index, incoming in enumerate(incoming_rows):
            if not isinstance(incoming, dict):
                continue
            editable_values = {}
            field_overrides = table_config.get("field_overrides") or {}
            for child_fieldname in table_config["fields"]:
                child_df = child_meta.get_field(child_fieldname)
                field_override = field_overrides.get(child_fieldname) or {}
                if (
                    not child_df
                    or field_override.get("force_read_only")
                    or (
                        child_df.read_only
                        and not field_override.get("force_editable")
                        and not _is_portal_editable_warehouse(child_df)
                    )
                    or child_df.fieldtype in ("Table", "Table MultiSelect")
                ):
                    continue
                if child_fieldname in incoming:
                    editable_values[child_fieldname] = incoming.get(child_fieldname)

            if not any(value not in (None, "", 0, "0") for value in editable_values.values()):
                continue

            row_name = incoming.get("_row_name")
            existing = existing_rows.get(row_name)
            if not existing and preserve_row_order and row_index < len(existing_row_list):
                existing = existing_row_list[row_index]
            row_values = deepcopy(existing or {})
            for internal in ("doctype", "parent", "parenttype", "parentfield", "idx"):
                row_values.pop(internal, None)
            row_values.update(editable_values)
            doc.append(fieldname, row_values)


def _prepare_portal_document(doc):
    if doc.doctype == "Material Request":
        transaction_date = doc.get("transaction_date")
        required_by = doc.get("schedule_date")
        if transaction_date and required_by and getdate(required_by) < getdate(transaction_date):
            frappe.throw(_("Required By cannot be earlier than Transaction Date."))
        for row in doc.get("items") or []:
            if row.meta.has_field("schedule_date"):
                row.schedule_date = required_by or transaction_date or nowdate()

    if doc.doctype == "Delivery Challan" and doc.get("company") and not doc.get("transit_warehouse"):
        from dux_indent_master.api import _get_delivery_challan_transit_warehouse

        doc.transit_warehouse = _get_delivery_challan_transit_warehouse(doc.company)

    if doc.get("company") and doc.meta.has_field("currency") and not doc.get("currency"):
        doc.currency = frappe.get_cached_value("Company", doc.company, "default_currency")
    if doc.meta.has_field("conversion_rate") and not flt(doc.get("conversion_rate")):
        doc.conversion_rate = 1
    for exchange_field in ("source_exchange_rate", "target_exchange_rate"):
        if doc.meta.has_field(exchange_field) and not flt(doc.get(exchange_field)):
            doc.set(exchange_field, 1)

    if doc.meta.has_field("items"):
        for row in doc.get("items") or []:
            if not row.get("item_code"):
                continue
            item = frappe.get_cached_value(
                "Item",
                row.item_code,
                ["item_name", "description", "stock_uom", "last_purchase_rate"],
                as_dict=True,
            )
            if not item:
                continue
            for fieldname, value in (
                ("item_name", item.item_name),
                ("description", item.description),
                ("stock_uom", item.stock_uom),
                ("uom", item.stock_uom),
                ("conversion_factor", 1),
            ):
                if row.meta.has_field(fieldname) and not row.get(fieldname):
                    row.set(fieldname, value)
            if row.meta.has_field("rate") and not row.get("rate"):
                row.rate = flt(item.last_purchase_rate)
            if row.meta.has_field("basic_rate") and not row.get("basic_rate"):
                row.basic_rate = flt(item.last_purchase_rate)
            if row.meta.has_field("schedule_date") and not row.get("schedule_date"):
                row.schedule_date = doc.get("schedule_date") or doc.get("transaction_date") or nowdate()
            if row.meta.has_field("required_date") and not row.get("required_date"):
                row.required_date = doc.get("required_date")
            _apply_portal_row_warehouses(doc, row)
            if (
                doc.doctype == "Purchase Receipt"
                and row.meta.has_field("received_qty")
                and not flt(row.get("received_qty"))
            ):
                row.received_qty = flt(row.get("qty"))

    set_missing_values = getattr(doc, "set_missing_values", None)
    if callable(set_missing_values):
        set_missing_values()
    calculate_totals = getattr(doc, "calculate_taxes_and_totals", None)
    if (
        callable(calculate_totals)
        and doc.meta.has_field("currency")
        and doc.meta.has_field("grand_total")
    ):
        calculate_totals()


def _apply_portal_row_warehouses(doc, row):
    for parent_field, child_field in (
        ("set_warehouse", "warehouse"),
        ("set_from_warehouse", "from_warehouse"),
        ("from_warehouse", "s_warehouse"),
        ("to_warehouse", "t_warehouse"),
        ("rejected_warehouse", "rejected_warehouse"),
        ("source_warehouse", "source_warehouse"),
        ("target_warehouse", "target_warehouse"),
    ):
        if (
            row.meta.has_field(child_field)
            and doc.meta.has_field(parent_field)
            and doc.get(parent_field)
        ):
            row.set(child_field, doc.get(parent_field))

    if row.meta.has_field("warehouse") and not row.get("warehouse"):
        company = doc.get("company") or doc.get("company_name")
        if company:
            row.warehouse = frappe.db.get_value(
                "Item Default",
                {"parent": row.item_code, "company": company},
                "default_warehouse",
            )


def _resolve_columns(meta, requested_columns):
    columns = []
    selected = set()
    for requested in requested_columns:
        fieldname = next(
            (
                candidate
                for candidate in requested["fieldnames"]
                if candidate not in selected and _field_exists(meta, candidate)
            ),
            None,
        )
        if not fieldname:
            continue

        selected.add(fieldname)
        if fieldname in SYSTEM_FIELDS:
            fieldtype = "Link" if fieldname in ("name", "owner", "modified_by") else "Datetime"
            options = meta.name if fieldname == "name" else "User" if fieldname in ("owner", "modified_by") else None
        else:
            df = meta.get_field(fieldname)
            fieldtype = df.fieldtype
            options = df.options

        columns.append(
            {
                "fieldname": fieldname,
                "label": _(requested["label"]),
                "fieldtype": fieldtype,
                "options": options,
            }
        )
    return columns


def _field_exists(meta, fieldname):
    return fieldname in SYSTEM_FIELDS or bool(meta.has_field(fieldname))


def _permission_aware_count(doctype, filters, or_filters=None):
    result = frappe.get_list(
        doctype,
        fields=["count(name) as total"],
        filters=filters,
        or_filters=or_filters or [],
        limit_page_length=1,
    )
    return cint(result[0].total) if result else 0


def _dashboard_kpi(key, label, route_key, filters):
    config = DOCUMENT_CONFIG[route_key]
    if not _can_read_doctype(config["doctype"]):
        return None
    return {
        "key": key,
        "label": _(label),
        "route_key": route_key,
        "icon": config["icon"],
        "value": _permission_aware_count(config["doctype"], filters),
    }


def _get_open_workflow_actions():
    if not frappe.db.exists("DocType", "Workflow Action") or not _can_read_doctype("Workflow Action"):
        return []

    meta = frappe.get_meta("Workflow Action")
    required_fields = ["reference_doctype", "reference_name", "status", "user", "modified"]
    if not all(_field_exists(meta, fieldname) for fieldname in required_fields):
        return []

    actions = frappe.get_list(
        "Workflow Action",
        fields=required_fields,
        filters={"status": "Open", "user": frappe.session.user},
        order_by="modified desc",
        limit_page_length=8,
    )
    return [
        {
            "doctype": row.reference_doctype,
            "name": row.reference_name,
            "status": row.status,
            "modified": row.modified,
        }
        for row in actions
        if row.reference_doctype and row.reference_name
    ]


def _link_is_available(config):
    if config["kind"] == "single":
        return frappe.db.exists("DocType", config["doctype"]) and _can_read_doctype(config["doctype"])
    if config["kind"] == "report":
        return bool(
            frappe.db.exists("Report", config["report"])
            and _can_read_doctype(config["ref_doctype"])
        )
    return False


def _can_read_doctype(doctype):
    return bool(frappe.db.exists("DocType", doctype) and frappe.has_permission(doctype, ptype="read"))


def _require_doctype_permission(doctype, ptype):
    if not frappe.has_permission(doctype, ptype=ptype):
        frappe.throw(_("You do not have permission to access {0}.").format(_(doctype)), frappe.PermissionError)


def _require_authenticated_user():
    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.throw(_("Please sign in to use Dux Procurement Portal."), frappe.AuthenticationError)


def _docstatus_label(docstatus):
    return {0: "Draft", 1: "Submitted", 2: "Cancelled"}.get(cint(docstatus), "Draft")


def _get_initials(value):
    parts = [part for part in (value or "").replace("@", " ").split() if part]
    if not parts:
        return "DU"
    return "".join(part[0].upper() for part in parts[:2])


def _unique(values):
    return list(dict.fromkeys(value for value in values if value))
