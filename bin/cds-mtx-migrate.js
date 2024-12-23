#!/usr/bin/env node

async function run(param, options) {
    const cds = require('@sap/cds')
    const { migrate,  cleanupMetatenants, syncTenantList: synchronizeTenantList, _hasMtEnv } = require('../lib/migration/migration')
    const { dry, cleanup, genTenantList, syncTenantList } = options

    async function cds_mtx_migrate(tenants, options) {
        if (!_hasMtEnv()) _handleError(`cds-mtx-migrate operation can only be run inside a multitenant application environment using @sap/cds-mtxs.`)
        if (!tenants) _handleError(`Please provide tenant(s): cds-mtx-migrate <tenant>[,<tenant>]`)

        const tenantList = _splitTenants(tenants)

        const services = [
            '@sap/cds/srv/mtx',
            '@sap/cds-mtxs/srv/model-provider'
        ]

        if (!dry) {
            services.push('@sap/cds-mtxs/srv/deployment-service')
            services.push('@sap/cds-mtxs/srv/extensibility-service')
        }

        await cds.connect.to('db')
        await cds.serve(services)
        cds.env.requires.multitenancy = cds.env.requires.multitenancy || true // needed for current sidecar config that only enables services
        await cds.emit('served')

        if (cleanup) {
            const deletedTenants = await cleanupMetatenants(tenantList, options)
            for (let t of deletedTenants.connectedTenants) await cds.db.disconnect(t)
            await cds.db.disconnect()

            deletedTenants.logResult(dry)

            // always fail gracefully
            // if (deletedTenants.hasError) process.exit(1)
        } else if (genTenantList) {
            const tenantListResult = await synchronizeTenantList(tenantList, options)
            for (let t of tenantListResult.connectedTenants) await cds.db.disconnect(t)
            await cds.db.disconnect()

            tenantListResult.logResult(dry)
        } else if (syncTenantList) {
            const tenantListResult = await synchronizeTenantList(tenantList, options, true)
            for (let t of tenantListResult.connectedTenants) await cds.db.disconnect(t)
            await cds.db.disconnect()

            tenantListResult.logResult(dry)
        }else {
            const migratedTenants = await migrate(tenantList, options)
            for (let t of migratedTenants.connectedTenants) await cds.db.disconnect(t)
            await cds.db.disconnect()

            migratedTenants.logResult()
            // make sure to get result != 0 so that potential followup scripts know of problems
            if (migratedTenants.hasError) process.exit(1)
        }
    }

    function _handleError(message) {
        console.log(message)
        process.exit(1)
    }

    function _splitTenants(tenants) {
        return tenants.split(',')
    }

    await cds_mtx_migrate(param, options).catch(console.error)
}

function getParameterValue(options, parameter) {
   const index = options.indexOf(parameter)
   const value = (index > -1) ? options[index + 1] : undefined
   return value && value[0] !== '-' ? value : undefined
}

if (require.main === module) {
   // Code section that will run only if current file is the entry point.
   // TODO use command line parser to get arguments
   // comma separated list of tenants
   const [, , tenants, ...options] = process.argv
   const directory = getParameterValue(options, '-d')
   const tag = getParameterValue(options, '--tag')
   const tagRule = getParameterValue(options, '--tagRule')
   const dry = options.includes('--dry')
   const cleanup = options.includes('--cleanup')
   const genTenantList = options.includes('--init-tenant-list')
   const syncTenantList = options.includes('--sync-tenant-list')
   const force = options.includes('--force')
   const skipVerification = options.includes('--skip-verification')
   run(tenants, { directory, dry, force, tag, tagRule, "skip-verification": skipVerification, cleanup, genTenantList, syncTenantList }).catch(console.error)
} else {
    module.exports.run = run
}
