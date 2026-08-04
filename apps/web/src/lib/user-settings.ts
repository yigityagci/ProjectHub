/**
 * The canonical shape returned by GET /api/auth/me and by every
 * account/preferences PATCH endpoint (see
 * apps/api/src/auth/account.service.ts#serializeUserSettings). Wire keys
 * for `notifications` are the NOTIFICATION_TYPES strings, not raw column
 * names.
 */
export interface UserSettings {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  avatarUrl: string | null;
  locale: string;
  notifications: {
    mention: boolean;
    task_assigned: boolean;
    comment_reply: boolean;
    due_date_soon: boolean;
  };
  accessibility: {
    reduceMotion: boolean;
    largerText: boolean;
  };
  personalization: {
    defaultBoardView: string;
    defaultLandingPage: string;
    compactMode: boolean;
    showKeyboardShortcutsReference: boolean;
  };
}
