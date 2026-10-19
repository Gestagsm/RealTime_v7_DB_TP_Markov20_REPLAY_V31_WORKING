# Connect GitHub Pages to the Windows Server database

The Pages website and the Node/PostgreSQL backend are separate services.
GitHub Pages cannot proxy `/api` requests to a Windows Server by itself. The
frontend deployment workflow reads the repository Actions variable
`ITR_API_BASE` and writes it into `frontend/api-config.js` at deploy time.
Set it to the public HTTPS API base, without the final `/api` suffix. For the
Cloudflare Tunnel hostname used by this site, the value is
`https://api.iibshe.com`.
Do not put passwords or database connection strings in this variable.

## Windows Server

1. Keep PostgreSQL and the market database on the Windows Server. Do not open
   PostgreSQL port 5432 to the public Internet. The backend should connect to
   `127.0.0.1:5432` when PostgreSQL is on the same server.
2. In the backend directory, create or update the server's private `.env`
   using `.env.example` as a reference. Preserve its existing database
   credentials and market-folder paths. Set `PORT=4001`, set a strong
   `API_PASSWORD` for user `realtime-web`, and include
   `https://gestagsm.github.io` in `CORS_ORIGIN` and keep `HOST=127.0.0.1`.
   The password is never stored
   in GitHub; the site prompts users for it when they first load database data.
3. In the existing Cloudflare Tunnel, add a public hostname for
   `api.iibshe.com` whose service is `http://127.0.0.1:4001`. Do not create a
   second tunnel or change the existing `iibshe.com` employee-site route. The
   tunnel carries API traffic to the loopback-only backend; do not expose port
   4001 publicly. If using IIS as an alternative proxy, install URL Rewrite and
   Application Request Routing (ARR), enable ARR proxying, and use
   `frontend/web.config`.
4. Run the backend as a Windows service or another supervised process so it
   starts again after a reboot. Do not expose port 4001 publicly. The existing
   Cloudflare Tunnel is the public HTTPS entry point.
5. On the server itself, request `http://127.0.0.1:4001/api/health`. It must
   return JSON with `"ok":true` and `"postgres":"connected"`. Then request
   `https://YOUR-SERVER-ORIGIN/api/health` from a browser outside the server;
   it must return the same healthy response.

## GitHub Pages

In the repository's **Settings → Secrets and variables → Actions → Variables**,
create the repository variable:

- Name: `ITR_API_BASE`
- Value: `https://api.iibshe.com` (HTTPS URL without the final `/api`)

Re-run **Deploy frontend to GitHub Pages** from the Actions tab. The three
trading sections load `api-config.js` before making database requests. If the
variable is absent, the UI reports that the backend URL must be configured
instead of sending API requests to the static GitHub Pages host.

The backend's Basic authentication protects reads and writes; do not remove
it or expose PostgreSQL port 5432. If using IIS as an alternative proxy, the
IIS alias `/terminal-api/api/*` proxies to the backend's `/api/*` routes. The
backend must allow the exact
`https://gestagsm.github.io` origin in `CORS_ORIGIN`. After deployment, the
browser's Network panel should show
`GET https://api.iibshe.com/api/health` returning 200 with PostgreSQL
connected, and tick/import requests should use that same API base.
