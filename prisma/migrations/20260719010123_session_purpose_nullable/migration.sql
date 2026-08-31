-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SessionPurpose" ADD VALUE 'customer_enrollment';
ALTER TYPE "SessionPurpose" ADD VALUE 'staff_context_selection';

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "purpose" DROP NOT NULL,
ALTER COLUMN "purpose" DROP DEFAULT;
