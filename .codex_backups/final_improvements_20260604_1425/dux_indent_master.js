frappe.ui.form.on("Dux Indent Master", {
    onload(frm) {
        set_parent_read_only(frm);
        if (frm.is_new()) {
            load_logged_in_user_details(frm);
        }
    },

    refresh(frm) {
        set_parent_read_only(frm);
        set_grid_read_only(frm);
        set_row_item_trackers(frm);
        add_view_stock_button(frm);
        add_actions_buttons(frm);
        add_view_material_requests_button(frm);

        if (frm.is_new()) {
            load_logged_in_user_details(frm);
        }
    },

    required_date(frm) {
        (frm.doc.items || []).forEach((row) => {
            row.required_date = frm.doc.required_date;
        });
        frm.refresh_field("items");
    },
});

frappe.ui.form.on("Dux Indent Master Item", {
    item_code(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (!row.item_code) {
            frappe.model.set_value(cdt, cdn, "stock_qty", 0);
            return;
        }

        const previous_item_code = row.__last_item_code;
        const item_changed = Boolean(previous_item_code && previous_item_code !== row.item_code);
        row.__last_item_code = row.item_code;

        fetch_item_uom(cdt, cdn, row.item_code);
        set_default_warehouse(frm, cdt, cdn, item_changed).then(() => fetch_stock_qty(cdt, cdn));
    },

    items_add(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (frm.doc.required_date && !row.required_date) {
            frappe.model.set_value(cdt, cdn, "required_date", frm.doc.required_date);
        }
    },

    warehouse(frm, cdt, cdn) {
        fetch_stock_qty(cdt, cdn);
    },

    qty(frm, cdt, cdn) {
        set_qty_balanced(frm, cdt, cdn);
    },

    purchase_qty(frm, cdt, cdn) {
        set_qty_balanced(frm, cdt, cdn);
    },
});

function set_parent_read_only(frm) {
    if (frm.fields_dict.user_name) {
        frm.set_df_property("user_name", "hidden", 1);
        frm.set_df_property("user_name", "read_only", 1);
    }
    if (frm.fields_dict.user_full_name) {
        frm.set_df_property("user_full_name", "read_only", 1);
    }
    if (frm.fields_dict.department_name) {
        frm.set_df_property("department_name", "read_only", 1);
    }
}

function load_logged_in_user_details(frm) {
    if (frm.__dux_user_details_loaded) {
        return;
    }
    frm.__dux_user_details_loaded = true;

    frappe.call({
        method: "dux_indent_master.api.get_logged_in_user_details",
        callback(r) {
            const details = r.message || {};
            if (frm.fields_dict.user_name && !frm.doc.user_name && details.user) {
                frm.set_value("user_name", details.user);
            }
            if (frm.fields_dict.user_full_name && (!frm.doc.user_full_name || frm.is_new())) {
                frm.set_value("user_full_name", details.full_name || details.user || "");
            }
            if (frm.fields_dict.department_name && !frm.doc.department_name && details.department) {
                frm.set_value("department_name", details.department);
            }
        },
    });
}

function set_grid_read_only(frm) {
    if (!frm.fields_dict.items || !frm.fields_dict.items.grid) {
        return;
    }

    [
        "purchase_qty",
        "qty_balanced",
        "delivery_challan_qty",
        "delivery_balance_qty",
        "stock_qty",
        "source_warehouse",
        "material_request",
        "material_request_item",
    ].forEach((fieldname) => {
        frm.fields_dict.items.grid.update_docfield_property(fieldname, "read_only", 1);
    });

    frm.fields_dict.items.grid.update_docfield_property("source_warehouse", "hidden", 1);

    if (frm.fields_dict.delivery_challans && frm.fields_dict.delivery_challans.grid) {
        ["delivery_challan_id", "status", "transaction_date", "total_qty"].forEach((fieldname) => {
            frm.fields_dict.delivery_challans.grid.update_docfield_property(fieldname, "read_only", 1);
        });
    }
}

function set_row_item_trackers(frm) {
    (frm.doc.items || []).forEach((row) => {
        row.__last_item_code = row.item_code;
    });
}

function fetch_item_uom(cdt, cdn, item_code) {
    frappe.db.get_value("Item", item_code, "stock_uom").then((r) => {
        const stock_uom = r.message && r.message.stock_uom;
        if (stock_uom) {
            frappe.model.set_value(cdt, cdn, "uom", stock_uom);
        }
    });
}

function set_default_warehouse(frm, cdt, cdn, item_changed) {
    const row = locals[cdt][cdn];
    const should_set_warehouse = !row.warehouse || item_changed;

    if (!row.item_code || !should_set_warehouse) {
        return Promise.resolve();
    }

    return frappe
        .call({
            method: "dux_indent_master.api.get_default_warehouse",
            args: {
                item_code: row.item_code,
                company: frm.doc.company_name,
            },
        })
        .then((r) => {
            const warehouse = r.message || "";
            if (warehouse) {
                return frappe.model.set_value(cdt, cdn, "warehouse", warehouse);
            }
            return null;
        });
}

function fetch_stock_qty(cdt, cdn) {
    const row = locals[cdt][cdn];
    if (!row.item_code || !row.warehouse) {
        frappe.model.set_value(cdt, cdn, "stock_qty", 0);
        return Promise.resolve();
    }

    return frappe
        .call({
            method: "dux_indent_master.api.get_item_stock_qty",
            args: {
                item_code: row.item_code,
                warehouse: row.warehouse,
            },
        })
        .then((r) => frappe.model.set_value(cdt, cdn, "stock_qty", flt(r.message)));
}

function set_qty_balanced(frm, cdt, cdn) {
    const row = locals[cdt][cdn];
    const balance = flt(row.qty) - flt(row.purchase_qty);
    if (balance < 0) {
        frappe.msgprint(__("Purchase Qty cannot be greater than Qty for {0}.", [row.item_code || __("row")]));
        row.qty_balanced = 0;
    } else {
        row.qty_balanced = balance;
    }
    frm.refresh_field("items");
}

function get_target_rows(frm) {
    const selected_names = frm.get_selected().items || [];
    let rows = (frm.doc.items || []).filter((row) => row.item_code);

    if (selected_names.length) {
        rows = rows.filter((row) => selected_names.includes(row.name));
    }

    return rows;
}

function add_view_stock_button(frm) {
    if (!get_target_rows(frm).length) {
        return;
    }

    frm.add_custom_button(__("View Stock"), () => {
        const rows = get_target_rows(frm);
        if (!rows.length) {
            frappe.msgprint(__("Please add or select item rows first."));
            return;
        }

        const dialog = new frappe.ui.Dialog({
            title: __("Stock Details"),
            size: "extra-large",
            fields: [{ fieldname: "stock_html", fieldtype: "HTML" }],
        });

        dialog.fields_dict.stock_html.$wrapper.html(
            `<table class="table table-bordered">
                <thead>
                    <tr>
                        <th>${__("Item")}</th>
                        <th>${__("Warehouse")}</th>
                        <th>${__("Available Qty")}</th>
                    </tr>
                </thead>
                <tbody><tr><td colspan="3">${__("Loading...")}</td></tr></tbody>
            </table>`
        );
        dialog.show();

        const calls = rows.map((row) => {
            const filters = { item_code: row.item_code };
            if (row.warehouse) {
                filters.warehouse = row.warehouse;
            }

            return frappe.call({
                method: "frappe.client.get_list",
                args: {
                    doctype: "Bin",
                    filters,
                    fields: ["warehouse", "actual_qty"],
                    limit_page_length: 100,
                },
            }).then((r) => ({ row, bins: r.message || [] }));
        });

        Promise.all(calls).then((results) => {
            const lines = [];
            results.forEach(({ row, bins }) => {
                bins.forEach((bin) => {
                    lines.push(`<tr>
                        <td>${frappe.utils.escape_html(row.item_code || "")}</td>
                        <td>${frappe.utils.escape_html(bin.warehouse || "")}</td>
                        <td>${flt(bin.actual_qty)}</td>
                    </tr>`);
                });
            });

            dialog.fields_dict.stock_html.$wrapper.find("tbody").html(
                lines.length ? lines.join("") : `<tr><td colspan="3">${__("No stock found.")}</td></tr>`
            );
        });
    });
}

function add_actions_buttons(frm) {
    if (frm.is_new() || frm.doc.docstatus !== 1 || !has_action_permission(frm)) {
        return;
    }

    if (!has_material_purchase(frm)) {
        frm.add_custom_button(__("Material Purchase"), () => show_material_purchase_dialog(frm), __("Actions"));
    }
    frm.add_custom_button(__("Delivery Challan"), () => create_delivery_challan(frm), __("Actions"));
}

function has_action_permission(frm) {
    const perm = (frm.perm || [])[0] || {};
    return Boolean(perm.write || perm.submit || perm.create);
}

function show_material_purchase_dialog(frm) {
    if (frm.is_new()) {
        frappe.msgprint(__("Save Dux Indent Master before creating a Material Request."));
        return;
    }
    if (frm.doc.docstatus !== 1) {
        frappe.msgprint(__("Submit Dux Indent Master before creating a Material Request."));
        return;
    }
    if (has_material_purchase(frm)) {
        frappe.msgprint(__("Material Purchase is already created for this Dux Indent Master."));
        return;
    }

    const rows = get_target_rows(frm);
    if (!rows.length) {
        frappe.msgprint(__("No item rows found."));
        return;
    }

    const fields = [];
    rows.forEach((row, index) => {
        fields.push({
            fieldname: `row_${index}_html`,
            fieldtype: "HTML",
                options: `<div class="text-muted" style="margin: 8px 0 2px;">
                <b>${frappe.utils.escape_html(row.item_code || "")}</b>
                &nbsp; ${__("Required")}: ${flt(row.qty)}
                &nbsp; ${__("Purchased")}: ${flt(row.purchase_qty)}
                &nbsp; ${__("Balance")}: ${flt(row.qty_balanced)}
            </div>`,
        });
        fields.push({
                fieldname: `qty_${index}`,
                fieldtype: "Float",
                label: __("Purchase Qty"),
                default: flt(row.qty_balanced) || flt(row.qty),
                reqd: 1,
            });
    });

    const dialog = new frappe.ui.Dialog({
        title: __("Create Material Purchase"),
        size: "large",
        fields,
        primary_action_label: __("Create Material Request"),
        primary_action(values) {
            const selected_items = [];
            for (let index = 0; index < rows.length; index++) {
                const qty = flt(values[`qty_${index}`]);
                if (qty <= 0) {
                    continue;
                }
                selected_items.push({ item_row: rows[index].name, qty });
            }

            if (!selected_items.length) {
                frappe.msgprint(__("Enter purchase quantity for at least one row."));
                return;
            }

            frappe.call({
                method: "dux_indent_master.api.create_material_request_from_indent",
                args: {
                    indent_name: frm.doc.name,
                    selected_items: JSON.stringify(selected_items),
                },
                freeze: true,
                freeze_message: __("Creating Material Request..."),
                callback(r) {
                    if (r.message && r.message.material_request) {
                        dialog.hide();
                        frappe.show_alert({
                            message: __("Material Request {0} created.", [r.message.material_request]),
                            indicator: "green",
                        });
                        frm.reload_doc().then(() => {
                            frappe.set_route("Form", "Material Request", r.message.material_request);
                        });
                    }
                },
            });
        },
    });

    dialog.show();
}

function has_material_purchase(frm) {
    return (frm.doc.material_purchase || []).some((row) => row.material_purchase_id);
}

function create_delivery_challan(frm) {
    if (frm.is_new()) {
        frappe.msgprint(__("Save Dux Indent Master before creating a Delivery Challan."));
        return;
    }

    frappe.call({
        method: "dux_indent_master.api.create_delivery_challan_from_indent",
        args: {
            indent_name: frm.doc.name,
        },
        freeze: true,
        freeze_message: __("Creating Delivery Challan..."),
        callback(r) {
            if (r.message && r.message.doctype && r.message.name) {
                frappe.show_alert({
                    message: __("{0} {1} created.", [r.message.doctype, r.message.name]),
                    indicator: "green",
                });
                frappe.set_route("Form", r.message.doctype, r.message.name);
            }
        },
    });
}

function add_view_material_requests_button(frm) {
    const linked = (frm.doc.material_purchase || []).filter((row) => row.material_purchase_id);
    if (!linked.length) {
        return;
    }

    frm.add_custom_button(__("View Material Requests"), () => {
        frappe.set_route("List", "Material Request", {
            custom_dux_indent_master: frm.doc.name,
        });
    });
}
