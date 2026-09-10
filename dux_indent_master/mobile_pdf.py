import secrets
from urllib.parse import urlencode

import frappe
from frappe import _, cstr


MOBILE_PDF_TOKEN_TTL_SECONDS = 300


@frappe.whitelist()
def download_document_pdf(
    doctype,
    name,
    print_format=None,
    no_letterhead=0,
    letterhead=None,
    language=None,
    pdf_generator=None,
    disposition="attachment",
):
    # Serve a permission-checked PDF directly from an authenticated form action.
    from frappe.translate import print_language
    from frappe.www.printview import validate_print_permission

    disposition = cstr(disposition).lower()
    if disposition not in {"attachment", "inline"}:
        frappe.throw(_("Invalid PDF response mode."))

    doc = frappe.get_doc(doctype, name)
    validate_print_permission(doc)
    with print_language(language or None):
        pdf_file = frappe.get_print(
            doctype,
            name,
            print_format or None,
            doc=doc,
            as_pdf=True,
            letterhead=letterhead or None,
            no_letterhead=frappe.utils.cint(no_letterhead),
            pdf_generator=pdf_generator or "wkhtmltopdf",
        )

    safe_name = cstr(name).replace(" ", "-").replace("/", "-")
    frappe.local.response.filename = f"{safe_name}.pdf"
    frappe.local.response.filecontent = pdf_file
    if disposition == "inline":
        frappe.local.response.type = "pdf"
    else:
        frappe.local.response.content_type = "application/pdf"
        frappe.local.response.display_content_as = "attachment"
        frappe.local.response.type = "download"


@frappe.whitelist()
def create_mobile_pdf_download(
    doctype,
    name,
    print_format=None,
    no_letterhead=0,
    letterhead=None,
    language=None,
    pdf_generator=None,
    disposition="attachment",
):
    """Return a short-lived real PDF URL for Android WebView downloads."""
    from frappe.www.printview import validate_print_permission

    doc = frappe.get_doc(doctype, name)
    validate_print_permission(doc)

    disposition = cstr(disposition).lower()
    if disposition not in {"attachment", "inline"}:
        frappe.throw(_("Invalid PDF response mode."))

    token = secrets.token_urlsafe(32)
    payload = {
        "doctype": cstr(doctype),
        "name": cstr(name),
        "print_format": cstr(print_format),
        "no_letterhead": int(frappe.utils.cint(no_letterhead)),
        "letterhead": cstr(letterhead),
        "language": cstr(language),
        "pdf_generator": cstr(pdf_generator),
        "disposition": disposition,
        "requested_by": frappe.session.user,
    }
    frappe.cache().set_value(
        f"mobile_pdf_download:{token}",
        frappe.as_json(payload),
        expires_in_sec=MOBILE_PDF_TOKEN_TTL_SECONDS,
    )
    query = urlencode({"token": token})
    return {
        "url": frappe.utils.get_url(
            f"/api/method/dux_indent_master.mobile_pdf.download_mobile_pdf?{query}"
        ),
        "filename": f"{cstr(name).replace('/', '-')}.pdf",
        "expires_in": MOBILE_PDF_TOKEN_TTL_SECONDS,
    }


@frappe.whitelist(allow_guest=True)
def download_mobile_pdf(token):
    """Serve one PDF attachment using a short-lived permission-checked token."""
    cache_key = f"mobile_pdf_download:{cstr(token)}"
    raw_payload = frappe.cache().get_value(cache_key)
    if not raw_payload:
        frappe.throw(
            _("This PDF download link has expired. Please tap Download PDF again.")
        )

    payload = frappe.parse_json(cstr(raw_payload))
    if not payload or not payload.get("doctype") or not payload.get("name"):
        frappe.cache().delete_value(cache_key)
        frappe.throw(_("Invalid PDF download link."))

    from frappe.translate import print_language

    try:
        doc = frappe.get_doc(payload["doctype"], payload["name"])
        frappe.flags.ignore_print_permissions = True
        with print_language(payload.get("language") or None):
            pdf_file = frappe.get_print(
                payload["doctype"],
                payload["name"],
                payload.get("print_format") or None,
                doc=doc,
                as_pdf=True,
                letterhead=payload.get("letterhead") or None,
                no_letterhead=frappe.utils.cint(payload.get("no_letterhead")),
                pdf_generator=payload.get("pdf_generator") or "wkhtmltopdf",
            )
    finally:
        frappe.flags.ignore_print_permissions = False

    frappe.cache().delete_value(cache_key)
    safe_name = cstr(payload["name"]).replace(" ", "-").replace("/", "-")
    frappe.local.response.filename = f"{safe_name}.pdf"
    frappe.local.response.filecontent = pdf_file
    if payload.get("disposition") == "inline":
        frappe.local.response.type = "pdf"
    else:
        frappe.local.response.content_type = "application/pdf"
        frappe.local.response.display_content_as = "attachment"
        frappe.local.response.type = "download"
