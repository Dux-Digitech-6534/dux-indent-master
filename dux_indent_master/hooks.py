app_name = "dux_indent_master"
app_title = "Dux Indent Master"
app_publisher = "Dux Digitech"
app_description = "Dux Indent Master app"
app_email = "support@duxdigitech.in"
app_license = "mit"

# The portal and indent workflow extend ERPNext procurement documents and the
# Delivery Challan custom app. Declaring these dependencies makes bench refuse
# an incomplete production installation instead of failing later at runtime.
required_apps = ["erpnext", "delivery_challan_custom"]

after_migrate = "dux_indent_master.setup.after_migrate"

doc_events = {
    "Material Request": {
        "on_submit": "dux_indent_master.api.on_material_request_submit",
        "on_cancel": "dux_indent_master.api.on_material_request_cancel",
    },
    "Purchase Order": {
        "validate": "dux_indent_master.api.sync_material_request_company",
        "on_submit": "dux_indent_master.api.on_purchase_order_submit",
        "on_cancel": "dux_indent_master.api.on_purchase_order_cancel",
    },
    "Purchase Receipt": {
        "on_submit": "dux_indent_master.api.on_purchase_receipt_submit",
        "on_cancel": "dux_indent_master.api.on_purchase_receipt_cancel",
    },
    "Delivery Challan": {
        "validate": "dux_indent_master.api.on_delivery_challan_validate",
        "before_submit": "dux_indent_master.api.on_delivery_challan_before_submit",
        "on_submit": "dux_indent_master.api.on_delivery_challan_submit",
        "before_cancel": "dux_indent_master.api.on_delivery_challan_before_cancel",
        "on_cancel": "dux_indent_master.api.on_delivery_challan_cancel",
    }
}

fixtures = [
    {
        "dt": "Custom Field",
        "filters": [
            [
                "name",
                "in",
                [
                    "Material Request-custom_dux_indent_department",
                    "Material Request-custom_dux_indent_design_attachment",
                    "Material Request-custom_dux_indent_master",
                    "Material Request-custom_dux_indent_note_attachment",
                    "Material Request-custom_dux_indent_remark",
                    "Material Request-custom_dux_indent_user",
                    "Material Request Item-custom_dux_indent_item",
                    "Material Request Item-custom_dux_indent_master",
                    "Material Request Item-custom_dux_indent_specification",
                    "Delivery Challan-custom_dux_indent_master",
                    "Delivery Challan-custom_dux_indent_required_date",
                    "Delivery Challan Item-custom_delivery_challan_qty",
                    "Delivery Challan Item-custom_dux_indent_item",
                    "Delivery Challan Item-custom_dux_indent_specification",
                ],
            ]
        ],
    }
]
