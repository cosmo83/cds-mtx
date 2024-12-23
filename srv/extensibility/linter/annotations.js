const LinterMessage = require('./message')
const Allowlist = require('./config')

// annotations with specific checks or messages
const checkedExtensionAnnotations = new Map([
  ['@requires', _createSecurityAnnotationWarning],
  ['@restrict', _createSecurityAnnotationWarning],
  ['@cds.persistence.journal', _createJournalAnnotationWarning],
  ['@mandatory', _createMandatoryAnnotationWarning],
  ['@readonly', _createMandatoryAnnotationWarning],
  ['@assert.notNull', _createMandatoryAnnotationWarning],
  ['@assert.range', _createMandatoryAnnotationWarning]
])

const criticalNewEntityAnnotations = /@sql.prepend|@sql.append|@cds.persistence.(?!skip)\w*/
const criticalExtensionAnnotations = new RegExp('^@(?:'
  + 'requires'
  + '|restrict'
  + '|readonly'
  + '|mandatory'
  + '|assert.*'
  + '|cds.persistence.*'
  + '|sql.append'
  + '|sql.prepend'
  // service annotations
  + '|path'
  + '|impl'
  + '|cds.autoexpose'
  + '|cds.api.ignore'
  + '|odata.etag'
  + '|cds.query.limit'
  + '|cds.localized'
  + '|cds.valid.*'
  + '|cds.search)'
);

function locationString(element) {
  const loc = element?.$location
  if (!loc) return ''
  const line = loc.line ? `${loc.line}:` : ''
  return loc.col ? `${loc.file}:${line}${loc.col}:` : `${loc.file}:${line}`
}

function _createGenericAnnotationWarning(annotationName, annoOrElem) {
  const message = `Annotation '${annotationName}' in '${
    annoOrElem.element.annotate || annoOrElem.element.name || annoOrElem.parent.extend || annoOrElem.parent.annotate
  }' is not supported in extensions`
  return new LinterMessage(locationString(annoOrElem.element) + message, annoOrElem.element)
}

function _createMandatoryAnnotationWarning(annotationName, annoOrElem) {
  if (annoOrElem.element.default || annoOrElem.element[annotationName] === false) return
  const message = `Annotation '${annotationName}' in '${
    annoOrElem.element.annotate || annoOrElem.element.name || annoOrElem.parent.extend || annoOrElem.parent.annotate
  }' is not supported in extensions without default value`
  return new LinterMessage(locationString(annoOrElem.element) + message, annoOrElem.element)
}

function _createSecurityAnnotationWarning(annotationName, annoOrElem) {
  const message = `Security relevant annotation '${annotationName}' in '${
    annoOrElem.element.annotate || annoOrElem.element.name
  }' cannot be overwritten`
  return new LinterMessage(locationString(annoOrElem.element) + message, annoOrElem.element)
}

function _createJournalAnnotationWarning(annotationName, annoOrElem) {
  const message = `Enabling schema evolution in extensions using '${annotationName}' in '${
    annoOrElem.element.annotate || annoOrElem.element.name
  }' not supported`
  return new LinterMessage(locationString(annoOrElem.element) + message, annoOrElem.element)
}

function _createJournalEntityExtensionNotAllowedWarning(element) {
  const message = `Extending entity '${element.extend}' is not supported as the corresponding database table has been enabled for schema evolution`
  return new LinterMessage(locationString(element) + message, element)
}

module.exports = class AnnotationsChecker {
  check(reflectedCsn, fullCsn, compileDir, mtxConfig = {}) {

    const allowList = new Allowlist(mtxConfig, fullCsn)

    if (!reflectedCsn.extensions || !reflectedCsn.definitions) {
      return []
    }

    const annotationExtensions = []
    const messages = []

    // check annotations for extensions including fields
    reflectedCsn.forall(
      () => true,
      (element, name, parent) => {
          if (Object.getOwnPropertyNames(element).filter(property =>
              property.startsWith('@') && criticalExtensionAnnotations.test(property)).length) {
            annotationExtensions.push({element, name, parent})
          }
        if (element.extend) {
          // check base entity for incompatible annotations
          this._checkExtendedEntityAnnotations(fullCsn, element, messages) // checks e. g. for journal annotations in base entity
        }
      },
      reflectedCsn.extensions
    )

    // check entities and fields from new definitions
    const annotatedDefinitions = []
    reflectedCsn.forall(
      () => true,
      (element, name, parent) => {
        if (Object.getOwnPropertyNames(element).filter(property => criticalNewEntityAnnotations.test(property)).length) {
          annotatedDefinitions.push({element, name, parent})
        }
      },
      reflectedCsn.definitions
    )

    for (const annotation of [...annotationExtensions, ...annotatedDefinitions]) {
      const warning = this._checkExtensionAnnotation(annotation, reflectedCsn, fullCsn, compileDir, allowList)
      if (warning) {
        messages.push(warning)
      }
    }

    return messages
  }

  _checkExtensionAnnotation(annotation, extCsn, fullCsn, dir, allowList) {

    const entityOrService = annotation.element.annotate ?? annotation.element.extend ?? annotation.parent?.annotate ?? annotation.parent?.extend

    if (!extCsn.definitions[entityOrService]) {
      const annotationName = Object.getOwnPropertyNames(annotation.element).filter(property => property.startsWith('@'))
      if (annotationName.length) {

         // get element permissions from allowlist
        const kind = this._getExtendedKind(fullCsn, extCsn, entityOrService)
        const permissions = allowList.getPermission(kind, entityOrService)
        // check if annotation is allowed
        if (permissions && permissions.annotations && permissions.annotations.includes(annotationName[0])) return null

        const fn = checkedExtensionAnnotations.get(annotationName[0]) ?? _createGenericAnnotationWarning
        return fn(annotationName, annotation)
      }
    }
    return null
  }

  _getExtendedKind(fullCsn, reflectedExtensionCsn, extendedEntity) {
    const elementFromBase = fullCsn.definitions?.[extendedEntity] || reflectedExtensionCsn.definitions?.[extendedEntity]
    return elementFromBase ? elementFromBase.kind : null
  }

  _checkExtendedEntityAnnotations(fullCsn, element, messages) {
    const kind = fullCsn.definitions[element.extend]?.kind
    if (kind === 'entity' && fullCsn.definitions[element.extend]?.['@cds.persistence.journal']) {
      messages.push(_createJournalEntityExtensionNotAllowedWarning(element))
    }
  }
}
