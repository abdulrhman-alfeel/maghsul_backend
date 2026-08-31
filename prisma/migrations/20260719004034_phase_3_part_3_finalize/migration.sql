/*
  Warnings:

  - Made the column `invitedByStaffMembershipId` on table `StaffInvitation` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "SessionPurpose" AS ENUM ('login', 'staff_invitation_accept');

-- DropForeignKey
ALTER TABLE "StaffInvitation" DROP CONSTRAINT "StaffInvitation_invitedByStaffMembershipId_fkey";

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "purpose" "SessionPurpose" NOT NULL DEFAULT 'login';

-- AlterTable
ALTER TABLE "StaffInvitation" ALTER COLUMN "invitedByStaffMembershipId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_invitedByStaffMembershipId_fkey" FOREIGN KEY ("invitedByStaffMembershipId") REFERENCES "StaffMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
