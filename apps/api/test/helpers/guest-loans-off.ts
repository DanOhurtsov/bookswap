/** Side-effect import, first in the file: pins the flag off regardless of the developer's `.env`. */
process.env.GUEST_LOANS_ENABLED = 'false'
process.env.GUEST_LOANS_SYNTHETIC_ONLY = 'false'
