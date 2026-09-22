# Security policy

Do not commit service URLs, tokens, internal hostnames, or deployment-specific
paths. Configure the extension only through `PI_LAYA_BASE_URL`,
`PI_LAYA_API_TOKEN`, or the generic Pi secret fallback.

The extension treats Laya output as advisory data, never as authorization to
perform an action. Keep automatic integrations disabled unless a separate,
tested adapter validates complete evidence and action arguments.

Run `npm run privacy:check` before packaging or publishing. Report a suspected
credential exposure privately to the package maintainer and rotate the exposed
credential immediately.
