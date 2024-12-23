const cds = require('@sap/cds/lib')
const LOG = cds.log('mtx'), DEBUG = cds.debug('mtx')
const main = require('../config')
const migration = require('../../lib/migration/migration')
const DeploymentService = 'cds.xt.DeploymentService'
const JobsService = 'cds.xt.JobsService'
const Tenants = 'cds.xt.Tenants'

const axiosInstance = require('axios').create()
axiosInstance.interceptors.response.use(response => response, require('../../lib/pruneAxiosErrors'))

if (!cds.env.requires.multitenancy) cds.env.requires.multitenancy = true // we need to run in multitenancy mode for t0 ops
const { t0 = 't0' } = cds.env.requires.multitenancy

module.exports = class ProvisioningService extends cds.ApplicationService {

  _options4(data) {
    if (!data?.options && !data._ && !data._application_) return undefined
    const _ = data._application_?.sap ? { hdi: { create: data._application_.sap['service-manager'] } } : data._
    return { ...data.options, _ }
  }

  async _tenantsByDb(tenants) {
    let tenantToDbUrl
    if (cds.requires.db.kind === 'hana') { // REVISIT: HANA-specific, should be in HANA plugin
      const hana = require('../plugins/hana/srv-mgr')
      const smTenants = (await hana.getAll(tenants.length > 0 ? tenants : '*')).filter(Boolean)
      if (tenants.length !== smTenants.length) {
        const smSet = new Set(smTenants.map(t => t.tenant_id ?? t.labels.tenant_id[0]))
        const inconsistent = tenants.filter(t => !smSet.has(t))
        if (inconsistent.length === 1) LOG.warn(`Warning: Tenant ${inconsistent[0]} does not exist in Service Manager any more and is therefore ignored. Make sure to unsubscribe the tenant.`)
        else LOG.warn(`Warning: Tenants ${inconsistent.join(', ')} do not exist in Service Manager any more and are therefore ignored. Make sure to unsubscribe the tenants.`)
      }
      tenantToDbUrl = smTenants.reduce((res, t) => {
        const id = t.tenant_id ?? t.labels.tenant_id[0]
        if (!t.credentials) throw new Error('Credentials for tenant ' + id + ' are not available.')
        return { ...res, [id]: `${t.credentials.host}:${t.credentials.port}` }
      }
      , {})
    } else {
      tenantToDbUrl = tenants.reduce((res, t) => ({ ...res, [t]: cds.db.url4(t) }), {})
    }
    const dbToTenants = {}
    for (const tenant of Object.keys(tenantToDbUrl)) {
      const dbUrl = tenantToDbUrl[tenant]
      if (!dbToTenants[dbUrl]) dbToTenants[dbUrl] = new Set
      dbToTenants[dbUrl].add(tenant)
    }
    return dbToTenants
  }

  _getAppUrl(context) {
    const { subscriptionPayload, subscriptionHeaders } = context?.data ?? {}
    return subscriptionHeaders?.application_url
        ?? process.env.SUBSCRIPTION_URL?.replace(`\${tenant_subdomain}`, subscriptionPayload.subscribedSubdomain)
        ?? 'Tenant successfully subscribed - no application URL provided'
  }

  _getSubscribedTenant(context) {
    const { data, params } = context ?? {}
    const { subscribedTenantId } = data ?? {}
    return subscribedTenantId ?? params?.[0]?.subscribedTenantId
  }

  async _create(context, metadata) {
    const { headers, data, http } = context
    DEBUG?.('received subscription request with', { data: require('util').inspect(data, { depth: 11 }) })
    const options = this._options4(metadata)
    // REVISIT: removing as they are polluting logs -> clearer data/options separation
    delete data._; delete data._application_; delete data.options
    const tenant = this._getSubscribedTenant(context)
    const { isSync } = this._parseHeaders(http?.req.headers)

    const sps = await cds.connect.to(this.name)
    const appUrl = await sps.getAppUrl(metadata, headers)
    if (isSync) {
      LOG.info(`subscribing tenant ${tenant}`)
      try {
        const ds = await cds.connect.to(DeploymentService)
        const tx = ds.tx(context)
        await tx.subscribe(tenant, metadata, options)
        await this._sendCallback('SUCCEEDED', 'Tenant creation succeeded', appUrl)
        cds.context.http.res.set('content-type', 'text/plain')
      } catch (error) {
        await this._sendCallback('FAILED', 'Tenant creation failed')
        throw error
      }
      return appUrl
    } else {
      const { lazyT0 } = cds.requires['cds.xt.DeploymentService'] ?? cds.requires.multitenancy ?? {}
      if (lazyT0) {
        await require('../plugins/common').resubscribeT0IfNeeded(options?._)
      }
      const js = await cds.connect.to(JobsService)
      const tx = js.tx({ tenant: context.tenant, user: new cds.User.Privileged() })
      return tx.enqueue('cds.xt.DeploymentService', 'subscribe', [new Set([tenant])], { data, options }, error => {
        if (error) this._sendCallback('FAILED', `Tenant creation failed with error '${error}'`)
        else this._sendCallback('SUCCEEDED', 'Tenant creation succeeded', appUrl)
      })
    }
  }

  async _read(context) {
    const tenant = this._getSubscribedTenant(context)
    if (tenant) {
      const one = await cds.tx({ tenant: t0 }, tx =>
        tx.run(SELECT.one.from(Tenants).columns(['metadata', 'createdAt', 'modifiedAt']).where({ ID: tenant }))
    )
      if (!one) cds.error(`Tenant ${tenant} not found`, { status: 404 })
      const { metadata, createdAt, modifiedAt } = one
      return { subscribedTenantId: tenant, ...JSON.parse(metadata ?? '{}'), createdAt, modifiedAt }
    }
    return (await cds.tx({ tenant: t0 }, tx =>
      tx.run(SELECT.from(Tenants).columns(['ID', 'metadata', 'createdAt', 'modifiedAt']))
    )).map(({ ID, metadata, createdAt, modifiedAt }) => ({ subscribedTenantId: ID, ...JSON.parse(metadata), createdAt, modifiedAt }))
  }

  async _getTenants() {
    const ds = await cds.connect.to(DeploymentService)
    const tenants = await ds.getTenants()
    const mtxTenants = await migration.getMissingMtxTenants(tenants)
    const all = [...tenants, ...mtxTenants]
    if (cds.env.requires[this.name]?.upgrade?.ignoreNonExistingContainers) {
      const containers = await ds.getContainers()
      return all.filter(t => containers.includes(t))
    }
    return all
  }

  async _upgrade(context) {
    const { tenants: tenantIds, options = {} } = context.data
    if (!tenantIds?.length) return
    const all = tenantIds.includes('*')
    const sharedGenDir = !main.requires.extensibility
    if (sharedGenDir) options.skipResources ??= sharedGenDir
    const tenants = all ? await this._getTenants() : tenantIds
    const { isSync } = this._parseHeaders(cds.context.http?.req.headers)
    if (!tenants.length && isSync) return
    if (sharedGenDir && cds.requires.db.kind === 'hana') { // REVISIT: Ideally part of HANA plugin
      const { resources4, csvs4, directory4 } = require('../plugins/hana')
      const out = await directory4('base', true)
      await resources4(out)
      await csvs4('base',out)
    }
    const { clusterSize = 1 } = cds.env.requires.multitenancy.jobs ?? cds.env.requires[this.name]?.jobs ?? {}
    const dbToTenants = clusterSize > 1 ? await this._tenantsByDb(tenants) : [new Set(tenants)]
    LOG.info('upgrading', { tenants })

    const js = await cds.connect.to(JobsService)
    return await new Promise((resolve, reject) => {
      const tx = js.tx({ tenant: cds.context.tenant, user: new cds.User.Privileged() })
      const job = tx.enqueue('cds.xt.DeploymentService', 'upgrade', dbToTenants, { options }, async error => {
        if (error) {
          await this._sendCallback('FAILED', `Tenant upgrade failed with error '${error}'`)
          if (isSync) reject(error)
        } else {
          await this._sendCallback('SUCCEEDED', 'Tenant upgrade succeeded')
          if (isSync) {
            cds.context.http?.res.status(204)
            resolve()
          }
        }
      })
      if (!isSync) resolve(job)
    })
  }

  async _delete(context) {
    DEBUG?.('received unsubscription request', context.data)
    const { isSync } = this._parseHeaders(context.http?.req.headers)

    const tenant = this._getSubscribedTenant(context) ?? context.query.DELETE.from?.ref?.[0]?.where?.find(e => e.val)?.val
    LOG.info(`unsubscribing tenant ${tenant}`)

    if (tenant === t0) {
      const ds = await cds.connect.to(DeploymentService)
      const tx = ds.tx(context)
      return tx.unsubscribe(tenant)
    }

    const one = await cds.tx({ tenant: t0 }, tx =>
      tx.run(SELECT.one.from(Tenants, { ID: tenant }, t => { t.metadata }))
    ) ?? {}
    const metadata = JSON.parse(one?.metadata ?? '{}')

    if (isSync) {
      const ds = await cds.connect.to(DeploymentService)
      const tx = ds.tx(context)
      try {
        await tx.unsubscribe(tenant, { metadata })
        await this._sendCallback('SUCCEEDED', 'Tenant deletion succeeded')
      } catch (error) {
        if (error.statusCode === 404) {
          LOG.info(`tenant ${tenant} is currently not subscribed`)
        } else {
          await this._sendCallback('FAILED', 'Tenant deletion failed')
          throw error
        }
      }
    } else {
      const lcs = await cds.connect.to(JobsService)
      const tx = lcs.tx({ tenant: context.tenant, user: new cds.User.Privileged() })
      return tx.enqueue('cds.xt.DeploymentService', 'unsubscribe', [new Set([tenant])], { metadata }, error => {
        if (error) this._sendCallback('FAILED', `Tenant deletion failed with error '${error}'`)
        else this._sendCallback('SUCCEEDED', 'Tenant deletion succeeded')
      })
    }
  }

  _dependencies() {
    // Compat for cds.requires.multitenancy.dependencies
    const provisioning = cds.env.requires[this.name] ?? cds.env.requires.multitenancy
    if (provisioning?.dependencies) {
      return provisioning.dependencies.map(d => ({ xsappname: d }))
    }

    // Construct from cds.requires
    const dependencies = []
    for (const [name, req] of Object.entries(cds.env.requires)) {
      const tree = req.subscriptionDependency
      if (!tree) continue
      const extractDependency = (node, root, path = []) => {
        if (typeof node === 'object' && node !== null) {
          for (const [key, value] of Object.entries(node)) {
            const currentPath = [...path, key]
            const next = root?.[key]
            if (!next) throw new Error(`Cannot resolve dependency at path '${currentPath.join('.')}' in service '${name}'. Make sure the service is bound to the MTX sidecar.`)
            extractDependency(value, next, currentPath)
          }
        } else if (typeof node === 'string') {
          const currentPath = [...path, node]
          const dep = root?.[node]
          if (!dep) throw new Error(`Cannot resolve dependency at path '${currentPath.join('.')}' in service '${name}'`)
          dependencies.push(dep)
        }
      }
      extractDependency(tree, cds.requires[name].credentials)
    }
    LOG.info('using SaaS dependencies', dependencies)
    return dependencies.map(d => ({ xsappname: d }))
  }

  async limiter(limit, payloads, fn) {
    const pending = [], all = []
    for (const payload of payloads) {
      const execute = Promise.resolve().then(() => fn(payload))
      all.push(execute)
      const executeAndRemove = execute.then(() => pending.splice(pending.indexOf(executeAndRemove), 1))
      pending.push(executeAndRemove)
      if (pending.length >= limit) {
        await Promise.race(pending)
      }
    }
    return Promise.allSettled(all)
  }

  async sendResult(callbackUrl, payload, customPayload, authorization) {
    const { status, message } = payload

    // call to custom application callback -> piggyback original SaaS registry payload
    if (customPayload) Object.assign(payload, customPayload)
    const headers = { authorization }

    LOG.info('sending result callback request to', callbackUrl, 'with', { status, message, ...LOG._debug ? payload : {} })

    if (customPayload) Object.assign(headers, { status_callback: customPayload.saasCallbackUrl }) // Java use case

    try {
        return await axiosInstance(callbackUrl, { method: 'PUT', headers, data: payload })
    } catch (error) {
        cds.error('Error sending result callback to saas-registry: ' + error.message)
    }
  }

}
