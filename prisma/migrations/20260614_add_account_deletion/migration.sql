-- Account Deletion — Apple Guideline 5.1.1(v)
-- Adds pending_deletion + deleted to UserStatus enum
-- Adds 5 nullable deletion tracking columns to User

-- Step 1: Add new enum values (IF NOT EXISTS prevents errors on re-run)
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'pending_deletion';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'deleted';

-- Step 2: Add deletion tracking columns to User table
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "scheduledDeletionAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletedAt"           TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletionReason"      TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "anonymizedAt"        TIMESTAMP(3);
