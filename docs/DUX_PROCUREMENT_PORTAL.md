# Dux Procurement Portal

The Dux Procurement Portal is a responsive Frappe Desk page based on the
approved procurement UI preview. It is packaged inside `dux_indent_master`, so
the page, APIs and permissions move together when the custom app is installed
on another site.

## URL

Sign in to Desk and open:

```text
https://apps.duxdigitech.in/app/dux-indent-portal
```

## Screen mapping

| Portal entry | Frappe target |
| --- | --- |
| Dashboard | Live permission-aware counts, recent activity and workflow actions |
| Material Requests | Material Request |
| Purchase Orders | Purchase Order |
| Purchase Receipts | Purchase Receipt |
| Purchase Invoices | Purchase Invoice |
| Stock Entries | Stock Entry |
| Payment Entries | Payment Entry |
| Delivery Challans | Delivery Challan |
| Delivery Challan Receipts | Delivery Challan records in received/partial/pending receipt states |
| Dux Indent Master | Dux Indent Master, including item, purchase and delivery child tracking |
| Suppliers | Supplier |
| Items | Item |
| Buying Settings | Native Buying Settings form |
| Accounts Payable | Native Accounts Payable report |
| Purchase Register | Native Purchase Register report |
| Item-wise Purchase Register | Native Item-wise Purchase Register report |

The original preview treated Delivery Challan Receipt as a separate screen.
The installed application already records receipt state on Delivery Challan,
so the portal presents a filtered Delivery Challan view instead of inventing a
second DocType.

## Security and business rules

- Every backend method requires an authenticated user.
- Lists use Frappe's permission-aware query API.
- Detail reads check both DocType and document-level permission.
- Portal routes, fields and filters are server allowlisted.
- Create and edit actions render inside the portal using allowlisted live
  DocType metadata.
- Portal forms support Link/Select/Date/Amount controls, item/tax/reference
  child rows, Save Draft and Save & Submit.
- Saves and submissions run the native DocType controller. Existing
  validations, workflows, naming, accounting and stock rules therefore remain
  authoritative.
- Users only see navigation entries and actions permitted by their roles.

## Portal-native forms

Portal forms are configured for Material Request, Purchase Order, Purchase
Receipt, Purchase Invoice, Stock Entry, Payment Entry, Delivery Challan, Dux
Indent Master, Supplier and Item. Delivery Challan Receipt uses the existing
Delivery Challan record and is available as a portal edit/view form.

The form layer exposes the operational fields and child tables intentionally
allowlisted in `portal.py`. This keeps the interface focused and prevents a
client from sending arbitrary DocType fields. Additional business fields can be
added to the relevant `FORM_CONFIG` entry without changing the renderer.

## Production install or update

Install ERPNext and `delivery_challan_custom` first, then run:

```bash
cd /home/frappe/frappe-bench
bench get-app <repository-url> --branch develop
bench --site <site-name> install-app dux_indent_master
bench --site <site-name> migrate
bench build --app dux_indent_master
bench --site <site-name> clear-cache
bench restart
```

For an existing app installation, pull the intended release/commit and run the
last four commands. Take a database and files backup before every production
update.

## Implementation files

- `dux_indent_master/portal.py`: secure dashboard, list, detail and form APIs.
- `dux_indent_master/dux_indent_master/page/dux_procurement_portal/`: Page JSON,
  JavaScript and scoped responsive CSS.
- `dux_indent_master/hooks.py`: app dependencies and existing document hooks.
