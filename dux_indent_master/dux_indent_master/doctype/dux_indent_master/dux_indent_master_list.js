frappe.listview_settings["Dux Indent Master"] = {
    add_fields: ["status", "docstatus"],

    get_indicator(doc) {
        const status = doc.status || get_docstatus_label(doc.docstatus);
        return [__(status), get_status_indicator_color(status), `status,=,${status}`];
    },
};

function get_docstatus_label(docstatus) {
    if (docstatus === 0) {
        return "Draft";
    }
    if (docstatus === 2) {
        return "Cancelled";
    }
    return "Submitted";
}

function get_status_indicator_color(status) {
    const color_map = {
        "Draft": "gray",
        "Open": "gray",
        "Approved": "blue",
        "Submitted": "blue",
        "Material Purchase Created": "orange",
        "Material Request Raised": "orange",
        "Purchase Requested": "orange",
        "Ordered": "orange",
        "Partially Purchase Requested": "yellow",
        "Partially Request Raised": "yellow",
        "Partially Ordered": "yellow",
        "Partially Received": "yellow",
        "Partially Delivered": "yellow",
        "Completed": "green",
        "Received": "green",
        "Closed": "red",
        "Cancelled": "red",
    };

    return color_map[status] || "gray";
}
