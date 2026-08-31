-- CreateTable
CREATE TABLE "WasherProduct" (
    "id" TEXT NOT NULL,
    "washerId" TEXT NOT NULL,
    "productId" TEXT,
    "price" INTEGER NOT NULL,
    "customName" TEXT,
    "customImage" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WasherProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WasherProduct_washerId_productId_key" ON "WasherProduct"("washerId", "productId");

-- CreateIndex
CREATE INDEX "WasherProduct_washerId_idx" ON "WasherProduct"("washerId");

-- CreateIndex
CREATE INDEX "WasherProduct_productId_idx" ON "WasherProduct"("productId");

-- AddForeignKey
ALTER TABLE "WasherProduct" ADD CONSTRAINT "WasherProduct_washerId_fkey" FOREIGN KEY ("washerId") REFERENCES "Washer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WasherProduct" ADD CONSTRAINT "WasherProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
