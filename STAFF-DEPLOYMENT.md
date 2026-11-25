# Staff subdomain deployment

The same build selects the staff interface on `app.sparkdv.com` and the storefront on other production hosts. `app.localhost` provides a local staff preview. The staff root opens `/login` when signed out and `/dashboard` for authorized staff. Customer accounts are denied staff screens. Existing API checks still enforce staff authorization.

## Hosting

Attach `app.sparkdv.com` to the verified SPARK-DV Vercel project after deploying this source. The existing SPA rewrite in `vercel.json` supports direct dashboard and order URLs. The deployment needs `AUTH_DATABASE_URL`, `AUTH_DATABASE_TOKEN`, `AUTH_JWT_SECRET`, and `ORDER_STAFF_USER_IDS`. Reuse the intended application's existing database configuration; do not import the local development database.

## DNS

The observed authoritative nameservers are `ns15.domaincontrol.com` and `ns16.domaincontrol.com`. In GoDaddy, add only the `app` record using the exact CNAME target supplied by Vercel after adding the project domain. Preserve apex, www, email, and other existing records. No DNS changes have been made yet.

## Verification

Verify HTTPS, anonymous login redirect, staff sign-in, customer denial, dashboard refresh, staff order APIs, and sign-out on the deployed host. Cookies remain host-only, so staff sign in separately on the subdomain.

Dashboard metrics and layout role selection are currently demonstration data, explicitly labeled in the interface. The connected order page retains existing authorization; assigned per-role permissions beyond order staff have not been implemented.
