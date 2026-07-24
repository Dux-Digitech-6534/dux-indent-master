frappe.pages["dux-indent-portal"].on_page_load = (wrapper) => {
	$("body").addClass("dux-portal-active");
	wrapper.dux_procurement_portal = new DuxProcurementPortal(wrapper);
};

frappe.pages["dux-indent-portal"].on_page_show = (wrapper) => {
	$("body").addClass("dux-portal-active");
	if (wrapper.dux_procurement_portal && !wrapper.dux_procurement_portal.initialized) {
		wrapper.dux_procurement_portal.initialize();
	}
};

frappe.pages["dux-indent-portal"].on_page_hide = () => {
	$("body").removeClass("dux-portal-active");
};

if (frappe.router && typeof frappe.router.on === "function") {
	frappe.router.on("change", () => {
		const route = frappe.get_route ? frappe.get_route() : [];
		$("body").toggleClass("dux-portal-active", route[0] === "dux-indent-portal");
	});
}

const PORTAL_PRINT_FORMATS = {
	purchase_order: "JEW Purchase Order",
	delivery_challan: "JEW Delivery Challan",
};

class DuxProcurementPortal {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("Dux Procurement Portal"),
			single_column: true,
		});
		this.$wrapper = $(wrapper).addClass("dux-portal-page");
		this.$wrapper.find(".page-head").hide();
		this.state = {
			route_key: "dashboard",
			start: 0,
			search: "",
			status: "All",
			from_date: "",
			to_date: "",
			activity_collapsed: false,
		};
		this.items = {};
		this.search_timer = null;
		this.updating_indent_company_warehouses = false;
		this.receipt_loading_challan = null;
		this.receipt_source_challan = null;
		this.initialized = false;
		this.make_shell();
		this.bind_events();
		this.initialize();
	}

	async initialize() {
		if (this.initialized) return;
		this.initialized = true;
		this.show_loading();
		try {
			this.bootstrap = await this.call("dux_indent_master.portal.get_portal_bootstrap");
			(this.bootstrap.menu || []).forEach((group) => {
				(group.items || []).forEach((item) => (this.items[item.key] = item));
			});
			this.apply_identity();
			this.render_navigation();
			this.start_clock();
			await this.open_dashboard();
		} catch (error) {
			this.initialized = false;
			this.show_error(error);
		}
	}

	call(method, args = {}) {
		if (typeof frappe.xcall === "function") return frappe.xcall(method, args);
		return new Promise((resolve, reject) => {
			frappe.call({
				method,
				args,
				callback: (response) => resolve(response ? response.message : undefined),
				error: reject,
			});
		});
	}

	make_shell() {
		let theme = "light";
		try {
			theme = localStorage.getItem("dux-procurement-theme") || "light";
		} catch (error) {
			// Browser storage may be disabled; light theme remains available.
		}

		this.$root = $(`
			<div class="duxp-root" data-dux-theme="${theme}">
				<div class="duxp-sidebar-backdrop" data-action="close-sidebar"></div>
				<aside class="duxp-sidebar">
					<div class="duxp-brand" aria-label="${__("Jain Engineering Work")}">
						<div class="duxp-brand-name">${__("Jain Engineering Work")}</div>
					</div>
					<div class="duxp-nav-search">
						${this.icon("search", 15)}
						<input type="search" placeholder="${__("Search menu…")}" data-role="nav-search">
					</div>
					<nav class="duxp-nav" data-role="nav"></nav>
					<div class="duxp-user-card">
						<div class="duxp-avatar" data-role="avatar">DU</div>
						<div class="duxp-user-copy"><strong data-role="user-name">${__("Loading…")}</strong><span data-role="company"></span></div>
						<span class="duxp-fy" data-role="fy"></span>
					</div>
				</aside>
				<section class="duxp-main">
					<header class="duxp-topbar">
						<button class="duxp-icon-btn duxp-menu-btn" data-action="open-sidebar" aria-label="${__("Open menu")}">${this.icon("menu", 17)}</button>
						<div class="duxp-breadcrumb"><span>Dux Portal</span>${this.icon("chevron", 12)}<strong data-role="breadcrumb">${__("Dashboard")}</strong></div>
						<div class="duxp-top-actions">
							<span class="duxp-clock" data-role="clock"></span>
							<button class="duxp-icon-btn" data-action="refresh" aria-label="${__("Refresh")}">${this.icon("refresh", 16)}</button>
							<button class="duxp-icon-btn" data-action="theme" aria-label="${__("Toggle theme")}">${this.icon("moon", 16)}</button>
							<div class="duxp-avatar" data-role="top-avatar">DU</div>
						</div>
					</header>
					<div class="duxp-scroll"><main class="duxp-content" data-role="content"></main></div>
				</section>
			</div>
		`).appendTo(this.page.main.empty());

		this.$content = this.$root.find('[data-role="content"]');
		this.$nav = this.$root.find('[data-role="nav"]');
	}

	bind_events() {
		this.$root.on("click", "[data-action]", (event) => {
			const $target = $(event.currentTarget);
			const action = $target.data("action");
			if (action === "theme") this.toggle_theme();
			if (action === "refresh") this.refresh_current();
			if (action === "toggle-activity") this.toggle_activity_panel();
			if (action === "open-linked-document") this.open_document_detail(
				$target.data("key"), $target.data("name")
			);
			if (action === "toggle-form-section") this.toggle_form_section($target);
			if (action === "switch-form-tab") this.switch_form_tab($target);
			if (action === "open-sidebar") this.$root.addClass("duxp-sidebar-open");
			if (action === "close-sidebar") this.$root.removeClass("duxp-sidebar-open");
			if (action === "dashboard") this.open_dashboard();
			if (action === "new") this.open_document_form($target.data("key"));
			if (action === "back-list") this.open_document_list($target.data("key"));
			if (action === "print-document") this.open_document_print($target.data("key"), $target.data("name"));
			if (action === "edit-form") this.open_document_form($target.data("key"), $target.data("name"));
			if (action === "toggle-create-menu") {
				event.stopPropagation();
				this.toggle_dropdown($target.closest(".duxp-dropdown"));
			}
			if (action === "create-mapped-document") {
				this.$root.find(".duxp-dropdown.is-open").removeClass("is-open");
				this.open_mapped_document_form(
					$target.data("target-key"), $target.data("source-key"), $target.data("source-name")
				);
			}
			if (action === "get-items-from") this.select_mapping_source(
				$target.data("target-key"), $target.data("source-key")
			);
			if (action === "close-source-picker") this.close_source_picker();
			if (action === "confirm-source-picker") this.confirm_source_picker();
			if (action === "run-lifecycle") this.run_lifecycle_action(
				$target.data("key"), $target.data("name"), $target.data("lifecycle-action"),
				Boolean($target.data("requires-reason")), $target.text().trim()
			);
			if (action === "run-workflow") this.run_workflow_action(
				$target.data("key"), $target.data("name"), $target.data("workflow-action")
			);
			if (action === "run-operational") {
				this.$root.find(".duxp-dropdown.is-open").removeClass("is-open");
				this.run_operational_action(
					$target.data("key"), $target.data("name"), $target.data("operational-action")
				);
			}
			if (action === "get-payment-outstanding") this.get_payment_outstanding($target.data("mode"));
			if (action === "amend-document") this.open_amended_document_form(
				$target.data("key"), $target.data("name")
			);
			if (action === "form-back") this.close_document_form();
			if (action === "add-form-row") this.add_form_row($target.data("table"));
			if (action === "remove-form-row") this.remove_form_row($target.data("table"), Number($target.data("index")));
			if (action === "save-form") this.save_portal_form(false);
			if (action === "submit-form") this.confirm_submit_form();
			if (action === "submit-detail") this.confirm_submit_detail(
				$target.data("key"), $target.data("name")
			);
			if (action === "open-native") this.open_native_document($target.data("doctype"), $target.data("name"));
			if (action === "previous") this.change_page(-1);
			if (action === "next") this.change_page(1);
			if (action === "run-report") this.run_report_filters();
		});

		this.$root.on("click", "[data-route-key]", (event) => {
			event.preventDefault();
			this.navigate($(event.currentTarget).data("route-key"));
		});

		this.$root.on("click", ".duxp-document-row", (event) => {
			if ($(event.target).closest("a").length) return;
			const $row = $(event.currentTarget);
			this.open_document_detail($row.data("key"), $row.data("name"));
		});

		this.$root.on("click", ".duxp-native-row", (event) => {
			const $row = $(event.currentTarget);
			this.open_native_document($row.data("doctype"), $row.data("name"));
		});

		this.$root.on("click", ".duxp-approval-row", (event) => {
			const $row = $(event.currentTarget);
			const key = $row.data("key");
			if (key) this.open_document_detail(key, $row.data("name"));
			else this.open_native_document($row.data("doctype"), $row.data("name"));
		});

		this.$root.on("input", '[data-role="nav-search"]', (event) => {
			const query = String(event.currentTarget.value || "").trim().toLowerCase();
			this.$nav.find(".duxp-nav-item").each((index, element) => {
				const $item = $(element);
				$item.toggle(String($item.data("label") || "").includes(query));
			});
			this.$nav.find(".duxp-nav-group").removeClass("is-collapsed");
		});

		this.$root.on("click", ".duxp-nav-heading", (event) => {
			$(event.currentTarget).closest(".duxp-nav-group").toggleClass("is-collapsed");
		});

		this.$root.on("input", '[data-role="list-search"]', (event) => {
			clearTimeout(this.search_timer);
			const value = event.currentTarget.value;
			this.search_timer = setTimeout(() => {
				this.state.search = value;
				this.state.start = 0;
				this.open_document_list(this.state.route_key, true);
			}, 350);
		});

		this.$root.on("change", '[data-role="status-filter"], [data-role="from-date"], [data-role="to-date"]', () => {
			this.state.status = this.$root.find('[data-role="status-filter"]').val() || "All";
			this.state.from_date = this.$root.find('[data-role="from-date"]').val() || "";
			this.state.to_date = this.$root.find('[data-role="to-date"]').val() || "";
			this.state.start = 0;
			this.open_document_list(this.state.route_key, true);
		});

		this.$root.on("change", '[data-role="indent-stock-all"]', (event) => {
			this.$root.find('[data-role="indent-stock-row"]').prop("checked", Boolean(event.currentTarget.checked));
			this.update_indent_stock_action_visibility();
		});
		this.$root.on("change", '[data-role="indent-stock-row"]', () => {
			this.update_indent_stock_action_visibility();
		});

		this.$root.on("focus input awesomplete-open", ".duxp-table-control .awesomplete input", (event) => {
			this.position_table_suggestions(event.currentTarget);
		});

		this.$root.on("awesomplete-close", ".duxp-table-control .awesomplete input", (event) => {
			this.reset_table_suggestions(event.currentTarget);
		});

		this.$root.find(".duxp-scroll").on("scroll", () => this.reposition_active_suggestions());
		$(window).off("resize.duxProcurementPortal").on("resize.duxProcurementPortal", () => {
			this.reposition_active_suggestions();
		});
		$(document).off("click.duxCreateMenu").on("click.duxCreateMenu", (event) => {
			if (!$(event.target).closest(".duxp-dropdown").length) {
				this.$root.find(".duxp-dropdown.is-open").removeClass("is-open");
			}
		});
		this.$root.on("change", '[name="duxp-picker-select"]', (event) => {
			const $input = $(event.currentTarget);
			this.toggle_source_picker_selection($input.val(), $input.attr("type") === "checkbox");
		});
		this.$root.on("input", '[data-role="source-picker-search"]', (event) => {
			this.search_source_picker(event.currentTarget.value);
		});
	}

	position_table_suggestions(input) {
		const $input = $(input);
		const $list = $input.closest(".awesomplete").children("ul").first();
		if (!$list.length) return;

		const rect = input.getBoundingClientRect();
		const viewport_width = window.innerWidth || document.documentElement.clientWidth;
		const viewport_height = window.innerHeight || document.documentElement.clientHeight;
		const width = Math.min(Math.max(rect.width, 280), Math.max(220, viewport_width - 24));
		const left = Math.max(12, Math.min(rect.left, viewport_width - width - 12));
		const room_below = viewport_height - rect.bottom;
		const room_above = rect.top;
		const open_above = room_below < 190 && room_above > room_below;
		const available = open_above ? room_above - 12 : room_below - 12;
		const max_height = Math.max(120, Math.min(300, available));
		const top = open_above ? Math.max(8, rect.top - max_height - 4) : rect.bottom + 4;

		$list.addClass("duxp-floating-suggestions").css({
			left: `${left}px`,
			top: `${top}px`,
			width: `${width}px`,
			maxHeight: `${max_height}px`,
		});
		this.active_suggestion_input = input;
	}

	reset_table_suggestions(input) {
		$(input).closest(".awesomplete").children("ul").first()
			.removeClass("duxp-floating-suggestions")
			.removeAttr("style");
		if (this.active_suggestion_input === input) this.active_suggestion_input = null;
	}

	reposition_active_suggestions() {
		if (this.active_suggestion_input && document.documentElement.contains(this.active_suggestion_input)) {
			this.position_table_suggestions(this.active_suggestion_input);
		}
	}

	apply_identity() {
		const user = this.bootstrap.user || {};
		this.$root.find('[data-role="user-name"]').text(user.full_name || user.id || "User");
		this.$root.find('[data-role="company"]').text(this.bootstrap.company || user.department || "");
		this.$root.find('[data-role="avatar"], [data-role="top-avatar"]').text(user.initials || "DU");
		this.$root.find('[data-role="fy"]').text(this.financial_year());
	}

	render_navigation() {
		const groups = (this.bootstrap.menu || []).map((group) => `
			<div class="duxp-nav-group">
				<button class="duxp-nav-heading"><span>${this.escape(group.label)}</span>${this.icon("down", 13)}</button>
				<div class="duxp-nav-items">
					${(group.items || []).map((item) => `
						<a href="#" class="duxp-nav-item" data-route-key="${this.escape(item.key)}" data-label="${this.escape(String(item.label).toLowerCase())}">
							${this.icon(item.icon, 15)}<span>${this.escape(item.label)}</span>
						</a>
					`).join("")}
				</div>
			</div>
		`).join("");

		this.$nav.html(`
			<a href="#" class="duxp-nav-item is-active duxp-dashboard-link" data-action="dashboard" data-label="dashboard">
				${this.icon("dashboard", 16)}<span>${__("Dashboard")}</span>
			</a>
			${groups}
		`);
	}

	async navigate(key) {
		const item = this.items[key];
		if (!item) return;
		this.$root.removeClass("duxp-sidebar-open");
		if (item.kind === "document") {
			await this.open_document_list(key);
			return;
		}
		if (item.kind === "single") {
			frappe.set_route("Form", item.doctype);
			return;
		}
		if (item.kind === "report") {
			await this.open_report_view(key);
		}
	}

	async load_report_filter_defs(report_name) {
		if (frappe.query_reports[report_name] && frappe.query_reports[report_name].filters) {
			return frappe.query_reports[report_name].filters;
		}
		try {
			const response = await this.call("frappe.desk.query_report.get_script", { report_name });
			if (response && response.script) frappe.dom.eval(response.script);
		} catch (error) {
			// Fall through with whatever (if anything) got registered.
		}
		return (frappe.query_reports[report_name] && frappe.query_reports[report_name].filters) || [];
	}

	async open_report_view(key, reset = true) {
		const item = this.items[key];
		if (!item) return;
		this.report_filter_defs = this.report_filter_defs || {};
		this.state.report_values = this.state.report_values || {};
		if (!this.report_filter_defs[item.report]) {
			this.report_filter_defs[item.report] = await this.load_report_filter_defs(item.report);
		}
		const filter_defs = this.report_filter_defs[item.report] || [];
		if (reset || !this.state.report_values[key]) {
			const values = {};
			filter_defs.forEach((filter) => {
				if (!filter.fieldname) return;
				values[filter.fieldname] = filter.default === undefined || filter.default === null ? "" : filter.default;
			});
			if (!values.company) values.company = this.bootstrap.company || "";
			this.state.report_values[key] = values;
			this.state.start = 0;
		}
		this.state.route_key = key;
		this.state.view = "report";
		this.set_active(key, item.label);
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_portal_report", {
				route_key: key,
				filters: JSON.stringify(this.state.report_values[key]),
				start: this.state.start || 0,
				page_length: this.bootstrap.page_length || 20,
			});
			this.current_list = data;
			this.render_report_view(data, filter_defs);
		} catch (error) {
			this.show_error(error);
		}
	}

	run_report_filters() {
		const values = {};
		Object.entries(this.report_filter_controls || {}).forEach(([fieldname, control]) => {
			if (control) values[fieldname] = control.get_value();
		});
		const previous_values = this.state.report_values[this.state.route_key] || {};
		const fieldnames = new Set([...Object.keys(previous_values), ...Object.keys(values)]);
		const filters_unchanged = [...fieldnames].every((fieldname) => {
			const previous = previous_values[fieldname] ?? "";
			const current = values[fieldname] ?? "";
			return JSON.stringify(previous) === JSON.stringify(current);
		});
		if (filters_unchanged) return;
		this.state.report_values[this.state.route_key] = values;
		this.state.start = 0;
		this.open_report_view(this.state.route_key, false);
	}

	make_report_filter_control($slot, df, value) {
		if (!$slot.length) return null;
		const safe_df = { ...df, ignore_link_validation: true };
		["get_query", "get_data"].forEach((key) => {
			const original = safe_df[key];
			if (typeof original !== "function") return;
			safe_df[key] = (...args) => {
				try {
					return original.apply(safe_df, args);
				} catch (error) {
					return {};
				}
			};
		});
		delete safe_df.on_change;
		delete safe_df.onchange;
		try {
			const control = frappe.ui.form.make_control({ df: safe_df, parent: $slot, render_input: true });
			control.set_value(value === undefined || value === null ? "" : value);
			return control;
		} catch (error) {
			return null;
		}
	}

	render_report_view(data, filter_defs) {
		clearTimeout(this.report_filter_timer);
		this.$content.off(".duxReportFilters");
		this.report_filters_ready = false;
		const SKIP_FIELDTYPES = ["Section Break", "Column Break", "Tab Break", "HTML", "Button"];
		const visible_filters = (filter_defs || []).filter((f) => f.fieldname && !f.hidden && !SKIP_FIELDTYPES.includes(f.fieldtype));
		const values = this.state.report_values[data.key] || {};
		const active_filter_count = Object.values(values).filter((value) => {
			if (Array.isArray(value)) return value.length > 0;
			return value !== null && value !== undefined && value !== "" && value !== false;
		}).length;
		const filter_items_html = visible_filters.map((f) => {
			const is_check = f.fieldtype === "Check";
			return `
			<div class="duxp-report-filter-item ${is_check ? "is-check" : ""}">
				${is_check ? "" : `<span class="duxp-report-filter-label">${this.escape(f.label || f.fieldname)}</span>`}
				<div class="duxp-form-control" data-report-fieldname="${this.escape(f.fieldname)}"></div>
			</div>
		`; }).join("");

		const rows = (data.rows || []).map((row) => `
			<tr>${(data.columns || []).map((column) => {
				const numeric = ["Currency", "Float", "Int", "Percent"].includes(column.fieldtype);
				return `<td class="${numeric ? "duxp-report-number-cell" : ""}">${this.format_value(row[column.fieldname], column, row)}</td>`;
			}).join("")}</tr>
		`).join("");
		const start = Number(data.start || 0);
		const end = Math.min(start + (data.rows || []).length, Number(data.total || 0));
		const can_previous = start > 0;
		const can_next = end < Number(data.total || 0);
		const range_label = `${data.total ? start + 1 : 0}–${end}`;

		this.$content.html(`
			<section class="duxp-report-hero">
				<div class="duxp-report-hero-icon">${this.icon("chart", 22)}</div>
				<div class="duxp-report-hero-copy">
					<span>${__("Procurement Analytics")}</span>
					<h1>${this.escape(data.label)}</h1>
					<p>${this.escape(data.description)}</p>
				</div>
				<div class="duxp-report-hero-meta">
					<span class="duxp-report-live"><i></i>${__("Live Report")}</span>
					<strong>${this.escape(data.total || 0)}</strong>
					<small>${__("Total records")}</small>
				</div>
			</section>
			<section class="duxp-card duxp-report-filter-card">
				<header class="duxp-report-filter-header">
					<div class="duxp-report-section-title">
						<span>${this.icon("filter", 16)}</span>
						<div><h2>${__("Report Filters")}</h2><p>${__("Refine the report using the criteria below.")}</p></div>
					</div>
					<div class="duxp-report-filter-actions">
						<span>${active_filter_count} ${active_filter_count === 1 ? __("filter active") : __("filters active")}</span>
					</div>
				</header>
				<div class="duxp-report-filter-grid">
					${filter_items_html}
				</div>
			</section>
			<section class="duxp-card duxp-report-results-card">
				<div class="duxp-report-results-header">
					<div class="duxp-report-section-title">
						<span>${this.icon("document", 16)}</span>
						<div><h2>${__("Report Results")}</h2><p>${__("Results based on the current filter selection.")}</p></div>
					</div>
					<span class="duxp-report-range">${range_label} ${__("of")} ${this.escape(data.total || 0)}</span>
				</div>
				<div class="duxp-table-wrap duxp-report-table-frame"><table class="duxp-table duxp-report-table"><thead><tr>${(data.columns || []).map((column) => `<th class="${["Currency", "Float", "Int", "Percent"].includes(column.fieldtype) ? "duxp-report-number-cell" : ""}">${this.escape(column.label)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${(data.columns || []).length || 1}">${this.empty_state(__("No data"), __("Try changing the filters."))}</td></tr>`}</tbody></table></div>
				<div class="duxp-pager duxp-report-pager"><span>${__("Showing")} ${range_label} ${__("of")} ${data.total || 0}</span><div><button data-action="previous" ${can_previous ? "" : "disabled"}>${this.icon("back", 14)}</button><button data-action="next" ${can_next ? "" : "disabled"}>${this.icon("forward", 14)}</button></div></div>
			</section>
		`);

		this.report_filter_controls = {};
		visible_filters.forEach((f) => {
			const $slot = this.$content.find(`[data-report-fieldname="${this.escape(f.fieldname)}"]`);
			const control = this.make_report_filter_control($slot, f, values[f.fieldname]);
			if (control) this.report_filter_controls[f.fieldname] = control;
		});

		this.$content.on(
			"change.duxReportFilters awesomplete-selectcomplete.duxReportFilters",
			"[data-report-fieldname] input, [data-report-fieldname] select",
			() => {
				if (!this.report_filters_ready) return;
				clearTimeout(this.report_filter_timer);
				this.report_filter_timer = setTimeout(() => this.run_report_filters(), 350);
			}
		);
		window.requestAnimationFrame(() => {
			if (this.state.view === "report" && this.state.route_key === data.key) {
				this.report_filters_ready = true;
			}
		});
	}

	async open_dashboard() {
		this.state.route_key = "dashboard";
		this.state.view = "dashboard";
		this.set_active("dashboard", __("Dashboard"));
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_dashboard");
			const user = this.bootstrap.user || {};
			const hour = new Date().getHours();
			const greeting = hour < 12 ? __("morning") : hour < 17 ? __("afternoon") : __("evening");
			const kpis = (data.kpis || []).map((kpi, index) => `
				<button class="duxp-card duxp-kpi" data-route-key="${this.escape(kpi.route_key)}">
					<span class="duxp-kpi-icon duxp-kpi-${index % 4}">${this.icon(kpi.icon, 17)}</span>
					<strong>${this.escape(kpi.value)}</strong><span>${this.escape(kpi.label)}</span>
				</button>
			`).join("");

			this.$content.html(`
				<section class="duxp-hero">
					<div><span class="duxp-eyebrow">Dux Portal · Procurement</span><h1>${__("Good")} <em>${this.escape(greeting)}</em>, ${this.escape(user.full_name || user.id || "User")}</h1><p>${__("Here is your live procurement activity summary.")}</p></div>
					<div class="duxp-hero-fy"><span>${__("Financial Year")}</span><strong>${this.financial_year()}</strong></div>
				</section>
				<section class="duxp-kpi-grid">${kpis}</section>
				<section class="duxp-dashboard-grid">
					<div class="duxp-card">
						${this.card_header(__("Recent Activity"), __("latest documents"))}
						${this.recent_table(data.recent || [])}
					</div>
					<div class="duxp-card">
						${this.card_header(__("Pending Approvals"), `${(data.approvals || []).length} ${__("awaiting action")}`)}
						${this.approval_list(data.approvals || [])}
					</div>
				</section>
			`);
		} catch (error) {
			this.show_error(error);
		}
	}

	async open_document_list(key, preserve_filters = false) {
		const item = this.items[key];
		if (!item) return;
		if (!preserve_filters || this.state.route_key !== key) {
			this.state.search = "";
			this.state.status = "All";
			this.state.from_date = "";
			this.state.to_date = "";
			this.state.start = 0;
		}
		this.state.route_key = key;
		this.state.view = "list";
		this.set_active(key, item.label);
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_document_list", {
				route_key: key,
				search: this.state.search,
				status: this.state.status,
				from_date: this.state.from_date,
				to_date: this.state.to_date,
				start: this.state.start,
				page_length: this.bootstrap.page_length || 20,
			});
			this.current_list = data;
			this.render_document_list(data);
		} catch (error) {
			this.show_error(error);
		}
	}

	render_document_list(data) {
		const status_options = ["All", ...(data.status_options || [])];
		const rows = (data.rows || []).map((row) => `
			<tr class="duxp-document-row" data-key="${this.escape(data.key)}" data-name="${this.escape(row.name)}">
				${(data.columns || []).map((column, index) => `<td class="${index === 0 ? "duxp-id-cell" : ""}">${this.format_value(row[column.fieldname], column, row)}</td>`).join("")}
				<td class="duxp-actions-cell"><button class="duxp-link-button">${this.icon("eye", 13)}${__("View")}</button></td>
			</tr>
		`).join("");
		const start = Number(data.start || 0);
		const end = Math.min(start + (data.rows || []).length, Number(data.total || 0));
		const can_previous = start > 0;
		const can_next = end < Number(data.total || 0);

		this.$content.html(`
			<section class="duxp-page-head">
				<div><h1>${this.escape(data.label)}</h1><p>${this.escape(data.description)}</p></div>
				<div class="duxp-head-actions">
					${data.can_create ? `<button class="duxp-btn duxp-btn-primary" data-action="new" data-key="${this.escape(data.key)}">${this.icon("plus", 14)}${__("New")} ${this.escape(data.label)}</button>` : ""}
				</div>
			</section>
			<section class="duxp-card">
				<div class="duxp-filter-bar">
					<label class="duxp-search-field">${this.icon("search", 14)}<input data-role="list-search" value="${this.escape(this.state.search)}" placeholder="${__("Search")} ${this.escape(data.label)}…"></label>
					<label class="duxp-filter-select">${this.icon("filter", 13)}<select data-role="status-filter">${status_options.map((option) => `<option ${option === this.state.status ? "selected" : ""}>${this.escape(option)}</option>`).join("")}</select></label>
					<label class="duxp-filter-select">${this.icon("calendar", 13)}<input type="date" data-role="from-date" value="${this.escape(this.state.from_date)}" title="${__("From Date")}"></label>
					<label class="duxp-filter-select">${this.icon("calendar", 13)}<input type="date" data-role="to-date" value="${this.escape(this.state.to_date)}" title="${__("To Date")}"></label>
				</div>
				<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr>${(data.columns || []).map((column) => `<th>${this.escape(column.label)}</th>`).join("")}<th class="duxp-actions-cell">${__("Action")}</th></tr></thead><tbody>${rows || `<tr><td colspan="${(data.columns || []).length + 1}">${this.empty_state(__("No documents found"), __("Try changing the search or filters."))}</td></tr>`}</tbody></table></div>
				<div class="duxp-pager"><span>${__("Showing")} ${data.total ? start + 1 : 0}–${end} ${__("of")} ${data.total || 0}</span><div><button data-action="previous" ${can_previous ? "" : "disabled"}>${this.icon("back", 14)}</button><button data-action="next" ${can_next ? "" : "disabled"}>${this.icon("forward", 14)}</button></div></div>
			</section>
		`);
	}

	async open_document_detail(key, name) {
		const item = this.items[key];
		if (!item) return;
		this.state.route_key = key;
		this.state.view = "detail";
		this.state.document_name = name;
		this.set_active(key, `${item.label} · ${name}`);
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_document_detail", { route_key: key, name });
			this.render_document_detail(data);
		} catch (error) {
			this.show_error(error);
		}
	}

	render_document_detail(data) {
		this.$content.addClass("duxp-detail-view");
		const fields = (data.fields || []).map((field) => `
			<div class="duxp-detail-field"><span>${this.escape(field.label)}</span><strong>${this.format_value(field.value, field, data)}</strong></div>
		`).join("");
		const tables = (data.child_tables || []).map((table, table_index) => {
			const selectable = data.key === "dux_indent_master" && table.fieldname === "items"
				&& (data.operational_actions || []).some((action) => action.action === "indent_view_stock");
			return `
			<section class="duxp-card duxp-detail-panel">
				${this.panel_header(table_index + 2, table.label, `${(table.rows || []).length} ${__("rows")}`)}
				<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr>${selectable ? `<th><input type="checkbox" data-role="indent-stock-all" aria-label="${__("Select all")}"></th>` : ""}<th>#</th>${(table.columns || []).map((column) => `<th>${this.escape(column.label)}</th>`).join("")}</tr></thead><tbody>
					${(table.rows || []).map((row, index) => `<tr>${selectable ? `<td><input type="checkbox" data-role="indent-stock-row" value="${this.escape(row._row_name || "")}"></td>` : ""}<td class="duxp-index">${index + 1}</td>${table.columns.map((column) => `<td>${this.format_child_table_value(data, table, row, column)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${(table.columns || []).length + 1 + (selectable ? 1 : 0)}">${this.empty_state(__("No rows"), "")}</td></tr>`}
				</tbody></table></div>
			</section>
		`; }).join("");

		const DROPDOWN_OPERATIONAL_ACTIONS = ["indent_material_purchase", "indent_delivery_challan"];
		const dropdown_operational_actions = (data.operational_actions || [])
			.filter((action) => DROPDOWN_OPERATIONAL_ACTIONS.includes(action.action));
		const create_menu_items = [
			...(data.create_actions || []).map((action) => `
				<button class="duxp-menu-item" data-action="create-mapped-document"
					data-target-key="${this.escape(action.target_route_key)}" data-source-key="${this.escape(action.source_route_key)}"
					data-source-name="${this.escape(data.name)}">${this.escape(action.label)}</button>
			`),
			...dropdown_operational_actions.map((action) => `
				<button class="duxp-menu-item" data-action="run-operational"
					data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}"
					data-operational-action="${this.escape(action.action)}">${this.escape(action.label)}</button>
			`),
		].join("");
		const create_actions = create_menu_items ? `
			<div class="duxp-dropdown" data-role="create-dropdown">
				<button class="duxp-btn duxp-btn-primary" data-action="toggle-create-menu" aria-haspopup="true" aria-expanded="false">
					${this.icon("plus", 14)}${__("Create")}${this.icon("down", 12)}
				</button>
				<div class="duxp-dropdown-menu">${create_menu_items}</div>
			</div>
		` : "";
		const lifecycle_actions = (data.lifecycle_actions || []).map((action) => {
			if (action.action === "amend") {
				return `<button class="duxp-btn duxp-btn-primary" data-action="amend-document" data-key="${this.escape(data.key)}"
					data-name="${this.escape(data.name)}">${this.icon("edit", 14)}${this.escape(action.label)}</button>`;
			}
			return `<button class="duxp-btn duxp-btn-${this.escape(action.style || "secondary")}" data-action="run-lifecycle"
				data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}"
				data-lifecycle-action="${this.escape(action.action)}" data-requires-reason="${action.requires_reason ? "1" : ""}">
				${action.action === "cancel" ? this.icon("trash", 14) : this.icon("refresh", 14)}${this.escape(action.label)}</button>`;
		}).join("");
		const workflow_actions = (data.workflow_actions || []).map((action) => `
			<button class="duxp-btn duxp-btn-${this.escape(action.style || "secondary")}" data-action="run-workflow"
				data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}"
				data-workflow-action="${this.escape(action.action)}">
				${this.icon(action.action === "Reject" ? "warning" : "check", 14)}${this.escape(action.label)}</button>
		`).join("");
		const operational_actions = (data.operational_actions || [])
			.filter((action) => !DROPDOWN_OPERATIONAL_ACTIONS.includes(action.action))
			.map((action) => `
			<button class="duxp-btn duxp-btn-${this.escape(action.style || "secondary")}" data-action="run-operational"
				data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}"
				data-operational-action="${this.escape(action.action)}" ${action.action === "indent_view_stock" ? "hidden" : ""}>
				${this.icon(action.style === "primary" ? "plus" : "workflow", 14)}${this.escape(action.label)}</button>
		`).join("");
		const form_label = data.can_edit ? __("Edit") : __("View Form");
		const hide_submitted_form_button = (data.docstatus === 1
			&& ["material_request", "purchase_order"].includes(data.key))
			|| (!data.can_edit && data.can_update_after_submit);
		const form_button = hide_submitted_form_button ? "" : `<button class="duxp-btn ${data.can_edit ? "duxp-btn-primary" : "duxp-btn-secondary"}"
			data-action="edit-form" data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}">
			${this.icon("edit", 14)}${form_label}</button>`;
		const print_button = PORTAL_PRINT_FORMATS[data.key] ? `<button class="duxp-btn duxp-btn-secondary"
			data-action="print-document" data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}">
			${this.icon("print", 14)}${__("Print")}</button>` : "";
		const submit_button = data.can_submit ? `<button class="duxp-btn duxp-btn-primary" data-action="submit-detail"
			data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}"
			data-workflow-action="${this.escape(data.submit_action || "")}">
			${this.icon("check", 14)}${this.escape(data.submit_label || __("Save & Submit"))}</button>` : "";
		const activity = this.render_activity_panel(data.activity || {}, data);
		const linked_documents = this.render_linked_documents(data.linked_documents || {});

		this.$content.html(`
			<section class="duxp-page-head">
				<div><span class="duxp-eyebrow">${this.escape(data.label)} · <em>${this.escape(data.name)}</em></span><h1>${this.escape(data.name)}</h1><div class="duxp-status-line">${this.status_tag(data.status)}</div></div>
				<div class="duxp-head-actions">
					<button class="duxp-btn duxp-btn-secondary" data-action="back-list" data-key="${this.escape(data.key)}">${this.icon("back", 14)}${__("Back to List")}</button>
					${print_button}
					${create_actions}
					${operational_actions}
					${workflow_actions}
					${lifecycle_actions}
					${submit_button}
					${form_button}
				</div>
			</section>
			<div class="duxp-detail-layout">
				<main class="duxp-detail-main">
					<section class="duxp-card duxp-detail-panel">
						${this.panel_header(1, __("Document Details"), data.doctype)}
						<div class="duxp-detail-grid">${fields}</div>
					</section>
					${tables}
				</main>
				<aside class="duxp-detail-sidebar">
					${activity}
					${linked_documents}
				</aside>
			</div>
		`);
		this.update_indent_stock_action_visibility();
	}

	format_child_table_value(data, table, row, column) {
		const indent_links = {
			"material_purchase.material_purchase_id": "material_request",
			"delivery_challans.delivery_challan_id": "delivery_challan",
		};
		const route_key = data.key === "dux_indent_master"
			? indent_links[`${table.fieldname}.${column.fieldname}`]
			: null;
		const value = row[column.fieldname];
		if (route_key && value) {
			return `<button type="button" class="duxp-link-button" data-action="open-linked-document"
				data-key="${this.escape(route_key)}" data-name="${this.escape(value)}">
				${this.icon("eye", 13)}${this.escape(value)}
			</button>`;
		}
		return this.format_value(value, column, row);
	}

	update_indent_stock_action_visibility() {
		if (!this.$content) return;
		const has_selection = this.$content.find('[data-role="indent-stock-row"]:checked').length > 0;
		this.$content.find('[data-operational-action="indent_view_stock"]')
			.prop("hidden", !has_selection);
	}

	render_activity_panel(activity, data) {
		const items = this.get_activity_items(activity, data);
		const attachments = (activity.attachments || []).map((file) => {
			const url = this.safe_attachment_url(file.file_url);
			return url ? `<a class="duxp-activity-attachment" href="${this.escape(url)}" target="_blank" rel="noopener"
				title="${this.escape(file.file_name)}">${this.icon("attachment", 12)}<span>${this.escape(file.file_name)}</span></a>` : "";
		}).join("");
		const summary = [
			`${items.length} ${__("events")}`,
			`${(activity.attachments || []).length} ${__("files")}`,
			`${(activity.assignments || []).length} ${__("assigned")}`,
		].join(" · ");
		const timeline = items.map((item) => {
			const details = (item.details || []).length ? `<ul>${item.details.map((detail) => `<li>${this.escape(detail)}</li>`).join("")}</ul>` : "";
			const actor = this.activity_user(item.owner, activity.user_info || {});
			return `<article class="duxp-activity-item duxp-activity-${this.escape(item.type || "info")}">
				<div class="duxp-activity-marker">${this.icon(item.icon || "history", 13)}</div>
				<div class="duxp-activity-body">
					<div class="duxp-activity-item-head"><strong>${this.escape(item.label)}</strong><time title="${this.escape(this.format_datetime(item.creation))}">${this.escape(this.activity_time(item.creation))}</time></div>
					<div class="duxp-activity-actor"><span>${this.escape(actor.initials)}</span>${this.escape(actor.name)}</div>
					${item.content ? `<p>${this.escape(item.content)}</p>` : ""}${details}
				</div>
			</article>`;
		}).join("");

		return `<section class="duxp-card duxp-activity-panel ${this.state.activity_collapsed ? "is-collapsed" : ""}">
			<header class="duxp-activity-header"><div><h3>${__("Activity")}</h3><span>${this.escape(summary)}</span></div>
				<button class="duxp-icon-btn duxp-activity-toggle" data-action="toggle-activity" aria-label="${__("Toggle Activity")}" aria-expanded="${this.state.activity_collapsed ? "false" : "true"}">${this.icon("down", 14)}</button></header>
			${attachments ? `<div class="duxp-activity-attachments">${attachments}</div>` : ""}
			<div class="duxp-activity-list">${timeline || `<div class="duxp-activity-empty">${this.icon("history", 24)}<span>${__("No activity yet")}</span></div>`}</div>
		</section>`;
	}

	render_linked_documents(linked_documents) {
		const groups = linked_documents.groups || [];
		const total = Number(linked_documents.total || 0);
		const content = groups.map((group) => {
			const documents = (group.documents || []).map((document) => {
				const relations = (document.relations || []).join(" · ");
				return `<button type="button" class="duxp-linked-document" data-action="open-linked-document"
					data-key="${this.escape(document.route_key || group.route_key)}" data-name="${this.escape(document.name)}">
					<span class="duxp-linked-icon">${this.icon("workflow", 14)}</span>
					<span class="duxp-linked-copy"><strong>${this.escape(document.name)}</strong>${relations ? `<small title="${this.escape(relations)}">${this.escape(relations)}</small>` : ""}</span>
					${this.status_tag(document.status)}
					${this.icon("chevron", 13)}
				</button>`;
			}).join("");
			return `<section class="duxp-linked-group">
				<header><span>${this.escape(group.label || group.doctype)}</span><em>${(group.documents || []).length}</em></header>
				<div>${documents}</div>
			</section>`;
		}).join("");

		return `<section class="duxp-card duxp-linked-panel">
			<header class="duxp-linked-header"><div><h3>${__("Linked Documents")}</h3><span>${total} ${total === 1 ? __("document") : __("documents")}</span></div>${this.icon("workflow", 17)}</header>
			<div class="duxp-linked-list">${content || `<div class="duxp-linked-empty">${this.icon("workflow", 23)}<span>${__("No linked documents")}</span></div>`}</div>
		</section>`;
	}

	get_activity_items(activity, data) {
		const items = [];
		const add = (type, label, source, options = {}) => {
			if (!source || !source.creation) return;
			items.push({
				type,
				label,
				creation: source.creation,
				owner: options.owner || source.owner || source.sender,
				content: this.activity_plain(options.content !== undefined ? options.content : source.content),
				details: options.details || [],
				icon: options.icon || "history",
			});
		};

		add("created", __("Created"), { creation: activity.creation, owner: activity.owner }, { content: __("Document created"), icon: "plus" });
		add("edited", __("Last edited"), { creation: activity.modified, owner: activity.modified_by }, { content: __("Document last updated"), icon: "edit" });
		(activity.versions || []).forEach((version) => add("version", __("Document updated"), version, { details: this.version_activity_details(version, data.doctype), icon: "history" }));
		(activity.comments || []).forEach((row) => add("comment", __("Comment"), row, { icon: "comment" }));
		[...(activity.communications || []), ...(activity.automated_messages || [])].forEach((row) => add("communication", row.subject || row.communication_medium || __("Communication"), { ...row, creation: row.communication_date || row.creation }, { owner: row.sender, content: row.content, icon: row.communication_medium === "Email" ? "mail" : "comment" }));
		(activity.workflow_logs || []).forEach((row) => add("workflow", __("Workflow"), row, { icon: "workflow" }));
		(activity.assignment_logs || []).forEach((row) => add("assignment", row.comment_type || __("Assignment"), row, { icon: "user" }));
		(activity.attachment_logs || []).forEach((row) => add("attachment", row.comment_type || __("Attachment"), row, { icon: "attachment" }));
		(activity.share_logs || []).forEach((row) => add("share", row.comment_type || __("Shared"), row, { icon: "user" }));
		(activity.info_logs || []).forEach((row) => add("info", row.comment_type === "Label" ? __("Status changed") : __("Information"), row, { icon: "history" }));
		(activity.like_logs || []).forEach((row) => add("like", __("Liked"), row, { icon: "check" }));
		(activity.views || []).forEach((row) => add("view", __("Viewed"), row, { content: __("Document viewed"), icon: "eye" }));
		(activity.energy_point_logs || []).forEach((row) => add("energy", __("Energy Points"), row, { content: `${row.points || 0} ${__("points")}`, icon: "check" }));
		(activity.milestones || []).forEach((row) => add("milestone", __("Milestone"), row, { content: `${frappe.model.unscrub(row.track_field || "")} → ${row.value || ""}`, icon: "workflow" }));
		(activity.additional_timeline_content || []).forEach((row) => add("custom", __("Activity"), row, { content: row.content || __("Custom activity"), icon: row.icon || "history" }));
		return items.sort((a, b) => new Date(b.creation || 0) - new Date(a.creation || 0));
	}

	version_activity_details(version, doctype) {
		let data = version.data || {};
		try { if (typeof data === "string") data = JSON.parse(data); } catch (error) { data = {}; }
		const MAX_DETAILS = 6;
		const details = [];
		(data.changed || []).forEach((change) => {
			const fieldname = change[0];
			const before = this.activity_value(change[1]);
			const after = this.activity_value(change[2]);
			if (before === after) return;
			const label = frappe.meta.get_label(doctype, fieldname) || frappe.model.unscrub(fieldname || __("Field"));
			details.push(`${label}: ${before} → ${after}`);
		});
		(data.added || []).forEach((change) => details.push(__("Added row in {0}", [frappe.model.unscrub(change[0] || __("Items"))])));
		(data.removed || []).forEach((change) => details.push(__("Removed row from {0}", [frappe.model.unscrub(change[0] || __("Items"))])));
		(data.row_changed || []).forEach((change) => details.push(__("Updated row in {0}", [frappe.model.unscrub(change[0] || __("Items"))])));
		if (!details.length) return [__("Document values updated")];
		if (details.length > MAX_DETAILS) {
			return [...details.slice(0, MAX_DETAILS), __("+{0} more changes", [details.length - MAX_DETAILS])];
		}
		return details;
	}

	activity_value(value) {
		if (value === null || value === undefined || value === "") return "—";
		if (typeof value === "object") {
			try { value = JSON.stringify(value); } catch (error) { value = String(value); }
		}
		let text = String(value);
		if (/<[a-z][\s\S]*>/i.test(text)) {
			const element = document.createElement("div");
			element.innerHTML = text;
			element.querySelectorAll("script, style").forEach((node) => node.remove());
			text = String(element.textContent || element.innerText || "").replace(/\s+/g, " ").trim();
		}
		if (text.length > 80) text = `${text.slice(0, 77)}...`;
		return text || "—";
	}

	activity_plain(value) {
		if (value === null || value === undefined) return "";
		const element = document.createElement("div");
		element.innerHTML = String(value);
		element.querySelectorAll("script, style").forEach((node) => node.remove());
		return String(element.textContent || element.innerText || "").replace(/\s+/g, " ").trim();
	}

	activity_user(user, user_info) {
		const info = (user && user_info[user]) || {};
		const name = info.fullname || info.full_name || user || __("System");
		const initials = String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "SY";
		return { name, initials };
	}

	activity_time(value) {
		if (!value) return "";
		try {
			if (frappe.datetime && typeof frappe.datetime.prettyDate === "function") return frappe.datetime.prettyDate(value);
			return frappe.datetime.str_to_user(value);
		} catch (error) {
			return String(value);
		}
	}

	toggle_dropdown($dropdown) {
		if (!$dropdown || !$dropdown.length) return;
		const was_open = $dropdown.hasClass("is-open");
		this.$root.find(".duxp-dropdown.is-open").removeClass("is-open");
		if (!was_open) $dropdown.addClass("is-open");
	}

	toggle_activity_panel() {
		this.state.activity_collapsed = !this.state.activity_collapsed;
		const $panel = this.$content.find(".duxp-activity-panel");
		$panel.toggleClass("is-collapsed", this.state.activity_collapsed);
		$panel.find('[data-action="toggle-activity"]').attr("aria-expanded", this.state.activity_collapsed ? "false" : "true");
	}

	toggle_form_section($target) {
		const $section = $target.closest(".duxp-form-section");
		const collapsed = !$section.hasClass("is-collapsed");
		$section.toggleClass("is-collapsed", collapsed);
		$target.attr("aria-expanded", collapsed ? "false" : "true");
	}

	switch_form_tab($target) {
		const tab = String($target.data("tab") || "details");
		const $tabs = $target.closest(".duxp-form-tabs");
		$tabs.find('[data-action="switch-form-tab"]').each((index, element) => {
			const active = String($(element).data("tab")) === tab;
			$(element).toggleClass("is-active", active).attr("aria-selected", active ? "true" : "false");
		});
		$tabs.find(".duxp-form-tab-panel").each((index, element) => {
			const active = String($(element).data("form-tab-panel")) === tab;
			$(element).toggleClass("is-active", active).prop("hidden", !active);
		});
		this.reposition_active_suggestions();
	}

	async open_document_form(key, name = null) {
		const item = this.items[key];
		if (!item || item.kind !== "document") return;
		if (key === "delivery_receipts") this.receipt_source_challan = null;
		this.state.route_key = key;
		this.state.view = "form";
		this.state.document_name = name || null;
		this.set_active(key, `${name ? __("Edit") : __("New")} ${item.label}`);
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_document_form", {
				route_key: key,
				name: name || undefined,
			});
			this.render_document_form(data);
		} catch (error) {
			this.show_error(error);
		}
	}

	async open_amended_document_form(key, name) {
		const item = this.items[key];
		if (!item || item.kind !== "document" || !name) return;
		this.state.route_key = key;
		this.state.view = "form";
		this.state.document_name = null;
		this.set_active(key, `${__("Amend")} ${item.label}`);
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_amended_document_form", {
				route_key: key,
				name,
			});
			this.render_document_form(data);
		} catch (error) {
			this.show_error(error);
		}
	}

	run_lifecycle_action(key, name, lifecycle_action, requires_reason, label) {
		if (!key || !name || !lifecycle_action) return;
		if (requires_reason) {
			frappe.prompt([
				{ fieldname: "reason", label: __("Reason for Hold"), fieldtype: "Small Text", reqd: 1 },
			], (values) => this.execute_lifecycle_action(key, name, lifecycle_action, values.reason),
			__("Hold Purchase Order"), __("Hold"));
			return;
		}
		const message = lifecycle_action === "cancel"
			? __("Cancel {0}? Linked documents and native ERPNext rules will be checked.", [name])
			: __("Apply {0} to {1}?", [label || lifecycle_action, name]);
		frappe.confirm(message, () => this.execute_lifecycle_action(key, name, lifecycle_action));
	}

	async execute_lifecycle_action(key, name, lifecycle_action, reason = null) {
		try {
			const method = lifecycle_action === "cancel"
				? "dux_indent_master.portal.cancel_portal_document"
				: "dux_indent_master.portal.update_portal_document_status";
			const args = { route_key: key, name };
			if (lifecycle_action !== "cancel") {
				args.action = lifecycle_action;
				args.reason = reason || undefined;
			}
			const result = await this.call(method, args);
			frappe.show_alert({ message: `${result.name} · ${result.status}`, indicator: "green" });
			await this.open_document_detail(key, name);
		} catch (error) {
			const message = error && (error.message || error.exc) ? error.message || error.exc : __("Unable to update document.");
			frappe.msgprint({ title: __("Action Failed"), message: this.escape(message), indicator: "red" });
		}
	}

	run_workflow_action(key, name, workflow_action) {
		if (!key || !name || !workflow_action || this.workflow_updating) return;
		frappe.confirm(
			__("Apply workflow action {0} to {1}?", [workflow_action, name]),
			() => this.execute_workflow_action(key, name, workflow_action)
		);
	}

	async execute_workflow_action(key, name, workflow_action) {
		if (this.workflow_updating) return;
		this.workflow_updating = true;
		this.$content.find('[data-action="run-workflow"]').prop("disabled", true);
		try {
			const result = await this.call("dux_indent_master.portal.apply_portal_workflow_action", {
				route_key: key,
				name,
				action: workflow_action,
			});
			frappe.show_alert({
				message: `${result.name} · ${result.workflow_state || result.status}`,
				indicator: "green",
			});
			await this.open_document_detail(key, name);
		} catch (error) {
			const message = error && (error.message || error.exc) ? error.message || error.exc : __("Unable to apply workflow action.");
			frappe.msgprint({ title: __("Workflow Action Failed"), message: this.escape(message), indicator: "red" });
			this.$content.find('[data-action="run-workflow"]').prop("disabled", false);
		} finally {
			this.workflow_updating = false;
		}
	}

	run_operational_action(key, name, action) {
		if (!key || !name || !action) return;
		if (action === "dc_add_material") return this.add_delivery_challan_material(name);
		if (action === "dc_create_receipt") return this.open_delivery_challan_receipt(name);
		if (action === "dc_close_shortage") return this.close_delivery_challan_shortage(name);
		if (action === "dc_dispatch") {
			return frappe.confirm(__("Dispatch material for {0}? Native stock validations will run.", [name]),
				() => this.execute_delivery_challan_action(name, action));
		}
		if (action === "indent_material_purchase") return this.open_indent_material_purchase(name);
		if (action === "indent_delivery_challan") return this.create_indent_delivery_challan(name);
		if (action === "indent_view_stock") return this.view_indent_stock(name);
	}

	add_delivery_challan_material(name) {
		frappe.prompt([
			{ fieldname: "item_code", label: __("Item"), fieldtype: "Link", options: "Item", reqd: 1 },
			{ fieldname: "qty", label: __("Quantity"), fieldtype: "Float", reqd: 1 },
			{ fieldname: "source_warehouse", label: __("Source Warehouse"), fieldtype: "Link", options: "Warehouse" },
			{ fieldname: "target_warehouse", label: __("Target Warehouse"), fieldtype: "Link", options: "Warehouse" },
			{ fieldname: "remarks", label: __("Remarks"), fieldtype: "Small Text" },
		], async (values) => {
			await this.call("dux_indent_master.portal.append_delivery_challan_material", { name, ...values });
			frappe.show_alert({ message: __("Material added"), indicator: "green" });
			await this.open_document_detail("delivery_challan", name);
		}, __("Add Material"), __("Add"));
	}

	async execute_delivery_challan_action(name, action, extra = {}) {
		try {
			const result = await this.call("dux_indent_master.portal.run_delivery_challan_action", {
				name, action, ...extra,
			});
			frappe.show_alert({ message: `${result.name} - ${result.status}`, indicator: "green" });
			await this.open_document_detail("delivery_challan", name);
		} catch (error) {
			this.show_action_error(error, __("Delivery Challan Action Failed"));
		}
	}

	async open_delivery_challan_receipt(name) {
		const delivery_challan = String(name || "").trim();
		if (!delivery_challan || this.receipt_loading_challan === delivery_challan) return;
		this.receipt_loading_challan = delivery_challan;
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_delivery_challan_receipt_form", {
				name: delivery_challan,
			});
			this.receipt_source_challan = delivery_challan;
			this.state.route_key = "delivery_receipts";
			this.state.view = "form";
			this.state.document_name = null;
			this.set_active("delivery_receipts", `${__("New")} ${this.items.delivery_receipts.label}`);
			this.render_document_form(data);
		} catch (error) {
			this.show_error(error);
		} finally {
			if (this.receipt_loading_challan === delivery_challan) {
				this.receipt_loading_challan = null;
			}
		}
	}

	close_delivery_challan_shortage(name) {
		frappe.prompt([
			{
				fieldname: "closure_type", label: __("Closure Type"), fieldtype: "Select", reqd: 1,
				options: ["Book as Shortage / Loss", "Return to Source Warehouse"],
			},
			{ fieldname: "shortage_reason", label: __("Shortage Reason"), fieldtype: "Small Text", reqd: 1 },
		], (values) => this.execute_delivery_challan_action(name, "dc_close_shortage", values),
		__("Close Shortage"), __("Close"));
	}

	async open_indent_material_purchase(name) {
		try {
			const data = await this.call("dux_indent_master.portal.get_dux_indent_action_data", { name });
			const available = (data.items || []).filter((row) => Number(row.balance_qty || 0) > 0);
			if (!available.length) return frappe.msgprint(__("No purchase balance is available."));
			const rows = available.map((row) => `<tr data-row-name="${this.escape(row.row_name)}">
				<td>${this.escape(row.item_code)}</td>
				<td><input class="form-control duxp-indent-purchase-qty" type="number" min="0" step="any" value="${this.escape(row.balance_qty)}"></td></tr>`).join("");
			const dialog = new frappe.ui.Dialog({
				title: __("Material Request"),
				fields: [{ fieldname: "items_html", fieldtype: "HTML", options: `<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr><th>${__("Item")}</th><th>${__("Purchase Qty")}</th></tr></thead><tbody>${rows}</tbody></table></div>` }],
				primary_action_label: __("Create Material Request"),
				primary_action: async () => {
					const selected = [];
					let invalid_quantity = false;
					dialog.$wrapper.find("tr[data-row-name]").each((index, element) => {
						const qty = Number($(element).find(".duxp-indent-purchase-qty").val() || 0);
						if (qty < 0) invalid_quantity = true;
						if (qty > 0) selected.push({ item_row: $(element).data("row-name"), qty });
					});
					if (invalid_quantity) return frappe.msgprint(__("Purchase Qty cannot be negative."));
					if (!selected.length) return frappe.msgprint(__("Enter purchase quantity for at least one item."));
					const result = await this.call("dux_indent_master.portal.create_material_request_from_portal_indent", {
						name, selected_items: JSON.stringify(selected),
					});
					dialog.hide();
					await this.open_document_detail("material_request", result.material_request);
				},
			});
			dialog.show();
		} catch (error) {
			this.show_action_error(error, __("Material Request Failed"));
		}
	}

	async create_indent_delivery_challan(name) {
		try {
			const data = await this.call("dux_indent_master.portal.get_dux_indent_delivery_action_data", { name });
			const balance_items = (data.items || []).filter((row) => Number(row.balance_qty || 0) > 0);
			if (!balance_items.length) return frappe.msgprint(__("No delivery balance quantity is available."));
			const rows = balance_items.map((row) => `<tr data-row-name="${this.escape(row.row_name)}" data-max-qty="${this.escape(row.max_qty)}">
				<td>${this.escape(row.item_name)}</td>
				<td><input class="form-control duxp-indent-delivery-qty" type="number" min="0" max="${this.escape(row.max_qty)}" step="any" value="${this.escape(row.max_qty)}"></td>
			</tr>`).join("");
			const dialog = new frappe.ui.Dialog({
				title: __("Create Delivery Challan"),
				fields: [{
					fieldname: "items_html",
					fieldtype: "HTML",
					options: `<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr><th>${__("Item Name")}</th><th>${__("DC Qty")}</th></tr></thead><tbody>${rows}</tbody></table></div>`,
				}],
				primary_action_label: __("Create Delivery Challan"),
				primary_action: async () => {
					const selected = [];
					let invalid_quantity = false;
					dialog.$wrapper.find("tr[data-row-name]").each((index, element) => {
						const qty = Number($(element).find(".duxp-indent-delivery-qty").val() || 0);
						const max_qty = Number($(element).data("max-qty") || 0);
						if (qty < 0 || qty > max_qty) invalid_quantity = true;
						if (qty > 0) selected.push({ item_row: $(element).data("row-name"), qty });
					});
					if (invalid_quantity) {
						return frappe.msgprint(__("DC Qty cannot exceed the indent quantity."));
					}
					if (!selected.length) return frappe.msgprint(__("Enter DC Qty for at least one item."));
					dialog.get_primary_btn().prop("disabled", true);
					try {
						const result = await this.call("dux_indent_master.portal.create_delivery_challan_from_portal_indent", {
							name, selected_items: JSON.stringify(selected),
						});
						const document_name = result.name || result.delivery_challan;
						if (!document_name) throw new Error(__("Delivery Challan was not returned."));
						dialog.hide();
						await this.open_document_detail("delivery_challan", document_name);
					} catch (error) {
						dialog.get_primary_btn().prop("disabled", false);
						this.show_action_error(error, __("Delivery Challan Creation Failed"));
					}
				},
			});
			dialog.show();
		} catch (error) {
			this.show_action_error(error, __("Delivery Challan Creation Failed"));
		}
	}

	async view_indent_stock(name) {
		const row_names = this.$content.find('[data-role="indent-stock-row"]:checked').map((index, element) => element.value).get();
		if (!row_names.length) return frappe.msgprint(__("Select at least one indent item row."));
		try {
			const rows = await this.call("dux_indent_master.portal.get_dux_indent_stock", {
				name, row_names: JSON.stringify(row_names),
			});
			const body = (rows || []).map((row) => `<tr><td>${this.escape(row.item_code)}</td><td>${this.escape(row.warehouse || "-")}</td><td>${this.escape(format_number(row.actual_qty))}</td></tr>`).join("")
				|| `<tr><td colspan="3" class="text-center text-muted">${__("No positive stock is available for the selected rows.")}</td></tr>`;
			frappe.msgprint({ title: __("Available Stock"), message: `<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr><th>${__("Item")}</th><th>${__("Warehouse")}</th><th>${__("Actual Qty")}</th></tr></thead><tbody>${body}</tbody></table></div>`, wide: true });
		} catch (error) {
			this.show_action_error(error, __("Stock Lookup Failed"));
		}
	}

	show_action_error(error, title) {
		const message = error && (error.message || error.exc) ? error.message || error.exc : __("Unable to complete the action.");
		frappe.msgprint({ title, message: this.escape(message), indicator: "red" });
	}

	async open_mapped_document_form(target_key, source_key, source_name) {
		const target = this.items[target_key];
		if (!target || target.kind !== "document" || !source_name) return;
		this.state.route_key = target_key;
		this.state.view = "form";
		this.state.document_name = null;
		this.set_active(target_key, `${__("New")} ${target.label}`);
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_mapped_document_form", {
				target_route_key: target_key,
				source_route_key: source_key,
				source_name,
			});
			this.render_document_form(data);
		} catch (error) {
			this.show_error(error);
		}
	}

	async open_mapped_documents_form(target_key, source_key, source_names, args = {}, company = null) {
		const target = this.items[target_key];
		if (!target || target.kind !== "document" || !Array.isArray(source_names) || !source_names.length) return;
		this.state.route_key = target_key;
		this.state.view = "form";
		this.state.document_name = null;
		this.set_active(target_key, `${__("New")} ${target.label}`);
		this.show_loading();
		try {
			const data = await this.call("dux_indent_master.portal.get_mapped_documents_form", {
				target_route_key: target_key,
				source_route_key: source_key,
				source_names: JSON.stringify([...new Set(source_names)]),
				filtered_children: JSON.stringify(args.filtered_children || []),
				company: company || undefined,
			});
			this.render_document_form(data);
			frappe.show_alert({
				message: __("Items loaded from {0} Material Request(s)", [source_names.length]),
				indicator: "green",
			});
		} catch (error) {
			this.show_error(error);
		}
	}

	select_mapping_source(target_key, source_key) {
		if (!this.form_data || this.form_data.name) return;
		const action = (this.form_data.get_items_from || []).find((item) =>
			item.target_route_key === target_key && item.source_route_key === source_key
		);
		if (!action) return;
		const company_control = this.form_controls && this.form_controls.company;
		const company = company_control && company_control.get_value ? company_control.get_value() : null;
		if (action.company_filter && !company) {
			frappe.msgprint({
				title: __("Company Required"),
				message: __("Please select Company before fetching {0}.", [action.label]),
				indicator: "orange",
			});
			return;
		}
		this.open_source_picker(target_key, source_key, action, company);
	}

	async open_source_picker(target_key, source_key, action, company, search = "") {
		let data;
		try {
			data = await this.call("dux_indent_master.portal.get_mapping_source_options", {
				target_route_key: target_key,
				source_route_key: source_key,
				company: company || undefined,
				search: search || undefined,
			});
		} catch (error) {
			this.show_action_error(error, __("Unable to Load Documents"));
			return;
		}
		this.source_picker = {
			target_key,
			source_key,
			action,
			company,
			search,
			rows: data.rows || [],
			selected: (this.source_picker && this.source_picker.selected) || new Set(),
		};
		this.render_source_picker_modal();
	}

	render_source_picker_modal() {
		const picker = this.source_picker;
		this.$root.find(".duxp-modal-overlay").remove();
		if (!picker) return;
		const multiple = Boolean(picker.action.multiple);
		const rows_html = (picker.rows || []).map((row) => `
			<label class="duxp-picker-row">
				<input type="${multiple ? "checkbox" : "radio"}" name="duxp-picker-select" value="${this.escape(row.name)}" ${picker.selected.has(row.name) ? "checked" : ""}>
				<span class="duxp-picker-row-main">
					<strong>${this.escape(row.name)}</strong>
					${row.supplier_name || row.supplier ? `<small>${this.escape(row.supplier_name || row.supplier)}</small>` : ""}
				</span>
				${row.grand_total !== undefined && row.grand_total !== null ? `<span class="duxp-picker-row-amount">${this.escape(format_currency(flt(row.grand_total), frappe.defaults.get_default("currency") || "INR"))}</span>` : ""}
				${row.status ? this.status_tag(row.status) : ""}
			</label>
		`).join("");
		const $overlay = $(`
			<div class="duxp-modal-overlay" data-action="close-source-picker">
				<div class="duxp-modal duxp-source-picker">
					<header><h3>${this.escape(picker.action.label)}</h3><button class="duxp-icon-btn" data-action="close-source-picker" aria-label="${__("Close")}">${this.icon("close", 15)}</button></header>
					<div class="duxp-modal-body">
						<label class="duxp-search-field duxp-picker-search">${this.icon("search", 14)}<input data-role="source-picker-search" placeholder="${__("Search")} ${this.escape(picker.action.label)}…" value="${this.escape(picker.search || "")}"></label>
						<div class="duxp-picker-list">${rows_html || this.empty_state(__("Nothing available"), __("No eligible documents to pull items from."))}</div>
					</div>
					<footer>
						<button class="duxp-btn duxp-btn-secondary" data-action="close-source-picker">${__("Cancel")}</button>
						<button class="duxp-btn duxp-btn-primary" data-action="confirm-source-picker">${this.icon("download", 14)}${__("Get Items")}</button>
					</footer>
				</div>
			</div>
		`);
		const $modalBox = $overlay.find(".duxp-modal");
		$modalBox.on("click", (event) => {
			if (!$(event.target).closest("[data-action]", $modalBox[0]).length) {
				event.stopPropagation();
			}
		});
		this.$root.append($overlay);
	}

	close_source_picker() {
		this.source_picker = null;
		this.$root.find(".duxp-modal-overlay").remove();
	}

	toggle_source_picker_selection(name, multiple) {
		const picker = this.source_picker;
		if (!picker || !name) return;
		if (!multiple) {
			picker.selected = new Set([name]);
			return;
		}
		if (picker.selected.has(name)) picker.selected.delete(name);
		else picker.selected.add(name);
	}

	search_source_picker(value) {
		const picker = this.source_picker;
		if (!picker) return;
		clearTimeout(this.source_picker_search_timer);
		this.source_picker_search_timer = setTimeout(() => {
			this.open_source_picker(picker.target_key, picker.source_key, picker.action, picker.company, value);
		}, 350);
	}

	confirm_source_picker() {
		const picker = this.source_picker;
		if (!picker) return;
		const source_names = [...(picker.selected || [])];
		if (!source_names.length) {
			frappe.show_alert({ message: __("Select at least one document."), indicator: "orange" });
			return;
		}
		const { target_key, source_key, action, company } = picker;
		this.close_source_picker();
		if (action.multiple) {
			this.open_mapped_documents_form(target_key, source_key, source_names, {}, company);
		} else {
			this.open_mapped_document_form(target_key, source_key, source_names[0]);
		}
	}

	render_document_form(data) {
		this.form_data = data;
		this.form_controls = {};
		this.table_controls = {};
		(data.tables || []).forEach((table) => {
			if (table.reqd && !(table.rows || []).length && data.can_save) table.rows = [{}];
		});

		let panel_index = 1;
		const sections = data.sections || [];
		const tab_definitions = [{ key: "details", label: __("Details") }];
		sections.forEach((section) => {
			const key = section.tab || "details";
			if (key !== "details" && !tab_definitions.some((tab) => tab.key === key)) {
				tab_definitions.push({ key, label: section.tab_label || section.label });
			}
		});
		const tab_panels = tab_definitions.map((tab, tab_index) => {
			const tab_sections = sections.filter((section) => (section.tab || "details") === tab.key);
			const before_sections = tab_sections
				.filter((section) => section.position !== "after_tables")
				.map((section) => this.render_form_section(section, panel_index++))
				.join("");
			const tab_tables = tab.key === "details" ? (data.tables || []) : [];
			const tables = tab_tables
				.filter((table) => table.position !== "after_tables")
				.map((table) => this.render_form_table(table, panel_index++))
				.join("");
			const after_items = [
				...tab_sections
					.filter((section) => section.position === "after_tables")
					.map((section) => ({ order: section.order || 0, render: () => this.render_form_section(section, panel_index++) })),
				...tab_tables
					.filter((table) => table.position === "after_tables")
					.map((table) => ({ order: table.order || 0, render: () => this.render_form_table(table, panel_index++) })),
			].sort((a, b) => a.order - b.order);
			const after_sections = after_items.map((item) => item.render()).join("");
			return `<div class="duxp-form-tab-panel ${tab_index === 0 ? "is-active" : ""}"
				data-form-tab-panel="${this.escape(tab.key)}" ${tab_index === 0 ? "" : "hidden"}>
				${before_sections}${tables}${after_sections}
			</div>`;
		}).join("");
		const form_tabs = tab_definitions.length > 1 ? `
			<div class="duxp-form-tab-list" role="tablist" aria-label="${this.escape(__("Form sections"))}">
				${tab_definitions.map((tab, index) => `<button type="button" role="tab"
					class="duxp-form-tab ${index === 0 ? "is-active" : ""}" data-action="switch-form-tab"
					data-tab="${this.escape(tab.key)}" aria-selected="${index === 0 ? "true" : "false"}">
					${this.escape(tab.label)}</button>`).join("")}
			</div>` : "";

		const get_items_from = (data.get_items_from || []).map((action) => `
			<button class="duxp-btn duxp-btn-secondary" data-action="get-items-from"
				data-target-key="${this.escape(action.target_route_key)}" data-source-key="${this.escape(action.source_route_key)}">
				${this.icon("download", 14)}${this.escape(action.label)}</button>
		`).join("");
		const payment_helpers = data.key === "payment_entry" && data.can_save ? `
			<button class="duxp-btn duxp-btn-secondary" data-action="get-payment-outstanding" data-mode="invoices">${this.icon("download", 14)}${__("Get Outstanding Invoices")}</button>
			<button class="duxp-btn duxp-btn-secondary" data-action="get-payment-outstanding" data-mode="orders">${this.icon("download", 14)}${__("Get Outstanding Orders")}</button>
		` : "";

		const form_notice = data.is_closed
			? __("This Material Indent is Closed. Every field and item row is locked, and procurement actions are disabled.")
			: data.docstatus === 2
			? __("This document is cancelled and read-only. Use Amend from the document view to make a corrected copy.")
			: data.docstatus === 1 && data.can_update_after_submit
				? __("This document is submitted. Only fields marked Allow on Submit by ERPNext are editable.")
				: data.docstatus === 1
					? __("Submitted documents are read-only. Use the available Stop, Close or Cancel action; cancel and amend to change normal fields.")
					: __("This form stays inside Dux Portal. Native ERPNext permissions, validations, stock and accounting rules run when you save.");

		this.$content.html(`
			<section class="duxp-form-toolbar">
				${get_items_from || payment_helpers ? `<div class="duxp-get-items"><span>${get_items_from ? __("Get Items From") : __("References")}</span>${get_items_from}${payment_helpers}</div>` : ""}
				<div class="duxp-head-actions">
					<button class="duxp-btn duxp-btn-secondary" data-action="form-back">${this.icon("back", 14)}${__("Back")}</button>
					${data.can_submit ? `<button class="duxp-btn duxp-btn-secondary" data-action="submit-form">${this.icon("check", 14)}${this.escape(data.submit_label || __("Save & Submit"))}</button>` : ""}
					${data.can_save ? `<button class="duxp-btn duxp-btn-primary" data-action="save-form">${this.icon("save", 14)}${data.can_update_after_submit ? __("Update") : __("Save Draft")}</button>` : ""}
				</div>
			</section>
			<div class="duxp-form-notice">${this.icon("shield", 15)}<span>${form_notice}</span></div>
			<div class="duxp-form-tabs">
				${form_tabs}
				${tab_panels}
			</div>
		`);
		this.mount_form_controls();
	}

	render_form_section(section, panel_index) {
		const collapsed = Boolean(section.collapsible && section.collapsed);
		const meta = `${(section.fields || []).length} ${__("fields")}`;
		const header = section.collapsible ? `<div class="duxp-panel-header duxp-collapsible-header" data-action="toggle-form-section"
			role="button" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}">
			<span>${String(panel_index).padStart(2, "0")}</span><h3>${this.escape(section.label)}</h3>
			<small>${this.escape(meta)}</small><i class="duxp-section-toggle-icon">${this.icon("down", 14)}</i>
		</div>` : this.panel_header(panel_index, section.label, meta);
		return `
			<section class="duxp-card duxp-form-section ${collapsed ? "is-collapsed" : ""}">
				${header}
				<div class="duxp-form-section-body"><div class="duxp-form-grid">
					${(section.fields || []).map((field) => `<div class="duxp-form-control" data-fieldname="${this.escape(field.fieldname)}"></div>`).join("")}
				</div></div>
			</section>
		`;
	}

	render_form_table(table, panel_index) {
		const rows = table.rows || [];
		return `
			<section class="duxp-card duxp-form-section duxp-form-table-section" data-form-table="${this.escape(table.fieldname)}">
				${this.panel_header(panel_index, table.label, `${rows.length} ${__("rows")}`)}
				<div class="duxp-form-table-wrap">
					<table class="duxp-form-table"><thead><tr><th>#</th>${(table.fields || []).map((field) => `<th>${this.escape(field.label)}${field.reqd ? '<span class="duxp-required">*</span>' : ""}</th>`).join("")}<th></th></tr></thead>
					<tbody>${rows.map((row, row_index) => `<tr><td class="duxp-index">${row_index + 1}</td>${table.fields.map((field) => `<td><div class="duxp-form-control duxp-table-control" data-table="${this.escape(table.fieldname)}" data-index="${row_index}" data-fieldname="${this.escape(field.fieldname)}"></div></td>`).join("")}<td><button class="duxp-row-remove" data-action="remove-form-row" data-table="${this.escape(table.fieldname)}" data-index="${row_index}" ${this.form_data.can_save ? "" : "disabled"} aria-label="${__("Remove row")}">${this.icon("trash", 14)}</button></td></tr>`).join("") || `<tr><td colspan="${table.fields.length + 2}">${this.empty_state(__("No rows"), __("Use Add Row to begin."))}</td></tr>`}</tbody></table>
				</div>
				${this.form_data.can_save ? `<div class="duxp-table-footer"><button class="duxp-btn duxp-btn-secondary" data-action="add-form-row" data-table="${this.escape(table.fieldname)}">${this.icon("plus", 14)}${__("Add Row")}</button></div>` : ""}
			</section>
		`;
	}

	mount_form_controls() {
		(this.form_data.sections || []).forEach((section) => {
			(section.fields || []).forEach((field) => {
				const $slot = this.$content.find(`.duxp-form-control[data-fieldname="${field.fieldname}"]`).not(".duxp-table-control").first();
				const control = this.make_form_control($slot, field, field.value, false);
				this.form_controls[field.fieldname] = control;
				if (control && this.form_data.can_save) {
					control.df.change = () => this.handle_parent_control_change(field.fieldname, control.get_value());
				}
				if (control) this.refresh_indent_attachment_preview(field.fieldname);
			});
		});

		(this.form_data.tables || []).forEach((table) => {
			this.table_controls[table.fieldname] = [];
			(table.rows || []).forEach((row, row_index) => {
				const row_controls = {};
				(table.fields || []).forEach((field) => {
					const $slot = this.$content.find(`.duxp-table-control[data-table="${table.fieldname}"][data-index="${row_index}"][data-fieldname="${field.fieldname}"]`).first();
					const control = this.make_form_control($slot, field, row[field.fieldname], true);
					row_controls[field.fieldname] = control;
					if (control && this.form_data.can_save) {
						control.df.change = () => this.handle_table_control_change(
							table.fieldname,
							row_index,
							field,
							control.get_value()
						);
					}
				});
				this.table_controls[table.fieldname].push(row_controls);
			});
		});
		this.$content.find(".duxp-form-table-wrap")
			.off("scroll.duxProcurementPortal")
			.on("scroll.duxProcurementPortal", () => this.reposition_active_suggestions());
		this.sync_child_required_dates();
		this.refresh_all_indent_balances();
		this.refresh_form_date_constraints();
		this.refresh_form_dependencies();
	}

	make_form_control($slot, field, value, in_table) {
		if (!$slot.length) return null;
		const df = {
			...field,
			label: in_table ? "" : field.label,
			read_only: field.read_only || !this.form_data.can_save ? 1 : 0,
		};
		if (["Link", "Dynamic Link"].includes(df.fieldtype)) {
			// This form has no frm/docname context, so ControlLink's async
			// validate_link_and_fetch round-trip has nothing to validate against and
			// resolves empty, silently blanking out values we already know are valid
			// (server-supplied defaults, mapped-document values, saved doc values).
			df.ignore_link_validation = true;
		}
		if (df.fieldtype === "Dynamic Link") {
			df.get_options = () => {
				const option_control = this.form_controls[df.options];
				return option_control ? option_control.get_value() : "";
			};
		}
		if (df.fieldtype === "Link" && ["Warehouse", "Account", "Cost Center"].includes(df.options)) {
			df.get_query = () => ({ filters: this.link_filters(df.options) });
		}
		const control = frappe.ui.form.make_control({ df, parent: $slot, render_input: true });
		control.duxp_field = field;
		control.duxp_base_read_only = Boolean(df.read_only);
		control.duxp_base_reqd = Boolean(df.reqd);
		let initial_value = value;
		if (
			(initial_value === null || initial_value === undefined || initial_value === "")
			&& this.form_data.is_new
			&& field.default !== null
			&& field.default !== undefined
			&& field.default !== ""
		) {
			initial_value = field.default;
		}
		control.set_value(initial_value === null || initial_value === undefined ? "" : initial_value);
		return control;
	}

	link_filters(options) {
		const filters = {};
		const company = this.form_company_value();
		if (["Warehouse", "Account", "Cost Center"].includes(options)) filters.is_group = 0;
		if (company) filters.company = company;
		return filters;
	}

	form_company_value() {
		for (const fieldname of ["company", "company_name"]) {
			const control = this.form_controls[fieldname];
			if (control && control.get_value()) return control.get_value();
		}
		return "";
	}

	parent_form_values() {
		const values = {};
		Object.entries(this.form_controls || {}).forEach(([fieldname, control]) => {
			if (control) values[fieldname] = control.get_value();
		});
		values.__islocal = Boolean(this.form_data && this.form_data.is_new);
		values.docstatus = this.form_data ? Number(this.form_data.docstatus || 0) : 0;
		return values;
	}

	table_row_values(table_fieldname, row_index) {
		const values = {};
		const controls = (this.table_controls[table_fieldname] || [])[row_index] || {};
		Object.entries(controls).forEach(([fieldname, control]) => {
			if (control) values[fieldname] = control.get_value();
		});
		return values;
	}

	evaluate_dependency(expression, doc, parent) {
		if (expression === null || expression === undefined || expression === "") return true;
		if (typeof expression === "boolean") return expression;
		if (typeof expression === "function") return Boolean(expression(doc));
		const condition = String(expression);
		try {
			if (condition.slice(0, 5) === "eval:") {
				return Boolean(frappe.utils.eval(condition.slice(5), { doc, parent }));
			}
			if (condition.slice(0, 3) === "fn:") return true;
			return Boolean(doc[condition]);
		} catch (error) {
			return true;
		}
	}

	apply_control_dependencies(control, field, doc, parent) {
		if (!control) return;
		const visible = this.evaluate_dependency(field.depends_on, doc, parent);
		if (this.form_data && this.form_data.key === "material_request" && control.$wrapper) {
			const $field_slot = control.$wrapper.closest(".duxp-form-control").not(".duxp-table-control");
			if ($field_slot.length) $field_slot.toggle(visible);
		}
		const required = Boolean(field.reqd || (
			field.mandatory_depends_on
			&& this.evaluate_dependency(field.mandatory_depends_on, doc, parent)
		));
		const read_only = Boolean(control.duxp_base_read_only || (
			field.read_only_depends_on
			&& this.evaluate_dependency(field.read_only_depends_on, doc, parent)
		));
		const changed = Boolean(control.df.hidden) === visible
			|| Boolean(control.df.reqd) !== required
			|| Boolean(control.df.read_only) !== read_only;
		if (!changed) return;
		control.df.hidden = visible ? 0 : 1;
		control.df.reqd = required ? 1 : 0;
		control.df.read_only = read_only ? 1 : 0;
		control.refresh();
	}

	refresh_form_date_constraints() {
		if (!this.form_data) return;
		(this.form_data.sections || []).forEach((section) => {
			(section.fields || []).forEach((field) => {
				if (!field.min_date_field) return;
				const control = this.form_controls[field.fieldname];
				const minimum_control = this.form_controls[field.min_date_field];
				if (!control || !minimum_control || !control.$input) return;
				control.$input.attr("min", minimum_control.get_value() || "");
			});
		});
	}

	sync_child_required_dates() {
		if (!this.form_data) return;
		const date_fields = ["schedule_date", "required_date"];
		date_fields.forEach((fieldname) => {
			const parent_control = this.form_controls[fieldname];
			if (!parent_control) return;
			const required_date = parent_control.get_value() || "";
			Object.values(this.table_controls || {}).forEach((rows) => {
				(rows || []).forEach((controls) => {
					if (controls[fieldname]) controls[fieldname].set_value(required_date);
				});
			});
		});
	}

	refresh_form_dependencies() {
		if (!this.form_data) return;
		const parent = this.parent_form_values();
		(this.form_data.sections || []).forEach((section) => {
			(section.fields || []).forEach((field) => {
				this.apply_control_dependencies(this.form_controls[field.fieldname], field, parent, parent);
			});
		});
		(this.form_data.tables || []).forEach((table) => {
			(table.rows || []).forEach((row, row_index) => {
				const doc = this.table_row_values(table.fieldname, row_index);
				(table.fields || []).forEach((field) => {
					const controls = (this.table_controls[table.fieldname] || [])[row_index] || {};
					this.apply_control_dependencies(controls[field.fieldname], field, doc, parent);
				});
			});
		});
		this.refresh_stock_entry_warehouse_state(parent);
	}

	refresh_stock_entry_warehouse_state(parent) {
		if (!this.form_data || this.form_data.key !== "stock_entry") return;
		const purpose = parent.stock_entry_type || parent.purpose || "";
		const states = {
			from_warehouse: purpose === "Material Receipt",
			to_warehouse: purpose === "Material Issue",
		};
		Object.entries(states).forEach(([fieldname, native_read_only]) => {
			const control = this.form_controls[fieldname];
			if (!control) return;
			const read_only = Boolean(control.duxp_base_read_only || native_read_only);
			if (Boolean(control.df.read_only) === read_only) return;
			control.df.read_only = read_only ? 1 : 0;
			control.refresh();
		});
	}

	async handle_parent_control_change(fieldname, value) {
		this.refresh_indent_attachment_preview(fieldname);
		if (this.form_data && this.form_data.key === "delivery_receipts"
			&& this.form_data.is_new && fieldname === "delivery_challan" && value) {
			if (value === this.receipt_source_challan || value === this.receipt_loading_challan) return;
			await this.open_delivery_challan_receipt(value);
			return;
		}
		if (this.form_data && this.form_data.key === "item" && fieldname === "item_code" && value) {
			const item_name_control = this.form_controls.item_name;
			if (item_name_control && !item_name_control.get_value()) {
				item_name_control.set_value(value);
			}
		}
		if (this.form_data && this.form_data.key === "purchase_order" && fieldname === "supplier" && value) {
			await this.fetch_supplier_party_details(value);
		}
		if (this.form_data && this.form_data.key === "purchase_order" && fieldname === "taxes_and_charges") {
			await this.apply_purchase_order_tax_template(value);
		} else if (
			this.form_data && this.form_data.key === "purchase_order"
			&& ["apply_discount_on", "additional_discount_percentage", "discount_amount", "conversion_rate"].includes(fieldname)
		) {
			await this.recalculate_purchase_order_totals();
		}
		if (this.form_data && ["transaction_date", "schedule_date", "required_date"].includes(fieldname)) {
			const transaction_date = this.form_controls.transaction_date
				? this.form_controls.transaction_date.get_value()
				: "";
			for (const required_fieldname of ["schedule_date", "required_date"]) {
				const required_date_control = this.form_controls[required_fieldname];
				if (required_date_control && required_date_control.get_value()
					&& transaction_date && required_date_control.get_value() < transaction_date) {
					const label = required_date_control.df.label || __("Required Date");
					required_date_control.set_value("");
					frappe.show_alert({
						message: __("{0} cannot be earlier than Transaction Date.", [label]),
						indicator: "orange",
					});
					break;
				}
			}
			this.sync_child_required_dates();
			this.refresh_form_date_constraints();
		}
		if (this.form_data && this.form_data.key === "dux_indent_master" && fieldname === "company_name") {
			await this.update_indent_item_warehouses_for_company();
		}
		const child_field_map = {
			set_warehouse: "warehouse",
			set_from_warehouse: "from_warehouse",
			from_warehouse: "s_warehouse",
			to_warehouse: "t_warehouse",
			rejected_warehouse: "rejected_warehouse",
			source_warehouse: "source_warehouse",
			target_warehouse: "target_warehouse",
		};
		const child_field = child_field_map[fieldname];
		if (child_field) {
			Object.values(this.table_controls || {}).forEach((rows) => {
				(rows || []).forEach((controls) => {
					if (controls[child_field]) controls[child_field].set_value(value || "");
				});
			});
		}
		this.refresh_form_dependencies();
	}

	async fetch_supplier_party_details(supplier) {
		let details;
		try {
			details = await this.call("erpnext.accounts.party.get_party_details", {
				party: supplier,
				party_type: "Supplier",
				company: this.form_company_value() || undefined,
				doctype: "Purchase Order",
			});
		} catch (error) {
			return;
		}
		if (!details) return;
		[
			"supplier_address", "address_display",
			"billing_address", "billing_address_display",
			"dispatch_address", "dispatch_address_display",
			"contact_person", "contact_display", "contact_mobile", "contact_email",
			"place_of_supply",
		].forEach((fieldname) => {
			const control = this.form_controls[fieldname];
			if (control && details[fieldname] !== undefined && details[fieldname] !== null) {
				control.set_value(details[fieldname]);
			}
		});
	}

	async apply_purchase_order_tax_template(template) {
		if (this.po_tax_template_inflight === template) return;
		this.po_tax_template_inflight = template;
		try {
			const table = (this.form_data.tables || []).find((item) => item.fieldname === "taxes");
			if (!table) return;
			let rows = [];
			if (template) {
				try {
					rows = (await this.call("erpnext.controllers.accounts_controller.get_taxes_and_charges", {
						master_doctype: "Purchase Taxes and Charges Template",
						master_name: template,
					})) || [];
				} catch (error) {
					rows = [];
				}
			}
			this.sync_form_data_from_controls();
			table.rows = rows;
			this.render_document_form(this.form_data);
			await this.recalculate_purchase_order_totals();
		} finally {
			this.po_tax_template_inflight = null;
		}
	}

	async recalculate_purchase_order_totals() {
		if (!this.form_data || this.form_data.key !== "purchase_order") return;
		if (this.po_totals_inflight) {
			this.po_totals_pending = true;
			return;
		}
		this.po_totals_inflight = true;
		try {
			this.sync_form_data_from_controls();
			const values = this.collect_form_values();
			let result;
			try {
				result = await this.call("dux_indent_master.portal.compute_purchase_order_totals", {
					values: JSON.stringify(values),
				});
			} catch (error) {
				return;
			}
			if (!result || !this.form_data || this.form_data.key !== "purchase_order") return;
			(this.table_controls.items || []).forEach((controls, index) => {
				const row = (result.items || [])[index];
				if (controls.amount && row && row.amount !== undefined) controls.amount.set_value(flt(row.amount, 2));
			});
			(this.table_controls.taxes || []).forEach((controls, index) => {
				const row = (result.taxes || [])[index];
				if (controls.tax_amount && row && row.tax_amount !== undefined) controls.tax_amount.set_value(flt(row.tax_amount, 2));
			});
			const totals = result.totals || {};
			["grand_total", "rounding_adjustment", "rounded_total"].forEach((fieldname) => {
				const control = this.form_controls[fieldname];
				if (control && totals[fieldname] !== undefined) control.set_value(flt(totals[fieldname], 2));
			});
		} finally {
			this.po_totals_inflight = false;
			if (this.po_totals_pending) {
				this.po_totals_pending = false;
				this.recalculate_purchase_order_totals();
			}
		}
	}

	refresh_indent_attachment_preview(fieldname) {
		if (
			!this.form_data || this.form_data.key !== "dux_indent_master"
			|| !["note_attachment", "design_attachment"].includes(fieldname)
		) return;
		const control = this.form_controls[fieldname];
		const $slot = this.$content.find(`.duxp-form-control[data-fieldname="${fieldname}"]`)
			.not(".duxp-table-control").first();
		if (!$slot.length) return;
		$slot.find(`[data-indent-attachment-preview="${fieldname}"]`).remove();
		const value = control && control.get_value ? control.get_value() : "";
		const attachment_url = this.safe_attachment_url(value);
		if (!attachment_url || !this.is_image_attachment(value)) return;
		const file_name = this.attachment_file_name(value);
		const $preview = $(`
			<figure class="duxp-image-preview-card" data-indent-attachment-preview="${this.escape(fieldname)}">
				<img src="${this.escape(attachment_url)}" alt="${this.escape(file_name)}" loading="lazy">
				<figcaption>${this.escape(file_name)}</figcaption>
				<a class="duxp-image-preview-action" href="${this.escape(attachment_url)}" target="_blank"
					rel="noopener noreferrer" aria-label="${this.escape(__("Preview {0}", [file_name]))}">
					${this.icon("eye", 17)}<span>${__("Preview")}</span>
				</a>
			</figure>
		`).appendTo($slot);
		$preview.find("img").on("error", () => $preview.remove());
	}

	is_image_attachment(value) {
		const path = String(value || "").split(/[?#]/)[0].toLowerCase();
		return /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/.test(path);
	}

	attachment_file_name(value) {
		const path = String(value || "").split(/[?#]/)[0];
		const raw_name = path.split("/").filter(Boolean).pop() || __("Image attachment");
		try {
			return decodeURIComponent(raw_name);
		} catch (error) {
			return raw_name;
		}
	}

	async get_payment_outstanding(mode) {
		if (!this.form_data || this.form_data.key !== "payment_entry" || !this.form_data.can_save) return;
		try {
			const rows = await this.call("dux_indent_master.portal.get_payment_entry_outstanding", {
				values: JSON.stringify(this.collect_form_values()),
				mode: mode || "invoices",
			});
			this.sync_form_data_from_controls();
			const table = (this.form_data.tables || []).find((item) => item.fieldname === "references");
			if (!table) throw new Error(__("References table is not available."));
			table.rows = rows || [];
			this.render_document_form(this.form_data);
			frappe.show_alert({ message: __("{0} outstanding reference(s) loaded", [table.rows.length]), indicator: "green" });
		} catch (error) {
			this.show_action_error(error, __("Outstanding References Failed"));
		}
	}

	async handle_table_control_change(table_fieldname, row_index, field, value) {
		if (this.updating_indent_company_warehouses) return;
		if (field.fieldname === "item_code") {
			await this.apply_item_defaults(table_fieldname, row_index, value);
		} else if (field.options === "Warehouse") {
			await this.refresh_row_stock(table_fieldname, row_index);
		}
		if (["qty", "rate"].includes(field.fieldname)) {
			this.recalculate_row_amount(table_fieldname, row_index);
		}
		if (
			this.form_data && this.form_data.key === "purchase_order"
			&& ["items", "taxes"].includes(table_fieldname)
			&& ["item_code", "qty", "rate", "charge_type", "account_head"].includes(field.fieldname)
		) {
			await this.recalculate_purchase_order_totals();
		}
		if (
			this.form_data && this.form_data.key === "dux_indent_master"
			&& table_fieldname === "items"
			&& ["item_code", "qty", "purchase_qty"].includes(field.fieldname)
		) {
			this.refresh_indent_row_balance(table_fieldname, row_index, field.fieldname !== "item_code");
		}
		this.refresh_form_dependencies();
	}

	recalculate_row_amount(table_fieldname, row_index) {
		const controls = (this.table_controls[table_fieldname] || [])[row_index] || {};
		if (!controls.amount) return;
		const qty = Number(controls.qty ? controls.qty.get_value() : 0) || 0;
		const rate = Number(controls.rate ? controls.rate.get_value() : 0) || 0;
		controls.amount.set_value(flt(qty * rate, 2));
	}

	header_warehouse_value() {
		for (const fieldname of ["set_warehouse", "source_warehouse", "from_warehouse", "to_warehouse", "target_warehouse"]) {
			const control = this.form_controls[fieldname];
			if (control && control.get_value()) return control.get_value();
		}
		return "";
	}

	async apply_item_defaults(table_fieldname, row_index, item_code) {
		const is_indent_item = Boolean(
			this.form_data && this.form_data.key === "dux_indent_master" && table_fieldname === "items"
		);
		const controls = (this.table_controls[table_fieldname] || [])[row_index] || {};
		if (!item_code) {
			if (is_indent_item && controls.stock_qty) controls.stock_qty.set_value(0);
			return;
		}
		try {
			const row_warehouse_control = controls.warehouse || controls.source_warehouse || controls.s_warehouse || controls.t_warehouse;
			const warehouse = !is_indent_item && row_warehouse_control && row_warehouse_control.get_value()
				? row_warehouse_control.get_value()
				: is_indent_item ? "" : this.header_warehouse_value();
			const defaults = await this.call("dux_indent_master.portal.get_portal_item_defaults", {
				item_code,
				company: this.form_company_value(),
				warehouse,
				...this.indent_item_context(table_fieldname, row_index),
			});
			["item_name", "description", "stock_uom", "uom", "conversion_factor", "rate", "basic_rate", "warehouse", "source_warehouse", "stock_qty"].forEach((fieldname) => {
				const control = controls[fieldname];
				if (!control || defaults[fieldname] === undefined) return;
				if (is_indent_item && ["uom", "warehouse", "stock_qty"].includes(fieldname)) {
					control.set_value(defaults[fieldname]);
				} else if (fieldname === "stock_qty" || !control.get_value()) {
					control.set_value(defaults[fieldname]);
				}
			});
			if (is_indent_item) this.refresh_indent_row_balance(table_fieldname, row_index);
			this.recalculate_row_amount(table_fieldname, row_index);
		} catch (error) {
			// The save controller will still validate and enrich the row server-side.
		}
	}

	async refresh_row_stock(table_fieldname, row_index) {
		const controls = (this.table_controls[table_fieldname] || [])[row_index] || {};
		if (!controls.item_code || !controls.item_code.get_value() || !controls.stock_qty) return;
		const warehouse_control = controls.warehouse || controls.source_warehouse || controls.s_warehouse || controls.t_warehouse;
		const warehouse = warehouse_control ? warehouse_control.get_value() : this.header_warehouse_value();
		try {
			const defaults = await this.call("dux_indent_master.portal.get_portal_item_defaults", {
				item_code: controls.item_code.get_value(),
				company: this.form_company_value(),
				warehouse,
				...this.indent_item_context(table_fieldname, row_index),
			});
			controls.stock_qty.set_value(defaults.stock_qty || 0);
		} catch (error) {
			// Native validation remains authoritative on save.
		}
	}

	collect_form_values() {
		const values = {};
		Object.entries(this.form_controls || {}).forEach(([fieldname, control]) => {
			if (control) values[fieldname] = control.get_value();
		});
		(this.form_data.tables || []).forEach((table) => {
			values[table.fieldname] = (this.table_controls[table.fieldname] || []).map((row_controls, index) => {
				const row = { _row_name: (table.rows[index] || {})._row_name || null };
				Object.entries(row_controls).forEach(([fieldname, control]) => {
					if (control) row[fieldname] = control.get_value();
				});
				return row;
			});
		});
		return values;
	}

	sync_form_data_from_controls() {
		const values = this.collect_form_values();
		(this.form_data.sections || []).forEach((section) => (section.fields || []).forEach((field) => {
			field.value = values[field.fieldname];
		}));
		(this.form_data.tables || []).forEach((table) => {
			table.rows = values[table.fieldname] || [];
		});
	}

	add_form_row(table_fieldname) {
		if (!this.form_data || !this.form_data.can_save) return;
		this.sync_form_data_from_controls();
		const table = (this.form_data.tables || []).find((item) => item.fieldname === table_fieldname);
		if (!table) return;
		const row = {};
		["schedule_date", "required_date"].forEach((fieldname) => {
			if ((table.fields || []).some((field) => field.fieldname === fieldname)
				&& this.form_controls[fieldname]) {
				row[fieldname] = this.form_controls[fieldname].get_value() || "";
			}
		});
		table.rows.push(row);
		this.render_document_form(this.form_data);
	}

	remove_form_row(table_fieldname, row_index) {
		if (!this.form_data || !this.form_data.can_save) return;
		this.sync_form_data_from_controls();
		const table = (this.form_data.tables || []).find((item) => item.fieldname === table_fieldname);
		if (!table || row_index < 0 || row_index >= table.rows.length) return;
		table.rows.splice(row_index, 1);
		this.render_document_form(this.form_data);
		if (this.form_data.key === "purchase_order" && ["items", "taxes"].includes(table_fieldname)) {
			this.recalculate_purchase_order_totals();
		}
	}

	close_document_form() {
		if (!this.form_data) return this.open_document_list(this.state.route_key);
		if (this.form_data.name) this.open_document_detail(this.form_data.key, this.form_data.name);
		else this.open_document_list(this.form_data.key);
	}

	async save_portal_form(submit_after = false) {
		if (!this.form_data || !this.form_data.can_save || this.form_saving) return;
		this.form_saving = true;
		this.$content.find('[data-action="save-form"], [data-action="submit-form"]').prop("disabled", true);
		try {
			const result = await this.call("dux_indent_master.portal.save_portal_document", {
				route_key: this.form_data.key,
				name: this.form_data.name || undefined,
				mapping_token: this.form_data.mapping_token || undefined,
				values: JSON.stringify(this.collect_form_values()),
			});
			if (submit_after) {
				const submit_result = await this.call("dux_indent_master.portal.submit_portal_document", {
					route_key: this.form_data.key,
					name: result.name,
					workflow_action: this.form_data.submit_action || undefined,
				});
				frappe.show_alert({
					message: `${result.name} · ${submit_result.workflow_state || submit_result.status}`,
					indicator: "green",
				});
				await this.open_document_detail(this.form_data.key, result.name);
			} else {
				frappe.show_alert({ message: `${result.name} ${__("saved")}`, indicator: "green" });
				await this.open_document_detail(this.form_data.key, result.name);
			}
		} catch (error) {
			const message = error && (error.message || error.exc) ? error.message || error.exc : __("Unable to save document.");
			frappe.msgprint({ title: __("Save Failed"), message: this.escape(message), indicator: "red" });
			this.$content.find('[data-action="save-form"], [data-action="submit-form"]').prop("disabled", false);
		} finally {
			this.form_saving = false;
		}
	}

	confirm_submit_form() {
		if (!this.form_data || !this.form_data.can_submit) return;
		const action = this.form_data.submit_label || __("Save & Submit");
		frappe.confirm(__("Save the latest changes and apply {0}?", [action]), () => this.save_portal_form(true));
	}

	confirm_submit_detail(key, name) {
		if (!key || !name || this.detail_submitting) return;
		const action = this.$content.find('[data-action="submit-detail"]').data("workflow-action") || __("Submit");
		frappe.confirm(__("Apply {0} to this saved draft document?", [action]), () => this.submit_document_from_detail(key, name, action));
	}

	async submit_document_from_detail(key, name, workflow_action = null) {
		if (this.detail_submitting) return;
		this.detail_submitting = true;
		this.$content.find('[data-action="submit-detail"]').prop("disabled", true);
		try {
			const result = await this.call("dux_indent_master.portal.submit_portal_document", {
				route_key: key,
				name,
				workflow_action: workflow_action || undefined,
			});
			frappe.show_alert({ message: `${name} · ${result.workflow_state || result.status}`, indicator: "green" });
			await this.open_document_detail(key, name);
		} catch (error) {
			const message = error && (error.message || error.exc) ? error.message || error.exc : __("Unable to submit document.");
			frappe.msgprint({ title: __("Submit Failed"), message: this.escape(message), indicator: "red" });
			this.$content.find('[data-action="submit-detail"]').prop("disabled", false);
		} finally {
			this.detail_submitting = false;
		}
	}

	indent_item_context(table_fieldname, row_index) {
		if (!this.form_data || this.form_data.key !== "dux_indent_master" || table_fieldname !== "items") {
			return {};
		}
		const table = (this.form_data.tables || []).find((item) => item.fieldname === table_fieldname);
		const row = table && (table.rows || [])[row_index];
		return {
			indent_name: this.form_data.is_new ? null : this.form_data.name,
			indent_item_row_name: row ? row._row_name || null : null,
		};
	}

	refresh_indent_row_balance(table_fieldname, row_index, notify = false) {
		if (!this.form_data || this.form_data.key !== "dux_indent_master" || table_fieldname !== "items") return;
		const controls = (this.table_controls[table_fieldname] || [])[row_index] || {};
		if (!controls.qty || !controls.qty_balanced) return;
		const qty = Number(controls.qty.get_value() || 0);
		const purchase_qty = Number(controls.purchase_qty && controls.purchase_qty.get_value() || 0);
		const balance = qty - purchase_qty;
		const next_value = Math.max(balance, 0);
		if (Number(controls.qty_balanced.get_value() || 0) !== next_value) {
			controls.qty_balanced.set_value(next_value);
		}
		if (notify && balance < 0) {
			const item_code = controls.item_code && controls.item_code.get_value() || __("row");
			frappe.msgprint(__("Purchase Qty cannot be greater than Qty for {0}.", [item_code]));
		}
	}

	refresh_all_indent_balances() {
		if (!this.form_data || this.form_data.key !== "dux_indent_master") return;
		(this.table_controls.items || []).forEach((controls, row_index) => {
			this.refresh_indent_row_balance("items", row_index);
		});
	}

	async update_indent_item_warehouses_for_company() {
		if (!this.form_data || this.form_data.key !== "dux_indent_master") return;
		const rows = this.table_controls.items || [];
		const item_rows = rows.map((controls, row_index) => ({ controls, row_index }))
			.filter(({ controls }) => controls.item_code && controls.item_code.get_value());
		if (!item_rows.length || this.updating_indent_company_warehouses) return;

		const update_rows = async () => {
			this.updating_indent_company_warehouses = true;
			try {
				await Promise.all(item_rows.map(async ({ controls, row_index }) => {
					const defaults = await this.call("dux_indent_master.portal.get_portal_item_defaults", {
						item_code: controls.item_code.get_value(),
						company: this.form_company_value(),
						warehouse: "",
						...this.indent_item_context("items", row_index),
					});
					if (controls.warehouse) controls.warehouse.set_value(defaults.warehouse || "");
					if (controls.stock_qty) controls.stock_qty.set_value(defaults.stock_qty || 0);
				}));
			} finally {
				this.updating_indent_company_warehouses = false;
			}
		};

		const has_existing_warehouses = item_rows.some(({ controls }) =>
			controls.warehouse && controls.warehouse.get_value()
		);
		if (!this.form_data.is_new && has_existing_warehouses) {
			await new Promise((resolve) => frappe.confirm(
				__("Company changed. Do you want to update warehouses in all item rows according to the selected company?"),
				async () => { await update_rows(); resolve(); },
				resolve
			));
			return;
		}
		await update_rows();
	}

	recent_table(rows) {
		if (!rows.length) return this.empty_state(__("No recent activity"), __("New activity will appear here."));
		return `<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr><th>${__("Document")}</th><th>${__("Reference")}</th><th>${__("Date")}</th><th>${__("Status")}</th></tr></thead><tbody>${rows.map((row) => `
			<tr class="duxp-document-row" data-key="${this.escape(row.key)}" data-name="${this.escape(row.name)}"><td>${this.escape(row.document_type)}</td><td class="duxp-id-cell">${this.escape(row.name)}</td><td>${this.format_date(row.date)}</td><td>${this.status_tag(row.status)}</td></tr>
		`).join("")}</tbody></table></div>`;
	}

	approval_list(rows) {
		if (!rows.length) return this.empty_state(__("No pending approvals"), __("You are all caught up."));
		return `<div class="duxp-approval-list">${rows.map((row) => `
			<button class="duxp-approval-item duxp-approval-row" data-key="${this.escape(row.route_key || "")}" data-doctype="${this.escape(row.doctype)}" data-name="${this.escape(row.name)}">
				<span class="duxp-approval-icon">${this.icon("check", 15)}</span><span><strong>${this.escape(row.name)}</strong><small>${this.escape(row.doctype)} · ${this.format_date(row.modified)}</small></span>${this.status_tag(row.status)}
			</button>
		`).join("")}</div>`;
	}

	change_page(direction) {
		if (!this.current_list) return;
		const page_length = Number(this.current_list.page_length || 20);
		this.state.start = Math.max(0, Number(this.state.start || 0) + direction * page_length);
		if (this.state.view === "report") this.open_report_view(this.state.route_key, false);
		else this.open_document_list(this.state.route_key, true);
	}

	refresh_current() {
		if (this.state.view === "form") this.open_document_form(this.state.route_key, this.state.document_name);
		else if (this.state.view === "detail") this.open_document_detail(this.state.route_key, this.state.document_name);
		else if (this.state.view === "report") this.open_report_view(this.state.route_key, false);
		else if (this.state.route_key === "dashboard") this.open_dashboard();
		else this.open_document_list(this.state.route_key, true);
	}

	set_active(key, label) {
		this.$nav.find(".duxp-nav-item").removeClass("is-active");
		if (key === "dashboard") this.$nav.find(".duxp-dashboard-link").addClass("is-active");
		else {
			this.$nav.find("[data-route-key]").filter((index, element) => {
				return String($(element).data("route-key")) === String(key);
			}).addClass("is-active");
		}
		this.$root.find('[data-role="breadcrumb"]').text(label);
		this.$root.find(".duxp-scroll").scrollTop(0);
	}

	open_native_document(doctype, name) {
		if (!doctype) return;
		frappe.set_route("Form", doctype, name);
	}

	open_document_print(key, name) {
		const format = PORTAL_PRINT_FORMATS[key];
		const item = this.items[key];
		if (!name || !format || !item) return;
		const params = new URLSearchParams({
			doctype: item.doctype,
			name: String(name),
			format,
			no_letterhead: "1",
			_lang: frappe.boot.lang || "en",
		});
		window.open(`/printview?${params.toString()}`, "_blank", "noopener,noreferrer");
	}

	toggle_theme() {
		const current = this.$root.attr("data-dux-theme") || "light";
		const next = current === "dark" ? "light" : "dark";
		this.$root.attr("data-dux-theme", next);
		try {
			localStorage.setItem("dux-procurement-theme", next);
		} catch (error) {
			// Theme still applies for the current session.
		}
	}

	start_clock() {
		const update = () => {
			const now = new Date();
			this.$root.find('[data-role="clock"]').text(
				`${now.toLocaleDateString(undefined, { day: "2-digit", month: "short" })} · ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
			);
		};
		update();
		clearInterval(this.clock_timer);
		this.clock_timer = setInterval(update, 1000);
	}

	show_loading() {
		this.$content.removeClass("duxp-detail-view");
		this.$content.html(`<div class="duxp-loading"><span></span><span></span><span></span><p>${__("Loading live data…")}</p></div>`);
	}

	show_error(error) {
		const message = error && (error.message || error.exc) ? error.message || error.exc : __("Unable to load portal data.");
		this.$content.html(`<div class="duxp-card duxp-error-state">${this.icon("warning", 28)}<h2>${__("Something went wrong")}</h2><p>${this.escape(message)}</p><button class="duxp-btn duxp-btn-primary" data-action="refresh">${__("Try Again")}</button></div>`);
	}

	format_value(value, column) {
		if (value === null || value === undefined || value === "") return '<span class="duxp-muted">—</span>';
		if (["status", "row_status", "docstatus"].includes(column.fieldname)) return this.status_tag(value);
		if (column.fieldname === "disabled") return this.status_tag(Number(value) ? __("Disabled") : __("Active"));
		if (typeof value === "string" && /address/i.test(column.fieldname || "") && /<[^>]+>/.test(value)) {
			return this.format_address_value(value);
		}
		if (column.fieldtype === "Check") return Number(value) ? __("Yes") : __("No");
		if (column.fieldtype === "Date") return this.format_date(value);
		if (column.fieldtype === "Datetime") return this.format_datetime(value);
		if (column.fieldtype === "Currency") return `<span class="duxp-number">${this.escape(format_currency(flt(value), frappe.defaults.get_default("currency") || "INR"))}</span>`;
		if (["Float", "Int", "Percent"].includes(column.fieldtype)) return `<span class="duxp-number">${this.escape(format_number(value))}</span>`;
		if (column.fieldtype === "Attach") {
			const attachment_url = this.safe_attachment_url(value);
			return attachment_url
				? `<a class="duxp-attachment" href="${this.escape(attachment_url)}" target="_blank" rel="noopener">${this.icon("attachment", 13)}${__("Open attachment")}</a>`
				: this.escape(value);
		}
		return this.escape(value);
	}

	format_address_value(value) {
		const normalized = String(value || "")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(?:p|div)>/gi, "\n")
			.replace(/<[^>]+>/g, "");
		const decoder = document.createElement("textarea");
		decoder.innerHTML = normalized;
		return this.escape(decoder.value.trim()).replace(/\r?\n/g, "<br>");
	}

	safe_attachment_url(value) {
		const raw = String(value || "").trim();
		if (raw.startsWith("/files/") || raw.startsWith("/private/files/")) return raw;
		try {
			const url = new URL(raw, window.location.origin);
			return ["http:", "https:"].includes(url.protocol) ? url.href : "";
		} catch (error) {
			return "";
		}
	}

	status_tag(status) {
		const value = String(status || __("Draft"));
		const normalized = value.toLowerCase();
		let tone = "pending";
		if (/(submitted|approved|received|completed|paid|active|reconciled)/.test(normalized)) tone = "success";
		if (/(draft)/.test(normalized)) tone = "draft";
		if (/(cancel|closed|disabled|rejected|overdue|unpaid|shortage)/.test(normalized)) tone = "danger";
		return `<span class="duxp-status duxp-status-${tone}"><i></i>${this.escape(value)}</span>`;
	}

	format_date(value) {
		if (!value) return "—";
		try {
			return this.escape(frappe.datetime.str_to_user(String(value).slice(0, 10)));
		} catch (error) {
			return this.escape(value);
		}
	}

	format_datetime(value) {
		if (!value) return "—";
		try {
			return this.escape(frappe.datetime.str_to_user(value));
		} catch (error) {
			return this.escape(value);
		}
	}

	financial_year() {
		const now = new Date();
		const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
		return `FY ${String(start).slice(-2)}–${String(start + 1).slice(-2)}`;
	}

	card_header(title, meta) {
		return `<div class="duxp-card-header"><h3>${this.escape(title)}</h3><span>${this.escape(meta)}</span></div>`;
	}

	panel_header(index, title, meta) {
		return `<div class="duxp-panel-header"><span>${String(index).padStart(2, "0")}</span><h3>${this.escape(title)}</h3><small>${this.escape(meta || "")}</small></div>`;
	}

	empty_state(title, description) {
		return `<div class="duxp-empty">${this.icon("inbox", 28)}<strong>${this.escape(title)}</strong>${description ? `<span>${this.escape(description)}</span>` : ""}</div>`;
	}

	escape(value) {
		return frappe.utils.escape_html(String(value === null || value === undefined ? "" : value));
	}

	icon(name, size = 16) {
		const icons = {
			dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
			clipboard: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M9 11h6M9 15h6"/>',
			document: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M15 2v5h5M8 13h8M8 17h5"/>',
			receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
			rupee: '<path d="M7 5h10M7 9h10M16 5c0 4-3.5 5-6.5 5L16 19"/>',
			layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
			truck: '<path d="M3 7h11v8H3zM14 9h4l3 3v3h-7"/><circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/>',
			building: '<path d="M5 21V5h10v16M15 9h4v12M9 8h2M9 12h2M9 16h2M3 21h18"/>',
			box: '<path d="m21 8-9-5-9 5 9 5zM3 8v9l9 5 9-5V8M12 13v9"/>',
			settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 3.1a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L5.1 11a7 7 0 0 0 0 2L3 14.5l2 3.4 2.4-1a7 7 0 0 0 1.7 1l.4 3.1h5l.4-3.1a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2.1-1.5c.1-.3.1-.7.1-1z"/>',
			chart: '<path d="M3 3v18h18M7 15l3-4 3 2 4-6"/>',
			search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
			filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
			calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
			plus: '<path d="M12 5v14M5 12h14"/>',
			close: '<path d="M18 6 6 18M6 6l12 12"/>',
			eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
			back: '<path d="M19 12H5m7 7-7-7 7-7"/>',
			forward: '<path d="M5 12h14m-7-7 7 7-7 7"/>',
			external: '<path d="M14 3h7v7M10 14 21 3M18 13v7H4V6h7"/>',
			refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
			moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
			menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
			chevron: '<path d="m9 6 6 6-6 6"/>',
			down: '<path d="m6 9 6 6 6-6"/>',
			check: '<path d="m4 12 5 5L20 6"/>',
			inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 6h13l3 6v6H2v-6z"/>',
			warning: '<path d="M12 3 2 21h20zM12 9v5M12 18h.01"/>',
			attachment: '<path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8L15 5.8"/>',
			comment: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/>',
			mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
			history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
			user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
			workflow: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="19" r="2"/><path d="M8 5h3a5 5 0 0 1 5 5M16 14a5 5 0 0 1-5 5H8"/>',
			download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
			edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>',
			save: '<path d="M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-7h8v7"/>',
			shield: '<path d="M12 3 4 6v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6zM9 12l2 2 4-5"/>',
			trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
			print: '<path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z"/><path d="M17 11h.01"/>',
		};
		return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.document}</svg>`;
	}
}
