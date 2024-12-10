const LinterMessage = require('./message')

module.exports = class NamespaceChecker {

  check(extensionCsn, fullCsn, compileDir, mtxConfig) {

    if (!Object.keys(mtxConfig ?? {}).length) return []

    const { 'element-prefix': p, 'namespace-blocklist': b, 'namespace-blacklist': b2 } = mtxConfig
    let elementPrefixes = p, namespaceBlocklist = b ?? b2
    const messages = []

    if (elementPrefixes) {
      elementPrefixes = Array.isArray(elementPrefixes) ? elementPrefixes : [elementPrefixes]
      if (extensionCsn.extensions) {
        extensionCsn.forall( // forall switches back to definitions if extensions are undefined
          () => true,
          (element, name, parent) => {
            element.name = name // REVISIT: assign name in forall?
            this._checkElement(element, parent, elementPrefixes, messages)
          },
          extensionCsn.extensions
        )
      }
      extensionCsn.forall(
        element => element.kind in { 'entity':1, 'function':1, 'action':1 },
        entity => this._checkEntity(entity, extensionCsn, fullCsn, elementPrefixes, messages)
      )
    }

    if (namespaceBlocklist) {
      namespaceBlocklist = Array.isArray(namespaceBlocklist) ? namespaceBlocklist : [namespaceBlocklist]
      extensionCsn.forall('service', service => this._checkNamespace(service, namespaceBlocklist, messages))
      extensionCsn.forall(
        element => element.kind in { 'aspect':1, 'entity':1, 'type':1 },
        (entity, name) => {
          entity.name = name // REVISIT: assign name in forall?
          if (entity._unresolved) return // skip unresolved entities
          this._checkNamespace(entity, namespaceBlocklist, messages)
        }
      )
    }
    return messages
  }

  _checkElement(element, parent, elementPrefixes, messages) {
    if (elementPrefixes.length < 1) return
    if (!parent) return
    if (element.kind === 'extend') return // check additional restrictions later
    if (!parent.extend) return
    if (elementPrefixes.some(prefix => element.name.startsWith(prefix))) return
    messages.push(this._createPrefixWarning(element, parent, elementPrefixes))
  }

  _checkEntity(element, reflectedCsn, reflectedFullCsn, elementPrefixes, messages) {
    if (elementPrefixes.length < 1) return
    const parent = this._getEnclosingEntity(reflectedCsn, element)
    if (parent) return // parent exists in extension
    const parentFullCsn = this._getEnclosingEntity(reflectedFullCsn, element)
    const elementName = !parentFullCsn ? element.name : element.name.replace(parentFullCsn.name + '.', '') || element.name
    if (elementPrefixes.some(prefix => elementName.startsWith(prefix))) return
    messages.push(this._createPrefixWarning(element, parentFullCsn, elementPrefixes))
  }

  // REVISIT: set parent entity name / check original test cases
  _getEnclosingEntity(reflectedCsn, element) {
    const splitEntityName = element.name.split('.')
    if (splitEntityName.length > 1) {
      splitEntityName.pop()
      return reflectedCsn.definitions[splitEntityName.join('.')]
    }
    return null
  }

  _checkNamespace(element, namespaceBlacklist, messages) {
    for (const namespace of namespaceBlacklist) {
      if (element.name.startsWith(namespace)) {
        messages.push(this._createNamespaceWarning(element, namespace))
      }
    }
  }

  _createPrefixWarning(element, parent, prefixRule) {
    const message = `Element '${element.name}' ${parent ? `in '${parent.extend || parent.name}'` : ''} must start with ${prefixRule}`
    return new LinterMessage(message, element)
  }

  _createNamespaceWarning(element, namespace) {
    const message = `Element '${element.name}' uses a forbidden namespace '${namespace}'`
    return new LinterMessage(message, element)
  }
}
