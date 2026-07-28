import { prisma } from "../core/prisma.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../core/errors.js";

const TASK_NOT_FOUND_MESSAGE = "This task doesn't exist in this project.";

export class DependencyCycleError extends AppError {
  constructor(
    message = "This dependency would create a cycle. A task cannot (even indirectly) depend on itself.",
  ) {
    super(409, "DEPENDENCY_CYCLE", message);
  }
}

export async function listDependencies(projectId: string, taskId: string) {
  return prisma.taskDependency.findMany({
    where: { projectId, blockedTaskId: taskId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * DFS over the existing dependency edges of the project (edge direction:
 * blockingTaskId -> blockedTaskId, i.e. "blocking blocks blocked") to
 * determine whether `target` is reachable from `start`. Used to detect
 * whether adding a new "blockingTaskId blocks blockedTaskId" edge would
 * close a cycle: if blockingTaskId is already reachable from blockedTaskId,
 * the new edge would create a loop.
 */
async function isReachable(projectId: string, start: string, target: string): Promise<boolean> {
  const edges = await prisma.taskDependency.findMany({
    where: { projectId },
    select: { blockingTaskId: true, blockedTaskId: true },
  });

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.blockingTaskId) ?? [];
    list.push(edge.blockedTaskId);
    adjacency.set(edge.blockingTaskId, list);
  }

  const visited = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return false;
}

export async function createDependency(
  workspaceId: string,
  projectId: string,
  blockedTaskId: string,
  blockingTaskId: string,
) {
  if (blockedTaskId === blockingTaskId) {
    throw new ValidationError("A task cannot depend on itself.");
  }

  const [blockedTask, blockingTask] = await Promise.all([
    prisma.task.findFirst({ where: { id: blockedTaskId, workspaceId, projectId } }),
    prisma.task.findFirst({ where: { id: blockingTaskId, workspaceId, projectId } }),
  ]);
  if (!blockedTask) {
    throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
  }
  if (!blockingTask) {
    throw new NotFoundError("This blocking task doesn't exist in this project.");
  }

  const existing = await prisma.taskDependency.findUnique({
    where: { blockedTaskId_blockingTaskId: { blockedTaskId, blockingTaskId } },
  });
  if (existing) {
    throw new ConflictError("This dependency already exists.");
  }

  // Would adding blockingTaskId -> blockedTaskId close a cycle? That's true
  // iff blockingTaskId is already reachable from blockedTaskId via existing
  // edges.
  if (await isReachable(projectId, blockedTaskId, blockingTaskId)) {
    throw new DependencyCycleError();
  }

  return prisma.taskDependency.create({
    data: { workspaceId, projectId, blockedTaskId, blockingTaskId },
  });
}

export async function removeDependency(projectId: string, taskId: string, dependencyId: string) {
  const existing = await prisma.taskDependency.findFirst({
    where: { id: dependencyId, projectId, blockedTaskId: taskId },
  });
  if (!existing) {
    throw new NotFoundError("This dependency doesn't exist for this task.");
  }
  await prisma.taskDependency.delete({ where: { id: dependencyId } });
}
