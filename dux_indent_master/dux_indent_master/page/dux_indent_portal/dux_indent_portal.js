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
		let saved_company = "";
		try {
			saved_company = localStorage.getItem("dux-procurement-company") || "";
		} catch (error) {
			// Browser storage may be disabled; "All Companies" remains available.
		}
		this.state = {
			route_key: "dashboard",
			start: 0,
			search: "",
			statuses: [],
			approval_types: [],
			from_date: "",
			to_date: "",
			activity_collapsed: false,
			company: saved_company,
		};
		this.items = {};
		this.search_timer = null;
		this.po_attachment_queue = [];
		this.po_attachment_counter = 0;
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
				(group.items || []).forEach((item) => {
					if (item.key === "purchase_receipt") item.label = __("Purchase Register (Receipt)");
					this.items[item.key] = item;
				});
			});
			this.apply_identity();
			this.render_company_filter();
			this.render_brand();
			this.render_navigation();
			this.start_clock();
			const deep_link = this.get_initial_document_link();
			if (deep_link) {
				await this.open_document_detail(deep_link.route_key, deep_link.document_name);
			} else if (this.bootstrap.default_route && this.bootstrap.default_route !== "dashboard") {
				await this.open_document_list(this.bootstrap.default_route);
			} else {
				await this.open_dashboard();
			}
		} catch (error) {
			this.initialized = false;
			this.show_error(error);
		}
	}

	get_initial_document_link() {
		try {
			const params = new URLSearchParams(window.location.search);
			const route_key = String(params.get("route_key") || "").trim();
			const document_name = String(params.get("document_name") || "").trim();
			const item = this.items[route_key];
			if (!route_key || !document_name || !item || item.kind !== "document") return null;
			return { route_key, document_name };
		} catch (error) {
			return null;
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
					<div class="duxp-brand" aria-label="${__("Jain Engineering Work")}" data-role="brand-content">
						<img class="duxp-brand-logo" src="/assets/dux_indent_master/images/jain-engineering-logo.png" alt="${__("Jain Engineering Work")}">
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
						<button class="duxp-icon-btn duxp-logout-btn" data-action="logout" aria-label="${__("Log out")}" title="${__("Log out")}">${this.icon("logout", 15)}</button>
					</div>
				</aside>
				<section class="duxp-main">
					<header class="duxp-topbar">
						<button class="duxp-icon-btn duxp-menu-btn" data-action="open-sidebar" aria-label="${__("Open menu")}">${this.icon("menu", 17)}</button>
						<div class="duxp-breadcrumb"><span>Dux Portal</span>${this.icon("chevron", 12)}<strong data-role="breadcrumb">${__("Dashboard")}</strong></div>
						<div class="duxp-top-actions">
							<div class="duxp-company-filter-group">
								<span class="duxp-company-label">${__("Company")}</span>
								<select class="duxp-company-filter" data-role="company-filter" aria-label="${__("Company")}">
									<option value="">${__("All Companies")}</option>
								</select>
							</div>
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
			if (action === "logout") this.logout();
			if (action === "toggle-activity") this.toggle_activity_panel();
			if (action === "open-linked-document") this.open_document_detail(
				$target.data("key"), $target.data("name")
			);
			if (action === "toggle-form-section") this.toggle_form_section($target);
			if (action === "switch-form-tab") this.switch_form_tab($target);
			if (action === "open-sidebar") this.$root.addClass("duxp-sidebar-open");
			if (action === "close-sidebar") this.$root.removeClass("duxp-sidebar-open");
			if (action === "dashboard") this.open_dashboard();
			if (action === "toggle-status-filter") {
				event.stopPropagation();
				const $filter = $target.closest(".duxp-status-multiselect");
				const should_open = !$filter.hasClass("is-open");
				this.$root.find(".duxp-status-multiselect.is-open").removeClass("is-open");
				$filter.toggleClass("is-open", should_open);
			}
			if (action === "apply-status-filter") {
				event.stopPropagation();
				const $filter = $target.closest(".duxp-status-multiselect");
				this.state.statuses = $filter.find('[data-role="status-filter-option"]:checked')
					.map((index, element) => String(element.value || "")).get().filter(Boolean);
				this.state.start = 0;
				this.open_document_list(this.state.route_key, true);
			}
			if (action === "clear-status-filter") {
				event.stopPropagation();
				this.state.statuses = [];
				this.state.start = 0;
				this.open_document_list(this.state.route_key, true);
			}
			if (action === "toggle-approval-type-filter") {
				event.stopPropagation();
				const $filter = $target.closest(".duxp-approval-type-multiselect");
				const should_open = !$filter.hasClass("is-open");
				this.$root.find(".duxp-status-multiselect.is-open").removeClass("is-open");
				$filter.toggleClass("is-open", should_open);
			}
			if (action === "apply-approval-type-filter") {
				event.stopPropagation();
				const $filter = $target.closest(".duxp-approval-type-multiselect");
				this.state.approval_types = $filter.find('[data-role="approval-type-filter-option"]:checked')
					.map((index, element) => String(element.value || "")).get().filter(Boolean);
				$filter.removeClass("is-open");
				this.filter_dashboard_approvals(this.state.approval_types);
			}
			if (action === "clear-approval-type-filter") {
				event.stopPropagation();
				const $filter = $target.closest(".duxp-approval-type-multiselect");
				$filter.find('[data-role="approval-type-filter-option"]').prop("checked", false);
				this.state.approval_types = [];
				$filter.removeClass("is-open");
				this.filter_dashboard_approvals([]);
			}
			if (action === "new") this.open_document_form($target.data("key"));
			if (action === "back-list") this.open_document_list($target.data("key"));
			if (action === "print-document") this.open_document_print($target.data("key"), $target.data("name"));
			if (action === "download-pdf-external") {
				this.open_document_pdf_external($target.data("key"), $target.data("name"));
			}
			if (action === "edit-form") this.open_document_form($target.data("key"), $target.data("name"));
			if (action === "toggle-create-menu") {
				event.stopPropagation();
				this.toggle_dropdown($target.closest(".duxp-dropdown"));
			}
			if (action === "create-mapped-document") {
				this.$root.find(".duxp-dropdown.is-open").removeClass("is-open");
				if ($target.data("target-key") === "purchase_receipt"
					&& $target.data("source-key") === "purchase_order") {
					this.open_purchase_register_receipt($target.data("source-name"));
				} else {
					this.open_mapped_document_form(
						$target.data("target-key"), $target.data("source-key"), $target.data("source-name")
					);
				}
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
			if (action === "add-po-charge") this.add_purchase_charge();
			if (action === "edit-po-charge") this.add_purchase_charge(Number($target.data("index")));
			if (action === "remove-po-charge") this.remove_purchase_charge(Number($target.data("index")));
			if (action === "remove-form-row") this.remove_form_row($target.data("table"), Number($target.data("index")));
			if (action === "remove-po-attachment") this.remove_purchase_order_attachment(String($target.data("attachment-id") || ""));
			if (action === "save-form") this.save_portal_form(false);
			if (action === "submit-form") this.confirm_submit_form();
			if (action === "submit-detail") this.confirm_submit_detail(
				$target.data("key"), $target.data("name")
			);
			if (action === "open-native") this.open_native_document($target.data("doctype"), $target.data("name"));
			if (action === "previous") this.change_page(-1);
			if (action === "next") this.change_page(1);
			if (action === "run-report") this.run_report_filters();
			if (action === "view-child-table-detail") this.show_child_table_detail(Number($target.data("table-index")));
		});

		this.$root.on("change", '[data-role="po-attachment-input"]', (event) => {
			this.queue_purchase_order_attachments(event.currentTarget.files);
			event.currentTarget.value = "";
		});

		this.$root.on("click", "[data-route-key]", (event) => {
			event.preventDefault();
			const route_key = $(event.currentTarget).data("route-key");
			if (route_key === "purchase_receipt") {
				this.open_purchase_register_receipt();
				return;
			}
			this.navigate(route_key);
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
			const cursor_position = event.currentTarget.selectionStart;
			this.search_timer = setTimeout(async () => {
				this.state.search = value;
				this.state.start = 0;
				await this.open_document_list(this.state.route_key, true);
				// open_document_list() re-renders the whole list, which replaces
				// this <input> with a fresh element and drops focus -- restore it
				// (and the caret position) so search-as-you-type doesn't force the
				// user to click back into the box after every pause.
				const $input = this.$root.find('[data-role="list-search"]');
				if ($input.length) {
					$input[0].focus();
					const pos = Math.min(cursor_position, $input.val().length);
					$input[0].setSelectionRange(pos, pos);
				}
			}, 350);
		});

		this.$root.on("change", '[data-role="from-date"], [data-role="to-date"]', () => {
			this.state.from_date = this.$root.find('[data-role="from-date"]').val() || "";
			this.state.to_date = this.$root.find('[data-role="to-date"]').val() || "";
			this.state.start = 0;
			this.open_document_list(this.state.route_key, true);
		});

		this.$root.on("change", '[data-role="company-filter"]', (event) => {
			this.state.start = 0;
			this.on_company_change(event.currentTarget.value);
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
			if (!$(event.target).closest(".duxp-status-multiselect").length) {
				this.$root.find(".duxp-status-multiselect.is-open").removeClass("is-open");
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

	render_company_filter() {
		const companies = this.bootstrap.companies || [];
		const $select = this.$root.find('[data-role="company-filter"]');
		if (!companies.length) {
			$select.closest(".duxp-company-filter-group").hide();
			return;
		}
		const options = [`<option value="">${__("All Companies")}</option>`].concat(
			companies.map((name) => `<option value="${this.escape(name)}">${this.escape(name)}</option>`)
		);
		$select.html(options.join(""));
		$select.val(this.state.company || "");
	}

	render_brand() {
		const primary_company = "Jain Engineering Works (India) Private Limited";
		const selected = this.state.company;
		const $brand = this.$root.find('[data-role="brand-content"]');
		if (!selected || selected === primary_company) {
			$brand.html(
				`<img class="duxp-brand-logo" src="/assets/dux_indent_master/images/jain-engineering-logo.png" alt="${__("Jain Engineering Work")}">`
			);
		} else {
			$brand.html(`<div class="duxp-brand-name">${this.escape(selected)}</div>`);
		}
	}

	on_company_change(value) {
		this.state.company = value || "";
		try {
			localStorage.setItem("dux-procurement-company", this.state.company);
		} catch (error) {
			// Browser storage may be disabled; filter still applies for this session.
		}
		this.render_brand();
		if (this.state.view === "dashboard") this.open_dashboard();
		else if (this.state.view === "list") this.open_document_list(this.state.route_key, true);
	}

	render_navigation() {
		const dashboard_link = this.bootstrap.restricted_indent_access ? "" : `
			<a href="#" class="duxp-nav-item is-active duxp-dashboard-link" data-action="dashboard" data-label="dashboard">
				${this.icon("dashboard", 16)}<span>${__("Dashboard")}</span>
			</a>
		`;
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
			${dashboard_link}
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

	open_purchase_register_receipt(purchase_order = "") {
		const params = new URLSearchParams({ view: "new" });
		if (purchase_order) params.set("purchase_order", String(purchase_order));
		window.location.assign("/desk/purchase-register-app?" + params.toString());
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
				return `<td class="${numeric ? "duxp-report-number-cell" : ""}">${this.format_report_value(row[column.fieldname], column, row)}</td>`;
			}).join("")}</tr>
		`).join("");
		const start = Number(data.start || 0);
		const end = Math.min(start + (data.rows || []).length, Number(data.total || 0));
		const can_previous = start > 0;
		const can_next = end < Number(data.total || 0);
		const range_label = `${data.total ? start + 1 : 0}–${end}`;

		this.$content
			.addClass("duxp-report-view")
			.removeClass("duxp-detail-view duxp-form-view duxp-list-view");
		this.$content.closest(".duxp-scroll")
			.addClass("duxp-report-scroll-shell")
			.removeClass("duxp-list-scroll-shell");

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
			const data = await this.call("dux_indent_master.portal.get_dashboard", {
				company: this.state.company,
			});
			const user = this.bootstrap.user || {};
			const hour = new Date().getHours();
			const greeting = hour < 12 ? __("morning") : hour < 17 ? __("afternoon") : __("evening");
			const approvals = data.approvals || [];
			this.dashboard_approvals = approvals;
			const approval_type_options = [
				{ doctype: "Material Request", label: __("Material Request") },
				{ doctype: "Purchase Order", label: __("Purchase Order (PO)") },
				{ doctype: "Purchase Receipt", label: __("Purchase Receipt (PR)") },
				{ doctype: "Purchase Invoice", label: __("Purchase Invoice (PI)") },
			];
			const selected_approval_types = Array.isArray(this.state.approval_types)
				? this.state.approval_types
				: [];
			const selected_approval_type_labels = approval_type_options
				.filter((option) => selected_approval_types.includes(option.doctype))
				.map((option) => option.label);
			const approval_type_summary = selected_approval_types.length === 0 ? __("All Types")
				: selected_approval_types.length === 1 ? selected_approval_type_labels[0]
				: `${selected_approval_types.length} ${__("selected")}`;
			const filtered_approvals = selected_approval_types.length
				? approvals.filter((row) => selected_approval_types.includes(row.doctype))
				: approvals;
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
					<div class="duxp-card duxp-recent-activity-card">
						${this.card_header(__("Recent Activity"), __("latest documents"))}
						${this.recent_table(data.recent || [])}
					</div>
					<div class="duxp-card duxp-pending-approvals-card">
						<div class="duxp-card-header">
							<h3>${this.escape(__("Pending Approvals"))}</h3>
							<span data-pending-approval-count>${filtered_approvals.length} ${this.escape(__("awaiting action"))}</span>
						</div>
						<div class="duxp-approval-filter-bar">
							<label>${this.escape(__("Pendency Type"))}</label>
							<div class="duxp-status-multiselect duxp-approval-type-multiselect">
								<button type="button" class="duxp-status-filter-trigger" data-action="toggle-approval-type-filter" title="${this.escape(selected_approval_type_labels.join(", ") || __("All Types"))}" aria-haspopup="true">
									${this.icon("filter", 13)}<span data-approval-type-summary>${this.escape(approval_type_summary)}</span>${this.icon("chevron", 12)}
								</button>
								<div class="duxp-status-filter-menu">
									<div class="duxp-status-filter-head">
										<strong>${this.escape(__("Select Pendency Types"))}</strong>
										<button type="button" data-action="clear-approval-type-filter">${this.escape(__("Show All"))}</button>
									</div>
									<div class="duxp-status-filter-options">
										${approval_type_options.map((option) => `<label class="duxp-status-filter-option">
											<input type="checkbox" data-role="approval-type-filter-option" value="${this.escape(option.doctype)}" ${selected_approval_types.includes(option.doctype) ? "checked" : ""}>
											<span>${this.escape(option.label)}</span>
										</label>`).join("")}
									</div>
									<button type="button" class="duxp-status-filter-apply" data-action="apply-approval-type-filter">${this.escape(__("Apply Filter"))}</button>
								</div>
							</div>
						</div>
						<div class="duxp-approval-list-host" data-pending-approval-list>
							${this.approval_list(filtered_approvals)}
						</div>
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
			this.state.statuses = [];
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
				status: this.state.statuses,
				from_date: this.state.from_date,
				to_date: this.state.to_date,
				start: this.state.start,
				page_length: this.bootstrap.page_length || 20,
				company: this.state.company,
			});
			this.current_list = data;
			this.render_document_list(data);
		} catch (error) {
			this.show_error(error);
		}
	}

	render_document_list(data) {
		const status_options = data.status_options || [];
		const selected_statuses = Array.isArray(this.state.statuses) ? this.state.statuses : [];
		const status_summary = selected_statuses.length === 0 ? __("All Statuses")
			: selected_statuses.length === 1 ? selected_statuses[0]
			: `${selected_statuses.length} ${__("selected")}`;
		const rows = (data.rows || []).map((row) => `
			<tr class="duxp-document-row" data-key="${this.escape(data.key)}" data-name="${this.escape(row.name)}">
				${(data.columns || []).map((column, index) => `<td class="${index === 0 ? "duxp-id-cell" : ""}">${this.format_value(row[column.fieldname], column, row)}</td>`).join("")}
			</tr>
		`).join("");
		const start = Number(data.start || 0);
		const end = Math.min(start + (data.rows || []).length, Number(data.total || 0));
		const can_previous = start > 0;
		const can_next = end < Number(data.total || 0);

		this.$content.addClass("duxp-list-view").removeClass("duxp-detail-view duxp-form-view");
		this.$content.closest(".duxp-scroll").addClass("duxp-list-scroll-shell");
		this.$content.html(`
			<section class="duxp-page-head">
				<div><h1>${this.escape(data.label)}</h1><p>${this.escape(data.description)}</p></div>
				<div class="duxp-head-actions">
					${data.can_create ? `<button class="duxp-btn duxp-btn-primary" data-action="new" data-key="${this.escape(data.key)}">${this.icon("plus", 14)}${__("New")} ${this.escape(data.label)}</button>` : ""}
				</div>
			</section>
			<section class="duxp-card duxp-document-list-card">
				<div class="duxp-filter-bar">
					<label class="duxp-search-field">${this.icon("search", 14)}<input data-role="list-search" value="${this.escape(this.state.search)}" placeholder="${__("Search")} ${this.escape(data.label)}…"></label>
					<div class="duxp-status-multiselect">
						<button type="button" class="duxp-status-filter-trigger" data-action="toggle-status-filter" title="${this.escape(selected_statuses.join(", ") || __("All Statuses"))}" aria-haspopup="true">
							${this.icon("filter", 13)}<span>${this.escape(status_summary)}</span>${this.icon("chevron", 12)}
						</button>
						<div class="duxp-status-filter-menu">
							<div class="duxp-status-filter-head">
								<strong>${__("Select Statuses")}</strong>
								<button type="button" data-action="clear-status-filter">${__("Clear")}</button>
							</div>
							<div class="duxp-status-filter-options">
								${status_options.map((option) => `<label class="duxp-status-filter-option">
									<input type="checkbox" data-role="status-filter-option" value="${this.escape(option)}" ${selected_statuses.includes(option) ? "checked" : ""}>
									<span>${this.escape(option)}</span>
								</label>`).join("")}
							</div>
							<button type="button" class="duxp-status-filter-apply" data-action="apply-status-filter">${__("Apply Filter")}</button>
						</div>
					</div>
					<label class="duxp-filter-select">${this.icon("calendar", 13)}<input type="date" data-role="from-date" value="${this.escape(this.state.from_date)}" title="${__("From Date")}"></label>
					<label class="duxp-filter-select">${this.icon("calendar", 13)}<input type="date" data-role="to-date" value="${this.escape(this.state.to_date)}" title="${__("To Date")}"></label>
				</div>
				<div class="duxp-table-wrap duxp-document-list-table-wrap"><table class="duxp-table"><thead><tr>${(data.columns || []).map((column) => `<th>${this.escape(column.label)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${(data.columns || []).length}">${this.empty_state(__("No documents found"), __("Try changing the search or filters."))}</td></tr>`}</tbody></table></div>
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
		const display_child_tables = (data.child_tables || []).map((table) => {
			if (data.key !== "purchase_order" || table.fieldname !== "taxes") return table;
			const source_rows = table.rows || [];
			const groups = this.get_purchase_charge_groups(source_rows);
			if (!groups.length) return table;
			const hidden_indices = new Set(groups.flatMap((group) => group.indices));
			const hidden_row_names = new Set(
				[...hidden_indices]
					.map((index) => (source_rows[index] || {})._row_name)
					.filter(Boolean)
			);
			const detail_rows = table.detail_rows || [];
			return {
				...table,
				rows: source_rows.filter((row, index) => !hidden_indices.has(index)),
				detail_rows: detail_rows.length === source_rows.length
					? detail_rows.filter((row, index) => !hidden_indices.has(index))
					: detail_rows.filter((row) => !hidden_row_names.has(row._row_name)),
				_purchase_charge_groups: groups.map((group) => ({
					charge: source_rows[group.base_index] || {},
					tax_rows: group.tax_indices.map((index) => source_rows[index] || {}),
				})),
			};
		});
		this.detail_data = { ...data, child_tables: display_child_tables };
		const fields = (data.fields || []).map((field) => {
			const is_rich_text = field.fieldtype === "Text Editor"
				&& !/address/i.test(field.fieldname || "");
			const formatted_value = this.format_value(field.value, field, data);
			return `<div class="duxp-detail-field ${is_rich_text ? "duxp-detail-field-richtext" : ""}">
				<span>${this.escape(field.label)}</span>
				${is_rich_text ? `<div class="duxp-detail-rich-value">${formatted_value}</div>` : `<strong>${formatted_value}</strong>`}
			</div>`;
		}).join("");
		let detail_panel_index = 2;
		const source_activity = data.activity || {};
		const detail_files = data.key === "purchase_order" ? (source_activity.attachments || []) : [];
		const detail_attachments = this.render_document_attachment_previews(detail_files);
		const supplier_addresses = data.key === "supplier"
			? this.render_supplier_addresses(data.addresses, detail_panel_index++)
			: "";
		const tables = display_child_tables.map((table, table_index) => {
			const table_panel_index = detail_panel_index++;
			const selectable = data.key === "dux_indent_master" && table.fieldname === "items"
				&& (data.operational_actions || []).some((action) => action.action === "indent_view_stock");
			const view_all_button = (table.rows || []).length ? `
				<button type="button" class="duxp-btn duxp-btn-secondary duxp-btn-sm" data-action="view-child-table-detail" data-table-index="${table_index}">
					${this.icon("eye", 13)}${__("View all")}
				</button>
			` : "";
			return `
			<section class="duxp-card duxp-detail-panel">
				${this.panel_header(table_panel_index, table.label, `${(table.rows || []).length} ${__("rows")}`, view_all_button)}
				<div class="duxp-table-wrap duxp-child-detail-table-wrap"><table class="duxp-table duxp-child-detail-table"><thead><tr>${selectable ? `<th><input type="checkbox" data-role="indent-stock-all" aria-label="${__("Select all")}"></th>` : ""}<th>#</th>${(table.columns || []).map((column) => `<th>${this.escape(column.label)}</th>`).join("")}</tr></thead><tbody>
					${(table.rows || []).map((row, index) => `<tr>${selectable ? `<td><input type="checkbox" data-role="indent-stock-row" value="${this.escape(row._row_name || "")}"></td>` : ""}<td class="duxp-index">${index + 1}</td>${table.columns.map((column) => `<td>${this.format_child_table_value(data, table, row, column)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${(table.columns || []).length + 1 + (selectable ? 1 : 0)}">${this.empty_state(__("No rows"), "")}</td></tr>`}
				</tbody>${this.render_child_table_totals_row(table, selectable)}</table></div>
			</section>
			${table._purchase_charge_groups
				? this.render_purchase_order_detail_charges(table._purchase_charge_groups, detail_panel_index++)
				: ""}
		`; }).join("");

		const DROPDOWN_OPERATIONAL_ACTIONS = ["indent_material_purchase", "indent_delivery_challan", "mr_delivery_challan"];
		const dropdown_operational_actions = (data.operational_actions || [])
			.filter((action) => DROPDOWN_OPERATIONAL_ACTIONS.includes(action.action));
		(data.create_actions || []).forEach((action) => {
			if (data.key === "purchase_order" && action.target_route_key === "purchase_receipt") {
				action.label = __("Purchase Register (Receipt)");
			}
		});
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
		const download_pdf_button = data.key === "purchase_order" ? `<button class="duxp-btn duxp-btn-secondary"
			data-action="download-pdf-external" data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}">
			${this.icon("download", 14)}${__("Download PDF")}</button>` : "";
		const submit_button = data.can_submit ? `<button class="duxp-btn duxp-btn-primary" data-action="submit-detail"
			data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}"
			data-workflow-action="${this.escape(data.submit_action || "")}">
			${this.icon("check", 14)}${this.escape(data.submit_label || __("Save & Submit"))}</button>` : "";
		const activity_data = data.key === "purchase_order" ? {
			...source_activity,
			attachments: [],
			attachment_logs: [],
		} : source_activity;
		const activity = this.render_activity_panel(activity_data, data);
		const linked_documents = this.render_linked_documents(data.linked_documents || {});

		this.$content.html(`
			<section class="duxp-page-head">
				<div><span class="duxp-eyebrow">${this.escape(data.label)} · <em>${this.escape(data.name)}</em></span><h1>${this.escape(data.name)}</h1><div class="duxp-status-line">${this.status_tag(data.status)}</div></div>
				<div class="duxp-head-actions">
					<button class="duxp-btn duxp-btn-secondary" data-action="back-list" data-key="${this.escape(data.key)}">${this.icon("back", 14)}${__("Back to List")}</button>
					${print_button}
					${download_pdf_button}
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
						${detail_attachments}
					</section>
					${supplier_addresses}
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

	render_supplier_addresses(addresses = [], panel_index = 2) {
		const cards = addresses.map((address) => {
			const locality = [address.city, address.state, address.pincode].filter(Boolean).join(", ");
			const address_lines = [
				address.address_line1,
				address.address_line2,
				locality,
				address.country,
			].filter(Boolean);
			const badges = [
				address.is_primary_address ? `<span class="duxp-address-badge is-primary">${__("Primary")}</span>` : "",
				address.is_shipping_address ? `<span class="duxp-address-badge">${__("Shipping")}</span>` : "",
			].join("");
			const contact_rows = [
				address.phone ? `<div><span>${__("Phone")}</span><strong>${this.escape(address.phone)}</strong></div>` : "",
				address.email_id ? `<div><span>${__("Email")}</span><strong>${this.escape(address.email_id)}</strong></div>` : "",
				address.gstin ? `<div><span>${__("GSTIN")}</span><strong>${this.escape(address.gstin)}</strong></div>` : "",
			].join("");
			return `
				<article class="duxp-supplier-address-card">
					<div class="duxp-supplier-address-head">
						<div>
							<strong>${this.escape(address.address_title || address.name || __("Address"))}</strong>
							<span>${this.escape(address.address_type || __("Address"))}</span>
						</div>
						<div class="duxp-address-badges">${badges}</div>
					</div>
					<div class="duxp-supplier-address-lines">
						${address_lines.length
							? address_lines.map((line) => `<span>${this.escape(line)}</span>`).join("")
							: `<span class="is-muted">${__("Address details not available")}</span>`}
					</div>
					${contact_rows ? `<div class="duxp-supplier-address-meta">${contact_rows}</div>` : ""}
				</article>
			`;
		}).join("");
		const content = cards || `
			<div class="duxp-supplier-address-empty">
				<strong>${__("No linked address")}</strong>
				<span>${__("No Address record is linked to this Supplier in ERPNext.")}</span>
			</div>`;
		const count_label = addresses.length === 1 ? __("address") : __("addresses");
		return `
			<section class="duxp-card duxp-detail-panel">
				${this.panel_header(panel_index, __("Supplier Addresses"), `${addresses.length} ${count_label}`)}
				<div class="duxp-supplier-address-grid">${content}</div>
			</section>
		`;
	}

	render_document_attachment_previews(files = [], options = {}) {
		const links = files.map((file) => {
			const url = this.safe_attachment_url(file.file_url);
			if (!url) return "";
			const file_name = file.file_name || this.attachment_file_name(file.file_url) || __("Attachment");
			const is_image = this.is_image_attachment(file.file_url || file_name);
			const media = is_image
				? `<img src="${this.escape(url)}" alt="${this.escape(file_name)}" loading="lazy">`
				: this.icon("attachment", 20);
			return `<a class="duxp-document-attachment-preview ${is_image ? "is-image" : "is-file"}" href="${this.escape(url)}" target="_blank"
				rel="noopener noreferrer" title="${this.escape(file_name)}">
				<span class="duxp-document-attachment-media">${media}</span>
				<span class="duxp-document-attachment-copy"><strong>${this.escape(file_name)}</strong><small>${__("Open in new tab")}</small></span>
				${this.icon("external", 12)}
			</a>`;
		}).join("");
		if (!links) return "";
		return `<div class="duxp-document-attachment-block ${options.compact ? "is-compact" : ""}">
			<div class="duxp-document-attachment-heading">
				<strong>${this.escape(options.label || __("Attachments"))}</strong>
				<small>${files.length} ${__("files")}</small>
			</div>
			<div class="duxp-document-attachment-grid">${links}</div>
		</div>`;
	}

	render_purchase_order_detail_charges(groups = [], panel_index) {
		if (!groups.length) return "";
		const currency_field = ((this.detail_data || {}).fields || [])
			.find((field) => field.fieldname === "currency");
		const currency = (currency_field && currency_field.value)
			|| frappe.defaults.get_default("currency") || "INR";
		const money = (value) => format_currency(flt(value), currency);
		const cards = groups.map((group) => {
			const charge = group.charge || {};
			const tax_rows = group.tax_rows || [];
			const charge_amount = flt(charge.tax_amount);
			const gst_amount = tax_rows.reduce(
				(total, row) => total + flt(charge_amount * flt(row.rate) / 100, 2), 0
			);
			const gst_summary = tax_rows.length
				? tax_rows.map((row) => `${this.purchase_charge_tax_kind(row)} ${flt(row.rate)}%`).join(" + ")
				: __("No GST");
			return `<article class="duxp-po-charge-card">
				<div class="duxp-po-charge-main">
					<span class="duxp-po-charge-label">${this.escape(charge.description || charge.account_head || __("Additional Charge"))}</span>
					<small>${this.escape(charge.account_head || "")}</small>
				</div>
				<div class="duxp-po-charge-value"><span>${__("Charge Amount")}</span><strong>${this.escape(money(charge_amount))}</strong></div>
				<div class="duxp-po-charge-value"><span>${__("GST")}</span><strong>${this.escape(gst_summary)}</strong></div>
				<div class="duxp-po-charge-value"><span>${__("GST Amount")}</span><strong>${this.escape(money(gst_amount))}</strong></div>
				<div class="duxp-po-charge-value duxp-po-charge-total"><span>${__("Total")}</span><strong>${this.escape(money(charge_amount + gst_amount))}</strong></div>
			</article>`;
		}).join("");
		return `<section class="duxp-card duxp-detail-panel duxp-po-additional-charges">
			${this.panel_header(panel_index, __("Additional Charges"), `${groups.length} ${__("charges")}`)}
			<div class="duxp-po-charge-list">${cards}</div>
		</section>`;
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

	render_child_table_totals_row(table, selectable) {
		const totals = table.totals || {};
		if (!Object.keys(totals).length) return "";
		const cells = (table.columns || []).map((column) => {
			if (!(column.fieldname in totals)) return "<td></td>";
			return `<td>${this.format_value(totals[column.fieldname], column)}</td>`;
		}).join("");
		return `<tfoot><tr class="duxp-child-detail-totals-row">${selectable ? "<td></td>" : ""}<td class="duxp-index">${this.escape(__("Total"))}</td>${cells}</tr></tfoot>`;
	}

	show_child_table_detail(table_index) {
		const data = this.detail_data;
		const table = data && (data.child_tables || [])[table_index];
		if (!table) return;
		const columns = table.detail_columns && table.detail_columns.length ? table.detail_columns : (table.columns || []);
		const rows = table.detail_rows && table.detail_rows.length ? table.detail_rows : (table.rows || []);
		const cards = rows.map((row) => `
			<div class="duxp-card" style="margin-bottom:12px;">
				<table class="duxp-child-detail-item-table">
					<tbody>
						${columns.map((column) => `
							<tr><th>${this.escape(column.label)}</th><td>${this.format_child_table_value(data, table, row, column)}</td></tr>
						`).join("")}
					</tbody>
				</table>
			</div>
		`).join("") || this.empty_state(__("No rows"), "");
		const dialog = new frappe.ui.Dialog({
			title: table.label,
			size: "large",
			fields: [{
				fieldname: "child_rows_html",
				fieldtype: "HTML",
				options: `<div class="duxp-child-detail-dialog">${cards}</div>`,
			}],
		});
		dialog.show();
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

	async open_created_draft(key, name) {
		const document_name = String(name || "").trim();
		if (!document_name) {
			throw new Error(__("The created draft document was not returned."));
		}
		await this.open_document_form(key, document_name);
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
		if (key === "purchase_order" && workflow_action === "Reject") {
			frappe.prompt([
				{ fieldname: "remark", label: __("Rejection Remark"), fieldtype: "Small Text", reqd: 1 },
			], (values) => this.execute_workflow_action(key, name, workflow_action, values.remark),
			__("Reject Purchase Order"), __("Reject"));
			return;
		}
		frappe.confirm(
			__("Apply workflow action {0} to {1}?", [workflow_action, name]),
			() => this.execute_workflow_action(key, name, workflow_action)
		);
	}

	async execute_workflow_action(key, name, workflow_action, remark = null) {
		if (this.workflow_updating) return;
		this.workflow_updating = true;
		this.$content.find('[data-action="run-workflow"]').prop("disabled", true);
		try {
			const result = await this.call("dux_indent_master.portal.apply_portal_workflow_action", {
				route_key: key,
				name,
				action: workflow_action,
				remark: remark || undefined,
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
		if (action === "mr_delivery_challan") return this.create_mr_delivery_challan(name);
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
					await this.open_created_draft("material_request", result.material_request);
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
				fields: [
					{
						fieldname: "company",
						fieldtype: "Link",
						options: "Company",
						label: __("Company"),
						reqd: 1,
						default: data.company || frappe.defaults.get_default("company") || undefined,
						onchange: () => dialog.set_value("warehouse", ""),
					},
					{
						fieldname: "warehouse",
						fieldtype: "Link",
						options: "Warehouse",
						label: __("Warehouse"),
						reqd: 1,
						description: __("Only non-transit warehouses that stock the selected item(s) are shown. Stock sufficiency is checked when you click Create."),
						get_query: () => {
							const selected_items = [];
							dialog.$wrapper.find("tr[data-row-name]").each((index, element) => {
								const qty = Number($(element).find(".duxp-indent-delivery-qty").val() || 0);
								if (qty > 0) selected_items.push({ item_row: $(element).data("row-name"), qty });
							});
							return {
								query: "dux_indent_master.portal.get_indent_delivery_source_warehouse_options",
								filters: {
									company: dialog.get_value("company") || "",
									indent_name: name,
									selected_items: JSON.stringify(selected_items),
								},
							};
						},
					},
					{
						fieldname: "items_html",
						fieldtype: "HTML",
						options: `<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr><th>${__("Item Name")}</th><th>${__("Indent Qty")}</th></tr></thead><tbody>${rows}</tbody></table></div>`,
					},
				],
				primary_action_label: __("Create Delivery Challan"),
				primary_action: async () => {
					const company = dialog.get_value("company");
					if (!company) return frappe.msgprint(__("Select a Company."));
					const warehouse = dialog.get_value("warehouse");
					if (!warehouse) return frappe.msgprint(__("Select a Warehouse."));
					const selected = [];
					let invalid_quantity = false;
					dialog.$wrapper.find("tr[data-row-name]").each((index, element) => {
						const qty = Number($(element).find(".duxp-indent-delivery-qty").val() || 0);
						const max_qty = Number($(element).data("max-qty") || 0);
						if (qty < 0 || qty > max_qty) invalid_quantity = true;
						if (qty > 0) selected.push({ item_row: $(element).data("row-name"), qty });
					});
					if (invalid_quantity) {
						return frappe.msgprint(__("Indent Qty cannot exceed the indent quantity."));
					}
					if (!selected.length) return frappe.msgprint(__("Enter Indent Qty for at least one item."));
					dialog.get_primary_btn().prop("disabled", true);
					try {
						const result = await this.call("dux_indent_master.portal.create_delivery_challan_from_portal_indent", {
							name, selected_items: JSON.stringify(selected), company, warehouse,
						});
						const document_name = result.name || result.delivery_challan;
						if (!document_name) throw new Error(__("Delivery Challan was not returned."));
						dialog.hide();
						await this.open_created_draft("delivery_challan", document_name);
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

	async create_mr_delivery_challan(name) {
		try {
			const data = await this.call("dux_indent_master.portal.get_material_request_delivery_action_data", { name });
			const balance_items = (data.items || []).filter((row) => Number(row.balance_qty || 0) > 0);
			if (!balance_items.length) return frappe.msgprint(__("No delivery balance quantity is available."));
			const rows = balance_items.map((row) => `<tr data-row-name="${this.escape(row.row_name)}" data-max-qty="${this.escape(row.max_qty)}">
				<td>${this.escape(row.item_name)}</td>
				<td><input class="form-control duxp-mr-delivery-qty" type="number" min="0" max="${this.escape(row.max_qty)}" step="any" value="${this.escape(row.max_qty)}"></td>
			</tr>`).join("");
			const dialog = new frappe.ui.Dialog({
				title: __("Create Delivery Challan"),
				fields: [
					{
						fieldname: "company",
						fieldtype: "Link",
						options: "Company",
						label: __("Company"),
						reqd: 1,
						default: data.company || frappe.defaults.get_default("company") || undefined,
						onchange: () => dialog.set_value("warehouse", ""),
					},
					{
						fieldname: "warehouse",
						fieldtype: "Link",
						options: "Warehouse",
						label: __("Warehouse"),
						reqd: 1,
						description: __("Only non-transit warehouses that stock the selected item(s) are shown. Stock sufficiency is checked when you click Create."),
						get_query: () => {
							const selected_items = [];
							dialog.$wrapper.find("tr[data-row-name]").each((index, element) => {
								const qty = Number($(element).find(".duxp-mr-delivery-qty").val() || 0);
								if (qty > 0) selected_items.push({ item_row: $(element).data("row-name"), qty });
							});
							return {
								query: "dux_indent_master.portal.get_material_request_delivery_source_warehouse_options",
								filters: {
									company: dialog.get_value("company") || "",
									material_request_name: name,
									selected_items: JSON.stringify(selected_items),
								},
							};
						},
					},
					{
						fieldname: "items_html",
						fieldtype: "HTML",
						options: `<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr><th>${__("Item Name")}</th><th>${__("Requested Qty")}</th></tr></thead><tbody>${rows}</tbody></table></div>`,
					},
				],
				primary_action_label: __("Create Delivery Challan"),
				primary_action: async () => {
					const company = dialog.get_value("company");
					if (!company) return frappe.msgprint(__("Select a Company."));
					const warehouse = dialog.get_value("warehouse");
					if (!warehouse) return frappe.msgprint(__("Select a Warehouse."));
					const selected = [];
					let invalid_quantity = false;
					dialog.$wrapper.find("tr[data-row-name]").each((index, element) => {
						const qty = Number($(element).find(".duxp-mr-delivery-qty").val() || 0);
						const max_qty = Number($(element).data("max-qty") || 0);
						if (qty < 0 || qty > max_qty) invalid_quantity = true;
						if (qty > 0) selected.push({ item_row: $(element).data("row-name"), qty });
					});
					if (invalid_quantity) {
						return frappe.msgprint(__("Requested Qty cannot exceed the Material Request quantity."));
					}
					if (!selected.length) return frappe.msgprint(__("Enter Requested Qty for at least one item."));
					dialog.get_primary_btn().prop("disabled", true);
					try {
						const result = await this.call("dux_indent_master.portal.create_delivery_challan_from_portal_material_request", {
							name, selected_items: JSON.stringify(selected), company, warehouse,
						});
						const document_name = result.name || result.delivery_challan;
						if (!document_name) throw new Error(__("Delivery Challan was not returned."));
						dialog.hide();
						await this.open_created_draft("delivery_challan", document_name);
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
			const body = (rows || []).map((row) =>
				`<tr><td>${this.escape(row.item_code)}</td><td>${this.escape(row.warehouse || "-")}${row.is_transit ? ` <span class="text-muted">(${this.escape(__("In Transit"))})</span>` : ""}</td><td>${this.escape(format_number(row.actual_qty))}</td></tr>`
			).join("")
				|| `<tr><td colspan="3" class="text-center text-muted">${__("No positive stock is available for the selected rows.")}</td></tr>`;
			const dialog = new frappe.ui.Dialog({
				title: __("Stock by Warehouse"),
				size: "large",
				fields: [{
					fieldname: "stock_html",
					fieldtype: "HTML",
					options: `<table class="table table-bordered" style="margin-bottom:0;"><thead><tr><th>${__("Item")}</th><th>${__("Warehouse")}</th><th>${__("Available Qty")}</th></tr></thead><tbody>${body}</tbody></table>`,
				}],
			});
			dialog.show();
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
		if (data !== this.form_data) {
			this.po_attachment_queue = [];
		}
		this.$content.addClass("duxp-form-view").removeClass("duxp-detail-view");
		this.form_data = data;
		this.form_controls = {};
		this.table_controls = {};
		(data.tables || []).forEach((table) => {
			if (!this.is_mobile_form_table_layout() && table.reqd && !(table.rows || []).length && data.can_save) {
				table.rows = [{}];
			}
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
			const tab_tables = (data.tables || []).filter((table) => (table.tab || "details") === tab.key);
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
		const field_controls = (section.fields || []).map((field) => {
			const control = `<div class="duxp-form-control" data-fieldname="${this.escape(field.fieldname)}"></div>`;
			const attachment_control = field.fieldname === "custom_sap_remarks" ? this.render_purchase_order_attachment_control() : "";
			return `${control}${attachment_control}`;
		}).join("");
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
					${field_controls}
				</div></div>
			</section>
		`;
	}

	render_purchase_order_attachment_control() {
		if (!this.form_data || this.form_data.key !== "purchase_order" || !this.form_data.can_save) return "";
		const existing_attachments = this.render_document_attachment_previews(
			this.form_data.attachments || [],
			{ compact: true, label: __("Existing Attachments") }
		);
		return `<div class="duxp-po-attachment-control">
			<label class="duxp-po-attachment-label">${__("Attachments")}</label>
			${existing_attachments}
			<label class="duxp-po-attachment-picker">
				<input type="file" multiple data-role="po-attachment-input">
				<span class="duxp-po-attachment-icon">${this.icon("attachment", 18)}</span>
				<span><strong>${__("Choose files")}</strong><small>${__("Images, PDF and other file types are supported")}</small></span>
			</label>
			<div class="duxp-po-attachment-summary" data-role="po-attachment-summary"></div>
			<div class="duxp-po-attachment-list" data-role="po-attachment-list">${this.render_purchase_order_attachment_items()}</div>
		</div>`;
	}

	render_purchase_order_attachment_items() {
		const queue = this.po_attachment_queue || [];
		if (!queue.length) return `<span class="duxp-po-attachment-empty">${__("No files selected")}</span>`;
		return queue.map((entry) => `<div class="duxp-po-attachment-item">
			<span class="duxp-po-attachment-file-icon">${this.icon("attachment", 13)}</span>
			<span class="duxp-po-attachment-copy"><strong title="${this.escape(entry.file.name)}">${this.escape(entry.file.name)}</strong><small>${this.escape(this.format_attachment_size(entry.file.size))}</small></span>
			<button type="button" class="duxp-icon-btn duxp-po-attachment-remove" data-action="remove-po-attachment"
				data-attachment-id="${this.escape(entry.id)}" aria-label="${__("Remove file")}" title="${__("Remove file")}">${this.icon("trash", 13)}</button>
		</div>`).join("");
	}

	render_form_table(table, panel_index) {
		const rows = table.rows || [];
		const visible_fields = (table.fields || []).filter((field) => !field.hide_in_form);
		if (this.form_data && this.form_data.key === "purchase_order" && table.fieldname === "taxes") {
			return this.render_purchase_order_tax_sections(table, panel_index, visible_fields);
		}
		return `
			<section class="duxp-card duxp-form-section duxp-form-table-section" data-form-table="${this.escape(table.fieldname)}">
				${this.panel_header(panel_index, table.label, `${rows.length} ${__("rows")}`)}
				<div class="duxp-form-table-wrap">
					<table class="duxp-form-table"><thead><tr><th>#</th>${visible_fields.map((field) => `<th>${this.escape(field.label)}${field.reqd ? '<span class="duxp-required">*</span>' : ""}</th>`).join("")}<th></th></tr></thead>
					<tbody>${rows.map((row, row_index) => `<tr><td class="duxp-index">${row_index + 1}</td>${visible_fields.map((field) => `<td data-label="${this.escape(field.label)}${field.reqd ? " *" : ""}"><div class="duxp-form-control duxp-table-control" data-table="${this.escape(table.fieldname)}" data-index="${row_index}" data-fieldname="${this.escape(field.fieldname)}"></div></td>`).join("")}<td class="duxp-row-remove-cell"><button class="duxp-row-remove" data-action="remove-form-row" data-table="${this.escape(table.fieldname)}" data-index="${row_index}" ${this.form_data.can_save ? "" : "disabled"} aria-label="${__("Remove row")}">${this.icon("trash", 14)}</button></td></tr>`).join("") || `<tr><td colspan="${visible_fields.length + 2}">${this.empty_state(__("No rows"), __("Use Add Row to begin."))}</td></tr>`}</tbody></table>
				</div>
				${this.form_data.can_save ? `<div class="duxp-table-footer"><button class="duxp-btn duxp-btn-secondary" data-action="add-form-row" data-table="${this.escape(table.fieldname)}">${this.icon("plus", 14)}${__("Add Row")}</button></div>` : ""}
			</section>
		`;
	}

	get_purchase_charge_groups(rows = []) {
		const shared_tax_indices = rows.reduce((indices, row, row_index) => {
			if (
				String(row.charge_type || "") === "On Previous Row Total"
				&& this.is_purchase_gst_tax_row(row)
			) indices.push(row_index);
			return indices;
		}, []);
		const shared_reference_index = shared_tax_indices.length
			? Number((rows[shared_tax_indices[0]] || {}).row_id) - 1 : -1;
		const first_shared_tax_index = shared_tax_indices.length
			? Math.min(...shared_tax_indices) : -1;

		return rows.reduce((groups, row, base_index) => {
			if (String(row.charge_type || "") !== "Actual" || this.is_purchase_gst_tax_row(row)) return groups;
			const legacy_tax_indices = rows.reduce((indices, candidate, candidate_index) => {
				if (
					String(candidate.charge_type || "") === "On Previous Row Amount"
					&& this.is_purchase_gst_tax_row(candidate)
					&& Number(candidate.row_id) === base_index + 1
				) indices.push(candidate_index);
				return indices;
			}, []);
			const uses_shared_taxes = !legacy_tax_indices.length
				&& shared_reference_index >= 0
				&& base_index <= shared_reference_index
				&& base_index < first_shared_tax_index;
			const tax_indices = legacy_tax_indices.length
				? legacy_tax_indices : uses_shared_taxes ? shared_tax_indices : [];
			groups.push({
				base_index,
				tax_indices,
				indices: [base_index, ...legacy_tax_indices],
				uses_shared_taxes,
			});
			return groups;
		}, []);
	}

	is_purchase_gst_tax_row(row = {}) {
		return ["CGST", "SGST", "IGST"].includes(this.purchase_charge_tax_kind(row));
	}

	capture_purchase_tax_references(rows = []) {
		const references = new Map();
		rows.forEach((row) => {
			if (!["On Previous Row Amount", "On Previous Row Total"].includes(String(row.charge_type || ""))) return;
			const referenced_row = rows[Number(row.row_id) - 1];
			if (referenced_row) references.set(row, referenced_row);
		});
		return references;
	}

	restore_purchase_tax_references(rows = [], references = new Map()) {
		rows.forEach((row) => {
			if (!references.has(row)) return;
			const reference_index = rows.indexOf(references.get(row));
			row.row_id = reference_index >= 0 ? String(reference_index + 1) : "";
		});
	}

	purchase_charge_tax_kind(row = {}) {
		const searchable = `${row.account_head || ""} ${row.description || ""}`.toLowerCase();
		if (searchable.includes("cgst")) return "CGST";
		if (searchable.includes("sgst")) return "SGST";
		if (searchable.includes("igst")) return "IGST";
		return __("GST");
	}

	format_purchase_charge_currency(value) {
		const currency_field = (this.form_data.sections || [])
			.flatMap((section) => section.fields || [])
			.find((field) => field.fieldname === "currency");
		const currency = (currency_field && currency_field.value)
			|| frappe.defaults.get_default("currency") || "INR";
		return format_currency(flt(value), currency);
	}

	render_purchase_order_tax_sections(table, panel_index, visible_fields) {
		const rows = table.rows || [];
		const groups = this.get_purchase_charge_groups(rows);
		const grouped_indices = new Set(groups.flatMap((group) => group.indices));
		const normal_rows = rows
			.map((row, row_index) => ({ row, row_index }))
			.filter(({ row_index }) => !grouped_indices.has(row_index));
		const normal_row_html = normal_rows.map(({ row_index }) => `<tr>
			<td class="duxp-index">${row_index + 1}</td>
			${visible_fields.map((field) => `<td data-label="${this.escape(field.label)}${field.reqd ? " *" : ""}"><div class="duxp-form-control duxp-table-control" data-table="${this.escape(table.fieldname)}" data-index="${row_index}" data-fieldname="${this.escape(field.fieldname)}"></div></td>`).join("")}
			<td class="duxp-row-remove-cell"><button class="duxp-row-remove" data-action="remove-form-row" data-table="${this.escape(table.fieldname)}" data-index="${row_index}" ${this.form_data.can_save ? "" : "disabled"} aria-label="${__("Remove row")}">${this.icon("trash", 14)}</button></td>
		</tr>`).join("");
		const hidden_controls = [...grouped_indices].sort((a, b) => a - b).map((row_index) =>
			visible_fields.map((field) => `<div class="duxp-form-control duxp-table-control" data-table="${this.escape(table.fieldname)}" data-index="${row_index}" data-fieldname="${this.escape(field.fieldname)}"></div>`).join("")
		).join("");
		const charge_cards = groups.map((group) => {
			const charge = rows[group.base_index] || {};
			const tax_rows = group.tax_indices.map((index) => rows[index] || {});
			const charge_amount = flt(charge.tax_amount);
			const gst_amount = tax_rows.reduce(
				(total, row) => total + flt(charge_amount * flt(row.rate) / 100, 2), 0
			);
			const gst_summary = tax_rows.length
				? tax_rows.map((row) => `${this.purchase_charge_tax_kind(row)} ${flt(row.rate)}%`).join(" + ")
				: __("No GST");
			return `<article class="duxp-po-charge-card" data-po-charge-base-index="${group.base_index}">
				<div class="duxp-po-charge-main">
					<span class="duxp-po-charge-label">${this.escape(charge.description || charge.account_head || __("Additional Charge"))}</span>
					<small>${this.escape(charge.account_head || "")}</small>
				</div>
				<div class="duxp-po-charge-value"><span>${__("Charge Amount")}</span><strong data-po-charge-value="charge">${this.escape(this.format_purchase_charge_currency(charge_amount))}</strong></div>
				<div class="duxp-po-charge-value"><span>${__("GST")}</span><strong>${this.escape(gst_summary)}</strong></div>
				<div class="duxp-po-charge-value"><span>${__("GST Amount")}</span><strong data-po-charge-value="gst">${this.escape(this.format_purchase_charge_currency(gst_amount))}</strong></div>
				<div class="duxp-po-charge-value duxp-po-charge-total"><span>${__("Total")}</span><strong data-po-charge-value="total">${this.escape(this.format_purchase_charge_currency(charge_amount + gst_amount))}</strong></div>
				${this.form_data.can_save ? `<div class="duxp-po-charge-actions">
					<button type="button" class="duxp-icon-btn" data-action="edit-po-charge" data-index="${group.base_index}" aria-label="${__("Edit charge")}" title="${__("Edit charge")}">${this.icon("edit", 14)}</button>
					<button type="button" class="duxp-icon-btn duxp-po-charge-delete" data-action="remove-po-charge" data-index="${group.base_index}" aria-label="${__("Remove charge")}" title="${__("Remove charge")}">${this.icon("trash", 14)}</button>
				</div>` : ""}
			</article>`;
		}).join("");
		return `
			<section class="duxp-card duxp-form-section duxp-form-table-section" data-form-table="${this.escape(table.fieldname)}">
				${this.panel_header(panel_index, table.label, `${normal_rows.length} ${__("tax rows")}`)}
				<div class="duxp-form-table-wrap">
					<table class="duxp-form-table"><thead><tr><th>#</th>${visible_fields.map((field) => `<th>${this.escape(field.label)}${field.reqd ? '<span class="duxp-required">*</span>' : ""}</th>`).join("")}<th></th></tr></thead>
					<tbody>${normal_row_html || `<tr><td colspan="${visible_fields.length + 2}">${this.empty_state(__("No item tax rows"), __("Select a tax template or use Add Row."))}</td></tr>`}</tbody></table>
				</div>
				<div class="duxp-po-charge-hidden-controls" hidden>${hidden_controls}</div>
				${this.form_data.can_save ? `<div class="duxp-table-footer"><button class="duxp-btn duxp-btn-secondary" data-action="add-form-row" data-table="${this.escape(table.fieldname)}">${this.icon("plus", 14)}${__("Add Tax Row")}</button></div>` : ""}
			</section>
			<section class="duxp-card duxp-form-section duxp-po-additional-charges">
				<div class="duxp-panel-header"><span>+</span><h3>${__("Additional Charges")}</h3><small>${groups.length} ${__("charges")}</small></div>
                <div class="duxp-po-charge-list">${charge_cards || this.empty_state(__("No additional charges"), __("Add freight, loading/unloading, labour or another charge with GST."))}</div>
				${this.form_data.can_save ? `<div class="duxp-table-footer"><button class="duxp-btn duxp-btn-secondary" data-action="add-po-charge">${this.icon("plus", 14)}${__("Add Additional Charge")}</button></div>` : ""}
			</section>
		`;
	}

	control_change_signature(value) {
		if (value === null || value === undefined) return "";
		if (typeof value === "object") {
			try {
				return JSON.stringify(value);
			} catch (error) {
				return String(value);
			}
		}
		return String(value);
	}

	bind_control_change(control, callback) {
		if (!control) return;
		control.duxp_last_change_signature = this.control_change_signature(control.get_value());
		control.df.change = () => {
			const value = control.get_value();
			const signature = this.control_change_signature(value);
			if (signature === control.duxp_last_change_signature) return;
			control.duxp_last_change_signature = signature;
			return callback(value);
		};
	}

	mount_form_controls() {
		(this.form_data.sections || []).forEach((section) => {
			(section.fields || []).forEach((field) => {
				const $slot = this.$content.find(`.duxp-form-control[data-fieldname="${field.fieldname}"]`).not(".duxp-table-control").first();
				const control = this.make_form_control($slot, field, field.value, false);
				this.form_controls[field.fieldname] = control;
				if (control && this.form_data.can_save) {
					this.bind_control_change(control, (value) => this.handle_parent_control_change(field.fieldname, value));
				}
				if (control) this.refresh_indent_attachment_preview(field.fieldname);
			});
		});

		(this.form_data.tables || []).forEach((table) => {
			this.table_controls[table.fieldname] = [];
			(table.rows || []).forEach((row, row_index) => {
				const row_controls = {};
				(table.fields || []).filter((field) => !field.hide_in_form).forEach((field) => {
					const $slot = this.$content.find(`.duxp-table-control[data-table="${table.fieldname}"][data-index="${row_index}"][data-fieldname="${field.fieldname}"]`).first();
					const control = this.make_form_control($slot, field, row[field.fieldname], true);
					row_controls[field.fieldname] = control;
					if (control && this.form_data.can_save) {
						this.bind_control_change(control, (value) => this.handle_table_control_change(
							table.fieldname,
							row_index,
							field,
							value
						));
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
		if (
			df.fieldtype === "Link"
			&& df.options === "Site Project"
			&& this.bootstrap.restricted_indent_access
		) {
			df.get_query = () => ({
				query: "dux_indent_master.portal.get_portal_site_options",
			});
		} else if (df.fieldtype === "Link" && df.options === "Purchase Taxes and Charges Template") {
			df.get_query = () => ({
				filters: {
					company: this.form_company_value() || ["in", []],
					disabled: 0,
				},
			});
		} else if (df.fieldtype === "Link" && ["Warehouse", "Account", "Cost Center", "Project", "Town At Project"].includes(df.options)) {
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
		if (["Warehouse", "Account", "Cost Center"].includes(options)) {
			filters.is_group = 0;
			if (company) filters.company = company;
		} else if (options === "Project") {
			if (company) filters.company = company;
		} else if (options === "Town At Project") {
			const site_project_control = this.form_controls["custom_site_project"];
			const site_project_value = site_project_control ? site_project_control.get_value() : "";
			filters.project_name = site_project_value || ["in", []];
			if (company) filters.company_name = company;
		} else if (company) {
			filters.company = company;
		}
		return filters;
	}

	form_company_value() {
		for (const fieldname of ["company", "company_name"]) {
			const control = this.form_controls[fieldname];
			if (control && control.get_value()) return control.get_value();
		}
		return this.state && this.state.company ? this.state.company : "";
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
		// Controls are recreated whenever a child row is added or removed. Frappe's
		// initial set_value can emit an asynchronous change after the handler is
		// attached, so do not treat an already-rendered value as a user selection.
		// This also prevents Company refresh from rendering the form and triggering
		// itself again in a loop.
        if (this.form_data && this.form_data.key === "purchase_order"
            && ["company", "taxes_and_charges", "payment_terms_template"].includes(fieldname)) {
            if (fieldname === "taxes_and_charges" && this.suppress_po_tax_template_reload) return;
			const rendered_field = (this.form_data.sections || [])
				.flatMap((section) => section.fields || [])
				.find((field) => field.fieldname === fieldname);
			if (rendered_field && String(rendered_field.value || "") === String(value || "")) return;
		}
		if (this.form_data && this.form_data.key === "delivery_receipts"
			&& this.form_data.is_new && fieldname === "delivery_challan" && value) {
			if (value === this.receipt_source_challan || value === this.receipt_loading_challan) return;
			await this.open_delivery_challan_receipt(value);
			return;
		}
		if (this.form_data && this.form_data.key === "purchase_receipt"
			&& this.form_data.is_new && fieldname === "purchase_order" && value) {
			await this.open_mapped_document_form("purchase_receipt", "purchase_order", value);
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
        if (this.form_data && this.form_data.key === "purchase_order" && fieldname === "payment_terms_template" && value) {
            await this.apply_purchase_order_payment_terms_template(value);
        }
		if (this.form_data && this.form_data.key === "purchase_order" && fieldname === "tc_name" && value) {
			await this.apply_purchase_order_terms_template(value);
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

	async refresh_purchase_order_company_context(company) {
		if (!this.form_data || this.form_data.key !== "purchase_order") return;
		this.sync_form_data_from_controls();
		const tax_control = this.form_controls.taxes_and_charges;
		const previous_template = tax_control ? tax_control.get_value() : "";
		let defaults = {};
		if (company) {
			try {
				defaults = (await this.call("dux_indent_master.portal.get_purchase_order_company_refresh", {
					company,
					taxes_and_charges: previous_template || undefined,
				})) || {};
			} catch (error) {
				defaults = {};
			}
		}

		const company_link_options = new Set([
			"Warehouse", "Account", "Cost Center", "Project", "Town At Project",
		]);
		(this.form_data.sections || []).forEach((section) => {
			(section.fields || []).forEach((field) => {
				if (field.fieldname === "company") {
					field.value = company || "";
				} else if (field.fieldname === "taxes_and_charges") {
					field.value = defaults.taxes_and_charges || "";
				} else if (field.fieldtype === "Link" && company_link_options.has(field.options)) {
					field.value = "";
				}
			});
		});

		(this.form_data.tables || []).forEach((table) => {
			if (table.fieldname === "taxes") {
				table.rows = [];
				return;
			}
			const company_fields = (table.fields || []).filter((field) => (
				field.fieldtype === "Link"
				&& (company_link_options.has(field.options) || field.options === "Item Tax Template")
			));
			(table.rows || []).forEach((row) => {
				company_fields.forEach((field) => {
					row[field.fieldname] = "";
				});
			});
		});

		this.render_document_form(this.form_data);
		const mapped_template = defaults.taxes_and_charges || "";
		if (mapped_template) {
			await this.apply_purchase_order_tax_template(mapped_template);
		} else {
			await this.recalculate_purchase_order_totals();
		}

		const supplier_control = this.form_controls.supplier;
		if (supplier_control && supplier_control.get_value()) {
			await this.fetch_supplier_party_details(supplier_control.get_value());
		}
		for (let index = 0; index < (this.table_controls.items || []).length; index += 1) {
			const controls = this.table_controls.items[index] || {};
			const item_code = controls.item_code ? controls.item_code.get_value() : "";
			if (item_code) await this.apply_item_defaults("items", index, item_code);
		}
		await this.recalculate_purchase_order_totals();
		frappe.show_alert({
			message: mapped_template
				? __("Company defaults and GST template refreshed.")
				: __("Company defaults refreshed. Select a GST template for this company."),
			indicator: mapped_template ? "green" : "orange",
		});
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
			"place_of_supply", "company_gstin",
		].forEach((fieldname) => {
			const control = this.form_controls[fieldname];
			if (control && details[fieldname] !== undefined && details[fieldname] !== null) {
				control.set_value(details[fieldname]);
			}
		});
	}

    async apply_purchase_order_payment_terms_template(template) {
        const table = (this.form_data.tables || []).find((item) => item.fieldname === "payment_schedule");
        if (!table || !template) return;
        this.sync_form_data_from_controls();
        const posting_date_control = this.form_controls.transaction_date;
        const grand_total_control = this.form_controls.rounded_total || this.form_controls.grand_total;
        const posting_date = posting_date_control ? posting_date_control.get_value() : "";
        const grand_total = grand_total_control ? flt(grand_total_control.get_value()) : 0;
        let schedule;
        try {
            schedule = await this.call("erpnext.controllers.accounts_controller.get_payment_terms", {
                terms_template: template,
                posting_date,
                grand_total,
                base_grand_total: grand_total,
            });
        } catch (error) {
            return;
        }
        table.rows = (schedule || []).map((row) => ({
            _row_name: null,
            payment_term: row.payment_term || "",
            due_date: row.due_date || "",
            invoice_portion: flt(row.invoice_portion),
            payment_amount: flt(row.payment_amount),
        }));
        this.render_document_form(this.form_data);
        frappe.show_alert({
            message: __("Payment schedule updated from {0}", [template]),
            indicator: "green",
        });
    }

	async apply_purchase_order_terms_template(template) {
		const terms_control = this.form_controls.terms;
		if (!terms_control) return;
		let rendered_terms;
		try {
			rendered_terms = await this.call(
				"erpnext.setup.doctype.terms_and_conditions.terms_and_conditions.get_terms_and_conditions",
				{
					template_name: template,
					doc: JSON.stringify(this.collect_form_values()),
				}
			);
		} catch (error) {
			return;
		}
		if (rendered_terms !== undefined && rendered_terms !== null) {
			terms_control.set_value(rendered_terms);
		}
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
			const tax_table = (this.form_data.tables || []).find((table) => table.fieldname === "taxes");
			(this.table_controls.taxes || []).forEach((controls, index) => {
				const row = (result.taxes || [])[index];
				if (row && row.tax_amount !== undefined) {
					const tax_amount = flt(row.tax_amount, 2);
					if (controls.tax_amount) controls.tax_amount.set_value(tax_amount);
					if (tax_table && tax_table.rows[index]) tax_table.rows[index].tax_amount = tax_amount;
				}
			});
			this.refresh_purchase_charge_card_values();
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

	refresh_purchase_charge_card_values() {
		if (!this.form_data || this.form_data.key !== "purchase_order") return;
		const table = (this.form_data.tables || []).find((item) => item.fieldname === "taxes");
		if (!table) return;
		this.get_purchase_charge_groups(table.rows || []).forEach((group) => {
			const charge = table.rows[group.base_index] || {};
			const charge_amount = flt(charge.tax_amount);
			const gst_amount = group.tax_indices.reduce((total, index) => {
				const tax_row = table.rows[index] || {};
				return total + flt(charge_amount * flt(tax_row.rate) / 100, 2);
			}, 0);
			const $card = this.$content.find(`[data-po-charge-base-index="${group.base_index}"]`);
			if (!$card.length) return;
			$card.find('[data-po-charge-value="charge"]').text(this.format_purchase_charge_currency(charge_amount));
			$card.find('[data-po-charge-value="gst"]').text(this.format_purchase_charge_currency(gst_amount));
			$card.find('[data-po-charge-value="total"]').text(this.format_purchase_charge_currency(charge_amount + gst_amount));
		});
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

	queue_purchase_order_attachments(file_list) {
		if (!this.form_data || this.form_data.key !== "purchase_order" || !this.form_data.can_save) return;
		const files = Array.from(file_list || []).filter((file) => file && file.name);
		files.forEach((file) => {
			this.po_attachment_counter += 1;
			this.po_attachment_queue.push({ id: `po-file-${Date.now()}-${this.po_attachment_counter}`, file });
		});
		this.refresh_purchase_order_attachment_queue();
	}

	remove_purchase_order_attachment(attachment_id) {
		this.po_attachment_queue = (this.po_attachment_queue || []).filter((entry) => entry.id !== attachment_id);
		this.refresh_purchase_order_attachment_queue();
	}

	refresh_purchase_order_attachment_queue() {
		const queue = this.po_attachment_queue || [];
		this.$content.find('[data-role="po-attachment-summary"]').text(
			queue.length ? __("{0} file(s) ready to upload", [queue.length]) : ""
		);
		this.$content.find('[data-role="po-attachment-list"]').html(this.render_purchase_order_attachment_items());
	}

	format_attachment_size(bytes) {
		const size = Number(bytes || 0);
		if (size < 1024) return `${size} B`;
		if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
		return `${(size / (1024 * 1024)).toFixed(1)} MB`;
	}

	async upload_purchase_order_attachment(file, docname) {
		const form_data = new FormData();
		form_data.append("file", file, file.name);
		form_data.append("doctype", "Purchase Order");
		form_data.append("docname", docname);
		form_data.append("is_private", "1");
		const response = await fetch("/api/method/upload_file", {
			method: "POST",
			headers: { "X-Frappe-CSRF-Token": frappe.csrf_token || "" },
			credentials: "same-origin",
			body: form_data,
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok || payload.exc || !payload.message) {
			throw new Error(payload.exception || payload.exc || __("Unable to upload {0}", [file.name]));
		}
		return payload.message;
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
			&& [
				"item_code",
				"item_tax_template",
				"qty",
				"rate",
				"charge_type",
				"account_head",
				"category",
				"add_deduct_tax",
				"tax_amount",
			].includes(field.fieldname)
		) {
			// Debounced: typing a rate/qty fires a control change per keystroke, and each
			// one used to await a full server round-trip. On a document with many rows
			// this queued up faster than the network could drain it, eventually freezing
			// the tab ("Page Unresponsive"). Only recompute once input settles.
			clearTimeout(this.po_totals_debounce_timer);
			this.po_totals_debounce_timer = setTimeout(() => this.recalculate_purchase_order_totals(), 400);
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
				rate: controls.rate ? controls.rate.get_value() : undefined,
				transaction_date: this.form_controls.transaction_date
					? this.form_controls.transaction_date.get_value() : undefined,
				taxes_and_charges: this.form_controls.taxes_and_charges
					? this.form_controls.taxes_and_charges.get_value() : undefined,
				...this.indent_item_context(table_fieldname, row_index),
			});
			["item_name", "description", "stock_uom", "uom", "conversion_factor", "last_purchase_rate", "warehouse", "source_warehouse", "stock_qty", "gst_hsn_code", "item_tax_template"].forEach((fieldname) => {
				const control = controls[fieldname];
				if (defaults[fieldname] === undefined) return;
				if (!control) {
					const table = (this.form_data.tables || []).find((item) => item.fieldname === table_fieldname);
					if (["item_tax_template", "warehouse"].includes(fieldname) && table && table.rows[row_index]) {
						table.rows[row_index][fieldname] = defaults[fieldname] || "";
					}
					return;
				}
				if (is_indent_item && ["uom", "warehouse", "stock_qty"].includes(fieldname)) {
					control.set_value(defaults[fieldname]);
				} else if (["gst_hsn_code", "item_tax_template"].includes(fieldname)) {
					control.set_value(defaults[fieldname] || "");
				} else if (["stock_qty", "last_purchase_rate"].includes(fieldname) || !control.get_value()) {
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
				const source_row = table.rows[index] || {};
				const row = { _row_name: source_row._row_name || null };
				(table.fields || []).filter((field) => field.hide_in_form).forEach((field) => {
					row[field.fieldname] = source_row[field.fieldname] ?? "";
				});
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

	is_mobile_form_table_layout() {
		return Boolean(window.matchMedia && window.matchMedia("(max-width: 620px)").matches);
	}

	new_form_table_row(table) {
		const row = {};
		["schedule_date", "required_date"].forEach((fieldname) => {
			if ((table.fields || []).some((field) => field.fieldname === fieldname)
				&& this.form_controls[fieldname]) {
				row[fieldname] = this.form_controls[fieldname].get_value() || "";
			}
		});
		return row;
	}

	mobile_form_row_dialog_field(field) {
		const df = {
			...field,
			label: field.label,
			read_only: field.read_only || !this.form_data.can_save ? 1 : 0,
		};
		if (["Link", "Dynamic Link"].includes(df.fieldtype)) df.ignore_link_validation = true;
		if (df.fieldtype === "Dynamic Link") {
			df.get_options = () => {
				const option_control = this.form_controls[df.options];
				return option_control ? option_control.get_value() : "";
			};
		}
		if (
			df.fieldtype === "Link"
			&& df.options === "Site Project"
			&& this.bootstrap.restricted_indent_access
		) {
			df.get_query = () => ({ query: "dux_indent_master.portal.get_portal_site_options" });
		} else if (df.fieldtype === "Link" && df.options === "Purchase Taxes and Charges Template") {
			df.get_query = () => ({
				filters: {
					company: this.form_company_value() || ["in", []],
					disabled: 0,
				},
			});
		} else if (
			df.fieldtype === "Link"
			&& ["Warehouse", "Account", "Cost Center", "Project", "Town At Project"].includes(df.options)
		) {
			df.get_query = () => ({ filters: this.link_filters(df.options) });
		}
		return df;
	}

	form_table_initial_value(field, value) {
		if (
			(value === null || value === undefined || value === "")
			&& this.form_data.is_new
			&& field.default !== null
			&& field.default !== undefined
			&& field.default !== ""
		) return field.default;
		return value === null || value === undefined ? "" : value;
	}

	open_mobile_form_row_dialog(table_fieldname) {
		if (!this.form_data || !this.form_data.can_save) return;
		this.sync_form_data_from_controls();
		const table = (this.form_data.tables || []).find((item) => item.fieldname === table_fieldname);
		if (!table) return;
		const visible_fields = (table.fields || []).filter((field) => !field.hide_in_form);
		if (!visible_fields.length) return;

		const row = this.new_form_table_row(table);
		const row_index = table.rows.length;
		table.rows.push(row);
		let committed = false;
		let disposed = false;
		let saving = false;
		const dialog = new frappe.ui.Dialog({
			title: __("Add {0}", [table.label || __("Row")]),
			fields: visible_fields.map((field) => this.mobile_form_row_dialog_field(field)),
			primary_action_label: __("Add Row"),
			primary_action: async () => {
				if (saving) return;
				saving = true;
				const $primary = dialog.get_primary_btn();
				$primary.prop("disabled", true);
				try {
					const item_control = dialog.fields_dict.item_code;
					if (item_control && item_control.get_value()) {
						await this.apply_item_defaults(table_fieldname, row_index, item_control.get_value());
					}
					const values = dialog.get_values();
					if (!values) return;
					visible_fields.forEach((field) => {
						const control = dialog.fields_dict[field.fieldname];
						if (control) row[field.fieldname] = control.get_value();
					});
					committed = true;
					dialog.hide();
					this.render_document_form(this.form_data);
					frappe.show_alert({ message: __("Row added"), indicator: "green" });
					if (this.form_data.key === "purchase_order" && ["items", "taxes"].includes(table_fieldname)) {
						setTimeout(() => this.recalculate_purchase_order_totals(), 250);
					}
				} finally {
					saving = false;
					if (!committed) $primary.prop("disabled", false);
				}
			},
		});

		const row_controls = {};
		visible_fields.forEach((field) => {
			const control = dialog.fields_dict[field.fieldname];
			if (!control) return;
			control.duxp_field = field;
			control.duxp_base_read_only = Boolean(control.df.read_only);
			control.duxp_base_reqd = Boolean(control.df.reqd);
			control.set_value(this.form_table_initial_value(field, row[field.fieldname]));
			row_controls[field.fieldname] = control;
		});
		this.table_controls[table.fieldname] = this.table_controls[table.fieldname] || [];
		this.table_controls[table.fieldname].push(row_controls);
		visible_fields.forEach((field) => {
			const control = row_controls[field.fieldname];
			if (!control) return;
			this.bind_control_change(control, (value) => this.handle_table_control_change(
				table.fieldname,
				row_index,
				field,
				value
			));
		});

		dialog.$wrapper.addClass("duxp-mobile-row-dialog");
		dialog.$wrapper.on("hidden.bs.modal", () => {
			if (committed || disposed) return;
			disposed = true;
			const current_index = table.rows.indexOf(row);
			if (current_index >= 0) table.rows.splice(current_index, 1);
			const controls = this.table_controls[table.fieldname] || [];
			const control_index = controls.indexOf(row_controls);
			if (control_index >= 0) controls.splice(control_index, 1);
			this.refresh_form_dependencies();
		});
		dialog.show();
		this.refresh_form_dependencies();
	}

	add_form_row(table_fieldname) {
		if (!this.form_data || !this.form_data.can_save) return;
		if (this.is_mobile_form_table_layout()) {
			this.open_mobile_form_row_dialog(table_fieldname);
			return;
		}
		this.sync_form_data_from_controls();
		const table = (this.form_data.tables || []).find((item) => item.fieldname === table_fieldname);
		if (!table) return;
		table.rows.push(this.new_form_table_row(table));
		this.render_document_form(this.form_data);
	}

	purchase_charge_tax_defaults(rows, groups, gst_accounts, template_name, edit_group = null) {
		const grouped_indices = new Set((groups || []).flatMap((group) => group.indices));
		const source_rows = edit_group
			? edit_group.tax_indices.map((index) => rows[index] || {})
			: rows.filter((row, index) => !grouped_indices.has(index));
		const find_tax = (kind) => source_rows.find((row) => this.purchase_charge_tax_kind(row) === kind) || {};
		const cgst = find_tax("CGST");
		const sgst = find_tax("SGST");
		const igst = find_tax("IGST");
		const rate_match = String(template_name || "").match(/(\d+(?:\.\d+)?)\s*%/);
		const template_rate = rate_match ? flt(rate_match[1]) : 18;
		let tax_type = String(template_name || "").includes("out-state") ? "IGST" : "CGST + SGST";
		if (edit_group) {
			tax_type = igst.account_head ? "IGST"
				: cgst.account_head || sgst.account_head ? "CGST + SGST" : "No GST";
		}
		return {
			tax_type,
			cgst_account: cgst.account_head || gst_accounts.cgst || "",
			sgst_account: sgst.account_head || gst_accounts.sgst || "",
			igst_account: igst.account_head || gst_accounts.igst || "",
			cgst_rate: flt(cgst.rate) || template_rate / 2,
			sgst_rate: flt(sgst.rate) || template_rate / 2,
			igst_rate: flt(igst.rate) || template_rate,
		};
	}

	replace_purchase_charge_group_rows(rows, group, replacement_rows) {
		const removed_indices = new Set(group.indices);
		const old_references = new Map(rows.map((row, index) => [index, Number(row.row_id)]));
		const row_number_map = new Map();
		const result = [];
		let replacement_base_number = 0;
		rows.forEach((row, index) => {
			if (index === group.base_index) {
				replacement_base_number = result.length + 1;
				result.push(...replacement_rows);
			}
			if (removed_indices.has(index)) return;
			row_number_map.set(index + 1, result.length + 1);
			result.push(row);
		});
		replacement_rows.slice(1).forEach((row) => {
			row.row_id = String(replacement_base_number);
		});
		result.forEach((row) => {
			if (replacement_rows.includes(row)) return;
			if (!["On Previous Row Amount", "On Previous Row Total"].includes(String(row.charge_type || ""))) return;
			const old_index = rows.indexOf(row);
			const old_reference = old_references.get(old_index);
			if (row_number_map.has(old_reference)) row.row_id = String(row_number_map.get(old_reference));
		});
		return result;
	}

	async add_purchase_charge(edit_row_index = null) {
		if (!this.form_data || this.form_data.key !== "purchase_order" || !this.form_data.can_save) return;
		const company = this.form_company_value();
		if (!company) {
			frappe.msgprint({ message: __("Please select Company before adding a charge."), indicator: "orange" });
			return;
		}

		const table = (this.form_data.tables || []).find((item) => item.fieldname === "taxes");
		if (!table) return;
		const groups = this.get_purchase_charge_groups(table.rows || []);
		const edit_group = Number.isInteger(edit_row_index)
			? groups.find((group) => group.base_index === edit_row_index) || null : null;

		let presets = [
			{ key: "freight_forwarding", label: __("Freight and Forwarding"), account_head: "" },
			{ key: "loading_unloading", label: __("Loading and Unloading"), account_head: "" },
            { key: "labour_charges", label: __("Labour Charges"), account_head: "" },
		];
		let gst_accounts = { cgst: "", sgst: "", igst: "" };
		try {
			const configured = await this.call("dux_indent_master.portal.get_portal_purchase_charge_options", { company });
			if (Array.isArray(configured) && configured.length) {
				presets = configured;
			} else if (configured) {
				if (Array.isArray(configured.charges) && configured.charges.length) presets = configured.charges;
				gst_accounts = { ...gst_accounts, ...(configured.gst_accounts || {}) };
			}
		} catch (error) {
			// The dialog remains usable; Account Heads can still be selected manually.
		}

		const editing_charge = edit_group ? table.rows[edit_group.base_index] || {} : {};
		if (editing_charge.description && !presets.some((preset) => preset.label === editing_charge.description)) {
			presets.push({ key: "existing_charge", label: editing_charge.description, account_head: editing_charge.account_head || "" });
		}
		const template_control = this.form_controls.taxes_and_charges;
		const template_name = template_control ? String(template_control.get_value() || "").toLowerCase() : "";
		const tax_defaults = this.purchase_charge_tax_defaults(
			table.rows || [], groups, gst_accounts, template_name, edit_group
		);
		const account_query = () => ({ filters: { company, is_group: 0, disabled: 0 } });
		let dialog;
		const set_default_account = () => {
			if (!dialog) return;
			const selected = presets.find((preset) => preset.label === dialog.get_value("charge_label"));
			dialog.set_value("account_head", selected && selected.account_head ? selected.account_head : "");
		};
		dialog = new frappe.ui.Dialog({
			title: edit_group ? __("Edit Additional Charge") : __("Add Additional Charge with GST"),
			fields: [
				{
					fieldname: "charge_label",
					label: __("Charge"),
					fieldtype: "Select",
					options: presets.map((preset) => preset.label).join("\n"),
					reqd: 1,
					change: set_default_account,
				},
				{
					fieldname: "account_head",
					label: __("Charge Account"),
					fieldtype: "Link",
					options: "Account",
					reqd: 1,
					get_query: account_query,
					description: __("Only accounts for {0} are shown.", [company]),
				},
				{
					fieldname: "amount",
					label: __("Charge Amount"),
					fieldtype: "Currency",
					reqd: 1,
				},
				{ fieldname: "gst_section", fieldtype: "Section Break", label: __("GST on this charge") },
				{
					fieldname: "tax_type",
					label: __("Tax Type"),
					fieldtype: "Select",
					options: "CGST + SGST\nIGST\nNo GST",
					reqd: 1,
				},
				{
					fieldname: "cgst_account",
					label: __("CGST Account"),
					fieldtype: "Link",
					options: "Account",
					get_query: account_query,
					depends_on: 'eval:doc.tax_type=="CGST + SGST"',
				},
				{
					fieldname: "cgst_rate",
					label: __("CGST Rate %"),
					fieldtype: "Float",
					depends_on: 'eval:doc.tax_type=="CGST + SGST"',
				},
				{ fieldname: "gst_column", fieldtype: "Column Break", depends_on: 'eval:doc.tax_type=="CGST + SGST"' },
				{
					fieldname: "sgst_account",
					label: __("SGST Account"),
					fieldtype: "Link",
					options: "Account",
					get_query: account_query,
					depends_on: 'eval:doc.tax_type=="CGST + SGST"',
				},
				{
					fieldname: "sgst_rate",
					label: __("SGST Rate %"),
					fieldtype: "Float",
					depends_on: 'eval:doc.tax_type=="CGST + SGST"',
				},
				{ fieldname: "igst_section", fieldtype: "Section Break", depends_on: 'eval:doc.tax_type=="IGST"' },
				{
					fieldname: "igst_account",
					label: __("IGST Account"),
					fieldtype: "Link",
					options: "Account",
					get_query: account_query,
					depends_on: 'eval:doc.tax_type=="IGST"',
				},
				{
					fieldname: "igst_rate",
					label: __("IGST Rate %"),
					fieldtype: "Float",
					depends_on: 'eval:doc.tax_type=="IGST"',
				},
			],
			primary_action_label: edit_group ? __("Update Charge") : __("Add Charge and GST"),
			primary_action: (values) => {
				const amount = flt(values.amount);
				if (amount <= 0) {
					frappe.msgprint({ message: __("Charge Amount must be greater than zero."), indicator: "orange" });
					return;
				}
				if (values.tax_type === "CGST + SGST" && (
					!values.cgst_account || !values.sgst_account || flt(values.cgst_rate) <= 0 || flt(values.sgst_rate) <= 0
				)) {
					frappe.msgprint({ message: __("Please select CGST/SGST accounts and enter both tax rates."), indicator: "orange" });
					return;
				}
				if (values.tax_type === "IGST" && (!values.igst_account || flt(values.igst_rate) <= 0)) {
					frappe.msgprint({ message: __("Please select IGST account and enter the tax rate."), indicator: "orange" });
					return;
				}

				this.sync_form_data_from_controls();
				const current_groups = this.get_purchase_charge_groups(table.rows || []);
				const current_edit_group = edit_group
					? current_groups.find((group) => group.base_index === edit_group.base_index) || edit_group
					: null;
				let rows = table.rows || [];
				const reference_map = this.capture_purchase_tax_references(rows);
				const taxable_charge_rows = new Set(
					current_groups
						.filter((group) => group.tax_indices.length)
						.map((group) => rows[group.base_index])
						.filter(Boolean)
				);
				const editing_row = current_edit_group ? rows[current_edit_group.base_index] : null;
				if (editing_row) taxable_charge_rows.delete(editing_row);

				const existing_gst_rows = rows.filter((row) => this.is_purchase_gst_tax_row(row));
				const existing_kinds = new Set(existing_gst_rows.map((row) => this.purchase_charge_tax_kind(row)));
				const existing_tax_type = existing_kinds.has("IGST")
					? "IGST"
					: existing_kinds.has("CGST") || existing_kinds.has("SGST") ? "CGST + SGST" : "";
				if (values.tax_type !== "No GST" && existing_tax_type && existing_tax_type !== values.tax_type) {
					frappe.msgprint({
						title: __("GST Type Does Not Match"),
						message: __(
							"This Purchase Order tax template uses {0}. Select {0} for the additional charge, or change the Purchase Taxes and Charges Template first.",
							[existing_tax_type]
						),
						indicator: "orange",
					});
					return;
				}

				const requested_specs = values.tax_type === "CGST + SGST"
					? [
						{ kind: "CGST", account_head: values.cgst_account, rate: flt(values.cgst_rate) },
						{ kind: "SGST", account_head: values.sgst_account, rate: flt(values.sgst_rate) },
					]
					: values.tax_type === "IGST"
						? [{ kind: "IGST", account_head: values.igst_account, rate: flt(values.igst_rate) }]
						: [];
				if (taxable_charge_rows.size && requested_specs.length) {
					const conflicts = requested_specs.some((spec) => {
						const existing = existing_gst_rows.find(
							(row) => this.purchase_charge_tax_kind(row) === spec.kind
						);
						return existing && (
							String(existing.account_head || "") !== String(spec.account_head || "")
							|| flt(existing.rate) !== flt(spec.rate)
						);
					});
					if (conflicts) {
						frappe.msgprint({
							title: __("Use the Same GST for Additional Charges"),
							message: __("ERPNext India Compliance uses one common GST row set for taxable items and additional charges. Use the same GST accounts and rates already selected on this Purchase Order."),
							indicator: "orange",
						});
						return;
					}
				}

				const legacy_rows = new Set();
				if (current_edit_group) {
					current_edit_group.indices.slice(1).forEach((index) => {
						if (rows[index]) legacy_rows.add(rows[index]);
					});
				}
				if (legacy_rows.size) rows = rows.filter((row) => !legacy_rows.has(row));

				const selected = presets.find((preset) => preset.label === values.charge_label);
				const charge_label = selected ? selected.label : values.charge_label;
				const charge_row = editing_row || {
					_row_name: null,
					category: "Total",
					add_deduct_tax: "Add",
					charge_type: "Actual",
					row_id: "",
				};
				Object.assign(charge_row, {
					category: "Total",
					add_deduct_tax: "Add",
					charge_type: "Actual",
					row_id: "",
					account_head: values.account_head,
					description: charge_label,
					rate: 0,
					tax_amount: amount,
				});
				rows = rows.filter((row) => row !== charge_row);

				if (requested_specs.length) {
					taxable_charge_rows.add(charge_row);
					const first_gst_index = rows.findIndex((row) => this.is_purchase_gst_tax_row(row));
					const first_non_taxable_charge_index = rows.findIndex((row) => (
						String(row.charge_type || "") === "Actual"
						&& !this.is_purchase_gst_tax_row(row)
						&& !taxable_charge_rows.has(row)
					));
					const insert_index = first_gst_index >= 0
						? first_gst_index
						: first_non_taxable_charge_index >= 0 ? first_non_taxable_charge_index : rows.length;
					rows.splice(insert_index, 0, charge_row);
				} else {
					rows.push(charge_row);
				}

				this.restore_purchase_tax_references(rows, reference_map);
				let gst_rows = rows.filter((row) => this.is_purchase_gst_tax_row(row));
				if (requested_specs.length && !gst_rows.length) {
					const new_gst_rows = requested_specs.map((spec) => ({
						_row_name: null,
						category: "Total",
						add_deduct_tax: "Add",
						charge_type: "On Previous Row Total",
						row_id: "",
						account_head: spec.account_head,
						description: spec.kind,
						rate: spec.rate,
						tax_amount: 0,
					}));
					const charge_index = rows.indexOf(charge_row);
					rows.splice(charge_index + 1, 0, ...new_gst_rows);
					gst_rows = new_gst_rows;
				}
				if (requested_specs.length) {
					requested_specs.forEach((spec) => {
						const row = gst_rows.find((candidate) => this.purchase_charge_tax_kind(candidate) === spec.kind);
						if (!row) return;
						row.account_head = spec.account_head;
						row.description = spec.kind;
						row.rate = spec.rate;
						row.tax_amount = 0;
					});
				}

				const taxable_indices = [...taxable_charge_rows]
					.map((row) => rows.indexOf(row))
					.filter((index) => index >= 0);
				if (taxable_indices.length) {
					const reference_row_id = String(Math.max(...taxable_indices) + 1);
					gst_rows.forEach((row) => {
						row.charge_type = "On Previous Row Total";
						row.row_id = reference_row_id;
					});
				} else {
					gst_rows.forEach((row) => {
						if (String(row.charge_type || "") !== "On Previous Row Total") return;
						row.charge_type = "On Net Total";
						row.row_id = "";
					});
				}
				table.rows = rows;

				dialog.hide();
				this.suppress_po_tax_template_reload = true;
				this.render_document_form(this.form_data);
				frappe.show_alert({
					message: edit_group ? __("Additional charge updated") : __("Additional charge added"),
					indicator: "green",
				});
				setTimeout(() => this.recalculate_purchase_order_totals(), 250);
				setTimeout(() => {
					this.suppress_po_tax_template_reload = false;
				}, 1500);
			},
		});
		dialog.show();
		dialog.set_value("charge_label", editing_charge.description || presets[0].label);
		dialog.set_value("account_head", editing_charge.account_head || presets[0].account_head || "");
		dialog.set_value("amount", edit_group ? flt(editing_charge.tax_amount) : 0);
		dialog.set_value("tax_type", tax_defaults.tax_type);
		dialog.set_value("cgst_account", tax_defaults.cgst_account);
		dialog.set_value("sgst_account", tax_defaults.sgst_account);
		dialog.set_value("igst_account", tax_defaults.igst_account);
		dialog.set_value("cgst_rate", tax_defaults.cgst_rate);
		dialog.set_value("sgst_rate", tax_defaults.sgst_rate);
		dialog.set_value("igst_rate", tax_defaults.igst_rate);
		if (!edit_group) set_default_account();
	}

	remove_purchase_charge(row_index) {
		if (!this.form_data || this.form_data.key !== "purchase_order" || !this.form_data.can_save) return;
		this.sync_form_data_from_controls();
		const table = (this.form_data.tables || []).find((item) => item.fieldname === "taxes");
		if (!table) return;
		const rows = table.rows || [];
		const groups = this.get_purchase_charge_groups(rows);
		const group = groups.find((candidate) => candidate.base_index === row_index);
		if (!group) return;

		const target_row = rows[group.base_index];
		const taxable_charge_rows = new Set(
			groups
				.filter((candidate) => candidate.tax_indices.length && candidate.base_index !== group.base_index)
				.map((candidate) => rows[candidate.base_index])
				.filter(Boolean)
		);
		const references = this.capture_purchase_tax_references(rows);
		const removed_rows = new Set(group.indices.map((index) => rows[index]).filter(Boolean));
		removed_rows.add(target_row);
		table.rows = rows.filter((row) => !removed_rows.has(row));
		this.restore_purchase_tax_references(table.rows, references);

		const gst_rows = table.rows.filter((row) => this.is_purchase_gst_tax_row(row));
		const taxable_indices = [...taxable_charge_rows]
			.map((row) => table.rows.indexOf(row))
			.filter((index) => index >= 0);
		if (taxable_indices.length) {
			const reference_row_id = String(Math.max(...taxable_indices) + 1);
			gst_rows.forEach((row) => {
				row.charge_type = "On Previous Row Total";
				row.row_id = reference_row_id;
			});
		} else {
			gst_rows.forEach((row) => {
				if (String(row.charge_type || "") !== "On Previous Row Total") return;
				row.charge_type = "On Net Total";
				row.row_id = "";
			});
		}
		this.render_document_form(this.form_data);
		this.recalculate_purchase_order_totals();
	}

	remove_form_row(table_fieldname, row_index) {
		if (!this.form_data || !this.form_data.can_save) return;
		this.sync_form_data_from_controls();
		const table = (this.form_data.tables || []).find((item) => item.fieldname === table_fieldname);
		if (!table || row_index < 0 || row_index >= table.rows.length) return;
		if (this.form_data.key === "purchase_order" && table_fieldname === "taxes") {
			const removed_indices = new Set([row_index]);
			let found_dependency = true;
			while (found_dependency) {
				found_dependency = false;
				table.rows.forEach((row, index) => {
					if (removed_indices.has(index)) return;
					if (!["On Previous Row Amount", "On Previous Row Total"].includes(row.charge_type)) return;
					const referenced_index = Number(row.row_id) - 1;
					if (removed_indices.has(referenced_index)) {
						removed_indices.add(index);
						found_dependency = true;
					}
				});
			}
			const row_number_map = new Map();
			let next_row_number = 1;
			table.rows.forEach((row, index) => {
				if (!removed_indices.has(index)) row_number_map.set(index + 1, next_row_number++);
			});
			table.rows = table.rows.filter((row, index) => !removed_indices.has(index));
			table.rows.forEach((row) => {
				if (["On Previous Row Amount", "On Previous Row Total"].includes(row.charge_type)) {
					row.row_id = String(row_number_map.get(Number(row.row_id)) || row.row_id || "");
				}
			});
		} else {
			table.rows.splice(row_index, 1);
		}
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

	async upload_queued_purchase_order_attachments(docname) {
		if (!docname || !this.po_attachment_queue.length) return 0;
		const pending = [...this.po_attachment_queue];
		const failed = [];
		let uploaded = 0;
		for (const entry of pending) {
			try {
				await this.upload_purchase_order_attachment(entry.file, docname);
				uploaded += 1;
			} catch (error) {
				failed.push(entry);
			}
		}
		this.po_attachment_queue = failed;
		this.refresh_purchase_order_attachment_queue();
		if (failed.length) {
			const error = new Error(
				__("Purchase Order {0} was saved, but {1} attachment(s) could not be uploaded. Please retry Save Draft.", [docname, failed.length])
			);
			error.purchase_order_saved = true;
			throw error;
		}
		return uploaded;
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
			this.form_data.name = result.name;
			this.form_data.is_new = false;
			this.state.document_name = result.name;
			const uploaded_attachments = await this.upload_queued_purchase_order_attachments(result.name);
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
				const attachment_message = uploaded_attachments
					? ` · ${uploaded_attachments} ${__("attachment(s) uploaded")}` : "";
				frappe.show_alert({ message: `${result.name} ${__("saved")}${attachment_message}`, indicator: "green" });
				await this.open_document_detail(this.form_data.key, result.name);
			}
		} catch (error) {
			const message = error && (error.message || error.exc) ? error.message || error.exc : __("Unable to save document.");
			frappe.msgprint({
				title: error && error.purchase_order_saved ? __("Attachment Upload Failed") : __("Save Failed"),
				message: this.escape(message), indicator: "red",
			});
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

	filter_dashboard_approvals(doctypes = []) {
		const approvals = this.dashboard_approvals || [];
		const selected = Array.isArray(doctypes) ? doctypes.filter(Boolean) : [];
		this.state.approval_types = selected;
		const filtered = selected.length
			? approvals.filter((row) => selected.includes(row.doctype))
			: approvals;
		const $list = this.$root.find("[data-pending-approval-list]");
		if (!$list.length) return;
		$list.html(this.approval_list(filtered));
		this.$root.find("[data-pending-approval-count]").text(
			`${filtered.length} ${__("awaiting action")}`
		);
		const labels = {
			"Material Request": __("Material Request"),
			"Purchase Order": __("Purchase Order (PO)"),
			"Purchase Receipt": __("Purchase Receipt (PR)"),
			"Purchase Invoice": __("Purchase Invoice (PI)"),
		};
		const summary = selected.length === 0 ? __("All Types")
			: selected.length === 1 ? labels[selected[0]] || selected[0]
			: `${selected.length} ${__("selected")}`;
		this.$root.find("[data-approval-type-summary]").text(summary);
		this.$root.find('[data-action="toggle-approval-type-filter"]')
			.attr("title", selected.map((doctype) => labels[doctype] || doctype).join(", ") || __("All Types"));
	}

	approval_list(rows) {
		if (!rows.length) return this.empty_state(__("No pending approvals"), __("You are all caught up."));
		// Cap the visible rows so this card never needs its own scrollbar --
		// same "top N, no in-card scroll" pattern as the Recent Activity card.
		// The header count badge still reflects the true, uncapped total.
		const visible_rows = rows.slice(0, 8);
		return `<div class="duxp-approval-table-wrap"><table class="duxp-table duxp-approval-table">
			<thead><tr><th>${__("ID")}</th><th>${__("Name")}</th><th>${__("Amount")}</th><th>${__("Status")}</th></tr></thead>
			<tbody>${visible_rows.map((row) => {
				const amount_html = (row.amount !== undefined && row.amount !== null && Number(row.amount) !== 0)
					? `<span class="duxp-number">${this.escape(format_currency(flt(row.amount), row.currency || frappe.defaults.get_default("currency") || "INR"))}</span>`
					: `<span class="duxp-muted">—</span>`;
				return `
				<tr class="duxp-approval-row" data-key="${this.escape(row.route_key || "")}" data-doctype="${this.escape(row.doctype)}" data-name="${this.escape(row.name)}">
					<td><strong class="duxp-id-cell">${this.escape(row.name)}</strong><small>${this.escape(row.doctype)} · ${this.format_date(row.modified)}</small></td>
					<td>${row.party ? this.escape(row.party) : `<span class="duxp-muted">—</span>`}</td>
					<td>${amount_html}</td>
					<td>${this.status_tag(row.status)}</td>
				</tr>
			`;}).join("")}</tbody>
		</table></div>`;
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
		const print_url = `/printview?${params.toString()}`;
		const user_agent = navigator.userAgent || "";
		const is_android = /Android/i.test(user_agent);

		// Android WebView wrappers commonly block target=_blank/window.open.
		// Reusing the current WebView keeps the Print action functional and lets
		// the device Back button return to the Purchase Order.
		if (is_android) {
			window.location.assign(print_url);
			return;
		}

		const popup = window.open(print_url, "_blank", "noopener,noreferrer");
		if (!popup) window.location.assign(print_url);
	}

	get_document_pdf_download_url(key, name) {
		const format = PORTAL_PRINT_FORMATS[key];
		const item = this.items[key];
		if (!name || !format || !item) return "";
		const params = new URLSearchParams({
			doctype: item.doctype,
			name: String(name),
			print_format: format,
			no_letterhead: "1",
			language: frappe.boot.lang || "en",
			disposition: "attachment",
		});
		return `/api/method/dux_indent_master.mobile_pdf.download_document_pdf?${params.toString()}`;
	}
	open_document_pdf_external(key, name) {
		const format = PORTAL_PRINT_FORMATS[key];
		const item = this.items[key];
		if (!name || !format || !item) return;

		try {
			// Create the short-lived URL while the WebView session is authenticated.
			// A synchronous request keeps this code inside the user's click gesture,
			// so target=_blank can still be handed to the device browser afterwards.
			const params = new URLSearchParams({
				doctype: item.doctype,
				name: String(name),
				print_format: format,
				no_letterhead: "1",
				language: frappe.boot.lang || "en",
				disposition: "attachment",
			});
			const endpoint = `/api/method/dux_indent_master.mobile_pdf.create_mobile_pdf_download?${params.toString()}`;
			const request = new XMLHttpRequest();
			request.open("GET", endpoint, false);
			request.setRequestHeader("Accept", "application/json");
			request.send(null);
			if (request.status < 200 || request.status >= 300) {
				throw new Error(__("Unable to prepare PDF download."));
			}

			const response = JSON.parse(request.responseText || "{}");
			const public_url = response && response.message && response.message.url;
			if (!public_url) throw new Error(__("PDF download link was not returned."));

			// Keep this as a normal HTTPS navigation. Android WebView wrappers can send
			// target=_blank links to the device browser, while intent:// links fail in
			// wrappers that do not implement custom URI-scheme handling.
			const download_url = new URL(public_url, window.location.origin).href;
			// Cordova-style wrappers understand _system as the external browser.
			// Plain WebViews fall back to a real target=_blank HTTPS link below.
			const external_window = window.open(download_url, "_system");
			if (external_window) return;

			const link = document.createElement("a");
			link.href = download_url;
			link.target = "_blank";
			link.rel = "noopener noreferrer external";
			link.setAttribute("data-open-external", "true");
			link.style.display = "none";
			document.body.appendChild(link);
			link.click();
			link.remove();
		} catch (error) {
			frappe.msgprint({
				title: __("PDF Download Failed"),
				message: error && error.message ? error.message : __("Unable to prepare PDF download."),
				indicator: "red",
			});
		}
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

	logout() {
		frappe.app.logout();
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
		this.$content.removeClass("duxp-detail-view duxp-form-view duxp-list-view duxp-report-view");
		this.$content.closest(".duxp-scroll").removeClass("duxp-list-scroll-shell duxp-report-scroll-shell");
		this.$content.html(`<div class="duxp-loading"><span></span><span></span><span></span><p>${__("Loading live data…")}</p></div>`);
	}

	show_error(error) {
		const message = error && (error.message || error.exc) ? error.message || error.exc : __("Unable to load portal data.");
		this.$content.html(`<div class="duxp-card duxp-error-state">${this.icon("warning", 28)}<h2>${__("Something went wrong")}</h2><p>${this.escape(message)}</p><button class="duxp-btn duxp-btn-primary" data-action="refresh">${__("Try Again")}</button></div>`);
	}

	format_report_value(value, column, row) {
		if (typeof value === "string") {
			const source = String(value);
			const contains_markup = /<\/?[a-z][^>]*>/i.test(source);
			const contains_entity = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/i.test(source);
			if (contains_markup || contains_entity) {
				const normalized = source
					.replace(/<br\s*\/?>/gi, "\n")
					.replace(/<li(?:\s[^>]*)?>/gi, " • ")
					.replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
					.replace(/<[^>]+>/g, "");
				const decoder = document.createElement("textarea");
				decoder.innerHTML = normalized;
				const plain_text = decoder.value
					.replace(/\u00a0/g, " ")
					.replace(/\s+/g, " ")
					.trim();
				return plain_text ? this.escape(plain_text) : '<span class="duxp-muted">—</span>';
			}
		}
		return this.format_value(value, column, row);
	}

	format_value(value, column) {
		if (value === null || value === undefined || value === "") return '<span class="duxp-muted">—</span>';
		if (["status", "row_status", "docstatus"].includes(column.fieldname)) return this.status_tag(value);
		if (column.fieldname === "disabled") return this.status_tag(Number(value) ? __("Disabled") : __("Active"));
		if (typeof value === "string" && column.fieldtype === "Text Editor") {
			if (/address/i.test(column.fieldname || "")) {
				return this.format_address_value(value) || '<span class="duxp-muted">—</span>';
			}
			return this.format_rich_text_value(value) || '<span class="duxp-muted">—</span>';
		}
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

	format_rich_text_value(value) {
		const source = document.createElement("template");
		source.innerHTML = String(value || "");
		const output = document.createElement("div");
		const allowed_tags = new Set([
			"a", "b", "blockquote", "br", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
			"hr", "i", "img", "li", "ol", "p", "s", "span", "strike", "strong", "sub", "sup",
			"table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
		]);
		const blocked_tags = new Set(["audio", "embed", "form", "iframe", "object", "script", "style", "svg", "video"]);
		const text_alignments = new Set(["left", "right", "center", "justify"]);

		const clean_node = (node) => {
			if (node.nodeType === 3) return document.createTextNode(node.nodeValue || "");
			const fragment = document.createDocumentFragment();
			if (node.nodeType !== 1) return fragment;

			const tag = String(node.tagName || "").toLowerCase();
			if (blocked_tags.has(tag)) return fragment;
			const target = allowed_tags.has(tag) ? document.createElement(tag) : fragment;

			if (target.nodeType === 1) {
				if (["td", "th"].includes(tag)) {
					["colspan", "rowspan"].forEach((attribute) => {
						const count = Number.parseInt(node.getAttribute(attribute), 10);
						if (count > 0 && count <= 100) target.setAttribute(attribute, String(count));
					});
				}
				if (tag === "ol") {
					const start = Number.parseInt(node.getAttribute("start"), 10);
					if (Number.isFinite(start)) target.setAttribute("start", String(start));
					const type = node.getAttribute("type") || "";
					if (/^(1|a|A|i|I)$/.test(type)) target.setAttribute("type", type);
				}
				if (tag === "li") {
					const item_value = Number.parseInt(node.getAttribute("value"), 10);
					if (Number.isFinite(item_value)) target.setAttribute("value", String(item_value));
				}
				if (tag === "a") {
					const href = this.safe_attachment_url(node.getAttribute("href") || "");
					if (href) {
						target.setAttribute("href", href);
						target.setAttribute("target", "_blank");
						target.setAttribute("rel", "noopener noreferrer");
					}
					const title = node.getAttribute("title");
					if (title) target.setAttribute("title", title);
				}
				if (tag === "img") {
					const src = this.safe_attachment_url(node.getAttribute("src") || "");
					if (!src) return fragment;
					target.setAttribute("src", src);
					target.setAttribute("alt", node.getAttribute("alt") || "");
					target.setAttribute("loading", "lazy");
				}
				const text_align = node.style && String(node.style.textAlign || "").toLowerCase();
				if (text_alignments.has(text_align)) target.style.textAlign = text_align;
			}

			Array.from(node.childNodes || []).forEach((child) => target.appendChild(clean_node(child)));
			return target;
		};

		Array.from(source.content.childNodes).forEach((node) => output.appendChild(clean_node(node)));
		const html = output.innerHTML.trim();
		return html ? `<div class="duxp-rich-text">${html}</div>` : "";
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

	panel_header(index, title, meta, extra = "") {
		return `<div class="duxp-panel-header"><span>${String(index).padStart(2, "0")}</span><h3>${this.escape(title)}</h3><small>${this.escape(meta || "")}</small>${extra}</div>`;
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
			logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
		};
		return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.document}</svg>`;
	}
}
