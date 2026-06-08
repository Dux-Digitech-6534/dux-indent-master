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
    if (status === "Draft") {
        return "gray";
    }
    if (status === "Cancelled") {
        return "red";
    }
    if (status === "Closed" || status === "Received") {
        return "green";
    }
    if ((status || "").includes("Partially")) {
        return "orange";
    }
    return "blue";
}
