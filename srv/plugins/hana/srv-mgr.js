const https = require('https')
const { inspect } = require('util')
const cds = require('@sap/cds')
const LOG = cds.log('mtx'), DEBUG = cds.debug('mtx|sm')
const { uuid, fs, path } = cds.utils
const { cacheBindings = true } = cds.env.requires.multitenancy ?? {}
const { sm_url, url, clientid, clientsecret, certurl, certificate, key } = cds.env.requires.db.credentials
const COLORS = !!process.stdout.isTTY && !!process.stderr.isTTY && !process.env.NO_COLOR || process.env.FORCE_COLOR
const axios = require('axios')
const pruneAxiosErrors = require('../../../lib/pruneAxiosErrors')

// In-memory storage -> later also distribute w/ Redis
const instanceLocations = new Map, bindingLocations = new Map

/* API */

async function create(tenant, parameters) {
  LOG.info('creating HDI container for', { tenant }, ...(parameters ? ['with', { ...parameters }] : []))
  const name = await _instanceName4(tenant), service_plan_id = await _planId()
  const { binding_parameters, provisioning_parameters } = parameters ?? {}
  let service_instance_id

  if (instanceLocations.has(tenant)) {
    const storedLocation = instanceLocations.get(tenant)
    LOG.info('polling ongoing instance creation for', { tenant })
    const polledInstance = await _poll(storedLocation)
    service_instance_id = polledInstance.resource_id
    instanceLocations.delete(tenant)
  } else {
  try {
      const _instance = await fetchApi('service_instances?async=true', {
        method: 'POST',
        data: {
          name, service_plan_id, parameters: provisioning_parameters,
          labels: { tenant_id: [tenant] },
        }
      })
      instanceLocations.set(tenant, _instance.headers.location)
      service_instance_id = (await _poll(_instance.headers.location)).resource_id
      instanceLocations.delete(tenant)
    } catch (e) {
      instanceLocations.delete(tenant)
      const status = e.status ?? 500
      if (status === 409 || e.error === 'Conflict') {
        const instance = await _instance4(tenant)
        if (!instance.ready || !instance.usable) {
          const { type, state, errors, resource_type } = instance?.last_operation ?? {}
          LOG.info(`detected unusable instance for tenant '${tenant}' in state '${state}' for operation type '${type}'`)
          if (type === 'create' && state === 'failed') {
            LOG.info(`removing and recreating faulty instance for tenant '${tenant}'`,
              DEBUG ? `with error: ${e.error}: ${e.description}. Last operation: ${errors?.error} ${errors?.description}` : ''
            )
            await remove(tenant)
            return create(tenant, parameters)
          } else if (type === 'create' && state === 'in progress') {
            const location = resource_type + '/' + instance.id + '/operations/' + instance.last_operation.id
            LOG.info(`polling ongoing instance creation for tenant '${tenant}' at location '${location}'`)
            instanceLocations.set(tenant, location)
            await _poll(location)
            instanceLocations.delete(tenant)
          } else {
            e.message ??= ''
            e.message += `${e.error}: ${e.description}. Last operation: ${errors?.error} ${errors?.description}`
            throw e
          }
        }
        service_instance_id = instance.id
      } else {
        cds.error(_errorMessage(e, 'creating', tenant), { status })
      }
    }
  }

  if (bindingLocations.has(tenant)) {
    const storedLocation = bindingLocations.get(tenant)
    LOG.info(`ongoing binding creation for tenant ${tenant}, polling existing request`)
    try {
      await _poll(storedLocation)
    } finally {
      bindingLocations.delete(tenant)
    }
  } else {
    const _binding = await fetchApi('service_bindings?async=true', {
      method: 'POST',
      data: {
        name: tenant + `-${uuid()}`, service_instance_id, binding_parameters,
        labels: { tenant_id: [tenant], service_plan_id: [service_plan_id], managing_client_lib: ['instance-manager-client-lib'] }
      }
    })
    bindingLocations.set(tenant, _binding.headers.location)
    await _poll(_binding.headers.location)
    bindingLocations.delete(tenant)
  }

  const binding = { ...await get(tenant), tags: ['hana'] }
  return cacheBindings ? _bindings4.cached[tenant] = binding : binding
}

async function acquire(tenant, parameters) {
  try { return await get(tenant, { disableCache: true }) } catch (e) {
    if (e.status === 404) return create(tenant, parameters)
    throw e
  }
}

async function get(tenant, options) {
  let credentials, result
  try {
    [{ credentials } = {}] = await _bindings4([tenant], options)
    result = { name: await _instanceName4(tenant), tenant_id: tenant, credentials, tags: ['hana'] }
  } catch (e) {
    cds.error(_errorMessage(e, 'getting', tenant), { status: e.status ?? 500 })
  }
  if (!credentials) cds.error(`Tenant '${tenant}' does not exist`, { status: 404 })
  return result
}

function getAll(tenants = '*', options) {
  return _bindings4(tenants, options)
}

function deploy(container, tenant, out, options, deployEnv) {
  return require('./hdi').deploy(container, tenant, out, options, deployEnv)
}

async function remove(tenant) {
  const instance = await _instance4(tenant)
  if (!instance) return
  const fieldQuery = `service_instance_id eq '${instance.id}'`
  const bindings = []; let token
  do {
    const { data } = await fetchApi('service_bindings', {
      params: { token, fieldQuery }
    })
    const { items, token: nextPageToken } = data
    bindings.push(...items)
    token = nextPageToken
  } while (token)
  const _deleteBindings = bindings.map(async ({ id }) =>
    _poll((await fetchApi(`service_bindings/${id}?async=true`, { method: 'DELETE' })).headers.location)
  )
  if (cacheBindings) delete _bindings4.cached[tenant]
  const failedDeletions = (await Promise.allSettled(_deleteBindings)).filter(d => d.status === 'rejected')
  if (failedDeletions.length > 0) throw new AggregateError(failedDeletions.map(d => d.reason))
  const _deleteInstance = await fetchApi(`service_instances/${instance.id}?async=true`, { method: 'DELETE' })
  if (_deleteInstance.headers.location) await _poll(_deleteInstance.headers.location)
}

module.exports = { create, get, getAll, acquire, deploy, delete: remove }

/* Private helpers */

async function _instance4(tenant) {
  const fieldQuery = `name eq '${await _instanceName4(tenant)}'`
  const instances = await fetchApi('service_instances?async=true&attach_last_operations=true', {
    params: { fieldQuery }
  })
  return instances.data.items[0]
}

async function _instanceName4(tenant) {
  if (cds.requires.multitenancy?.humanReadableInstanceName) return tenant
  // Compatible with @sap/instance-manager-created instances
  return require('crypto').createHash('sha256').update(`${await _planId()}_${tenant}`).digest('base64')
}

_bindings4.cached = {}
async function _bindings4(tenants, { disableCache = false } = {}) {
  const useCache = cacheBindings && !disableCache && tenants !== '*'
  const uncached = useCache ? tenants.filter(t => !(t in _bindings4.cached)) : tenants
  DEBUG?.('retrieving', { tenants }, { uncached })
  if (uncached.length === 0) return tenants.map(t => _bindings4.cached[t])
  const _tenantFilter = () => ` and tenant_id in (${uncached.map(t => `'${t}'`).join(', ')})`
  const tenantFilter = tenants === '*' ? '' : _tenantFilter()
  const labelQuery = `service_plan_id eq '${await _planId()}'` + tenantFilter
  const fieldQuery = `ready eq 'true'`
  const fetched = []; let token
  do {
    const { data } = await fetchApi('service_bindings', {
      params: { token, labelQuery, fieldQuery }
    })
    const { items, token: nextPageToken } = data
    fetched.push(...items)
    token = nextPageToken
  } while (token)
  const cacheMisses = Object.fromEntries(fetched.filter(b => b.labels?.tenant_id).map(b => [b.labels.tenant_id[0], b]))
  Object.assign(_bindings4.cached, cacheMisses)
  if (useCache) {
    return tenants.map(t => _bindings4.cached[t])
  }
  return fetched
}

async function _planId() {
  if (_planId.cached) return _planId.cached
  const fieldQuery = `catalog_name eq 'hdi-shared' and service_offering_id eq '${await _offeringId()}'`
  const { data } = await fetchApi('service_plans', { params: { fieldQuery } })
  const [planId] = data.items
  if (!planId) cds.error(`Could not find service plan with ${fieldQuery}`)
  return _planId.cached = data.items[0].id
}

async function _offeringId() {
  if (_offeringId.cached) return _offeringId.cached
  const fieldQuery = `catalog_name eq 'hana'`
  const { data } = await fetchApi('service_offerings', { params: { fieldQuery } })
  const [offeringId] = data.items
  if (!offeringId) cds.error(`Could not find service offering with ${fieldQuery}`)
  return _offeringId.cached = data.items[0].id
}

async function _token() {
  if (!_token.cached || _token.cached.expiry < Date.now() + 30000) {
    const auth = certificate ? { maxRedirects: 0, httpsAgent: new https.Agent({ cert: certificate, key }) }
                             : { auth: { username: clientid, password: clientsecret } }
    const authUrl = `${certurl ?? url}/oauth/token`
    const data = `grant_type=client_credentials&client_id=${encodeURI(clientid)}`
    const config = { method: 'POST', timeout: 5000, data, ...auth }
    const { access_token, expires_in } = (await fetchResiliently(authUrl, config)).data
    _token.cached = { access_token, expiry: Date.now() + expires_in * 1000 }
  }
  return `Bearer ${_token.cached.access_token}`
}

function _poll(location) {
  let attempts = 0, maxAttempts = 60, pollingTimeout = 3000, maxTime = pollingTimeout * maxAttempts/1000
  const _next = async (resolve, reject) => {
    const { data, data: { state, errors } } = await fetchApi(location.slice('/v1/'.length))
    if (state === 'succeeded') return resolve(data)
    if (state === 'failed') return reject(errors[0] ?? errors)
    if (attempts > maxAttempts) return reject(new Error(`Polling ${location} timed out after ${maxTime} seconds with state ${state}`))
    setTimeout(++attempts && _next, pollingTimeout, resolve, reject)
  }
  return new Promise(_next)
}

function _errorMessage(e, action, tenant) {
  const msg = `Error ${action} tenant ${tenant}: ${e.response?.data?.error ?? e.code ?? e.message ?? 'unknown error'}`
  const cause = e.description || e.cause ? require('os').EOL + `Root Cause: ${e.description ?? e.cause}` : ''
  return msg + cause
}

const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))

const fetchApi = async (url, conf = {}) => {
  conf.headers ??= {}
  conf.headers.Authorization ??= await _token()
  conf.headers['Content-Type'] ??= 'application/json'
  conf.headers['Client-ID'] ??= 'cap-mtx-sidecar'
  conf.headers['Client-Version'] ??= version
  conf.headers['X-CorrelationID'] ??= cds.context?.id
  conf.headers['X-Correlation-ID'] ??= cds.context?.id
  conf.baseURL ??= sm_url + '/v1/'
  return fetchResiliently(conf.baseURL + url, conf)
}

const SECRETS = /(passw)|(cert)|(ca)|(secret)|(key)|(access_token)|(imageUrl)/i
/**
 * Masks password-like strings, also reducing clutter in output
 * @param {any} cred - object or array with credentials
 * @returns {any}
 */
const _redacted = function _redacted(cred) {
  if (!cred) return cred
  if (Array.isArray(cred)) return cred.map(c => _redacted(c))
  if (typeof cred === 'object') {
    const newCred = Object.assign({}, cred)
    Object.keys(newCred).forEach(k => (typeof newCred[k] === 'string' && SECRETS.test(k)) ? (newCred[k] = '...') : (newCred[k] = _redacted(newCred[k])))
    return newCred
  }
  return cred
}

const maxRetries = cds.requires?.multitenancy?.serviceManager?.retries ?? 3
const fetchResiliently = module.exports.fetchResiliently = async function (url, conf, retriesLeft = maxRetries) {
  conf.method ??= 'GET'
  try {
    DEBUG?.('>', conf.method.toUpperCase(), url, inspect({
      ...(conf.headers && { headers: { ...conf.headers, Authorization: conf.headers.Authorization.split(' ')?.[0] + ' ...' } }),
      ...(conf.params && { params: conf.params }),
      ...(conf.data && { data: conf.data })
    }, { depth: 11, compact: false, colors: COLORS }))
    const response = await axios(url, conf)
    const { status, statusText } = response
    DEBUG?.('<', conf.method.toUpperCase(), url, status, statusText, inspect(_redacted(response.data), { depth: 11, colors: COLORS }))
    return response
  } catch (error) {
    const { status, headers } = error.response ?? { status: 500 }
    if (status in { 401: 1, 403: 1, 404: 1 } || retriesLeft === 0) return pruneAxiosErrors(error)

    const attempt = maxRetries - retriesLeft + 1
    if (LOG._debug) {
      const e = error.toJSON?.() ?? error
      DEBUG(`fetching ${url} attempt ${attempt} failed with`, {
        ...(e.name && { name: e.name }),
        ...(e.message && { message: e.message }),
        ...(e.description && { description: e.description })
      })
    }
    let delay = 0
    if (status === 429) {
      const retryAfter = headers['retry-after']
      if (retryAfter) delay = parseInt(retryAfter, 10) * 1000
      else return pruneAxiosErrors(error)
    } else { // S-curve instead of exponential backoff to allow for high number of reattempts (∞)
      const maxDelay = 30000, midpoint = 6, steepness = 0.4
      delay = maxDelay * (1 + Math.tanh(steepness * (attempt - midpoint))) / 2
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (conf.headers?.Authorization) conf.headers.Authorization = await _token()
    return fetchResiliently(url, conf, retriesLeft - 1)
  }
}
