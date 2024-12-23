const cds = require('@sap/cds/lib')
const { t0_ } = require('../../lib/utils')
const Tenants = 'cds.xt.Tenants'
const LOG = cds.log('mtx')
const main = require('../config')

exports.activated = 'Generic Metadata'

const t0 = cds.env.requires.multitenancy?.t0 ?? 't0'

// Add database-agnostic metadata handlers to DeploymentService...
cds.on ('serving:cds.xt.DeploymentService', ds => {

  const lazyT0 = cds.env.requires['cds.xt.DeploymentService']?.lazyT0 ?? cds.env.requires.multitenancy?.lazyT0

  ds.before ('*', req => {
    const { tenant } = req?.data ?? {}
    if (tenant) cds.context = { tenant }
  })

  ds.before ('subscribe', req => {
    if (lazyT0 && req.data.tenant !== t0) {
      return _resubscribeT0IfNeeded(req.data.options?._)
    }
  })

  ds.before ('upgrade', async req => {
    if (main.requires.extensibility) return // no checks needed

    if (cds.env.requires['cds.xt.DeploymentService']?.upgrade?.skipExtensionCheck === true) return

    // duplicate code, but it must be ensured that the tenant is set for the following operations
    const { tenant } = req?.data ?? {}
    if (tenant) cds.context = { tenant }

    let existingExt
    try {
      existingExt = await SELECT.one(1).from('cds.xt.Extensions')
    } catch (e) {
      LOG.debug('No extensions found', e) // ok, no problem
    }

    if (existingExt) cds.error(`Extensions exist, but extensibility is disabled. Upgrade aborted to avoid data loss`, { status: 500 })
  })

  ds.after ('subscribe', async (_, req) => {
    const { tenant, metadata } = req.data
    if (tenant === t0) return

    try {
      // can't use UPSERT here so @cds.on.insert still works for createdAt
      await t0_(INSERT.into(Tenants, { ID: tenant, metadata: JSON.stringify(metadata) }))
    } catch (e) {
      if (e.message === 'ENTITY_ALREADY_EXISTS') {
        await t0_(UPSERT.into(Tenants, { ID: tenant, metadata: JSON.stringify(metadata) }))
      } else throw e
    }
    LOG.info(`subscribed tenant ${tenant}`)
  })

  ds.after ('unsubscribe', async (_, req) => {
    const { tenant } = req.data
    if (tenant !== t0) await t0_(DELETE.from(Tenants).where({ ID: tenant }))
    LOG.info(`unsubscribed tenant ${tenant}`)
  })

  ds.on ('getTenants', async () => {
    return (await cds.tx({ tenant: t0 }, tx =>
      tx.run(SELECT.from(Tenants, tenant => { tenant.ID }))
    )).map(({ ID }) => ID)
  })

  const { getArtifactCdsPersistenceName } = require('@sap/cds-compiler')

  function _getT0TenantsTableName(csn) {
    return cds.requires.db.kind === 'hana' ?
    getArtifactCdsPersistenceName('cds.xt.Tenants', cds.env.sql.names || 'plain', csn, 'hana')
    : 'cds_xt_Tenants'
  }

  // Needs to be exposed for lazyT0 (CALM use case)
  const _resubscribeT0IfNeeded = module.exports.resubscribeT0IfNeeded = async function (params) {
    await cds.connect() // REVISIT: Ideally shouldn't be necessary
    // REVISIT: schema evolution/delta deployment (might be expensive though)
    await ds.tx({ tenant: t0 }, async tx => {
      const csn = await cds.load(`${__dirname}/../../db/t0.cds`)
      const columns = await tx.getColumns(t0, _getT0TenantsTableName(csn), params)
      const needsT0Redeployment = !columns.includes('createdAt') && !columns.includes('CREATEDAT')
      if (!needsT0Redeployment) return

      await tx.subscribe({ tenant: t0, options: { csn, _: params }})
    })
  }
  if (!lazyT0) cds.once('served', () => _resubscribeT0IfNeeded())
})
