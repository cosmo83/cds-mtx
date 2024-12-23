const cds = require('@sap/cds/lib'), {db} = cds.env.requires
const path = require('path')
const { promisify } = require('util')
const { retry } = require('../../lib/utils')
const TEMP_DIR = require('fs').realpathSync(require('os').tmpdir())
module.exports = exports = { resources4, build, _imCreateParams, directory4 }
const { cacheBindings = true, t0 = 't0' } = cds.requires.multitenancy ?? {}
const { existsSync } = require('fs')
const { mkdirp } = cds.utils
const main = require('../config')

const { readData } = require('../../lib/utils')

const migration = require('../../lib/migration/migration')

if (db?.kind === 'hana') {
  if (!db.credentials?.sm_url) cds.error('No Service Manager credentials found. Make sure the application is bound to a BTP Service Manager instance.')

  const hana = require('./hana/srv-mgr')
  exports.activated = 'HANA Database'

  // Add HANA-specific handlers to DeploymentService...
  cds.on ('serving:cds.xt.DeploymentService', ds => {

    ds.on ('subscribe', async req => {
      const { tenant:t, options: { _: params } = {}, metadata } = req.data
      let existingContainer
      try { existingContainer = await hana.get(t, { disableCache: true }) } catch (e) {
        if (e.status === 404) return _deploy(req, hana.create(t, _imCreateParams(t, params, metadata)), { skipExt: true })
        else throw e
      }
      // run upgrade
      return _deploy(req, existingContainer)
    })
    ds.on (['upgrade', 'extend'], req => {
      const { tenant:t, options } = req.data
      return _deploy(req, hana.get(t), options)
    })
    ds.on ('deploy', async req => {
      const { tenant:t, options: { _: params, container, out } } = req.data
      await hana.deploy (container, t, out, _hdiDeployParams(t, params), params?.hdi?.deployEnv)
      LOG.info(`successfully deployed to tenant ${t}`)
    })
    ds.on ('unsubscribe', req => {
      const { tenant:t } = req.data
      if (cds.db) cds.db.disconnect(t) // Clean pool with active connections
      return hana.delete(t)
    })
    ds.on ('getTables', async req => {
      const { tenant:t } = req.data
      const { schema } = (t === t0 ? await hana.acquire(t, _imCreateParams(t)) : await hana.get(t)).credentials
      return (await cds.tx({ tenant: t }, tx =>
        tx.run('SELECT TABLE_NAME FROM TABLES WHERE SCHEMA_NAME = ?', [schema])
      )).map(({ TABLE_NAME }) => TABLE_NAME)
    })
    ds.on ('getColumns', async req => {
      const { tenant:t, table, params } = req.data
      const { schema } = (t === t0 ? await hana.acquire(t, _imCreateParams(t, params)) : await hana.get(t)).credentials
      return (await cds.tx({ tenant: t }, tx =>
        tx.run('SELECT * FROM TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?', [schema, table])
      )).map(({ COLUMN_NAME }) => COLUMN_NAME)
    })
    ds.on ('getContainers', async () => {
      const bindings = await hana.getAll()
      const tenantIds = bindings.map(({ labels: { tenant_id } }) => tenant_id[0])
      return [...new Set(tenantIds)]
    })

    // check migration before upgrade
    ds.before('upgrade', async (req) => {
      await migration.checkMigration(req)
    })
  })

}

function _imCreateParams(tenant, params = {}, metadata) {
  const createParamsFromEnv = cds.env.requires['cds.xt.DeploymentService']?.hdi?.create ?? {}
  const createParamsFromTenantOptions = cds.env.requires['cds.xt.DeploymentService']?.for?.[tenant]?.hdi?.create ?? {}
  const createParams = { ...createParamsFromEnv, ...createParamsFromTenantOptions, ...params?.hdi?.create }

  // @sap/instance-manager API compat
  const compat = 'provisioning_parameters' in createParams || 'binding_parameters' in createParams
  if (compat) {
    createParams.provisioning_parameters = { ..._encryptionParams(metadata), ...createParams.provisioning_parameters }
    return createParams
  }

  // flatter @sap/cds-mtxs config
  const bindParamsFromEnv = cds.env.requires['cds.xt.DeploymentService']?.hdi?.bind ?? {}
  const bindParamsFromTenantOptions = cds.env.requires['cds.xt.DeploymentService']?.for?.[tenant]?.hdi?.bind ?? {}
  const bindParams = { ...bindParamsFromEnv, ...bindParamsFromTenantOptions, ...params?.hdi?.bind }

  const final = {}

  const provisioningParams = { ..._encryptionParams(metadata), ...createParams }
  if (Object.keys(provisioningParams).length > 0) final.provisioning_parameters = provisioningParams
  if (Object.keys(bindParams).length > 0) final.binding_parameters = bindParams

  if (tenant === t0) delete final.provisioning_parameters?.dataEncryption

  return Object.keys(final).length > 0 ? final : null
}

function _encryptionParams(data) {
  return data?.globalAccountGUID ? {
    subscriptionContext: {
      // crmId: '',
      globalAccountID: data.globalAccountGUID,
      subAccountID: data.subscribedSubaccountId,
      applicationName: data.subscriptionAppName
    }
  } : {}
}

function _hdiDeployParams(tenant, params = {}) {
  const paramsFromEnv = cds.env.requires['cds.xt.DeploymentService']?.hdi?.deploy || {}
  const paramsFromTenantOptions = cds.env.requires['cds.xt.DeploymentService']?.for?.[tenant]?.hdi?.deploy ?? {}
  return { ...paramsFromEnv, ...paramsFromTenantOptions, ...params?.hdi?.deploy }
}


const { fs, tar, rimraf } = cds.utils
const LOG = cds.log('mtx'), DEBUG = cds.debug('mtx')


function csn4 (tenant) {
  const { 'cds.xt.ModelProviderService': mp } = cds.services
  return mp.getCsn ({ tenant, toggles: ['*'], activated: true })
}


async function resources4 (out) {
  const { 'cds.xt.ModelProviderService': mp } = cds.services
  try {
    const rscs = await mp.getResources()
    await tar.xz(rscs).to(out)
    return out
  } catch (error) {
    if (error.code === 404) return false // No deployment resources
    else error.code = 500 // avoid error codes bubble up to response
    if (!error.message) {
      error.message = 'Could not get additional deployment resources'
    }
    throw error
  }
}
module.exports.resources4 = resources4 // required in abstract provisioning service to prepare shared deployment directory

async function csvs4(tenant, outRoot) {
  const csvs = await _readExtCsvs(tenant)
  if (!csvs) return
  const out = await fs.mkdirp (outRoot,'src','gen','data'), gen = []
  for (const [filename,csv] of Object.entries(csvs)) {
    // store files in src/gen/data
    const filepath = path.join(out, filename)
    gen.push (fs.promises.writeFile(filepath, csv))
  }
  return Promise.all (gen)
}
module.exports.csvs4 = csvs4 // required in abstract provisioning service to prepare shared deployment directory

async function _readExtCsvs(tenant) {
  if (!main.requires.extensibility) return
  const { 'cds.xt.ModelProviderService': mp } = cds.services
  const extensions = await mp.getExtResources(tenant)
  if (!extensions) return null

  const out = await fs.promises.mkdtemp(`${TEMP_DIR}${path.sep}extension-`)
  try {
    const { csvs } = await readData(extensions, out)
    return csvs
  } finally {
    await rimraf(out)
  }
}

async function build (outRoot, csn, updateCsvs, tenant) {
  const out = await fs.mkdirp(outRoot,'src','gen'), gen = []

  const hanaArtifacts = _compileToHana(csn, tenant)

  const { getArtifactCdsPersistenceName } = cds.compiler
  const migrationTables = new Set(cds.reflect(csn)
    .all(item => item.kind === 'entity' && item['@cds.persistence.journal'])
    .map(entity => getArtifactCdsPersistenceName(entity.name, 'quoted', csn, 'hana'))
  )

  for (const { name, suffix, sql } of hanaArtifacts) {
    if (suffix !== '.hdbtable' || !migrationTables.has(name)) {
      gen.push(fs.promises.writeFile(path.join(out, name + suffix), sql))
    }
  }

  // (re-) generate hdbtabledata files, only if csvs have to be added (extension)
  if (updateCsvs) {
    const toHdbtabledata = cds.compile.to.hdbtabledata ?? require(path.join(cds.home, 'bin/build/provider/hana/2tabledata')) // cds@6 compatibility
    const tdata = await toHdbtabledata(csn, { dirs: [path.join(out, 'data')] })

    for (const [data, { file, csvFolder }] of tdata) {
      gen.push (fs.promises.writeFile(path.join(csvFolder,file), JSON.stringify(data)))
    }
  }

  return Promise.all (gen)
}

async function directory4(tenant, stable) {
  // generate suffix if not stable
  const folderSuffix = !stable ? `-${cds.utils.uuid()}` : ''
  const defaultDir = path.join(cds.root, 'gen', `${tenant}${folderSuffix}`)

  try {
    if (!existsSync(defaultDir)) await mkdirp(defaultDir)
    return defaultDir
  } catch (e) {
    if (e.code !== 'EACCES') throw e
    LOG?.(`using temporary directory ${TEMP_DIR} for build result`)
    const out = path.join(TEMP_DIR, 'gen', `${tenant}${folderSuffix}`)
    await mkdirp(out)
    return out
  }
}

async function _deploy (req, _container, { skipExt = false, skipResources = false } = {}) {
  const { tenant, options: { _: params = {}, csn: csnFromParameter } = {} } = req.data

  // avoid undeploy if csn is passed - would potentially delete all tables
  if (csnFromParameter) params.hdi = { ...params.hdi, deploy: { ...params.hdi?.deploy, auto_undeploy: false }}

  if (!cds.db) cds.db = cds.services.db = await cds.connect.to(db)

  const out = await fs.mkdirp (await directory4(skipResources ? 'base' : tenant, skipResources))

  DEBUG?.('preparing HANA deployment artifacts')

  let container = await _container // csn4 accesses tenant tables, container has to exist

  // Note: currently the hana files are created twice, first from getResources,
  // then from local compile -2 hana. This has to be adapted depending on if
  // the project is extended or not. Ideally the base hana files would have to
  // be filtered already when getting the resources.

  // Can already start getting the csn if later required
  const requiresCsn = main.requires.extensibility && !csnFromParameter && !skipExt
  const _csn = requiresCsn ? csn4(tenant) : csnFromParameter

  // 1. Unpack what comes from getResources()
  if (!csnFromParameter && !skipResources) {
    const result = await resources4(out)
    if (result === false) {
      LOG.info('No deployment resources found - skipping deployment')
      return
    }
  }

  // 2. Get csvs from extensions
  const updateCsvs = !csnFromParameter && !skipExt && !!await csvs4(tenant, out)

  if (_csn) {
    // 3. Run cds compile -2 hana with potentially extended model from getCsn()
    const csn = await _csn
    if (csn) try {
        await build(out, csn, updateCsvs, tenant)
        DEBUG?.('finished HANA build')
      } catch (e) {
        if (e.code !== 'ERR_CDS_COMPILATION_FAILURE') throw e
        req.reject(422, e.message)
      }
  }
  if (csnFromParameter) {
    await fs.write ({ file_suffixes: {
      csv:                { plugin_name: 'com.sap.hana.di.tabledata.source' },
      hdbconstraint:      { plugin_name: 'com.sap.hana.di.constraint' },
      hdbindex:           { plugin_name: 'com.sap.hana.di.index' },
      hdbtable:           { plugin_name: 'com.sap.hana.di.table' },
      hdbtabledata:       { plugin_name: 'com.sap.hana.di.tabledata' },
      hdbview:            { plugin_name: 'com.sap.hana.di.view' },
      hdbcalculationview: { plugin_name: 'com.sap.hana.di.calculationview' },
      hdbeshconfig:       { plugin_name: 'com.sap.hana.di.eshconfig' }
    }}) .to (out,'src','gen','.hdiconfig')
  }

  LOG.info('deploying HANA artifacts in', { path: out })
  try {
    // 3. hdi-deploy final build content
    const { 'cds.xt.DeploymentService': ds } = cds.services

    if (cacheBindings) {
      // health-check credentials for DB connection, get uncached if stale
      const driver = require('@sap/cds/libx/_runtime/hana/driver')
      const client = require(driver.name).createClient(container.credentials)
      const connect = promisify(client.connect.bind(client))
      const disconnect = promisify(client.disconnect.bind(client))

      const checkAndRefreshCredentials = async(container, tenant) => {
        try {
          await connect()
          await disconnect()
          return container
        } catch (e) {
          if (/authentication failed/i.test(e.message) || /SSL certificate validation failed/i.test(e.message)) {
            const hana = require('./hana/srv-mgr')
            return hana.get(tenant, { disableCache: true })
          } else {
            LOG.error('refreshing credentials failed with', e)
            throw e
          }
        }
      }
      container = await retry(() => checkAndRefreshCredentials(container, tenant))
    }
    return await ds.deploy({ tenant, options: { container, out, _: params } })
  } finally {
    if (!out.endsWith('gen' + path.sep + 'base')) await fs.rimraf (out) // REVISIT: keep that for caching later on
  }
}

function _compileToHana(csn, tenant) {
  const options = { messages: [], sql_mapping: cds.env.sql.names }
  if (tenant === t0) Object.assign(options, { assertIntegrity: false })
  if (tenant !== t0) Object.assign(options, main.env.cdsc)
  let definitions = []

  if (cds.compile.to.hana) {
    const files = cds.compile.to.hana(csn, options);
    for (const [content, { file }] of files) {
      if (path.extname(file) !== '.json') {
        const { name, ext: suffix } = path.parse(file)
        definitions.push({ name, suffix, sql: content })
      }
    }
  } else {
    // compatibility with cds 7
    const r = cds.compiler.to.hdi.migration(csn, options)
    definitions = r.definitions
  }

  if (options.messages.length > 0) {
    // REVISIT: how to deal with compiler info and warning messages
    DEBUG?.('cds compilation messages:', options.messages)
  }
  return definitions
}
