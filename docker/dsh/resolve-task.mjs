const id = process.env.NEO_TASK_ID
const token = process.env.NEO_TASK_TOKEN
if (!id || !token) throw new Error('Task identity and credential are required')
const response = await fetch(
  `${process.env.CONTROL_URL || 'http://control:8090'}/tasks/${encodeURIComponent(id)}`,
  {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  },
)
if (!response.ok)
  throw new Error(`Task authorization failed (${response.status})`)
const task = await response.json()
if (task.id !== id.toLowerCase() || !['fast', 'thorough'].includes(task.mode))
  throw new Error('Invalid task response')
if (!['pending', 'running'].includes(task.status))
  throw new Error(
    `Task is ${task.status}; create or reopen a task before starting`,
  )
process.stdout.write(task.mode)
