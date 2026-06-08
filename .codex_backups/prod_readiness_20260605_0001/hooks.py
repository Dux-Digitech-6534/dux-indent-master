app_name = "dux_indent_master"
app_title = "Dux Indent Master"
app_publisher = "Dux Digitech"
app_description = "Dux Indent Master app"
app_email = "support@duxdigitech.in"
app_license = "mit"

after_migrate = "dux_indent_master.setup.after_migrate"

doc_events = {
    "Material Request": {
        "on_submit": "dux_indent_master.api.on_material_request_submit",
        "on_cancel": "dux_indent_master.api.on_material_request_cancel",
    },
    "Delivery Challan": {
        "validate": "dux_indent_master.api.on_delivery_challan_validate",
        "before_submit": "dux_indent_master.api.on_delivery_challan_before_submit",
        "on_submit": "dux_indent_master.api.on_delivery_challan_submit",
        "before_cancel": "dux_indent_master.api.on_delivery_challan_before_cancel",
        "on_cancel": "dux_indent_master.api.on_delivery_challan_cancel",
    }
}
