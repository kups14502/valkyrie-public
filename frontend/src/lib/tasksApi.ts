import { api } from './api'

// The Tasks list (backend/src/routes/tasks.ts): every project's checklist
// items plus the tasks that belong to no project, with New York due dates
// (lib/taskDue.ts reads them).

export type TaskRef = { kind: 'project'; projectId: string; tabId: string; id: string } | { kind: 'loose'; id: string }

export type Task = {
  ref: TaskRef
  text: string
  /** New York wall clock, 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' */
  due: string | null
  done: boolean
  doneAt: string | null
  area: string
  /** null for a task outside any project */
  project: { id: string; name: string } | null
  /** the checklist tab it sits in */
  list: string | null
  createdAt: string | null
}

export type TaskView = 'open' | 'done'

export type TasksPage = {
  view: TaskView
  /** New York's date, 'YYYY-MM-DD', on the server */
  today: string
  tasks: Task[]
  projects: { id: string; name: string; area: string }[]
  areas: string[]
}

export const taskKey = (r: TaskRef): string => (r.kind === 'project' ? `p.${r.projectId}.${r.tabId}.${r.id}` : `l.${r.id}`)

const pathOf = (r: TaskRef): string => (r.kind === 'project'
  ? `/tasks/project/${encodeURIComponent(r.projectId)}/${encodeURIComponent(r.tabId)}/${encodeURIComponent(r.id)}`
  : `/tasks/loose/${encodeURIComponent(r.id)}`)

export const fetchTasks = async (view: TaskView): Promise<TasksPage> =>
  (await api.get<TasksPage>('/tasks', { params: { view } })).data

export type NewTask = { text: string; due?: string | null; projectId?: string; area?: string }

export const addTask = async (t: NewTask): Promise<Task> =>
  (await api.post<{ ok: boolean; task: Task }>('/tasks', t)).data.task

export type TaskPatch = { done?: boolean; text?: string; due?: string | null; area?: string }

export const updateTask = async (r: TaskRef, patch: TaskPatch): Promise<Task> =>
  (await api.patch<{ ok: boolean; task: Task }>(pathOf(r), patch)).data.task

export const removeTask = async (r: TaskRef): Promise<void> => {
  await api.delete(pathOf(r))
}

export const restoreTask = async (id: string): Promise<Task> =>
  (await api.post<{ ok: boolean; task: Task }>(`/tasks/loose/${encodeURIComponent(id)}/restore`)).data.task
