/*
  Warnings:

  - The values [pending,accepted,picked_up,sorting,washing,ready,delivering,completed] on the enum `OrderStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `userId` on the `Notification` table. All the data in the column will be lost.
  - You are about to drop the column `cleaningIntensity` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `customerId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `deliveryAddress` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `deliveryZoneId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `driverId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `pickupAddress` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `pickupZoneId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `washerProductId` on the `OrderItem` table. All the data in the column will be lost.
  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WasherPaymentMethod` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WasherProduct` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WasherSchedule` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Zone` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[customerMembershipId,idempotencyKey]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `identityId` to the `Notification` table without a default value. This is not possible if the table is not empty.
  - Added the required column `branchId` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `contentHash` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `customerMembershipId` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `idempotencyKey` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "IdentityStatus" AS ENUM ('active', 'suspended', 'pending_deletion', 'deleted');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('active', 'suspended', 'blocked', 'pending_deletion', 'deleted');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('washer_owner', 'washer_manager', 'branch_manager', 'worker', 'driver');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('super_admin', 'support', 'finance', 'operations');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('branch', 'washer', 'platform');

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('allow', 'deny');

-- CreateEnum
CREATE TYPE "TokenStatus" AS ENUM ('active', 'expired', 'invalid');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('provisional', 'operational', 'customer');

-- CreateEnum
CREATE TYPE "BranchStatus" AS ENUM ('active', 'temporarily_closed', 'permanently_closed', 'archived');

-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('inclusion', 'exclusion');

-- CreateEnum
CREATE TYPE "CoverageShapeType" AS ENUM ('circle', 'polygon', 'multi_polygon');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('login', 'delete_account', 'phone_change');

-- AlterEnum
BEGIN;
CREATE TYPE "OrderStatus_new" AS ENUM ('pending_pickup', 'pickup_assigned', 'driver_heading_to_pickup', 'driver_arrived_pickup', 'delivered_to_laundry', 'received_in_laundry', 'sorting_in_progress', 'sorting_confirmed', 'invoice_generated', 'payment_pending', 'payment_confirmed', 'drying', 'ironing', 'packaging', 'ready_for_delivery', 'delivery_assigned', 'driver_heading_to_delivery', 'driver_arrived_delivery', 'delivered', 'cancelled');
ALTER TABLE "public"."Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TABLE "OrderEvent" ALTER COLUMN "from" TYPE "OrderStatus_new" USING ("from"::text::"OrderStatus_new");
ALTER TABLE "OrderEvent" ALTER COLUMN "to" TYPE "OrderStatus_new" USING ("to"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "public"."OrderStatus_old";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'pending_pickup';
COMMIT;

-- DropForeignKey
ALTER TABLE "DriverTask" DROP CONSTRAINT "DriverTask_assignedDriverId_fkey";

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_senderId_fkey";

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_userId_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_customerId_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_driverId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_washerId_fkey";

-- DropForeignKey
ALTER TABLE "WasherPaymentMethod" DROP CONSTRAINT "WasherPaymentMethod_washerId_fkey";

-- DropForeignKey
ALTER TABLE "WasherProduct" DROP CONSTRAINT "WasherProduct_productId_fkey";

-- DropForeignKey
ALTER TABLE "WasherProduct" DROP CONSTRAINT "WasherProduct_washerId_fkey";

-- DropForeignKey
ALTER TABLE "WasherSchedule" DROP CONSTRAINT "WasherSchedule_washerId_fkey";

-- DropForeignKey
ALTER TABLE "Zone" DROP CONSTRAINT "Zone_washerId_fkey";

-- DropIndex
DROP INDEX "Notification_userId_isRead_createdAt_idx";

-- DropIndex
DROP INDEX "Order_customerId_idx";

-- DropIndex
DROP INDEX "Order_driverId_idx";

-- DropIndex
DROP INDEX "Order_driverId_status_idx";

-- DropIndex
DROP INDEX "Order_status_idx";

-- DropIndex
DROP INDEX "Order_washerId_idx";

-- DropIndex
DROP INDEX "OtpCode_phone_idx";

-- AlterTable
ALTER TABLE "Notification" DROP COLUMN "userId",
ADD COLUMN     "identityId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "cleaningIntensity",
DROP COLUMN "customerId",
DROP COLUMN "deliveryAddress",
DROP COLUMN "deliveryZoneId",
DROP COLUMN "driverId",
DROP COLUMN "pickupAddress",
DROP COLUMN "pickupZoneId",
ADD COLUMN     "branchId" TEXT NOT NULL,
ADD COLUMN     "contentHash" TEXT NOT NULL,
ADD COLUMN     "customerMembershipId" TEXT NOT NULL,
ADD COLUMN     "deliveryAddressText" TEXT,
ADD COLUMN     "deliveryApartmentNumber" TEXT,
ADD COLUMN     "deliveryBuildingNumber" TEXT,
ADD COLUMN     "deliveryCity" TEXT,
ADD COLUMN     "deliveryDistrict" TEXT,
ADD COLUMN     "deliveryFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryFloor" TEXT,
ADD COLUMN     "deliveryInstructions" TEXT,
ADD COLUMN     "deliveryLandmark" TEXT,
ADD COLUMN     "deliveryStreet" TEXT,
ADD COLUMN     "discount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "driverStaffMembershipId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "pickupAddressText" TEXT,
ADD COLUMN     "pickupApartmentNumber" TEXT,
ADD COLUMN     "pickupBuildingNumber" TEXT,
ADD COLUMN     "pickupCity" TEXT,
ADD COLUMN     "pickupDistrict" TEXT,
ADD COLUMN     "pickupFloor" TEXT,
ADD COLUMN     "pickupInstructions" TEXT,
ADD COLUMN     "pickupLandmark" TEXT,
ADD COLUMN     "pickupStreet" TEXT,
ADD COLUMN     "pricingSnapshot" JSONB,
ADD COLUMN     "subtotal" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "status" SET DEFAULT 'pending_pickup';

-- AlterTable
ALTER TABLE "OrderItem" DROP COLUMN "washerProductId";

-- AlterTable
ALTER TABLE "OtpCode" ADD COLUMN     "appClientId" TEXT,
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "purpose" "OtpPurpose" NOT NULL DEFAULT 'login';

-- AlterTable
ALTER TABLE "Washer" ADD COLUMN     "address" TEXT,
ADD COLUMN     "deliveryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "deliveryFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "isOpen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "minimumOrderAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT;

-- DropTable
DROP TABLE "User";

-- DropTable
DROP TABLE "WasherPaymentMethod";

-- DropTable
DROP TABLE "WasherProduct";

-- DropTable
DROP TABLE "WasherSchedule";

-- DropTable
DROP TABLE "Zone";

-- DropEnum
DROP TYPE "UserRole";

-- DropEnum
DROP TYPE "UserStatus";

-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "status" "IdentityStatus" NOT NULL DEFAULT 'active',
    "deletionRequestedAt" TIMESTAMP(3),
    "scheduledDeletionAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "anonymizedAt" TIMESTAMP(3),
    "deletionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityAddress" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "label" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "addressText" TEXT,
    "city" TEXT,
    "district" TEXT,
    "street" TEXT,
    "buildingNumber" TEXT,
    "apartmentNumber" TEXT,
    "floor" TEXT,
    "landmark" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMembershipAddress" (
    "id" TEXT NOT NULL,
    "customerMembershipId" TEXT NOT NULL,
    "identityAddressId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "pickupInstructions" TEXT,
    "deliveryInstructions" TEXT,
    "additionalNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMembershipAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMembership" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "washerId" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "MembershipStatus" NOT NULL DEFAULT 'active',
    "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
    "walletBalance" INTEGER NOT NULL DEFAULT 0,
    "preferredBranchId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffMembership" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "washerId" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'active',
    "hasFullWasherAccess" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffInvitation" (
    "id" TEXT NOT NULL,
    "washerId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "proposedRole" "StaffRole" NOT NULL,
    "proposedBranchIds" JSONB,
    "invitedByIdentityId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAccess" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'active',
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "PermissionScope" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchPermissionOverride" (
    "id" TEXT NOT NULL,
    "branchAccessId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedById" TEXT,

    CONSTRAINT "BranchPermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchAccess" (
    "id" TEXT NOT NULL,
    "staffMembershipId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appType" TEXT NOT NULL,
    "appVersion" TEXT,
    "model" TEXT,
    "osVersion" TEXT,
    "fcmToken" TEXT,
    "tokenStatus" "TokenStatus" NOT NULL DEFAULT 'active',
    "tokenUpdatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppClient" (
    "id" TEXT NOT NULL,
    "washerId" TEXT NOT NULL,
    "appKey" TEXT NOT NULL,
    "appName" TEXT,
    "platform" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "userDeviceId" TEXT,
    "sessionType" "SessionType" NOT NULL,
    "washerId" TEXT,
    "branchId" TEXT,
    "staffMembershipId" TEXT,
    "customerMembershipId" TEXT,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "parentTokenId" TEXT,
    "replacedById" TEXT,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "washerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "status" "BranchStatus" NOT NULL DEFAULT 'active',
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "acceptingOrders" BOOLEAN NOT NULL DEFAULT true,
    "minimumOrderAmount" INTEGER NOT NULL DEFAULT 0,
    "deliveryFee" INTEGER NOT NULL DEFAULT 0,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageZone" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT,
    "zoneType" "ZoneType" NOT NULL DEFAULT 'inclusion',
    "coverageType" "CoverageShapeType" NOT NULL DEFAULT 'circle',
    "bbMinLat" DOUBLE PRECISION,
    "bbMaxLat" DOUBLE PRECISION,
    "bbMinLng" DOUBLE PRECISION,
    "bbMaxLng" DOUBLE PRECISION,
    "centerLat" DOUBLE PRECISION,
    "centerLng" DOUBLE PRECISION,
    "radiusMeters" INTEGER,
    "geoJson" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverageZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchSchedule" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "fromTime" TEXT NOT NULL,
    "toTime" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BranchSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchPaymentMethod" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOverride" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "customName" TEXT,
    "customImage" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ProductOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Identity_phone_key" ON "Identity"("phone");

-- CreateIndex
CREATE INDEX "Identity_phone_idx" ON "Identity"("phone");

-- CreateIndex
CREATE INDEX "Identity_status_idx" ON "Identity"("status");

-- CreateIndex
CREATE INDEX "IdentityAddress_identityId_isDeleted_idx" ON "IdentityAddress"("identityId", "isDeleted");

-- CreateIndex
CREATE INDEX "CustomerMembershipAddress_customerMembershipId_idx" ON "CustomerMembershipAddress"("customerMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMembershipAddress_customerMembershipId_identityAddr_key" ON "CustomerMembershipAddress"("customerMembershipId", "identityAddressId");

-- CreateIndex
CREATE INDEX "CustomerMembership_identityId_idx" ON "CustomerMembership"("identityId");

-- CreateIndex
CREATE INDEX "CustomerMembership_washerId_idx" ON "CustomerMembership"("washerId");

-- CreateIndex
CREATE INDEX "CustomerMembership_status_idx" ON "CustomerMembership"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMembership_identityId_washerId_key" ON "CustomerMembership"("identityId", "washerId");

-- CreateIndex
CREATE INDEX "StaffMembership_identityId_idx" ON "StaffMembership"("identityId");

-- CreateIndex
CREATE INDEX "StaffMembership_washerId_status_idx" ON "StaffMembership"("washerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StaffMembership_identityId_washerId_key" ON "StaffMembership"("identityId", "washerId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffInvitation_tokenHash_key" ON "StaffInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "StaffInvitation_phone_idx" ON "StaffInvitation"("phone");

-- CreateIndex
CREATE INDEX "StaffInvitation_washerId_status_idx" ON "StaffInvitation"("washerId", "status");

-- CreateIndex
CREATE INDEX "StaffInvitation_tokenHash_idx" ON "StaffInvitation"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAccess_identityId_key" ON "PlatformAccess"("identityId");

-- CreateIndex
CREATE INDEX "PlatformAccess_status_idx" ON "PlatformAccess"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_code_key" ON "Permission"("code");

-- CreateIndex
CREATE INDEX "Permission_code_idx" ON "Permission"("code");

-- CreateIndex
CREATE INDEX "Permission_scope_idx" ON "Permission"("scope");

-- CreateIndex
CREATE INDEX "RolePermission_role_idx" ON "RolePermission"("role");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_role_permissionId_key" ON "RolePermission"("role", "permissionId");

-- CreateIndex
CREATE INDEX "BranchPermissionOverride_branchAccessId_idx" ON "BranchPermissionOverride"("branchAccessId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchPermissionOverride_branchAccessId_permissionId_key" ON "BranchPermissionOverride"("branchAccessId", "permissionId");

-- CreateIndex
CREATE INDEX "BranchAccess_staffMembershipId_idx" ON "BranchAccess"("staffMembershipId");

-- CreateIndex
CREATE INDEX "BranchAccess_branchId_idx" ON "BranchAccess"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchAccess_staffMembershipId_branchId_key" ON "BranchAccess"("staffMembershipId", "branchId");

-- CreateIndex
CREATE INDEX "UserDevice_identityId_idx" ON "UserDevice"("identityId");

-- CreateIndex
CREATE INDEX "UserDevice_fcmToken_idx" ON "UserDevice"("fcmToken");

-- CreateIndex
CREATE INDEX "UserDevice_tokenStatus_idx" ON "UserDevice"("tokenStatus");

-- CreateIndex
CREATE UNIQUE INDEX "UserDevice_installationId_applicationId_key" ON "UserDevice"("installationId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AppClient_appKey_key" ON "AppClient"("appKey");

-- CreateIndex
CREATE INDEX "AppClient_appKey_idx" ON "AppClient"("appKey");

-- CreateIndex
CREATE INDEX "AppClient_washerId_idx" ON "AppClient"("washerId");

-- CreateIndex
CREATE INDEX "Session_identityId_idx" ON "Session"("identityId");

-- CreateIndex
CREATE INDEX "Session_isRevoked_expiresAt_idx" ON "Session"("isRevoked", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "RefreshToken_tokenHash_idx" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "RefreshToken_isRevoked_expiresAt_idx" ON "RefreshToken"("isRevoked", "expiresAt");

-- CreateIndex
CREATE INDEX "Branch_washerId_status_idx" ON "Branch"("washerId", "status");

-- CreateIndex
CREATE INDEX "CoverageZone_branchId_isActive_zoneType_idx" ON "CoverageZone"("branchId", "isActive", "zoneType");

-- CreateIndex
CREATE INDEX "BranchSchedule_branchId_day_idx" ON "BranchSchedule"("branchId", "day");

-- CreateIndex
CREATE INDEX "BranchPaymentMethod_branchId_idx" ON "BranchPaymentMethod"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchPaymentMethod_branchId_method_key" ON "BranchPaymentMethod"("branchId", "method");

-- CreateIndex
CREATE INDEX "ProductOverride_branchId_idx" ON "ProductOverride"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductOverride_branchId_productId_key" ON "ProductOverride"("branchId", "productId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_subjectId_idx" ON "AuditLog"("subjectId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_identityId_isRead_createdAt_idx" ON "Notification"("identityId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Order_customerMembershipId_idx" ON "Order"("customerMembershipId");

-- CreateIndex
CREATE INDEX "Order_washerId_branchId_status_idx" ON "Order"("washerId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_customerMembershipId_idempotencyKey_key" ON "Order"("customerMembershipId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OtpCode_phone_purpose_verified_idx" ON "OtpCode"("phone", "purpose", "verified");

-- AddForeignKey
ALTER TABLE "IdentityAddress" ADD CONSTRAINT "IdentityAddress_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembershipAddress" ADD CONSTRAINT "CustomerMembershipAddress_customerMembershipId_fkey" FOREIGN KEY ("customerMembershipId") REFERENCES "CustomerMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembershipAddress" ADD CONSTRAINT "CustomerMembershipAddress_identityAddressId_fkey" FOREIGN KEY ("identityAddressId") REFERENCES "IdentityAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMembership" ADD CONSTRAINT "CustomerMembership_washerId_fkey" FOREIGN KEY ("washerId") REFERENCES "Washer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMembership" ADD CONSTRAINT "StaffMembership_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMembership" ADD CONSTRAINT "StaffMembership_washerId_fkey" FOREIGN KEY ("washerId") REFERENCES "Washer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_washerId_fkey" FOREIGN KEY ("washerId") REFERENCES "Washer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_invitedByIdentityId_fkey" FOREIGN KEY ("invitedByIdentityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAccess" ADD CONSTRAINT "PlatformAccess_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchPermissionOverride" ADD CONSTRAINT "BranchPermissionOverride_branchAccessId_fkey" FOREIGN KEY ("branchAccessId") REFERENCES "BranchAccess"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchPermissionOverride" ADD CONSTRAINT "BranchPermissionOverride_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchAccess" ADD CONSTRAINT "BranchAccess_staffMembershipId_fkey" FOREIGN KEY ("staffMembershipId") REFERENCES "StaffMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchAccess" ADD CONSTRAINT "BranchAccess_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppClient" ADD CONSTRAINT "AppClient_washerId_fkey" FOREIGN KEY ("washerId") REFERENCES "Washer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userDeviceId_fkey" FOREIGN KEY ("userDeviceId") REFERENCES "UserDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_washerId_fkey" FOREIGN KEY ("washerId") REFERENCES "Washer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageZone" ADD CONSTRAINT "CoverageZone_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchSchedule" ADD CONSTRAINT "BranchSchedule_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchPaymentMethod" ADD CONSTRAINT "BranchPaymentMethod_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOverride" ADD CONSTRAINT "ProductOverride_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOverride" ADD CONSTRAINT "ProductOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerMembershipId_fkey" FOREIGN KEY ("customerMembershipId") REFERENCES "CustomerMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverTask" ADD CONSTRAINT "DriverTask_assignedDriverId_fkey" FOREIGN KEY ("assignedDriverId") REFERENCES "StaffMembership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
