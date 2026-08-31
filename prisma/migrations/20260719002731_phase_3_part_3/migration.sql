-- AlterEnum
ALTER TYPE "InvitationStatus" ADD VALUE 'superseded';

-- AlterTable
ALTER TABLE "StaffInvitation" ADD COLUMN     "invitedByStaffMembershipId" TEXT;

-- AlterTable
ALTER TABLE "Washer" ADD COLUMN     "permissionsVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "StaffInvitation_invitedByStaffMembershipId_idx" ON "StaffInvitation"("invitedByStaffMembershipId");

ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_invitedByStaffMembershipId_fkey" FOREIGN KEY ("invitedByStaffMembershipId") REFERENCES "StaffMembership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreatePartialUniqueIndex
CREATE UNIQUE INDEX "StaffInvitation_washerId_phone_pending_key" ON "StaffInvitation"("washerId", "phone") WHERE "status" = 'pending';
