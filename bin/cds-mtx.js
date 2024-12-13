#!/usr/bin/env node

const cds = require('@sap/cds')
const { _import, isfile, local, path } = cds.utils

const isCli = require.main === module
const SUPPORTED = ['subscribe', 'unsubscribe', 'upgrade']

async function cds_mtx(cmd, tenant, body) {

    let connectedTenants = [tenant]

    try {
        if (!cmd) return _usage()
        if (!SUPPORTED.includes(cmd)) return _usage(`Unknown command ${cmd}.`)
        if (!_hasMtEnv()) return _handleError(`cds-mtx ${cmd} operation can only be run inside a multitenant application environment using @sap/cds-mtxs.`)
        if (!tenant) return _handleError(`Please provide a tenant: cds-mtx ${cmd} <tenant>`)
        if (/.*,.*/.test(tenant)) return _handleError(`List of tenants not supported: ${tenant}`)
        // parse body and handle error
        let parsedMetadata
        if (body) {
            try {
                parsedMetadata = JSON.parse(body)
            } catch (e) {
                return _handleError(`Invalid subscription body: ${e.message}: ${body} `)
            }
        }
        const services = [
            '@sap/cds-mtxs/srv/deployment-service',
            '@sap/cds-mtxs/srv/model-provider',
            '@sap/cds-mtxs/srv/cf/saas-provisioning-service'
        ]
        const model = await cds.load([...services, '@sap/cds-mtxs/db/extensions'])
        cds.model = cds.compile.for.nodejs(model)
        const { 'cds.xt.DeploymentService':ds, 'cds.xt.SaasProvisioningService':sps } = await cds.serve (services)
        await _local_server_js()
        await cds.emit('served')
        if (cmd === 'unsubscribe') {
            await cds.connect.to('db')
        }

        if (tenant === '*') {
            if (cmd !== 'upgrade') return _handleError('"*" only supported for upgrade command')
            const tenants = await sps.read('tenant')
            connectedTenants = tenants.map(t => t.subscribedTenantId)
            await sps.upgrade([tenant], parsedMetadata)
            return
        }
        await ds[cmd](tenant, parsedMetadata, parsedMetadata)
    } catch(e) {
        if (isCli) {
            console.error(e.message)
            process.exit(1)
        } else throw e
    } finally {
        if (cds.db) {
            cds.db.disconnect(cds.env.requires.multitenancy.t0 ?? 't0')
            for (const t of connectedTenants) cds.db.disconnect(t)
        }
    }
}

// copied from cds.serve
async function _local_server_js() {
    const _local = file => isfile(file) || isfile (path.join(cds.env.folders.srv,file))
    const cli_js = process.env.CDS_TYPESCRIPT && _local('cli.ts') || _local('cli.js')
    if (cli_js) {
      console.log ('[cds] - loading server from', { file: local(cli_js) })
      await _import(cli_js)
    }
  }

// check for application environment
function _hasMtEnv() {
    if (cds.mtx) {
        console.log('Old @sap/cds-mtx detected')
        return false
    }
    if (cds.requires.multitenancy) {
        return true
    }
    for (const service of ['cds.xt.DeploymentService', 'cds.xt.ModelProviderService']) {
        if (!cds.env.requires[service]) {
            console.log(`Service ${service} not configured`)
            return false
        }
    }
    return true
}

async function _handleError(message) {
    if (isCli) {
        console.error(message)
        process.exit(1)
    }
    throw new Error(message)
}

async function _usage(message = '') {
    return _handleError(message + `

USAGE

   cds-mtx <command> <tenant> [--body <json>]

COMMANDS

   subscribe   subscribe a tenant
   unsubscribe unsubscribe a tenant
   upgrade     upgrade a tenant

EXAMPLES

   cds-mtx subscribe t1
   cds-mtx subscribe t1 --body '{ "_": { "hdi": { "create": { "database_id": "<database id>" } } } }'
   cds-mtx unsubscribe t1
   cds-mtx upgrade t1
   cds-mtx upgrade "*"
`
    )
}

if (isCli) {
    const [, , cmd, tenant, option, json] = process.argv
    if (option && option !== '--body') _usage(`Invalid option ${option}`)
    ;(async () => await cds_mtx(cmd, tenant, option ? json : undefined))()
}
module.exports = { cds_mtx }
