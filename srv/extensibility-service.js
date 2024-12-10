const cds = require('@sap/cds/lib'), { fs, path, tar, rimraf } = cds.utils
const main = require('./config')
const { token, authMeta } = require('./extensibility/token')
const { addCodeAnnotations } = require('./extensibility/code-extensibility/addCodeAnnotLocal')
const linter = require('./extensibility/linter')
const { getMigratedProjects } = require('../lib/migration/migration')
const { readData } = require('../lib/utils')

const TOMBSTONE_ID = '__tombstone'
const TEMP_DIR = fs.realpathSync(require('os').tmpdir())
const LOG = cds.log('mtx')
const DEBUG = cds.debug('mtx')
const _isCSN = str => str.substring(0, 1) === '{'
const _async = (req) => {
  const async = cds.context.http?.req?.headers?.prefer === 'respond-async'
  DEBUG?.('Request headers for async extensibility')
  DEBUG?.('cds.context.http.req.headers.prefer: ', cds.context.http?.req?.headers?.prefer)
  DEBUG?.('req.headers.prefer: ', req.headers?.prefer)
  // TODO remove
  if (cds.env.requires['cds.xt.ExtensibilityService']?._disableAsync === true) return false
  return async
}

module.exports = class ExtensibilityService extends cds.ApplicationService {

  async init() {

    this.on('push', async req => {
      let { extension, tag } = req.data
      if (!req.user.is('internal-user') && req.data.tenant && req.data.tenant !== req.tenant)
        req.reject(403, `No permission to push extensions to tenants other than ${req.tenant}`)
      const tenant = (req.user.is('internal-user') && req.data.tenant) || req.tenant
      if (tenant) cds.context = { tenant }

      if (!extension) req.reject(400, 'Missing extension')
      const sources = typeof extension === 'string' ? Buffer.from(extension, 'base64') : extension
      const root = await fs.promises.mkdtemp(`${TEMP_DIR}${path.sep}extension-`)
      try {
        const { extCsn, bundles, csvs } = await readData(sources, root)
        if (main.requires.extensibility?.code) await addCodeAnnotations(root, extCsn, req.tenant)
        if (!extCsn.extensions && !extCsn.definitions) req.reject(400, 'Missing or bad extension')
        if (!tag) tag = null
        await _activate(tenant, tag, extCsn, bundles, csvs, sources, 'database', req)
      } finally {
        rimraf (root)
      }
    })

    this.on('pull', async req => {
      LOG.info(`pulling latest model for tenant '${req.tenant}'`)
      const { 'cds.xt.ModelProviderService': mps } = cds.services
      const csn = await mps.getCsn({
        tenant: req.tenant,
        toggles: cds.context.features, // with all enabled feature extensions
        base: true, // without any custom extensions
        flavor: 'xtended'
      })
      // filter @impl from csn - danger, must be cloned as it comes from the cache
      const extProjectBaseCsn = cds.clone(csn)
      for (const def of Object.values(extProjectBaseCsn.definitions)) {
        delete def['@impl']
      }
      req.http.res?.set('content-type', 'application/octet-stream; charset=binary')
      const temp = await fs.promises.mkdtemp(`${TEMP_DIR}${path.sep}extension-`)
      try {
        await fs.promises.writeFile(path.join(temp, 'index.csn'), cds.compile.to.json(extProjectBaseCsn))
        const config = linter.configCopyFrom(cds.env)
        await fs.promises.writeFile(path.join(temp, '.cdsrc.json'), JSON.stringify(config, null, 2))
        return await tar.cz(temp)
      } finally {
        rimraf (temp)
      }
    })

    this.on('READ', 'Extensions', async req => {
      const tenant = _tenant(req)
      if (tenant) cds.context = { tenant }
      const ext = !req.data?.ID ? await SELECT.from('cds.xt.Extensions') : await SELECT.one.from('cds.xt.Extensions').where({ tag: req.data.ID })
      if (Array.isArray(ext)) return ext.filter(e => e.tag !== TOMBSTONE_ID).map(e => ({ ID: e.tag, csn: e.csn, i18n: e.i18n !== '{}' ? e.i18n : undefined, timestamp: e.timestamp }))
      if (ext) return { ID: ext.tag, csn: ext.csn, i18n: ext.i18n !== '{}' ? ext.i18n : undefined, timestamp: ext.timestamp }
      return ext
    })

    this.on('UPDATE', 'Extensions', async req => {
      const tenant = _tenant(req)
      const job = await _set(req, { extension: [...req.data.csn], resources: req.data.i18n, tag: req.data.ID, tenant: tenant ?? req.tenant })
      if (_async(req)) {
        return job
      }
      const res = await SELECT.one.from('cds.xt.Extensions').where({ tag: req.data.ID })
      cds.context.http?.res.status(200)
      return { ID: res.tag, csn: res.csn, i18n: res.i18n !== '{}' ? res.i18n : undefined, timestamp: res.timestamp }
    })

    this.on('set', req => {
      let { extension, tag, resources, activate } = req.data
      // if (!req.user.is('internal-user') && req.data.tenant && req.data.tenant !== req.tenant)
      //   req.reject(403, `No permission to add extensions to tenants other than ${req.tenant}`)
      const tenant = (req.user.is('internal-user') && req.data.tenant) || req.tenant || '' // REVISIT: magic
      return _set(req, { extension, tag, resources, activate, tenant })
    })

    this.on('DELETE', 'Extensions', async req => {
      const tenant = _tenant(req)
      if (tenant) cds.context = { tenant } // req.data.tenant from header if exists
      const result = !req.data?.ID ? await DELETE.from('cds.xt.Extensions') : await DELETE.from('cds.xt.Extensions').where({ tag: req.data.ID })
      // leave tombstone for deployment - ID cannot be used in case of all extensions (no ID passed)
      const job = await _set(req, { extension: ['{}'], tag: TOMBSTONE_ID, tenant: tenant ?? req.tenant })
      if (_async(req)) {
        return job
      }
      return result
    })

    this.on('getMigratedProjects', (req) => {
      let { tagRule, defaultTag } = req.data
      const tenant = req.tenant // REVISIT: check if access for arbitrary tenants needed
      if (!tenant) req.reject(401, 'User not assigned to any tenant')
      return getMigratedProjects(req, tagRule || undefined, defaultTag || undefined, tenant)
    })

    const _in_prod = process.env.NODE_ENV === 'production'
    if (main.requires.extensibility?.code && !_in_prod && !main.requires.multitenancy) {
      const findings = await addCodeAnnotations()
      if (findings?.length > 0) {
        let message = `Code validation failed with ${findings.length} finding(s):\n\n`
        message += findings.join('\n')
        throw new Error(message)
      }
    }

    cds.on('served', () => {
      cds.app?.post('/-/cds/login/token', token)
      cds.app?.get('/-/cds/login/authorization-metadata', authMeta)
    })

    return super.init()
  }

  async activateExtension(tenant, tag, extCsn, bundles, csvs, sources, activated) {
    try {
      // remove current extension with tag
      if (tag) await DELETE.from('cds.xt.Extensions').where({ tag })

      // insert and activate extension
      const ID = cds.utils.uuid()
      const csn = JSON.stringify(extCsn)
      const i18n = bundles ? JSON.stringify(bundles) : null
      await INSERT.into('cds.xt.Extensions').entries({ ID, csn, i18n, sources, activated, tag })

      // do validation after extension table update - trust transaction handling for rollback
      await _lint(tenant, extCsn, tag)

      if (activated === 'database')  {
        LOG.info(`activating extension '${tag}' ...`)
        const { 'cds.xt.DeploymentService': ds } = cds.services
        await ds.extend(tenant, csvs)
      }
    } catch (error) {
      // needs to be serialized because it is stored in the db by the job service - TODO check for HDI error somehow?
      if (error.code || error.status) throw new Error(JSON.stringify(error))
      throw new Error(JSON.stringify({ status: 422, message: error.message })) // for HDI errors
    }
  }
}

const _tenant = function (req) {
  const tenant = req.headers['x-tenant-id']
  if (!req.user.is('internal-user') && tenant && tenant !== req.tenant)
    req.reject(403, `No permission to activate extensions by tenants other than ${req.tenant}`)
  return tenant
}

const _mergeCSN = function (extension, merged) {
  if (!merged) merged = { extensions: [], definitions: {} }
  if (extension.definitions) Object.assign (merged.definitions, extension.definitions)
  if (extension.extensions) merged.extensions.push (...extension.extensions)
  return merged
}

const _toJson = function (content) {
  const json = {}, splitted = content.split('\n')
  splitted.forEach(s => {
    const parts = s.split('=').map(s => s.trim()), [key, val] = parts
    if (parts.length === 2) json[key] = val
  })
  return json
}

const _getFiles = function (resources) {
  let bundles = {}
  let fromJson = false
  const csvs = {}
  if (resources && Array.isArray(resources) && resources.length) {
    resources.forEach(file => {
      const key = file.name.match(/i18n_*(.*)\.properties/), lang = key?.[1]
      if (key) {
        if (fromJson) throw new cds.error ({ message:  `Mixed i18n file types not supported: i18n.json and ${file.name}`, code: 422 })
        bundles[lang] = _toJson(file.content)
      } else if (file.name === 'i18n.json') {
        if (Object.entries(bundles).length) throw new cds.error ({ message:`Mixed i18n file types not supported: i18n.json and .properties`, code: 422 })
        try {
          bundles = JSON.parse(file.content)
          fromJson = true
        } catch (e) {
          throw new cds.error ({ message: `Invalid JSON content in i18n.json: ${e.message}`, code: 422 })
        }
      } else if (file.name.endsWith('.csv')) {
        csvs[file.name] = file.content
      }
    })
  }
  return { bundles, csvs }
}

const _set = async function (req, { extension, tag = null, resources, activate = 'database', tenant }) {
  if (!extension) throw new cds.error ({ message: 'Property "extension" is missing', code: 400 })
    if (Array.isArray(extension)) {
      if (!extension.length) throw new cds.error ({ message: 'Property "extension" is empty', code: 400 })
    } else {
      const length = typeof extension === 'string' ? extension.length : Object.keys(extension).length
      if (!length) throw new cds.error ({ message: 'Property "extension" is malformed', code: 400 })
    }
  if (tenant) cds.context = { tenant }
  let extCsn
  for (let ext of extension) {
    if (typeof ext === 'string') {
      if (!ext.length) throw new cds.error ({ message: 'Missing extension', code: 400 })
      if (_isCSN(ext)) extCsn = _mergeCSN(JSON.parse(ext), extCsn)
      else try { extCsn = _mergeCSN(cds.parse.cdl(ext), extCsn) } catch (e) {
        if (e.code === 'ERR_CDS_COMPILATION_FAILURE') throw new cds.error ({ message: e.message, code: 422 })
        else throw e
      }
    } else {
      if (!Object.keys(ext).length) throw new cds.error ({ message: 'Missing extension', code: 400 })
      extCsn = _mergeCSN(ext, extCsn)
    }
  }
  if (extCsn.requires) delete extCsn.requires
  const { bundles, csvs } = _getFiles(resources)
  await _activate(tenant, tag, extCsn, bundles, csvs, null, activate, req)
}

const _activate = async function (tenant, tag, extCsn, bundles, csvs, sources, activate, req) {
  const async = _async(req)
  try {
    const js = await cds.connect.to('cds.xt.JobsService')
    // eslint-disable-next-line no-async-promise-executor
    return await new Promise( async (resolve, reject) => {
      const cb = !async ? error => {
        if (error) {
          try {
            const errorObject = JSON.parse(error)
            return reject(errorObject)
          } catch {
            return reject(error)
          }
        }
        cds.context.http?.res.status(204)
        return resolve()
      } : () => {}

      const tx = js.tx({ tenant: req.tenant, user: new cds.User.Privileged() })
      const job = await tx.enqueue('cds.xt.ExtensibilityService', 'activateExtension', [new Set([tenant])], { tag, extCsn, bundles, csvs, sources, activate }, cb)
      if (async) {
        resolve(job)
      }
    })
  } catch (err) {
    if (err.code === 'ERR_CDS_COMPILATION_FAILURE') req.reject(422, _getCompilerError(err.messages))
    else req.reject(err)
  }
}

const _lint = async function (tenant, extCsn, tag) {
  LOG.info(`validating extension '${tag}' ...`)
  const { 'cds.xt.ModelProviderService': mps } = cds.services
  let csn // REVISIT: Isn't that also done during activate?
  try {
    csn = await mps.getCsn(tenant, cds.context.features)
  } catch (err) {
    throw new cds.error ({ message: _getCompilerError(err.messages), code: 400 })
  }

  const findings = linter.lint(extCsn, csn)
  if (findings.length > 0) {
    let message = `Validation for ${tag} failed with ${findings.length} finding(s):\n\n`
    message += findings.map(f => '  - ' + f.message).join('\n') + '\n'
    throw new cds.error ({ message, status: 422 })
  }
}

const _getCompilerError = messages => {
  const defaultMsg = 'Error while compiling extension'
  if (!messages) return defaultMsg
  for (const msg of messages) {
    if (msg.severity === 'Error') return msg.message
  }
  return defaultMsg
}
