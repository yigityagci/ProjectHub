-- AlterTable
ALTER TABLE "users" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "notifyOnCommentReply" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyOnMention" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyOnTaskAssigned" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "prefersLargerText" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "prefersReducedMotion" BOOLEAN NOT NULL DEFAULT false;
