# @jeirslab/paypal-client

Typed PayPal client for the hackathon projects. Config comes from env only (`targetFromEnv`).

SDK or fetch: `@paypal/paypal-server-sdk` 2.5.0 only knows `Environment.Production | Sandbox`; it has no
custom base URL (checked in `dist/esm/types/configuration.d.ts`). So **Orders and Transaction Search use the SDK
for `sandbox` and `live`, and fetch for `mock`**; Payouts and Disputes always use fetch (the SDK has no
controllers for them). Both paths return the REST (snake_case) types in `src/types.ts`; the SDK path converts
camelCase models with `src/casing.ts`. The SDK path has not been run against the real sandbox (no credentials
exist yet); the mock path is covered by the tests.
