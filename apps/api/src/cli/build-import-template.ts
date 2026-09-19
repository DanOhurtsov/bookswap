import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildLibraryImportTemplate } from '../library/import/library-import-template.builder'

/**
 * Regenerates the downloadable `.xlsx` import template.
 *
 * The template is a committed binary asset, exactly as the CSV one is, because
 * the web app serves it as a static file. A binary cannot be reviewed in a
 * diff, so it is written by this script rather than by hand — and
 * `library-import-template.spec.ts` reads the committed file back with the
 * production reader, so an asset that drifts from the contract fails the build
 * instead of reaching a person.
 */
const TEMPLATE_PATH = resolve(__dirname, '../../../web/public/library-import-template.xlsx')

async function main(): Promise<void> {
  await writeFile(TEMPLATE_PATH, await buildLibraryImportTemplate())
  process.stdout.write(`Written: ${TEMPLATE_PATH}\n`)
}

void main()
