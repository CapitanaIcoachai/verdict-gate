# Third-party licenses

Verdict Gate is MIT licensed. The Python parts (verifiers, schema tools, MCP server) use the standard library only. The `upgrade` verifier uses two npm packages, pinned in `verifiers/upgrade/package-lock.json` (checked 26 October 2026):

| Package | Version | License |
|---|---|---|
| typescript | 5.9.3 | Apache-2.0 |
| semver | 7.8.5 | ISC |

The demo application in `demo-app/node-service` lists nine deliberately old npm packages (axios, chalk, commander, express, glob, lodash, node-fetch, rimraf, uuid) as *analysis targets*. They are not bundled or redistributed here; they are installed only when you run the demo, under their own licenses.

The CI templates refer to GitLab features (CI/CD components, Duo agents and flows); those are services, not redistributed code.
