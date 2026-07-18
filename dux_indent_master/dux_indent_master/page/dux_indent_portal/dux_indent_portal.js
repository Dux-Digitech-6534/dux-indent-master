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
					<div class="duxp-brand">
						<img class="duxp-brand-logo" src="/files/dux-logo.png" alt="Dux Digitech">
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
			if (action === "toggle-form-section") this.toggle_form_section($target);
			if (action === "open-sidebar") this.$root.addClass("duxp-sidebar-open");
			if (action === "close-sidebar") this.$root.removeClass("duxp-sidebar-open");
			if (action === "dashboard") this.open_dashboard();
			if (action === "new") this.open_document_form($target.data("key"));
			if (action === "back-list") this.open_document_list($target.data("key"));
			if (action === "edit-form") this.open_document_form($target.data("key"), $target.data("name"));
			if (action === "create-mapped-document") this.open_mapped_document_form(
				$target.data("target-key"), $target.data("source-key"), $target.data("source-name")
			);
			if (action === "get-items-from") this.select_mapping_source(
				$target.data("target-key"), $target.data("source-key")
			);
			if (action === "run-lifecycle") this.run_lifecycle_action(
				$target.data("key"), $target.data("name"), $target.data("lifecycle-action"),
				Boolean($target.data("requires-reason")), $target.text().trim()
			);
			if (action === "amend-document") this.open_amended_document_form(
				$target.data("key"), $target.data("name")
			);
			if (action === "form-back") this.close_document_form();
			if (action === "add-form-row") this.add_form_row($target.data("table"));
			if (action === "remove-form-row") this.remove_form_row($target.data("table"), Number($target.data("index")));
			if (action === "save-form") this.save_portal_form(false);
			if (action === "submit-form") this.confirm_submit_form();
			if (action === "open-native") this.open_native_document($target.data("doctype"), $target.data("name"));
			if (action === "previous") this.change_page(-1);
			if (action === "next") this.change_page(1);
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
			frappe.set_route("query-report", item.report);
		}
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
		const tables = (data.child_tables || []).map((table, table_index) => `
			<section class="duxp-card duxp-detail-panel">
				${this.panel_header(table_index + 2, table.label, `${(table.rows || []).length} ${__("rows")}`)}
				<div class="duxp-table-wrap"><table class="duxp-table"><thead><tr><th>#</th>${(table.columns || []).map((column) => `<th>${this.escape(column.label)}</th>`).join("")}</tr></thead><tbody>
					${(table.rows || []).map((row, index) => `<tr><td class="duxp-index">${index + 1}</td>${table.columns.map((column) => `<td>${this.format_value(row[column.fieldname], column, row)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${(table.columns || []).length + 1}">${this.empty_state(__("No rows"), "")}</td></tr>`}
				</tbody></table></div>
			</section>
		`).join("");

		const create_actions = (data.create_actions || []).map((action, index) => `
			<button class="duxp-btn ${index === 0 ? "duxp-btn-primary" : "duxp-btn-secondary"}" data-action="create-mapped-document"
				data-target-key="${this.escape(action.target_route_key)}" data-source-key="${this.escape(action.source_route_key)}"
				data-source-name="${this.escape(data.name)}">${this.icon("plus", 14)}${__("Create")} ${this.escape(action.label)}</button>
		`).join("");
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
		const form_label = data.can_edit ? __("Edit in Portal")
			: data.can_update_after_submit ? __("Update in Portal") : __("View Form");
		const hide_submitted_form_button = data.docstatus === 1
			&& ["material_request", "purchase_order"].includes(data.key);
		const form_button = hide_submitted_form_button ? "" : `<button class="duxp-btn ${data.can_edit || data.can_update_after_submit ? "duxp-btn-primary" : "duxp-btn-secondary"}"
			data-action="edit-form" data-key="${this.escape(data.key)}" data-name="${this.escape(data.name)}">
			${this.icon("edit", 14)}${form_label}</button>`;
		const activity = this.render_activity_panel(data.activity || {}, data);

		this.$content.html(`
			<section class="duxp-page-head">
				<div><span class="duxp-eyebrow">${this.escape(data.label)} · <em>${this.escape(data.name)}</em></span><h1>${this.escape(data.name)}</h1><div class="duxp-status-line">${this.status_tag(data.status)}</div></div>
				<div class="duxp-head-actions">
					<button class="duxp-btn duxp-btn-secondary" data-action="back-list" data-key="${this.escape(data.key)}">${this.icon("back", 14)}${__("Back to List")}</button>
					${create_actions}
					${lifecycle_actions}
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
				${activity}
			</div>
		`);
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

		return `<aside class="duxp-card duxp-activity-panel ${this.state.activity_collapsed ? "is-collapsed" : ""}">
			<header class="duxp-activity-header"><div><h3>${__("Activity")}</h3><span>${this.escape(summary)}</span></div>
				<button class="duxp-icon-btn duxp-activity-toggle" data-action="toggle-activity" aria-label="${__("Toggle Activity")}" aria-expanded="${this.state.activity_collapsed ? "false" : "true"}">${this.icon("down", 14)}</button></header>
			${attachments ? `<div class="duxp-activity-attachments">${attachments}</div>` : ""}
			<div class="duxp-activity-list">${timeline || `<div class="duxp-activity-empty">${this.icon("history", 24)}<span>${__("No activity yet")}</span></div>`}</div>
		</aside>`;
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
		const details = [];
		(data.changed || []).forEach((change) => {
			const fieldname = change[0];
			const label = frappe.meta.get_label(doctype, fieldname) || frappe.model.unscrub(fieldname || __("Field"));
			details.push(`${label}: ${this.activity_value(change[1])} → ${this.activity_value(change[2])}`);
		});
		(data.added || []).forEach((change) => details.push(__("Added row in {0}", [frappe.model.unscrub(change[0] || __("Items"))])));
		(data.removed || []).forEach((change) => details.push(__("Removed row from {0}", [frappe.model.unscrub(change[0] || __("Items"))])));
		(data.row_changed || []).forEach((change) => details.push(__("Updated row in {0}", [frappe.model.unscrub(change[0] || __("Items"))])));
		return details.length ? details : [__("Document values updated")];
	}

	activity_value(value) {
		if (value === null || value === undefined || value === "") return "—";
		if (typeof value === "object") {
			try { return JSON.stringify(value); } catch (error) { return String(value); }
		}
		return String(value);
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

	async open_document_form(key, name = null) {
		const item = this.items[key];
		if (!item || item.kind !== "document") return;
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
		const filters = Object.assign({}, action.filters || {});
		const company_control = this.form_controls && this.form_controls.company;
		const company = company_control && company_control.get_value ? company_control.get_value() : null;
		if (action.company_filter && !company) {
			frappe.msgprint({
				title: __("Company Required"),
				message: __("Please select Company before fetching Material Requests."),
				indicator: "orange",
			});
			return;
		}
		if (company) filters.company = company;

		if (action.multiple && frappe.ui.form.MultiSelectDialog) {
			const dialog = new frappe.ui.form.MultiSelectDialog({
				doctype: action.source_doctype,
				target: { doc: { company } },
				date_field: action.date_field || undefined,
				setters: action.setters || {},
				get_query: () => ({ filters }),
				add_filters_group: 1,
				allow_child_item_selection: action.allow_child_item_selection,
				child_fieldname: action.child_fieldname,
				child_columns: action.child_columns || [],
				size: "extra-large",
				action: (selections, args) => {
					const source_names = [...new Set(selections || [])];
					if (!source_names.length) {
						frappe.msgprint(__("Please select at least one Material Request."));
						return;
					}
					dialog.dialog.hide();
					this.open_mapped_documents_form(target_key, source_key, source_names, args, company);
				},
			});
			return;
		}

		frappe.prompt([
			{
				fieldname: "source_name",
				label: action.label,
				fieldtype: "Link",
				options: action.source_doctype,
				reqd: 1,
				get_query: () => ({ filters }),
			},
		], (values) => this.open_mapped_document_form(target_key, source_key, values.source_name),
		__("Get Items From"), __("Get Items"));
	}

	render_document_form(data) {
		this.form_data = data;
		this.form_controls = {};
		this.table_controls = {};
		(data.tables || []).forEach((table) => {
			if (table.reqd && !(table.rows || []).length && data.can_save) table.rows = [{}];
		});

		let panel_index = 1;
		const before_sections = (data.sections || [])
			.filter((section) => section.position !== "after_tables")
			.map((section) => this.render_form_section(section, panel_index++))
			.join("");
		const tables = (data.tables || [])
			.map((table) => this.render_form_table(table, panel_index++))
			.join("");
		const after_sections = (data.sections || [])
			.filter((section) => section.position === "after_tables")
			.map((section) => this.render_form_section(section, panel_index++))
			.join("");

		const get_items_from = (data.get_items_from || []).map((action) => `
			<button class="duxp-btn duxp-btn-secondary" data-action="get-items-from"
				data-target-key="${this.escape(action.target_route_key)}" data-source-key="${this.escape(action.source_route_key)}">
				${this.icon("download", 14)}${this.escape(action.label)}</button>
		`).join("");

		const form_notice = data.docstatus === 2
			? __("This document is cancelled and read-only. Use Amend from the document view to make a corrected copy.")
			: data.docstatus === 1 && data.can_update_after_submit
				? __("This document is submitted. Only fields marked Allow on Submit by ERPNext are editable.")
				: data.docstatus === 1
					? __("Submitted documents are read-only. Use the available Stop, Close or Cancel action; cancel and amend to change normal fields.")
					: __("This form stays inside Dux Portal. Native ERPNext permissions, validations, stock and accounting rules run when you save.");

		this.$content.html(`
			<section class="duxp-form-toolbar">
				${get_items_from ? `<div class="duxp-get-items"><span>${__("Get Items From")}</span>${get_items_from}</div>` : ""}
				<div class="duxp-head-actions">
					<button class="duxp-btn duxp-btn-secondary" data-action="form-back">${this.icon("back", 14)}${__("Back")}</button>
					${data.can_submit ? `<button class="duxp-btn duxp-btn-secondary" data-action="submit-form">${this.icon("check", 14)}${__("Save & Submit")}</button>` : ""}
					${data.can_save ? `<button class="duxp-btn duxp-btn-primary" data-action="save-form">${this.icon("save", 14)}${data.can_update_after_submit ? __("Update") : __("Save Draft")}</button>` : ""}
				</div>
			</section>
			<div class="duxp-form-notice">${this.icon("shield", 15)}<span>${form_notice}</span></div>
			${before_sections}
			${tables}
			${after_sections}
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
		this.sync_material_request_required_dates();
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

	sync_material_request_required_dates() {
		if (!this.form_data || this.form_data.key !== "material_request") return;
		const required_by = this.form_controls.schedule_date
			? this.form_controls.schedule_date.get_value()
			: "";
		(this.table_controls.items || []).forEach((controls) => {
			if (controls.schedule_date) controls.schedule_date.set_value(required_by || "");
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

	handle_parent_control_change(fieldname, value) {
		if (this.form_data && this.form_data.key === "material_request") {
			const transaction_date = this.form_controls.transaction_date
				? this.form_controls.transaction_date.get_value()
				: "";
			const required_by_control = this.form_controls.schedule_date;
			if (required_by_control && required_by_control.get_value()
				&& transaction_date && required_by_control.get_value() < transaction_date) {
				required_by_control.set_value("");
				frappe.show_alert({
					message: __("Required By cannot be earlier than Transaction Date."),
					indicator: "orange",
				});
			}
			if (fieldname === "schedule_date") this.sync_material_request_required_dates();
			this.refresh_form_date_constraints();
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

	async handle_table_control_change(table_fieldname, row_index, field, value) {
		if (field.fieldname === "item_code") {
			await this.apply_item_defaults(table_fieldname, row_index, value);
		} else if (field.options === "Warehouse") {
			await this.refresh_row_stock(table_fieldname, row_index);
		}
		this.refresh_form_dependencies();
	}

	header_warehouse_value() {
		for (const fieldname of ["set_warehouse", "source_warehouse", "from_warehouse", "to_warehouse", "target_warehouse"]) {
			const control = this.form_controls[fieldname];
			if (control && control.get_value()) return control.get_value();
		}
		return "";
	}

	async apply_item_defaults(table_fieldname, row_index, item_code) {
		if (!item_code) return;
		try {
			const controls = (this.table_controls[table_fieldname] || [])[row_index] || {};
			const row_warehouse_control = controls.warehouse || controls.source_warehouse || controls.s_warehouse || controls.t_warehouse;
			const warehouse = row_warehouse_control && row_warehouse_control.get_value()
				? row_warehouse_control.get_value()
				: this.header_warehouse_value();
			const defaults = await this.call("dux_indent_master.portal.get_portal_item_defaults", {
				item_code,
				company: this.form_company_value(),
				warehouse,
			});
			["item_name", "description", "stock_uom", "uom", "conversion_factor", "rate", "basic_rate", "warehouse", "source_warehouse", "stock_qty"].forEach((fieldname) => {
				const control = controls[fieldname];
				if (!control || defaults[fieldname] === undefined) return;
				if (fieldname === "stock_qty" || !control.get_value()) control.set_value(defaults[fieldname]);
			});
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
		if (this.form_data.key === "material_request" && table_fieldname === "items") {
			row.schedule_date = this.form_controls.schedule_date
				? this.form_controls.schedule_date.get_value()
				: "";
		}
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
				await this.call("dux_indent_master.portal.submit_portal_document", {
					route_key: this.form_data.key,
					name: result.name,
				});
				frappe.show_alert({ message: `${result.name} ${__("submitted")}`, indicator: "green" });
				await this.open_document_detail(this.form_data.key, result.name);
			} else {
				frappe.show_alert({ message: `${result.name} ${__("saved")}`, indicator: "green" });
				await this.open_document_form(this.form_data.key, result.name);
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
		frappe.confirm(__("Save the latest changes and submit this document?"), () => this.save_portal_form(true));
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
			<button class="duxp-approval-item duxp-native-row" data-doctype="${this.escape(row.doctype)}" data-name="${this.escape(row.name)}">
				<span class="duxp-approval-icon">${this.icon("check", 15)}</span><span><strong>${this.escape(row.name)}</strong><small>${this.escape(row.doctype)} · ${this.format_date(row.modified)}</small></span>${this.status_tag(row.status)}
			</button>
		`).join("")}</div>`;
	}

	change_page(direction) {
		if (!this.current_list) return;
		const page_length = Number(this.current_list.page_length || 20);
		this.state.start = Math.max(0, Number(this.state.start || 0) + direction * page_length);
		this.open_document_list(this.state.route_key, true);
	}

	refresh_current() {
		if (this.state.view === "form") this.open_document_form(this.state.route_key, this.state.document_name);
		else if (this.state.view === "detail") this.open_document_detail(this.state.route_key, this.state.document_name);
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
		if (column.fieldname === "status" || column.fieldname === "row_status") return this.status_tag(value);
		if (column.fieldname === "disabled") return this.status_tag(Number(value) ? __("Disabled") : __("Active"));
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
		if (/(cancel|disabled|rejected|overdue|unpaid|shortage)/.test(normalized)) tone = "danger";
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
		};
		return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.document}</svg>`;
	}
}
