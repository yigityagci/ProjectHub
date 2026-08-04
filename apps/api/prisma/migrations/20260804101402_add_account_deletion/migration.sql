-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'deleted';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deletedAt" TIMESTAMP(3);
