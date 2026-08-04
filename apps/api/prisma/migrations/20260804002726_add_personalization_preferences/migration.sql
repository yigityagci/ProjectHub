-- AlterTable
ALTER TABLE "users" ADD COLUMN     "defaultBoardView" TEXT NOT NULL DEFAULT 'board',
ADD COLUMN     "defaultLandingPage" TEXT NOT NULL DEFAULT 'workspaces',
ADD COLUMN     "prefersCompactMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "showKeyboardShortcutsReference" BOOLEAN NOT NULL DEFAULT true;
