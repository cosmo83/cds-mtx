const { join } = require('path')
const { deploy, clean_env } = require('@sap/hdi-deploy/library')
const cds = require ('@sap/cds/lib')
const LOG = cds.log('mtx'), LOG_DEPLOY = cds.log('deploy'), DEBUG = LOG_DEPLOY._debug ? cds.debug('deploy') : cds.debug('mtx')
const { fs, mkdirp } = cds.utils
const TEMP_DIR = fs.realpathSync(require('os').tmpdir())

exports._logDirectory = async () => {
  const defaultDir = join(cds.root, 'logs')
  try {
    await mkdirp(defaultDir)
    return defaultDir
  } catch (e) {
    if (e.code !== 'EACCES') throw e
    LOG?.(`using temporary directory ${TEMP_DIR} for deployment logs`)
    return join(TEMP_DIR, 'logs')
  }
}

exports.deploy = async (hana, tenant, cwd, options, deployEnv) => {
  const env = exports._hdi_env4(tenant,hana,options,deployEnv)
  DEBUG?.(`deployment directory: ${cwd}`)
  DEBUG?.(`effective HDI options:`, env.HDI_DEPLOY_OPTIONS)

  const logDir = await exports._logDirectory()
  const logPath = join(logDir, `${cds.context.tenant}.log`)
  await mkdirp(logDir)
  const writeStream = fs.createWriteStream(logPath)
  DEBUG?.('------------[BEGIN HDI-DEPLOY-OUTPUT]---------------')
  try {
    return await new Promise((resolve, reject) => {
        deploy(cwd, env, (error, response) => {
            if (error) return reject(error)
            if (response?.exitCode) {
                const logs = response.messages.filter(m => typeof m === 'object' && m.severity === 'ERROR').map(m => m.message).join('\n')
                let message = `HDI deployment failed with exit code ${response.exitCode}. Correlation ID: ${cds.context.id}, Logs:\n${logs}`
                if (response.signal) message += `. ${response.signal}`
                return reject(new Error(message))
            }
            return resolve()
        }, {
          stderrCB: buffer => {
              LOG.error(buffer.toString())
              writeStream.write(buffer)
          },
          stdoutCB: buffer => {
              DEBUG?.(buffer.toString())
              writeStream.write(buffer)
          }
      })
    })
  } finally {
    DEBUG?.('-------------[END HDI-DEPLOY-OUTPUT]----------------')
    writeStream.end()
    LOG.info('written deployment logs', { to: logPath })
  }
}
/**
 *
 * @param {String} t tenant
 * @param {Object} container container credentials
 * @param {Object} options only contains HDI_DEPLOY_OPTIONS
 * @param {Object} deployEnv custom environment variables
 * @returns environment variables for HDI deployment
 */
exports._hdi_env4 = (t,container,options,deployEnv)=>{
  const env = {
    ...clean_env(process.env),
    TARGET_CONTAINER:t,
    SERVICE_REPLACEMENTS: process.env.SERVICE_REPLACEMENTS,
    ...deployEnv // Although VCAP is in here, it will be overwritten
  }

  const { hana=[], 'user-provided':up=[] } = _parse_env (process.env, 'VCAP_SERVICES')
  const { hana: customEnvHana=[], 'user-provided':customEnvUp=[] } = _parse_env(deployEnv ?? {}, 'VCAP_SERVICES')

  const vcapFromEnv = {
    hana:[ { ...container, name:t, tenant_id:t }, ...hana, ...customEnvHana ],
    'user-provided': [ ...up, ...customEnvUp ]
  }
  const emulatedVcap = _emulated_vcap_services()
  env.VCAP_SERVICES = JSON.stringify ({ ...vcapFromEnv, ...emulatedVcap})

  const hdi_opts = _parse_env (process.env, 'HDI_DEPLOY_OPTIONS', options)
  try { require.resolve('hdb') } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') hdi_opts.use_hdb = false
    else throw e
  }
  if (hdi_opts.use_hdb !== false) hdi_opts.use_hdb = true
  if (hdi_opts.use_hdb === false) hdi_opts.use_hdb = undefined
  env.HDI_DEPLOY_OPTIONS = JSON.stringify (hdi_opts)
  return env
}
const _parse_env = (env, key, options) => {
  const val = env[key]; if (!val) return { ...options }
  try {
    return { ...(typeof val === 'string' ? JSON.parse(val) : val), ...options }
  } catch(e) {
    e.message = `Invalid ${key} options: ${e.message} ${val}`
    e.code = e.statusCode = 400
    throw e
  }
}

/**
  * Build VCAP_SERVICES for compatibility (for example for CloudSDK) or for running
  * locally with credentials (hybrid mode).
  * Copied from @sap/cds/lib/env/cds-env.js#L333
  */
function _emulated_vcap_services() {
  const vcap_services = {}, names = new Set()
  for (const service in cds.env.requires) {
    let { vcap, credentials, binding } = cds.env.requires[service]
    // "binding.vcap" is chosen over "vcap" because it is meta data resolved from the real service (-> cds bind)
    if (binding && binding.vcap) vcap = binding.vcap
    if (vcap && vcap.label && credentials && Object.keys(credentials).length > 0) {
      // Only one entry for a (instance) name. Generate name from label and plan if not given.
      const { label, plan } = vcap
      const name = vcap.name || `instance:${label}:${plan || ""}`
      if (names.has(name)) continue
      names.add(name)

      if (!vcap_services[label]) vcap_services[label] = []
      vcap_services[label].push(Object.assign({ name }, vcap, { credentials }))
    }
  }
  return vcap_services
}
