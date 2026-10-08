/**
 * Side-effect import: must be the FIRST import of a file that needs the guest-loans
 * flag on. `ConfigModule.forRoot({ validate })` reads `process.env` when `AppModule`
 * is first evaluated, so the flag has to be set before `auth.helpers` is loaded.
 * Synthetic-only is required by the env validation outside production (D2 safeguard).
 */
process.env.GUEST_LOANS_ENABLED = 'true'
process.env.GUEST_LOANS_SYNTHETIC_ONLY = 'true'
