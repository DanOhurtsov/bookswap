import next from 'eslint-config-next/core-web-vitals'
import base from '../../eslint.config.mjs'
import { buildFeatureBoundaryConfig } from './eslint-feature-boundaries.mjs'

// TD-01: features that currently exist under `features/`, one path per feature relative to
// this file's directory (apps/web). A feature earns an entry here once it exists — this list
// is not a place to pre-declare features that don't exist yet.
const KNOWN_FEATURES = [
  'features/catalog/add-book',
  'features/catalog/correction',
  'features/library/csv-import',
  'features/library/activation',
  'features/library/own-library',
  'features/network',
]

export default [
  ...base,
  ...next,
  {
    ignores: ['.next/**', 'next-env.d.ts'],
  },

  // TD-01: CONVENTIONS.md §1.3 — a feature exposes only what its index.ts / index.client.ts
  // re-exports. Importing an internal file (components/hooks/api/model/lib) from outside the
  // feature is forbidden; this doubles as the server/client boundary from §2.3–2.4, since the
  // only sanctioned entry point into a feature's client-side code is its index.client.ts.
  // See eslint-feature-boundaries.mjs for why this is a generator function rather than an
  // inline `.map`, and for the multi-feature composition it depends on.
  ...buildFeatureBoundaryConfig(KNOWN_FEATURES),

  // TD-01: CONVENTIONS.md §1.3 — `components/ui` and `lib` are the design system and shared
  // utilities, with zero business logic; the dependency is one-directional (features may use
  // ui/lib, never the reverse).
  {
    files: ['components/ui/**/*.ts', 'components/ui/**/*.tsx', 'lib/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/**'],
              message:
                'components/ui and lib must not depend on features — the dependency runs one way only (CONVENTIONS.md §1.3).',
            },
          ],
        },
      ],
    },
  },
]
