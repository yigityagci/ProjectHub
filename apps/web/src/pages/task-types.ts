export interface TaskAssignee {
  userId: string;
  displayName: string;
  email: string;
}

export interface TaskLabelRef {
  labelId: string;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  projectId: string;
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
  version: number;
  createdAt: string;
  updatedAt: string;
  assignees: TaskAssignee[];
  labels: TaskLabelRef[];
}
