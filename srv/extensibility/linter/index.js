const cds = require('@sap/cds/lib')
const { deduplicateMessages } = require('@sap/cds-compiler')

const NamespaceChecker = require('./namespace')
const AnnotationsChecker = require('./annotations')
const AllowlistChecker = require('./allowlist')

const LINTER_OPTIONS = ['element-prefix', 'extension-allowlist', 'namespace-blocklist']
const LEGACY_OPTIONS = ['entity-whitelist', 'service-whitelist', 'namespace-blacklist']
const EXT_SERVICE_NAME = 'cds.xt.ExtensibilityService'

module.exports.lint = (extCsn, fullCsn, env = cds.env) => {
  const conf = env.requires[EXT_SERVICE_NAME] || env.mtx
  const compat = env.mtx
  const linter_options = {}
  let x
  for (let p of LINTER_OPTIONS) if ((x = conf[p] || compat[p])) linter_options[p] = x
  for (let p of LEGACY_OPTIONS) if ((x = compat[p])) linter_options[p] = x

  const reflectedCsn = cds.reflect(extCsn)
  const reflectedFullCsn = cds.reflect(fullCsn)
  const compileBaseDir = cds.root
  const messages = [
    ...new NamespaceChecker().check(reflectedCsn, reflectedFullCsn, compileBaseDir, linter_options),
    ...new AnnotationsChecker().check(reflectedCsn, reflectedFullCsn, compileBaseDir, linter_options), // always mandatory
    ...new AllowlistChecker().check(reflectedCsn, reflectedFullCsn, compileBaseDir, linter_options)
  ]
  deduplicateMessages(messages)
  return messages
}

/**
 * Sparsely copies the linter-relevant config from the given env into the given target
 */
module.exports.configCopyFrom = (env, target = {}) => {
  if (!env.requires?.[EXT_SERVICE_NAME]) return target

  const config = {}
  Object.keys(env.requires[EXT_SERVICE_NAME])
    .filter(key => LINTER_OPTIONS.includes(key)) // only let some keys pass, to not compromise security
    .filter(key => !!env.requires[EXT_SERVICE_NAME][key])
    .forEach(key => (config[key] = env.requires[EXT_SERVICE_NAME][key]))

  target.requires = target.requires || {}
  target.requires[EXT_SERVICE_NAME] = config // overwrite ext.service key, though
  return target
}
