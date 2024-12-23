const path = require('path')
const mtxAdapter = require('./mtx-adapter')
const { createProjects } = require('./extension-project')
const cds = require('@sap/cds')
const LOG = cds.log('mtx'), DEBUG = cds.debug('mtx')
const { mkdirp, rimraf, tar, exists, readdir, read, write, isdir, isfile } = cds.utils
const fs = cds.utils.fs.promises

const linter = require('../../srv/extensibility/linter')
const { t0_ } = require('../utils')
const Tenants = 'cds.xt.Tenants'

// REVISIT: Exported private functions
module.exports._hasMtEnv = () => cds.requires.multitenancy || (cds.env.requires['cds.xt.DeploymentService'] && cds.env.requires['cds.xt.ModelProviderService'])
module.exports._hasExtensibilityEnv = () => cds.requires.extensibility || cds.env.requires['cds.xt.ExtensibilityService']

module.exports._getExtensionProjectDirectory = function(dir) {
    if (dir) {
        LOG.log(`Project directory ${dir} does not exist. ${dir} has been created.`)
        return mkdirp(dir)
    }
    return mtxAdapter.mkdirTemp()
}

class MigrationResult {
    constructor() {
        this.connectedTenants = []
        this.results = {}
        this.hasError = false
    }

    addTenant(tenant, meta = true) {
        this.connectedTenants.push(tenant)
        if (meta) this.connectedTenants.push(mtxAdapter.getMetaTenantName(tenant))
    }

    log(tenant, message) {
        if (!this.results[tenant]) this.results[tenant] = []
        this.results[tenant].push(message)
        LOG.log(message)
    }

    error(tenant, message, error) {
        if (!this.results[tenant]) this.results[tenant] = []
        this.results[tenant].push(`${message} ${error.message}`)
        LOG.error(message, error)
        this.hasError = true
    }

    logResult(dry = false) {
        LOG.log(`Migration Result ${dry ? '(dry run only)' : ''}:`)
        for (const tenant of Object.keys(this.results)) {
            for (const line of this.results[tenant]) LOG.log(`[${tenant}] ${line}`)
        }
    }
}

function getT0() {
    return cds.env.requires.multitenancy?.t0 ?? 't0'
}

module.exports.syncTenantList = async function syncTenantList(tenants, options, deleteEntries = false) {
    const EXCLUDED_TENANTS = /^MT_LIB_TENANT-.*/

    const migrationResult = new MigrationResult()
    const { dry, force } = options
    const t0 = getT0()
    migrationResult.addTenant(t0, false) // adds tenant for disconnect

    // get all containers + create metadata in t0
    const ds = await cds.connect.to('cds.xt.DeploymentService')
    const existingTenantLists = await ds.getTenants()
    if (!force && !deleteEntries && existingTenantLists.length) {
        migrationResult.log(t0, `Existing tenant list not empty. Skipping creation.`)
        return migrationResult
    }
    const containers = await ds.getContainers()
    const tenantContainers = containers.filter(
        c => c !== t0
        && existingTenantLists.indexOf(c) === -1
        && (tenants.includes('*') || tenants.includes(c))
        && !EXCLUDED_TENANTS.test(c))
    if (!dry && tenantContainers.length) {
        await t0_(INSERT.into(Tenants, tenantContainers.map(c => ({ ID: c, metadata: JSON.stringify({ subscribedTenantId: c }) }))))
    }
    const missingContainers = existingTenantLists.filter(
        c => c !== t0
        && containers.indexOf(c) === -1
        && (tenants.includes('*') || tenants.includes(c)))
    if (!dry && deleteEntries && missingContainers.length) {
        await t0_(DELETE.from(Tenants).where({ ID: { in: missingContainers } }))
    }
    migrationResult.log(t0, `Tenant list created for ${JSON.stringify(tenantContainers)} ${dry ? '(dry run only)' : ''}.`)
    return migrationResult
}

module.exports.cleanupMetatenants = async function cleanup(tenants, options) {
    const migrationResult = new MigrationResult()
    const { dry } = options

    let tenantsToCleanup = tenants
    // handle tenant "*" -> retrieve all tenants
    if (tenants.includes('*')) {
        tenantsToCleanup = await mtxAdapter.getAllTenantIds()
    }

    const t0 = getT0()
    migrationResult.addTenant(t0, false) // adds tenant for disconnect

    const metatenantsToCleanup = {}
    for (const tenant of tenantsToCleanup) {
        if (tenant === t0) continue
        const metatenant = mtxAdapter.getMetaTenantName(tenant)
        metatenantsToCleanup[tenant] = metatenant
    }

    for (const [tenant, metatenant] of Object.entries(metatenantsToCleanup)) {
        migrationResult.addTenant(metatenant, false)

        try {
            // check if tenant was already migrated
            try {
                const migrated = tenant !== '__META__' ? await mtxAdapter.isMigrated(tenant) : { timestamp: true }
                if (!migrated.timestamp) {
                    migrationResult.error(tenant, `Tenant ${tenant} was not migrated. Skipping cleanup.`, new Error(`Tenant ${tenant} was not migrated`))
                    continue
                }
            } catch (e) {
                if (e.status === 404) {
                    migrationResult.log(tenant, `No @sap/cds-mtx meta-tenant found for ${tenant}. Skipping cleanup.`)
                    continue
                } else throw e
            }

            // do the cleanup
            if (!dry) {
                const ds = await cds.connect.to('cds.xt.DeploymentService')
                await ds.unsubscribe(metatenant)
            }
            migrationResult.log(metatenant, `Metatenant ${metatenant} successfully deleted.`)
        } catch (error) {
            migrationResult.error(metatenant, `Cleanup of tenant ${metatenant} failed.`, error)
            continue
        }
    }

    // only cleanup __META__ if all other meta tenants have been cleaned up successfully
    if (!dry && tenants.includes('*') && !migrationResult.hasError) {
        const ds = await cds.connect.to('cds.xt.DeploymentService')
        const commonMetaTenant = '__META__'
        await ds.unsubscribe(commonMetaTenant)
        migrationResult.log(commonMetaTenant, `Common metatenant ${commonMetaTenant} successfully deleted.`)
    }

    LOG.log('Cleanup done')
    return migrationResult
}

module.exports.checkMigration = async function checkMigration(req) {
    const { tenant } = req.data
    if (await mtxAdapter.hasExtensions(tenant)) {
        if (module.exports._hasExtensibilityEnv()) {
            if (!await mtxAdapter.isMigrated(tenant))
                req.reject(422, `Upgrade of tenant ${tenant} aborted. Extensions have not been migrated yet`)
        } else {
            req.reject(422, `Upgrade of tenant ${tenant} aborted. Old MTX Extensions exist but extensibility is not configured (cds.requires.extensibility is false)`)
        }
    }
}

module.exports.getMissingMtxTenants = async (existingTenants) => {
    if (await mtxAdapter.wasOldMtx()) {
        // TODO do this only once
        // get all mtx tenants
        const mtxTenants = await mtxAdapter.getAllTenantIds()
        // add metadata for non-existing entries
        return await Promise.all(mtxTenants.filter( mtxTenant => !existingTenants.includes(mtxTenant)).map( async mtxTenant => {
            await module.exports.addMetadata(mtxTenant, {
                subscribedTenantId: mtxTenant
            })
            return mtxTenant
        }))
    }
    return []
}

module.exports.migrate = async function migrate(tenants, options) {

    const { directory, dry, force, tagRule, tag: defaultTag, "skip-verification": skipVerification} = options

    const migrationResult = new MigrationResult()
    let tenantsToMigrate = tenants

    // handle tenant "*" -> retrieve all tenants
    if (tenants.includes('*')) {
        tenantsToMigrate = await mtxAdapter.getAllTenantIds()
    }

    const t0 = getT0()
    migrationResult.addTenant(t0, false) // adds tenant for disconnect

    const extensibility = module.exports._hasExtensibilityEnv()
    let projectsDir

    for (const tenant of tenantsToMigrate) {

        migrationResult.addTenant(tenant)

        // skip migration of t0
        if (tenant === t0) {
            migrationResult.log(tenant, `Skipping internal tenant ${tenant}.`)
            continue
        }

        try {
            // check if tenant was already migrated
            try {
                const migrated = await mtxAdapter.isMigrated(tenant)
                if (migrated?.timestamp && !force) {
                    migrationResult.log(tenant, `Tenant ${tenant} is already migrated. Skipping migration.`)
                    continue
                }
            } catch (e) {
                if (e.status === 404) {
                    migrationResult.log(tenant, `No @sap/cds-mtx meta-tenant found for ${tenant}. Skipping migration.`)
                    continue
                } else throw e
            }

            // Get from old mtx
            const metadata = await mtxAdapter.getMetadata(tenant)

            if (extensibility) {

                // update tenant metadata + extension tables
                // add extension tables - TODO could also be done on-the-fly with push
                const extTables = await cds.load(`${__dirname}/../../db/extensions.cds`)
                cds.model = cds.db.model = cds.compile.for.nodejs(extTables)
                if (!dry) {
                    // disable extension deployment to avoid lengthy redeployments when doing the push()
                    const ds = await cds.connect.to('cds.xt.DeploymentService')
                    ds.prepend (srv => srv.on ('extend', () => { }))

                    try {
                        await cds.tx({ tenant}, tx => tx.run(SELECT.one(1).from('cds.xt.Extensions')))
                        // add metadata in case it had not been added before
                        await module.exports.addMetadata(tenant, metadata)
                    } catch (error) {
                        LOG.log('cds.xt.Extensions not yet deployed, deploying ...')
                        DEBUG && DEBUG(error)
                        await ds.subscribe({ tenant, metadata, options: { csn: extTables } }) // also creates metadata ...
                    }
                }

                // run extend -> into memory?
                const mtxExtension = await mtxAdapter.getExtension(tenant)

                if (mtxExtension) {
                    // allow different folder from command line to preserve results
                    projectsDir = projectsDir || await module.exports._getExtensionProjectDirectory(directory)
                    const tenantProjectFolder = path.join(projectsDir, tenant)

                    const tags = await createProjects(mtxExtension, tenantProjectFolder, tagRule, defaultTag)

                    // upload and verify extensions
                    // iterate all tags
                    migrationResult.log(tenant, `Created projects for tags "${tags}"`)

                    // Verify migrated extension
                    if (!skipVerification) {
                        try {
                            // check diff and abort if necessary
                            const existingCsn = await mtxAdapter.getCsn(tenant)

                            await fs.mkdir(path.join(tenantProjectFolder, 'mtx_original_csn'), { recursive: true })
                            await fs.writeFile(path.join(tenantProjectFolder, 'mtx_original_csn', 'csn.json'), JSON.stringify(existingCsn, null, 2))

                            await _verifyExtension(migrationResult, tenantProjectFolder, tenant, tags, existingCsn, options)
                            migrationResult.log(tenant, `Extension verification successful for tenant ${tenant} [${tenantProjectFolder}]`)
                        } catch (error) {
                            migrationResult.error(tenant, `Extension verification failed for tenant ${tenant} [${tenantProjectFolder}]), skipping migration.`, error)
                            continue
                        }
                    } else {
                        migrationResult.log(tenant, `Extension verification skipped for tenant ${tenant}`)
                    }

                    if (!dry && force) {
                        // cleanup in case extension ids have changed
                        if (tenant) cds.context = { tenant }
                        await DELETE.from('cds.xt.Extensions')
                    }

                    for (const tag of tags) {
                        const projectFolder = path.join(tenantProjectFolder, tag)

                        if (!dry) {
                            try {
                                const extensionTgz = await fs.readFile(path.join(projectFolder, 'gen', 'extension.tgz'))
                                const es = await cds.connect.to('cds.xt.ExtensibilityService')
                                await es.tx({ tenant, user: new cds.User.Privileged }, tx =>
                                    tx.push(extensionTgz.toString('base64'), tag)
                                )
                                migrationResult.log(tenant, `Extension for tenant ${tenant} and tag ${tag} pushed.`)
                            } catch (error) {
                                migrationResult.error(tenant, `Error pushing extension for tenant ${tenant} and tag ${tag}`, error)
                                continue
                            }
                        }
                    }
                }
            } else {
                // check if extensions exist -> abort if yes
                if (await mtxAdapter.hasExtensions(tenant)) throw new Error(`Extensions exist but extensibility is not configured (cds.requires.extensibilty is false)`)

                if (!dry) {
                    await module.exports.addMetadata(tenant, metadata)
                    migrationResult.log(tenant, `Metadata for tenant ${tenant} added.`)
                }
            }

            if (!dry) await mtxAdapter.setMigrated(tenant, tagRule, defaultTag, !!force /* ensure it is not undefined so that a record is written */)
            migrationResult.log(tenant, `Migration of tenant ${tenant} done.`)
        } catch (error) {
            migrationResult.error(tenant, `Migration of tenant ${tenant} failed.`, error)
        }
    }

    // cleanup tmpdir, keep directory if it was set externally
    if (!directory && projectsDir) await fs.rm(projectsDir, { recursive: true, force: true })

    LOG.log('Extension migration done')
    return migrationResult
}

module.exports.addMetadata = async function addMetadata(tenant, metadata) {
    try {
        // can't use UPSERT here so @cds.on.insert still works for createdAt
        await t0_(INSERT.into('cds.xt.Tenants', { ID: tenant, metadata: JSON.stringify(metadata) }))
      } catch (e) {
        if (e.message === 'ENTITY_ALREADY_EXISTS') {
          await t0_(UPSERT.into('cds.xt.Tenants', { ID: tenant, metadata: JSON.stringify(metadata) }))
        } else throw e
      }
}

async function _verifyExtension(migrationResult, tenantProjectFolder, tenant, tags, existingCsn, options) {

    const { "ignore-migrations": ignoreMigrations  } = options

    const projectFolders = tags

    const mp = await cds.connect.to('cds.xt.ModelProviderService')
    const mainCsn = await mp.getCsn({ tenant, flavor: 'inferred', activated: true, base: true })

    if (!mainCsn) throw new Error(`Verification error for tenant ${tenant}: Empty base model`)

    let previewCsn = mainCsn

    // calculate model with extensions to be pushed later
    for (const projectFolder of projectFolders) {
        const extensionCsnString = await fs.readFile(path.join(tenantProjectFolder, projectFolder, 'gen', 'ext', 'extension.csn'))
        const extensionCsn = JSON.parse(extensionCsnString)
        previewCsn = cds.extend(previewCsn).with(extensionCsn)
    }

    // ensure flavor
    const inferredExistingCsn = cds.compile({inferred: existingCsn}, {flavor: 'inferred'})

    const existingHana = cds.compiler.to.hdi.migration(inferredExistingCsn)
    const newHana = cds.compiler.to.hdi.migration(previewCsn)

    const diffMessages = []

    // are artifacts lost?
    const hanaDiffNewToOld = cds.compiler.to.hdi.migration(cds.minify(previewCsn), {}, cds.minify(existingHana.afterImage))
    if (hanaDiffNewToOld.deletions.length) {
        diffMessages.push(`Migrated model is missing artifacts:\n ${hanaDiffNewToOld.deletions.map( ({ name, suffix }) => `${name}${suffix}\n`)}`)
    }

     if (hanaDiffNewToOld.migrations.length) {
        const ignore = ignoreMigrations ?? '^sap.common'
        const relevantMigrations = hanaDiffNewToOld.migrations.filter( m => !new RegExp(ignore).test(m.name))
        migrationResult.log(tenant, `Table migrations found but ignored for /${ignore}/`)

        if (relevantMigrations.length) diffMessages.push(`Table migrations found\n` +
            `${relevantMigrations.map( ({ name, suffix, changeset }) => `  ${name}${suffix}: ${changeset.map(({sql}) => sql)}\n`)}`)
    }

    // does the new model contain more artifacts?
    const MTXS_ENTITIES = ['cds.xt.Extensions']
    const hanaDiffOldToNew = cds.compiler.to.hdi.migration(cds.minify(inferredExistingCsn), {}, cds.minify(newHana.afterImage)) // cds.xt.Extensions is allowed
    const filteredDeletions = hanaDiffOldToNew.deletions.filter( ({name}) => !MTXS_ENTITIES.includes(name))
    if (filteredDeletions.length) {
        diffMessages.push(`Migrated model has additional artifacts:\n ${hanaDiffOldToNew.deletions.map( ({ name, suffix }) => `${name}${suffix}\n`)}`)
        throw new Error(`Verification error for tenant ${tenant}: migrated model has additional artifacts:\n ${hanaDiffOldToNew.deletions.map( ({ name, suffix }) => `${name}${suffix}\n`)}`)
    }

    if (diffMessages.length) throw new Error(`Verification error for tenant ${tenant}:\n${diffMessages.join('\n')}`)
}

module.exports.getMigratedProjects = async (req, tagRule, defaultTag, tenant) => {
    const temp = await mtxAdapter.mkdirTemp()

    let parameters = { tagRule, defaultTag }
    if (!(tagRule || defaultTag)) {
        try {
            const storedParameters = await mtxAdapter.getMigrationParameters(tenant) ?? {}
            parameters = { ...parameters, ...storedParameters }
        } catch (e) {
            req.reject(404, `No migrated projects found for tenant ${tenant}: ${e.message}`)
        }
    }

    // run dry migration with force + own temp directory
    // { directory, dry, force, tagRule: tagRegex, tag: defaultTag, "skip-verification": skipVerification, "ignore-migrations": ignoreMigrations }
    await module.exports.migrate([tenant], { directory: temp, dry: true, skipVerification: true, tagRule: parameters.tagRule, tag: parameters.defaultTag, force: true})

    const projectsLocation = path.join(temp, tenant)
    if (!exists(projectsLocation)) req.reject(404, `No migrated projects found for tenant ${tenant}`)

    // postprocessing: remove cds-based base model, adjust references
    await module.exports.fixBaseModelReferences(projectsLocation)

    try {
        return await tar.cz(projectsLocation)
    } finally {
        rimraf(temp)
    }
}

module.exports.fixBaseModelReferences = async (directory) => {

    await traverse(directory, async (file) => {
        // remove base cds files
        if (/.*\/node_modules\/_base\//.test(file)) {
            await rimraf(file)
        }

        // remove gen folder
        if (new RegExp(`${directory}/.*/gen$`).test(file)) {
            await rimraf(file)
        }

        // fix using statements
        if (/.*\.cds$/.test(file) && isfile(file)) {
            const content = await read(file, 'utf-8')
            const fixedContent = content.replace(/'_base\/.*'/g, '\'_base\'')
            await write(file, fixedContent, 'utf-8')
        }
    })

    // add index.csn and .cdsrc.json
    await traverse(directory, async (file) => {
        if (/.*\/node_modules\/_base$/.test(file)) {
            await addBaseAndConfig(file)
        }
    })

    async function traverse(dir, visitor) {
        const list = await readdir(dir)
        for (const entry of list) {
            const fullPath = path.join(dir, entry)
            await visitor(fullPath)
            if (await isdir(fullPath)) {
                await traverse(fullPath, visitor)
            }
        }
    }
}

const addBaseAndConfig = async function (directory) {
    const { 'cds.xt.ModelProviderService': mps } = cds.services
    const csn = await mps.getCsn({
      base: true, // without any custom extensions
      flavor: 'xtended'
    })
    await write(path.join(directory, 'index.csn'), cds.compile.to.json(csn))
    const config = linter.configCopyFrom(cds.env)
    await write(path.join(directory, '.cdsrc.json'), JSON.stringify(config, null, 2))
}