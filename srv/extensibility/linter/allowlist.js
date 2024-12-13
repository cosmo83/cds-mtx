const cds = require('@sap/cds/lib')
const LinterMessage = require('./message')
const Allowlist = require('./config')

const LABELS = {
  service: 'Service',
  entity: 'Entity',
  aspect: 'Aspect',
  type: 'Type'
}

const NEW_FIELDS = 'new-fields'
const FIELDS = 'fields'
const NEW_ENTITIES = 'new-entities'

module.exports = class AllowlistChecker {

  check(reflectedExtensionCsn, fullCsn, compileDir, mtxConfig) {

    if (!Object.keys(mtxConfig ?? {}).length) return []

    const allowList = new Allowlist(mtxConfig, fullCsn)
    const messages = []

    // check entities for extensions
    if (reflectedExtensionCsn.extensions && allowList) {
      for (const extension of reflectedExtensionCsn.extensions) {
        this._checkEntity(extension, reflectedExtensionCsn, fullCsn, compileDir, allowList, messages)
      }
    }

    // check entities for code extensions
    if (cds.env.requires.extensibility?.code) {
      if (reflectedExtensionCsn.extensions && allowList) {
        for (const extension of reflectedExtensionCsn.extensions) {
          this._checkExtensionCode(extension, fullCsn, reflectedExtensionCsn, allowList, messages)
        }
      }
    }

    // check services
    const foundServiceExt = {}
    reflectedExtensionCsn.forall(
      element => {
        return ['entity', 'element', 'function', 'action'].includes(element.kind)
      },
      (element, name, parent) => {
        if (allowList) {
          this._checkService(
            reflectedExtensionCsn,
            fullCsn,
            element,
            parent,
            { compileDir },
            allowList,
            messages,
            foundServiceExt
          )
        }
      }
    )
    this._addServiceLimitWarnings(foundServiceExt, allowList, compileDir, messages)

    return messages
  }

  _checkEntity(extension, extCsn, fullCsn, compileDir, allowlist, messages) {
    const extendedEntity = extension.extend
    if (extendedEntity) {
      if (
        fullCsn &&
        fullCsn.definitions &&
        (!extCsn.definitions[extendedEntity] || extCsn.definitions[extendedEntity].kind !== 'entity')
      ) {
        const kind = this._getExtendedKind(fullCsn, extCsn, extendedEntity)

        if (!allowlist.isAllowed(kind, extendedEntity)) {
          // not allowed at all
          this._addColumnWarnings(extension, messages, compileDir, allowlist.getList(kind), kind)
          this._addElementWarnings(extension, messages, compileDir, allowlist.getList(kind), kind)
        } else {
          // might have limits
          this._addEntityLimitWarnings(extension, messages, compileDir, allowlist, kind)
          this._addEntityFieldWarnings(extension, messages, compileDir, allowlist, kind)
        }
      }
    }
  }

  _checkActionFunction(actionKind, checkResult, name, allowlist, messages, kind) {
    if (actionKind === 'action' && !checkResult.code.includes('action')) {
      this._addCodeWarnings(name, messages, 'action', allowlist.getList(kind), kind)
    }
    if (actionKind === 'function' && !checkResult.code.includes('function')) {
      this._addCodeWarnings(name, messages, 'function', allowlist.getList(kind), kind)
    }
  }

  _checkExtensionCode(extension, fullCsn, reflectedExtensionCsn, allowlist, messages) {
    const extendedEntity = extension.annotate
    if (extendedEntity) {
      const kind = this._getExtendedKind(fullCsn, reflectedExtensionCsn, extendedEntity)
      if (kind === 'entity') {
        const checkResult = allowlist.isAllowed(kind, extendedEntity)
        if (!checkResult) {
          return this._addElementCodeWarnings(extension, messages, allowlist.getList(kind), kind)
        }
        const codeExt = extension['@extension.code']
        if (codeExt) {
          codeExt.forEach(element => {
            const operation = element.before || element.after
            if (!checkResult.code || !checkResult.code.includes(operation)) {
              this._addCodeWarnings(extension.annotate, messages, operation, allowlist.getList(kind), kind)
            }
          })
        }
        if (extension.actions && Object.keys(extension.actions).length) {
          const actionName = Object.keys(extension.actions)[0]
          const getActionKind = csn => csn.definitions?.[extendedEntity]?.actions?.[actionName].kind
          const actionKind = getActionKind(fullCsn) || getActionKind(reflectedExtensionCsn)
          this._checkActionFunction(actionKind, checkResult, extension.annotate, allowlist, messages, kind)
        }
      } else if (extendedEntity.includes('.')) {
        const serviceName = extendedEntity.split('.')[0]
        const checkResult = allowlist.isAllowed('service', serviceName)
        this._checkActionFunction(kind, checkResult, serviceName, allowlist, messages, 'service')
      }
    }
  }

  _getExtendedKind(fullCsn, reflectedExtensionCsn, extendedEntity) {
    const elementFromBase = fullCsn.definitions?.[extendedEntity] || reflectedExtensionCsn.definitions?.[extendedEntity]
    return elementFromBase ? elementFromBase.kind : null
  }

  _addElementWarnings(extension, messages, compileDir, allowlist, kind) {
    if (extension.elements) {
      for (const element in extension.elements) {
        messages.push(
          this._createAllowlistWarning(
            extension.extend,
            extension.elements[element],
            compileDir,
            allowlist,
            LABELS[kind]
          )
        )
      }
    }
  }

  _addElementCodeWarnings(extension, messages, allowlist, kind) {
    messages.push(
      this._createAllowlistWarning(
        extension.annotate,
        'code',
        null,
        allowlist,
        LABELS[kind]
      )
    )
  }

  _addCodeWarnings(name, messages, operation, allowlist, kind) {
    messages.push(
      this._createCodeOperationWarning(
        name,
        'code',
        operation,
        allowlist,
        LABELS[kind]
      )
    )
  }

  _addColumnWarnings(extension, messages, compileDir, allowlist, kind) {
    // loop columns + elements
    if (extension.columns) {
      for (const column of extension.columns) {
        messages.push(this._createAllowlistWarning(extension.extend, column, compileDir, allowlist, LABELS[kind]))
      }
    }
  }

  _addEntityLimitWarnings(extension, messages, compileDir, allowlist, kind) {
    const limit = allowlist.getPermission(kind, extension.extend)[NEW_FIELDS]

    if (limit == undefined) {
      return
    }

    if (
      (extension.columns ? extension.columns.length : 0) +
      (extension.elements ? Object.keys(extension.elements).length : 0) <=
      limit
    ) {
      return
    }

    // loop columns + elements
    if (extension.columns) {
      for (const column of extension.columns) {
        messages.push(this._createElementLimitWarning(extension.extend, column, compileDir, limit, LABELS[kind]))
      }
    }

    if (extension.elements) {
      for (const element in extension.elements) {
        messages.push(
          this._createLimitWarning(extension.extend, element, extension.elements[element], compileDir, limit, LABELS[kind])
        )
      }
    }
  }

  _addEntityFieldWarnings(extension, messages, compileDir, allowlist, kind) {
    const allowedFields = allowlist.getPermission(kind, extension.extend)[FIELDS]

    // TODO change default later (cds 8)
    if (!allowedFields || allowedFields.includes('*')) {
      return
    }

    const extendedFields = Object.keys(extension.elements ?? {}).filter(element => extension.elements[element].kind === 'extend')

    if (!extendedFields) {
      return
    }

    for (const fieldName of extendedFields) {
      if (!allowedFields.includes(fieldName)) {
        messages.push(this._createFieldExtensionWarning(fieldName, extension.extend, extension.elements[fieldName], compileDir, allowedFields))
      }
    }
  }

  _addServiceLimitWarnings(foundServiceExt, allowlist, compileDir, messages) {
    if (!allowlist) {
      return
    }

    for (const service in foundServiceExt) {
      let extLimit = allowlist.getPermission('service', service)[NEW_ENTITIES]
      if (extLimit && extLimit < foundServiceExt[service].length) {
        // loop all extension for one service
        for (const element of foundServiceExt[service]) {
          messages.push(this._createElementLimitWarning(service, element, compileDir, extLimit, LABELS['service']))
        }
      }
    }
  }

  _getParentName(element) {
    if (element.name) {
      const splitEntityName = element.name.split('.')
      if (splitEntityName.length > 1) {
        splitEntityName.pop()
        return splitEntityName.join('.')
      }
    }
    return null
  }

  _isDefinedInExtension(reflectedCsn, name) {
    return reflectedCsn.definitions ? !!reflectedCsn.definitions[name] : false
  }

  _isDefinedInBasemodel(fullCsn, name) {
    return !!this._getFromBasemodel(fullCsn, name)
  }

  _getFromBasemodel(fullCsn, name) {
    return fullCsn.definitions[name]
  }

  _checkService(reflectedExtensionCsn, fullCsn, element, parent, extension, allowlist, messages, foundExt) {
    if (parent && parent.kind && parent.kind !== 'service') {
      return
    }

    let parentName
    if (!parent) {
      parentName = this._getParentName(element)
    } else {
      parentName = this._getEntityName(parent)
    }

    // definition of element in extension itself
    if (!parentName) {
      return
    }

    // check if parent is defined in extension itself
    if (this._isDefinedInExtension(reflectedExtensionCsn, parentName)) {
      return
    }

    // check if parent is defined in basemodel
    if (!this._isDefinedInBasemodel(fullCsn, parentName)) {
      return
    }

    if (allowlist.isAllowed('service', parentName)) {
      foundExt[parentName] = foundExt[parentName] || []
      foundExt[parentName].push(element)
      return
    }

    messages.push(
      this._createAllowlistWarning(parentName, element, extension.compileDir, allowlist.service, LABELS['service'])
    )
  }

  _createAllowlistWarning(entityName, element, compileDir, allowlist = {}, label) {
    let message = `${label} '${entityName}' must not be extended`
    message += `. Check ${label} allowlist: ${
      Object.keys(allowlist).length > 0 ? Object.keys(allowlist) : '<empty list>'
    }`
    return new LinterMessage(message, element)
  }

  _createFieldExtensionWarning(fieldName, entityName, element, compileDir, fieldlist) {
    let message = `Field '${fieldName}' of entity ${entityName} must not be extended`
    message += `. Check allowlist: ${fieldlist?.length ? fieldlist : '<empty list>'}`
    return new LinterMessage(message, element)
  }

  _createCodeOperationWarning(name, element, operation, allowlist = {}, label) {
    let message = `Code extension is not allowed for operation '${operation}' in '${name}'`
    message += `. Check ${label || ''} allowlist: ${
      Object.keys(allowlist).length > 0 ? Object.keys(allowlist) : '<empty list>'
    }`
    return new LinterMessage(message, element)
  }

  _createElementLimitWarning(entityName, element, compileDir, limit, label) {
    return this._createLimitWarning(entityName, element.name, element, compileDir, limit, label)
  }

  _createLimitWarning(entityName, elementName, element, compileDir, limit, label) {
    let message = `'${elementName}' exceeds extension limit of ${limit} for ${label} '${entityName}'`
    return new LinterMessage(message, element)
  }

  _getEntityName(entity) {
    return entity.extend ? entity.extend : entity.name
  }
}
