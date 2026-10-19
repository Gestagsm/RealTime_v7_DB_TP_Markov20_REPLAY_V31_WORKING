# RealTime v7 DB TP Markov20 Replay

Source code for the RealTime order-flow project.

- `frontend/` contains the browser interface.
- `backend/` contains the Node.js API and database integration.
- `admin/` contains the administration portal.
- `bridge/` contains the Excel/Python integration.

Local environment files, market data, workbooks, database exports, runtime
state, and backup copies are intentionally excluded from this repository.
Keep credentials in local environment files and do not commit them.

## Windows Server backend

The GitHub Pages site is static. To load the shared Windows Server PostgreSQL
database, configure the backend on that server and set the repository Actions
variable `ITR_API_BASE` to its public HTTPS origin (for example,
`https://api.example.com`, without `/api`). See
[`WINDOWS-SERVER-DEPLOYMENT.md`](WINDOWS-SERVER-DEPLOYMENT.md) for the server,
database, IIS reverse-proxy, and CORS requirements.
