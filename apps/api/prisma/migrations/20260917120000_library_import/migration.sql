-- CreateEnum
CREATE TYPE "LibraryImportStatus" AS ENUM ('DRAFT', 'EXPIRED', 'COMMITTED');

-- CreateEnum
CREATE TYPE "LibraryImportRowStatus" AS ENUM ('READY_EXISTING_EDITION', 'READY_CREATE_CHAIN', 'NEEDS_REVIEW', 'INVALID', 'SKIPPED');

-- CreateTable
CREATE TABLE "LibraryImport" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "status" "LibraryImportStatus" NOT NULL DEFAULT 'DRAFT',
    "rowCount" INTEGER NOT NULL,
    "copyCount" INTEGER NOT NULL,
    "createdCopyCount" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryImportRow" (
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "LibraryImportRowStatus" NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "LibraryImportRow_pkey" PRIMARY KEY ("importId","rowNumber")
);

-- CreateIndex
CREATE INDEX "LibraryImport_ownerId_status_idx" ON "LibraryImport"("ownerId", "status");

-- CreateIndex
CREATE INDEX "LibraryImport_expiresAt_idx" ON "LibraryImport"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryImport_ownerId_sourceHash_key" ON "LibraryImport"("ownerId", "sourceHash");

-- AddForeignKey
ALTER TABLE "LibraryImport" ADD CONSTRAINT "LibraryImport_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryImportRow" ADD CONSTRAINT "LibraryImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "LibraryImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- MANUAL ADDITION: invariants Prisma Schema cannot express
-- (docs/plan/stage-8-inventory.md, R6, §5). The application validates the same
-- rules; these constraints are the last line of defence against a write that
-- bypasses it.

-- `committedAt` is set exactly when the import is committed, and the
-- idempotency summary exists only for a committed import.
ALTER TABLE "LibraryImport" ADD CONSTRAINT "library_import_commit_fields_match_status" CHECK (
  ("status" = 'COMMITTED') = ("committedAt" IS NOT NULL)
  AND ("createdCopyCount" IS NULL OR "status" = 'COMMITTED')
);

ALTER TABLE "LibraryImport" ADD CONSTRAINT "library_import_counts_nonnegative" CHECK (
  "rowCount" >= 0
  AND "copyCount" >= 0
  AND ("createdCopyCount" IS NULL OR "createdCopyCount" >= 0)
);

-- R6: an opaque SHA-256 hex digest, never file content.
ALTER TABLE "LibraryImport" ADD CONSTRAINT "library_import_source_hash_sha256" CHECK (
  "sourceHash" ~ '^[0-9a-f]{64}$'
);

ALTER TABLE "LibraryImportRow" ADD CONSTRAINT "library_import_row_number_positive" CHECK (
  "rowNumber" >= 1
);
