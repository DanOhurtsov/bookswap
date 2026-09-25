-- CreateEnum
CREATE TYPE "InvitationKind" AS ENUM ('LINK', 'EMAIL');

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "kind" "InvitationKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "recipientEmailHash" TEXT,
    "maxUses" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvitationAcceptance" (
    "id" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvitationAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_inviterId_createdAt_idx" ON "Invitation"("inviterId", "createdAt");

-- CreateIndex
CREATE INDEX "Invitation_recipientEmailHash_createdAt_idx" ON "Invitation"("recipientEmailHash", "createdAt");

-- CreateIndex
CREATE INDEX "InvitationAcceptance_userId_idx" ON "InvitationAcceptance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "InvitationAcceptance_invitationId_userId_key" ON "InvitationAcceptance"("invitationId", "userId");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvitationAcceptance" ADD CONSTRAINT "InvitationAcceptance_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "Invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvitationAcceptance" ADD CONSTRAINT "InvitationAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
