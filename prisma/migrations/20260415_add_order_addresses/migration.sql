-- AlterTable: Add pickupAddress and deliveryAddress columns to Order table
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "pickupAddress" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryAddress" TEXT;
