export interface TaskAssignee {
  userId: string;
  displayName: string;
  email: string;
  isDeleted: boolean;
}

export interface TaskLabelRef {
  labelId: string;
  name: string;
  color: string;
}

export interface TaskTemplate {
  id: string;
  projectId: string;
  name: string;
  titleTemplate: string;
  description: string | null;
  priority: "low" | "medium" | "high" | "urgent" | null;
  defaultLabelIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  categoryId: string;
  columnId: string;
  parentTaskId: string | null;
  milestoneId: string | null;
  title: string;
  description: string | null;
  priority: "low" | "medium" | "high" | "urgent";
  position: number;
  creatorId: string;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  assignees: TaskAssignee[];
  labels: TaskLabelRef[];
}

export interface CommentMention {
  userId: string;
  displayName: string;
  isDeleted: boolean;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  authorDisplayName: string;
  authorEmail: string;
  authorIsDeleted: boolean;
  body: string;
  createdAt: string;
  updatedAt: string;
  mentionedUserIds: string[];
  mentions: CommentMention[];
}

export interface Attachment {
  id: string;
  taskId: string;
  uploaderId: string;
  uploaderDisplayName: string;
  uploaderEmail: string;
  uploaderIsDeleted: boolean;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}
