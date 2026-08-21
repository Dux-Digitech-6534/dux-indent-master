function dux_prompt_po_rejection_remark(frm) {
	return new Promise((resolve, reject) => {
		let completed = false;
		const dialog = new frappe.ui.Dialog({
			title: __("Reject Purchase Order"),
			fields: [
				{
					fieldname: "remark",
					label: __("Rejection Remark"),
					fieldtype: "Small Text",
					reqd: 1,
				},
			],
		});

		dialog.set_primary_action(__("Reject"), async () => {
			const remark = String(dialog.get_value("remark") || "").trim();
			if (!remark) {
				frappe.msgprint(__("Rejection Remark is required."));
				return;
			}
			await frm.set_value("custom_rejection_remark", remark);
			completed = true;
			dialog.hide();
			resolve();
		});

		dialog.$wrapper.one("hidden.bs.modal", () => {
			if (!completed) reject(new Error(__("Purchase Order rejection was cancelled.")));
		});
		dialog.show();
	});
}

frappe.ui.form.on("Purchase Order", {
	before_workflow_action(frm) {
		if (String(frm.selected_workflow_action || "").trim().toLowerCase() !== "reject") return;
		return dux_prompt_po_rejection_remark(frm);
	},
});
