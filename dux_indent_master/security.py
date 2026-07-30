from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cstr


RESTRICTED_ROLE = "DUX Indent MPUSIP 7C User"
INDENT_DOCTYPE = "Dux Indent Master"
INDENT_ROUTE_KEY = "dux_indent_master"
SITE_DOCTYPE = "Site Project"
SITE_FIELD = "custom_site_project"
REQUIRED_SITE = "MPUSIP - 7C"

# Second group: MPUSIP-7C Supervisors. Same Site lock as the first group but
# with access to Material Request too and NO owner filter (they see entries
# created by all users for the Site).
SUPERVISOR_ROLE = "DUX Indent MPUSIP 7C Supervisor"
MR_DOCTYPE = "Material Request"
MR_ROUTE_KEY = "material_request"
SUPERVISOR_ROUTE_KEYS = (INDENT_ROUTE_KEY, MR_ROUTE_KEY)
SUPERVISOR_DOCTYPES = (INDENT_DOCTYPE, MR_DOCTYPE)


def is_restricted_portal_user(user=None):
    user = user or frappe.session.user
    roles = frappe.get_roles(user) if user and user != "Guest" else []
    return bool(
        user
        and user not in ("Guest", "Administrator")
        and "System Manager" not in roles
        and RESTRICTED_ROLE in roles
    )


def get_restricted_site(user=None):
    """Resolve the role user's one portal Site from editable User Permission rows."""
    user = user or frappe.session.user
    if not is_restricted_portal_user(user):
        return None

    rows = frappe.get_all(
        "User Permission",
        filters={
            "user": user,
            "allow": SITE_DOCTYPE,
            "applicable_for": INDENT_DOCTYPE,
        },
        fields=["for_value"],
        order_by="for_value asc",
    )
    allowed_sites = sorted({cstr(row.for_value).strip() for row in rows if row.for_value})
    if allowed_sites != [REQUIRED_SITE] or not frappe.db.exists(SITE_DOCTYPE, REQUIRED_SITE):
        frappe.throw(
            _(
                "Your DUX Indent Portal Site permission is not configured correctly. "
                "Contact an administrator."
            ),
            frappe.PermissionError,
        )
    return REQUIRED_SITE


def is_supervisor_portal_user(user=None):
    user = user or frappe.session.user
    roles = frappe.get_roles(user) if user and user != "Guest" else []
    return bool(
        user
        and user not in ("Guest", "Administrator")
        and "System Manager" not in roles
        and SUPERVISOR_ROLE in roles
    )


def is_site_scoped_portal_user(user=None):
    return is_restricted_portal_user(user) or is_supervisor_portal_user(user)


def get_supervisor_site(user=None):
    """Resolve the supervisor's one portal Site from editable User Permission rows."""
    user = user or frappe.session.user
    if not is_supervisor_portal_user(user):
        return None

    rows = frappe.get_all(
        "User Permission",
        filters={"user": user, "allow": SITE_DOCTYPE},
        fields=["for_value", "applicable_for"],
    )
    allowed_sites = sorted(
        {
            cstr(row.for_value).strip()
            for row in rows
            if row.for_value
            and (not row.applicable_for or row.applicable_for in SUPERVISOR_DOCTYPES)
        }
    )
    if allowed_sites != [REQUIRED_SITE] or not frappe.db.exists(SITE_DOCTYPE, REQUIRED_SITE):
        frappe.throw(
            _(
                "Your DUX Indent Portal Site permission is not configured correctly. "
                "Contact an administrator."
            ),
            frappe.PermissionError,
        )
    return REQUIRED_SITE


def get_scoped_site(user=None):
    if is_restricted_portal_user(user):
        return get_restricted_site(user)
    if is_supervisor_portal_user(user):
        return get_supervisor_site(user)
    return None


def allowed_portal_route_keys(user=None):
    """Route keys a site-scoped user may open, or None when unrestricted."""
    if is_supervisor_portal_user(user):
        return set(SUPERVISOR_ROUTE_KEYS)
    if is_restricted_portal_user(user):
        return {INDENT_ROUTE_KEY}
    return None


def require_restricted_route(route_key):
    if is_restricted_portal_user() and route_key != INDENT_ROUTE_KEY:
        frappe.throw(
            _("You can access only Material Indent in DUX Indent Portal."),
            frappe.PermissionError,
        )
    if is_supervisor_portal_user() and route_key not in SUPERVISOR_ROUTE_KEYS:
        frappe.throw(
            _("You can access only Material Indent and Material Request in DUX Indent Portal."),
            frappe.PermissionError,
        )


def get_restricted_indent_filters():
    if is_restricted_portal_user():
        return {
            SITE_FIELD: get_restricted_site(),
            "owner": frappe.session.user,
        }
    if is_supervisor_portal_user():
        # Site lock only -- supervisors see entries from all users for the Site.
        return {SITE_FIELD: get_supervisor_site()}
    return {}


def assert_restricted_indent_access(doc):
    """Reject cross-owner/cross-Site access without disclosing document details."""
    if is_restricted_portal_user():
        if (
            not doc
            or doc.doctype != INDENT_DOCTYPE
            or cstr(doc.get(SITE_FIELD)).strip() != get_restricted_site()
            or doc.owner != frappe.session.user
        ):
            frappe.throw(
                _(
                    "You can access only Material Indent entries created by your User ID "
                    "for Site {0}."
                ).format(REQUIRED_SITE),
                frappe.PermissionError,
            )
        return doc
    if is_supervisor_portal_user():
        if (
            not doc
            or doc.doctype not in SUPERVISOR_DOCTYPES
            or cstr(doc.get(SITE_FIELD)).strip() != get_supervisor_site()
        ):
            frappe.throw(
                _(
                    "You can access only Material Indent and Material Request entries "
                    "for Site {0}."
                ).format(REQUIRED_SITE),
                frappe.PermissionError,
            )
        return doc
    return doc


def deny_restricted_non_indent_operation():
    if is_site_scoped_portal_user():
        frappe.throw(
            _("This action is not available in your DUX Indent Portal access."),
            frappe.PermissionError,
        )
