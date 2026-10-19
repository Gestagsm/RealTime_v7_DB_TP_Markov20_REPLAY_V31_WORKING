# Connect GitHub Pages to the Windows Server database

The Pages website and the Node/PostgreSQL backend are separate services.
GitHub Pages cannot proxy `/api` requests to a Windows Server by itself. The
frontend deployment workflow reads the repository Actions variable
`ITR_API_BASE` and writes it into `frontend/api-config.js` at deploy time.
Set it to the public HTTPS **origin** for the Windows Server API, without an
`/api` suffix. Do not put passwords or database connection strings in this
variable.

## Windows Server

1. Keep PostgreSQL and the market database on the Windows Server. Do not open
   PostgreSQL port 5432 to the public Internet. The backend should connect to
   `127.0.0.1:5432` when PostgreSQL is on the same server.
2. In the backend directory, create or update the server's private `.env`
   using `.env.example` as a reference. Preserve its existing database
   credentials and market-folder paths. Set `PORT=4001` and add
   `https://gestagsm.github.io` to `CORS_ORIGIN`.
3. Install IIS URL Rewrite and Application Request Routing (ARR), and enable
   ARR proxying. Place `frontend/web.config` in the IIS site's root so `/api/*`
   is reverse-proxied to `http://127.0.0.1:4001/api/*`. Use a valid HTTPS
   certificate for the public server origin.
4. Run the backend as a Windows service or another supervised process so it
   starts again after a reboot. Do not expose port 4001 publicly; IIS should
   be the public HTTPS entry point.
5. On the server itself, request `http://127.0.0.1:4001/api/health`. It must
   return JSON with `"ok":true` and `"postgres":"connected"`. Then request
   `https://YOUR-SERVER-ORIGIN/api/health` from a browser outside the server;
   it must return the same healthy response.

## GitHub Pages

In the repository's **Settings → Secrets and variables → Actions → Variables**,
create the repository variable:

- Name: `ITR_API_BASE`
- Value: `https://YOUR-SERVER-ORIGIN` (HTTPS origin only; no trailing `/api`)

Re-run **Deploy frontend to GitHub Pages** from the Actions tab. The three
trading sections load `api-config.js` before making database requests. If the
variable is absent, the UI reports that the backend URL must be configured
instead of sending API requests to the static GitHub Pages host.

The backend must allow the exact `https://gestagsm.github.io` origin in
`CORS_ORIGIN`. After deployment, the browser's Network panel should show
`GET https://YOUR-SERVER-ORIGIN/api/health` returning 200 with PostgreSQL
connected, and tick/import requests should use that same server origin.
