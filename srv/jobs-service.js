const { inspect } = require('util')
const cds = require('@sap/cds'), { uuid } = cds.utils
const LOG = cds.log('mtx'), DEBUG = cds.debug('mtx')
const COLORS = !!process.stdout.isTTY && !!process.stderr.isTTY && !process.env.NO_COLOR || process.env.FORCE_COLOR

const Jobs = 'cds.xt.Jobs', Tasks = 'cds.xt.Tasks'

const { t0_ } = require('../lib/utils')

const {
  queueSize = 100, clusterSize = 1, workerSize = 1, poolSize = 1
} = cds.env.requires.multitenancy?.jobs
    ?? cds.env.requires['cds.xt.SaasProvisioningService']?.jobs
    ?? cds.env.requires['cds.xt.SmsProvisioningService']?.jobs
    ?? {}

const RUNNING = 'RUNNING', FINISHED = 'FINISHED', FAILED = 'FAILED', QUEUED = 'QUEUED'

// A queue, implemented as a circular buffer for O(1) insert + delete
class Queue {
  constructor(capacity) {
    this.buffer = new Array(capacity)
    this.pointer = 0
    this.size = 0
    this.capacity = capacity
    DEBUG?.(`initialized tenant operation job queue with capacity ${capacity}`)
  }
  enqueue(value) {
    if (this.size === this.capacity) cds.error('Tenant operation job queue is full. Please try again later.', { status: 429 })
    this.buffer[(this.pointer + this.size) % this.capacity] = value
    this.size++
  }
  peek() {
    return this.buffer[this.pointer]
  }
  dequeue() {
    const value = this.buffer[this.pointer]
    this.pointer = (this.pointer + 1) % this.capacity
    this.size--
    return value
  }
}
const jobQueue = new Queue(queueSize)
let runningJobs = []

module.exports = class JobsService extends cds.ApplicationService {

  async init() {
    this.on('READ', 'Jobs', async () => {
      const jobs = await t0_(
        SELECT.from(Jobs, j => { j.ID, j.op, j.status, j.error, j.tasks(t => { t.ID, t.status, t.tenant, t.error } )}).orderBy('createdAt desc')
      )
      return jobs.map(job => ({ ...job, tasks: job.tasks.sort((a, b) => a.tenant.localeCompare(b.tenant))}))
    })
    return super.init()
  }

  async enqueue(service, op, clusters, args, onJobDone) {
    const _inspect = obj => obj && Object.values(obj).filter(Boolean).length > 0 ? inspect(obj, { depth: 5, colors: COLORS }) : []
    const inspected = Object.entries(args).reduce((acc, [k, v]) => {
      const inspectedValue = _inspect(v)
      if (Buffer.isBuffer(v)) acc.push(`${k}: <Buffer>`)
      else if (v?.length || v && typeof v === 'object' && Object.keys(v).length > 0) acc.push(`${k}: ${inspectedValue}`)
      return acc
    }, [])
    const _args = inspected.length ? ['with', ...inspected] : []
    const _format = clusters => {
      if (Array.isArray(clusters)) return clusters.flatMap(c => [...c])
      return Object.fromEntries(Object.entries(clusters).map(([k, v]) => [k, [...v]]))
    }

    LOG.info(`enqueuing`, { service, op }, 'for', _format(clusters), ..._args)

    const job_ID = uuid()
    const job = { ID: job_ID, createdAt: (new Date).toISOString(), op, status: QUEUED }
    const jobs = Object.values(clusters).map(cluster => Array.from(cluster).map(tenant => ({ job_ID, ID: uuid(), tenant, op, status: QUEUED })))
    const tasks = jobs.flat()

    await t0_(async () => {
      await INSERT.into(Jobs, job)
      if (tasks.length) {
        await INSERT.into(Tasks, tasks)
      }
    })

    if (tasks.length) {
      jobQueue.enqueue({ job_ID, clusters: jobs, fn: task => {
        const serviceInstance = cds.services[service]
        return serviceInstance.tx({ tenant: cds.context.tenant }, tx => tx[op](task.tenant, ...Object.values(args)))
      }, onJobDone })
      pickJob()
    } else {
      await t0_(UPDATE(Jobs, { ID: job_ID }).with({ status: FINISHED }))
    }

    const url = process.env.VCAP_APPLICATION ? 'https://' + JSON.parse(process.env.VCAP_APPLICATION).uris?.[0] : cds.server.url
    cds.context.http?.res.set('Location', `${url}/-/cds/jobs/pollJob(ID='${job_ID}')`)
    cds.context.http?.res.set('x-job-id', job_ID)
    const { headers } = cds.context.http?.req ?? {}
    if (headers?.prefer?.includes('respond-async') || headers?.status_callback || headers?.mtx_status_callback) {
      cds.context.http.res.status(202)
    }
    return {
      ...job,
      tenants: Object.fromEntries(tasks.map(task =>
        [task.tenant, { ...task, job_ID: undefined, tenant: undefined, op: undefined }]
      )),
      tasks: Object.fromEntries(tasks.sort((a, b) => a.tenant.localeCompare(b.tenant)).map(task =>
        [task.tenant, { ...task, job_ID: job.ID, tenant: task.tenant, op: job.op }]
      ))
    }
  }

  async pollJob(ID) {
    const job = await t0_(
      SELECT.one.from(Jobs, j => { j.ID, j.op, j.error, j.status, j.tasks(t => { t.ID, t.status, t.tenant, t.error } )}).where({ ID })
    )
    if (!job) cds.error(`No job found for ID ${ID}`, { status: 404 })
    job.tasks.sort((a, b) => a.tenant.localeCompare(b.tenant)) // REVISIT: Ideally j.tasks supports orderBy
    job.tenants = Object.fromEntries(job.tasks.map(task => [task.tenant ?? task.TENANT, {
      status: task.status ?? task.STATUS,
      error: task.error ?? task.ERROR ?? undefined
    }]))

    return job
  }

  async pollTask(ID) {
    const task = await t0_(SELECT.one.from(Tasks).where({ ID }))
    return {
      status: task.status ?? task.STATUS,
      op: task.op ?? task.OP,
      error: task.error ?? task.ERROR ?? undefined
    }
  }
}

async function limiter(limit, payloads, fn, asTask = false) {
  const pending = [], all = []
  for (const payload of payloads) {
    const { ID, tenant } = payload
    if (asTask) await t0_(UPDATE(Tasks, { ID, tenant }).with({ status: RUNNING }))
    const execute = asTask ? _nextTask(payload, fn(payload)) : fn(payload)
    all.push(execute)
    const executeAndRemove = execute.finally(() => pending.splice(pending.indexOf(executeAndRemove), 1))
    pending.push(executeAndRemove)
    if (pending.length >= limit) {
      await Promise.race(pending)
    }
  }
  return Promise.allSettled(all)
}

async function pickJob() {
  if (jobQueue.size === 0) return

  const next = new Set(jobQueue.peek().clusters.flat().map(t => t.tenant).flat())
  // Later, for scaled instances. Requires Redis/heartbeat messages to prevent starvation, though.
  // const running = await _run(SELECT.one.from(Jobs).where ({ status: RUNNING }))
  // (!running) pickJob()
  const running = runningJobs.map(j => j.clusters.flat().map(t => t.tenant)).flat()
  if (running.some(t => next.has(t))) return

  const job = jobQueue.dequeue()
  const { job_ID, clusters, fn, onJobDone } = job
  try {
    runningJobs.push(job)
    await t0_(UPDATE(Jobs, { ID: job_ID }).with({ status: RUNNING }))
    await _nextJob(clusters, fn, onJobDone)
  } catch (e) {
    await t0_(UPDATE(Jobs, { ID: job_ID }).with({ status: FAILED, error: _errorMessage(e) }))
  } finally {
    runningJobs.splice(runningJobs.findIndex(j => j.job_ID === next.job_ID), 1)
  }
  setImmediate(pickJob)
}

async function _nextJob(clusters, fn, onJobDone) {
  if (clusters.length > 1) {
    await limiter(clusterSize, clusters, cluster => limiter(workerSize ?? poolSize, Array.from(cluster), fn, true))
  } else {
    await limiter(workerSize ?? poolSize, Array.from(clusters[0]), fn, true)
  }

  const { job_ID } = clusters[0][0] // all tasks have the same job ID -> just take the first
  const failed = await t0_(SELECT.one.from(Tasks).where ({ job_ID, and: { status: FAILED }}))
  const running = await t0_(SELECT.one.from(Tasks).where ({ job_ID, and: { status: RUNNING }}))

  if (failed) {
    await t0_(UPDATE(Jobs, { ID: job_ID }).with({ status: FAILED }))
    if (onJobDone) await onJobDone(failed.error ?? failed.ERROR ?? 'Unknown error')
  } else if (!running) {
    await t0_(UPDATE(Jobs, { ID: job_ID }).with({ status: FINISHED }))
    if (onJobDone) await onJobDone()
  }
}

async function _nextTask(task, _fn) {
  const { ID, tenant } = task
  try {
    await _fn
    await t0_(UPDATE(Tasks, { ID, tenant }).with({ status: FINISHED }))
  } catch (e) {
    LOG.error(e)
    await t0_(UPDATE(Tasks, { ID, tenant }).with({ status: FAILED, error: _errorMessage(e) ?? 'Unknown error' }))
  }
}

function _errorMessage(e) {
  let message = e.message ?? 'Unknown error'
  if (e.error) message += ' ' + e.error
  if (e.description) message += ': ' + e.description
  return message
}

if (cds.requires.multitenancy?.jobCleanup !== false) {
  const hours = 1000 * 60 * 60

  // Cleanup finished/failed jobs
  const jobCleanup = setInterval(async () => {
    const cutoff = new Date(new Date - (cds.env.requires.multitenancy.jobCleanupAge ?? 24*hours))
    await t0_(DELETE.from(Jobs, { status: FAILED, or: { status: FINISHED, and: { createdAt: { '<': cutoff.toISOString() }}}})
    )
  }, cds.env.requires.multitenancy?.jobCleanupInterval ?? 24*hours)
  jobCleanup.unref()

  // Cleanup stale jobs
  const jobCleanupStale = setInterval(async () => {
    const cutoff = new Date(new Date - (cds.env.requires.multitenancy.jobCleanupAgeStale ?? 48*hours))
    await t0_(DELETE.from(Jobs, { createdAt: { '<': cutoff.toISOString() }}))
  }, cds.env.requires.multitenancy?.jobCleanupIntervalStale ?? 48*hours)
  jobCleanupStale.unref()

}

// Later, for blue-green deployment support
// if (cds.requires.multitenancy?.jobs?.restartCancelled && cds.services['cds.xt.DeploymentService'].lazyT0 !== true) {
//   pickJob()
// }

// cds.once('shutdown', async () => {
//   if (runningJobs) {
//     const jobIDs = runningJobs.map(j => j.job_ID)
//     await _run(UPDATE(Jobs, { status: RUNNING }).with({ status: CANCELLED }).where({ ID: { in: jobIDs } }))
//     await _run(UPDATE(Tasks, { status: RUNNING }).with({ status: CANCELLED }).where({ job_ID: { in: jobIDs } }))
//   }
// })
