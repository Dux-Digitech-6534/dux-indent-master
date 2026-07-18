### Dux Indent Master

Dux Indent Master app

It includes the **Dux Procurement Portal**, a responsive Desk page that brings
the supported buying, stock, accounts and indent workflows into one
permission-aware interface. Create and edit forms stay inside the portal and
support draft saving, child rows and native document submission.

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch develop
bench install-app dux_indent_master
bench --site your-site migrate
bench build --app dux_indent_master
bench --site your-site clear-cache
```

Open the portal at `/app/dux-indent-portal` after signing in. ERPNext and
`delivery_challan_custom` must be installed before this app.

See [docs/DUX_PROCUREMENT_PORTAL.md](docs/DUX_PROCUREMENT_PORTAL.md) for the
screen mapping, permission model and production update procedure.

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/dux_indent_master
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

mit
