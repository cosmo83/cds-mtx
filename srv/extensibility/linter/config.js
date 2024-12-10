const LEGACY_ENTITY_WHITELIST = 'entity-whitelist'
const LEGACY_SERVICE_WHITELIST = 'service-whitelist'
const EXTENSION_ALLOWLIST = 'extension-allowlist'

const PROTECTED_NAMESPACES = ['cds.xt']

module.exports = class Allowlist {
    constructor(mtxConfig, fullCsn) {
      this.allowlist = Allowlist._setupPermissionList(mtxConfig, fullCsn)
    }

    get all() {
      return this.allowlist.all
    }

    get entity() {
      return this.allowlist.entity
    }

    get service() {
      return this.allowlist.service
    }

    getList(kind) {
      return this.allowlist[kind]
    }

    getPermission(kind, name) {
      function findInList(list, name) {
        if (list) {
          const splitName = name.split('.')
          while (splitName.length > 0) {
            const nameOrPrefix = splitName.join('.')
            if (list[nameOrPrefix]) {
              return list[nameOrPrefix]
            }
            splitName.pop()
          }
          return list['*'] ? list['*'] : null
        }
        return null
      }

      return findInList(this.allowlist[kind], name) || findInList(this.allowlist['all'], name)
    }

    isAllowed(kind, name) {
      // check protected internal namespaces
      if (PROTECTED_NAMESPACES.some( namespace => name.startsWith(`${namespace}.`))) return false

      return this.getPermission(kind, name)
    }

    static _setupPermissionList(mtxConfig, fullCsn) {
      // internal structure:
      // result[name] = { kind, new-fields | new-entities | annotations }

      const result = {}

      // create from legacy lists
      let { entityWhitelist, serviceWhitelist } = Allowlist._getLegacyLists(mtxConfig)

      // create from new lists
      const allowlistNewFormat = mtxConfig[EXTENSION_ALLOWLIST]

      Allowlist._addLegacyLists(result, serviceWhitelist, entityWhitelist)

      if (allowlistNewFormat) {
        // seperate into single entities /services for better processing
        for (const permission of allowlistNewFormat) {
          if (permission.for) {
            for (const name of permission.for) {
              if (permission.kind) {
                // kind is specfied
                result[permission.kind] = result[permission.kind] || {}
                result[permission.kind][name] = permission
              } else {
                // check kind
                if (fullCsn.definitions[name]) {
                  result[fullCsn.definitions[name].kind] = result[fullCsn.definitions[name].kind] || {}
                  result[fullCsn.definitions[name].kind][name] = permission
                } else {
                  // allow all
                  result.all = result.all || {}
                  result.all[name] = permission
                }
              }
            }
          }
        }
      }
      return result
    }

    static _addLegacyLists(result, serviceWhitelist, entityWhitelist) {
      if (serviceWhitelist) {
        result.service = result.service || {}
        for (const service of serviceWhitelist) {
          result.service[service] = {}
        }
      }

      if (entityWhitelist) {
        result.entity = result.entity || {}
        for (const entity of entityWhitelist) {
          result.entity[entity] = {}
        }
      }
      return result
    }

    static _getLegacyLists(mtxConfig) {
      let entityWhitelist = mtxConfig[LEGACY_ENTITY_WHITELIST]
      let serviceWhitelist = mtxConfig[LEGACY_SERVICE_WHITELIST]

      if (entityWhitelist && !Array.isArray(entityWhitelist)) {
        entityWhitelist = [entityWhitelist]
      }

      if (serviceWhitelist && !Array.isArray(serviceWhitelist)) {
        serviceWhitelist = [serviceWhitelist]
      }
      return { entityWhitelist, serviceWhitelist }
    }
  }