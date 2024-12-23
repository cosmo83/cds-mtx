const cds = require('@sap/cds/lib'), {db} = cds.requires, {fs, rimraf, path} = cds.utils
const LOG = cds.log('mtx')

const TEMP_DIR = require('fs').realpathSync(require('os').tmpdir())
const { readData } = require('../../lib/utils')
const main = require('../config')

exports.activated = (db?.kind in { 'sqlite':1, 'better-sqlite':2 }) && 'SQLite database'
if (exports.activated) cds.on ('serving:cds.xt.DeploymentService', ds => {

  ds.on ('subscribe', async function (req) {
    const { tenant:t, options } = req.data
    await this.deploy (t,options)
  })

  async function _readExtCsvs(tenant) {
    const { 'cds.xt.ModelProviderService': mp } = cds.services
    const extensions = await mp.getExtResources(tenant)
    if (!extensions) return null

    const out = await fs.promises.mkdtemp(`${TEMP_DIR}${path.sep}extension-`)
    try {
      const { csvs } = await readData(extensions, out)
      return csvs
    } finally {
      rimraf(out)
    }
  }

  ds.on ('deploy', async function (req) {
    const { tenant:t, options } = req.data
    const csn = await options?.csn || await csn4(t) // always get csn for tenant to be idempotent (incl extensions)
    LOG.info (`(re-)deploying SQLite database for tenant: ${t}`)
    const deployOptions = main.requires.extensibility ? { schema_evolution: 'auto' } : {}
    const t0 = cds.requires.multitenancy?.t0 ?? 't0'
    if (t !== t0) Object.assign(deployOptions, main.env.cdsc)

    const extCsvs = await _readExtCsvs(t)
    await cds.deploy(csn, deployOptions, extCsvs ? { ...extCsvs, ...options?.csvs } : options?.csvs).to('db')
  })

  ds.on (['upgrade','extend'], function (req) {
    const { tenant:t, csvs } = req.data
    return this.deploy (t, { csn: csn4(t), csvs })
  })

  ds.on ('unsubscribe', async function (req) {
    const { tenant:t } = req.data
    const { url, database } = cds.env.requires.db.credentials
    if (url === ':memory:' || database === ':memory:') {
      cds.db?.disconnect(t) // REVISIT: ideally not necessary
      cds.connect() // REVISIT: ideally not necessary
    } else {
      const dbUrl = cds.db?.url4(t)
      cds.db?.disconnect(t) // REVISIT: ideally not necessary
      if (dbUrl) {
        await Promise.all([
          fs.rimraf(dbUrl),
          fs.rimraf(dbUrl+'-shm'), // REVISIT: ideally not necessary
          fs.rimraf(dbUrl+'-wal') // REVISIT: ideally not necessary
        ])
      }
    }
  })
  ds.on ('getTables', async req => {
    const { tenant:t } = req.data
    return (await cds.tx({ tenant: t }, tx =>
      tx.run(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    )).map(({ name }) => name)
  })
  ds.on ('getColumns', async req => {
    const { tenant:t, table } = req.data
    return (await cds.tx({ tenant: t }, tx =>
      tx.run(`PRAGMA table_info('${table}')`)
    )).map(({ name }) => name)
  })
  ds.on ('getContainers', async () => {
    const dbUrl = cds.db?.url4('(.*)')
    const list = await fs.readdir(path.dirname(dbUrl))
    const dbPattern = new RegExp(`^${path.basename(dbUrl)}$`)
    return list.filter(f => dbPattern.test(f)).map( f => f.match(dbPattern)[1])
  })

  function csn4 (tenant) {
    const { 'cds.xt.ModelProviderService': mp } = cds.services
    return mp.getCsn ({ tenant, toggles: ['*'], activated: true })
  }

  // workaround for SQLite:
  if (!cds.env.requires.multitenancy) cds.env.requires.multitenancy = true
})
