const crypto = require('crypto')
const fs = require('fs').promises
const path = require('path')
const cds = require('@sap/cds/lib'), { tar, rimraf, exists, read } = cds.utils
const { readData } = require('../lib/utils')
const { worker4 } = require('./worker/pool')
const conf = cds.requires['cds.xt.ModelProviderService'] || cds.requires.kinds['cds.xt.ModelProviderService']
const TEMP_DIR = require('fs').realpathSync(require('os').tmpdir())
const main = require('./config')

// If we run in sidecar with mocked auth, use the main app's configured mock users
if (conf.root && cds.env.requires.auth?.users) {
  cds.env.requires.auth.users = main.requires.auth.users
}
const fts = main.env.features.folders
const DEBUG = cds.debug('mtx')
if (DEBUG) cds.once('served', ()=> DEBUG ('model provider options:', conf))

const _getETagFormatted = value => `"${value}"`
const BASE_MODEL_ETAG = _getETagFormatted('basemodel')

module.exports = class ModelProviderService extends cds.ApplicationService {

  /**
   * Overload `.on` to decorate handlers to set `cds.context.tenant` based on incoming arg `tenant`.
   */
  on (event, handler) {
    return super.on(event, (req) => {
      if (req.data.tenant) cds.context = { tenant: req.data.tenant }
      // REVISIT: might not be correct when called via ExtensibilityService.add(...)
      //> const tenant = req.tenant || (req.user.is('internal-user') && req.data.tenant)
      return handler(req)
    })
  }

  init() {

    // REVISIT: We should do the enforcement only in production
    // let requires = this.definition['@requires_']
    // if (requires && process.env.NODE_ENV === 'production') this.before ('*', req => {
    //   if (!cds.context?.http) return //> not called from external
    //   if (req.user._is_anonymous) return req.reject({ code:401 })
    //   if (!requires.some(r => req.user.is(r))) return req.reject({ code:403 })
    // })

    this._in_sidecar = conf._in_sidecar

    this.before(['getCsn', 'getEdmx', 'getExtCsn', 'getI18n'], req => {
      let toggles = req.data?.toggles
      if (!toggles) return
      else if (Array.isArray(toggles)) ; //> go on below...
      else if (typeof toggles === 'object') toggles = Object.keys(toggles)
      else if (typeof toggles === 'string') toggles = toggles.split(',')
      const invalid = toggles.find(t => t !== '*' && !/^(?!.*\.\.)[\w-.]+$/.test(t))
      if (invalid) return req.reject(400, `Unsupported input toggle param ${invalid}`)
    })

    this.on('getCsn', req => _getCsn(req))

    this.on('getExtCsn', req => {
      if (!main.requires.extensibility) return req.reject(400, 'Missing extensibility parameter')
      return _getCsn (req, true)
    })

    this.on('getExtResources', getExtResources)

    // TODO save db requests, some lazy loading, abstract extension API
    // - loads needed data from extensions
    // - does merging
    // - improve _getExtension4 ?
    // - split merging

    this.on('getEdmx', async req => {
      const { res } = req._; if (res) res.set('Content-Type', 'application/xml')
      const { tenant, service, model, locale, flavor, toggles } = req.data

      if (service === 'all') return req.reject(501, `Edmx request for 'all' services not supported`)

      let precompiledEdmx = await _getPrebuiltBundle(tenant, toggles, service, flavor, model)

      delete req.data.flavor // we need to delete the OData 'flavor' argument, as getCsn has a different CSN `flavor` argument
      const csn = model ? model : await _getCsn(req)
      if (!cds.context.http || cds.context.http.res.statusCode !== 304) { // wee need to check whether the eTag handling by calling _getCsn modified the response with no modified
        if (!precompiledEdmx) {
          const edmx = cds.compile.to.edmx(csn, { service, flavor })
          const extBundle = await _getExtI18n(tenant, locale)
          return locale?.at ? cds.localize(csn, locale, edmx, extBundle) : edmx
        }
        // localization of base model without any extra i18n
        return locale?.at ? cds.localize(csn, locale, precompiledEdmx) : precompiledEdmx
      }
    })

    this.on('getI18n', async req => {
      const csn = await _getCsn(req)
      if (!cds.context.http || cds.context.http.res.statusCode !== 304) {
        const { tenant, locale } = req.data
        const baseBundle = cds.localize.bundle4(csn, locale)
        const extBundle = await _getExtI18n(tenant, locale)
        return { ...baseBundle, ...extBundle }
      }
    })

    this.on('getResources', async req => {
      let res = req.res
      if (!res?.writable) res = req.http?.res || req._.res //> REVISIT: use req.res once cds^8 is used
      if (res && !res.headersSent) res.set('content-type', 'application/octet-stream; charset=binary')

      // REVISIT: Works only w/o encoding parameter. Default encoding is 'utf8'.
      // try { return await cds.utils.read('resources.tgz') }

      // root is defined in cds.requires, in case of the sidecar scenario it is set to "_main"
      const tgzs = ['resources.tgz']
      const _inProd = process.env.NODE_ENV === 'production'
      if (!_inProd) tgzs.push('gen/srv/resources.tgz', 'gen/mtx/sidecar/_main/resources.tgz', 'mtx/sidecar/gen/_main/resources.tgz')
      for (const tgz of tgzs) {
        try { return await fs.readFile(path.resolve(main.root, tgz)) } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
      }

      const files = Object.keys(await cds.deploy.resources(['*', cds.env.features.folders]))
      if (!files.length) return req.reject(404)
      return tar.cz (files) // REVISIT: pipe to res instead of materializing buffer
    })

    this.on('isExtended', async req => {
      if (!main.requires.extensibility) return false
      if (!req.data.tenant && main.requires.multitenancy) return false
      const one = await SELECT.one(1).from('cds.xt.Extensions')
      return !!one
    })

    this.on('getExtensions', async req => {
      if (!main.requires.extensibility) return req.reject(400, 'Missing extensibility parameter')
      return await _getExtensions4(req.data.tenant) || req.reject(404, 'Missing extensions')
    })

    async function _getPrebuiltBundle(tenant, toggles, service, flavor, model) {
      const { 'cds.xt.ModelProviderService': mp } = cds.services
      const needsEdmxCompile = await mp.isExtended(tenant) || !!toggles?.length || model
      if (!needsEdmxCompile) {
        const edmxPath = path.join(main.root, 'srv/odata', flavor ?? cds.env.odata.version,`${service}.xml`)
        if (exists(edmxPath)) {
          return read(edmxPath, 'utf-8')
        }
        DEBUG?.('No precompiled bundle for', { service }, 'found in', { path: edmxPath })
      }
      return null
    }

    /** Implementation for getCsn */
    const baseCache = new Map, extensionCache = new Map
    async function _getCsn (req, checkExt) {
      let { tenant, toggles, base, flavor, for:javaornode, activated } = req.data

      if (conf._in_sidecar) {
        const eTag = base ? BASE_MODEL_ETAG : await _getETag(tenant)

        let res = req.res
        if (!res?.writable) res = req.http?.res || req._.res //> REVISIT: use req.res once cds^8 is used
        if (res && !res.headersSent) res.set('eTag', eTag)

        if (eTag === req.headers?.['if-none-match']) {
          res?.status(304)
          return req.reply()
        }
      }

      const extensions = !base && main.requires.extensibility && await _getExtensions4 (tenant, activated)
      if (!extensions && checkExt) req.reject(404, 'Missing extensions')

      if (toggles && typeof toggles === 'object' && !Array.isArray(toggles)) toggles = Object.keys(toggles)
      const features = (!toggles || !main.requires.toggles) ? [] : toggles === '*' || toggles.includes('*') ? [fts] : toggles.map (f => fts.replace('*',f))
      const models = cds.resolve (['*',...features], main); if (!models) return

      DEBUG?.('loading models for', { tenant, toggles } ,'from', models.map (cds.utils.local))

      let csn = await lru4(baseCache, JSON.stringify({ models, flavor, javaornode }), () =>
        worker4(path.join(__dirname, 'worker/load.js'), { models, flavor, javaornode })
      )

      if (extensions) {
        const key = crypto.createHash('sha256').update(JSON.stringify({ extensions, models, javaornode })).digest('hex')
        csn = lru4(extensionCache, key, () => cds.extend (csn) .with (extensions))
      }
      if (javaornode) csn = cds.compile.for[javaornode] (csn)

      return csn
    }

    /**
     * A Least Recently Used (LRU) cache.
     * @template T
     * @param {Map} cache The cache.
     * @param {string} key Unique string for cache look-up.
     * @param {() => T} fn Function producing result to be cached.
     * @returns {T}
     */
    function lru4(cache, key, fn) {
      // Starting simple, might later have different/dynamic cache sizes
      const cacheSize = cds.requires['cds.xt.ModelProviderService']?.cacheSize ?? 5
      let _csn = cache.get(key)
      if (_csn) { // cache hit: update map insertion order -> key is last in queue again
        cache.delete(key)
        cache.set(key, _csn)
      } else {
        cache.set(key, _csn = fn())
        if (cache.size > cacheSize) {
          cache.delete(cache.keys().next().value)
        }
      }
      return _csn
    }

    async function _getExtensions4 (tenant, activated = false) {
      if (!main.requires.extensibility || !tenant && main.requires.multitenancy) return
      try {
        const cqn = SELECT(['csn','tag']).from('cds.xt.Extensions').orderBy('tag','timestamp')
        if (activated) cqn.where('activated=', 'database')
        const exts = await cds.db.run(cqn)
        if (!exts.length) return

        const merged = { extensions: [], definitions: {} }
        let lastTag
        for (const { csn, tag } of exts) {
          if (lastTag === tag) continue // skip duplicates that might have been created due to race conditions
          const {definitions,extensions} = JSON.parse(csn)
          if (definitions) Object.assign (merged.definitions, definitions)
          if (extensions) merged.extensions.push (...extensions)
          lastTag = tag
        }
        return merged
      } catch (error) {
        DEBUG?.(`cds.xt.Extensions not yet deployed for tenant ${tenant}`, error) // REVISIT: Questionable usage of try-catch pattern
      }
    }

    async function _getExtI18n (tenant, locale) {
      if (!main.requires.extensibility) return
      if (!tenant && main.requires.multitenancy) return

      const cqn = SELECT('i18n').from('cds.xt.Extensions').where('i18n !=', null).orderBy('timestamp')
      const extBundles = await cds.db.run(cqn)

      const { i18n } = cds.env
      let merged = {}

      if (extBundles?.length) {
        merged = extBundles.reduce((acc, cur) => {
          const bundle = JSON.parse(cur.i18n)
          const merge = lang => acc[lang] = { ...(acc[lang] ?? {}), ...(bundle[lang] ?? {}) }
          if (locale) merge(locale)
          merge(i18n.default_language)
          merge(i18n.fallback_bundle)
          return acc
        }, {})
      }

      return { ...merged[i18n.fallback_bundle], ...merged[i18n.default_language], ...merged[locale] }
    }

    async function _getETag(tenant) {
      if (!main.requires.extensibility || main.requires.multitenancy && !tenant) return BASE_MODEL_ETAG
      try {
        const query = SELECT('max(timestamp) as ts').from('cds.xt.Extensions')
        const exts = await cds.db.run(query)
        if (!exts.length || !exts[0].ts) return BASE_MODEL_ETAG
        return _getETagFormatted(exts[0].ts)
      } catch (error) {
        DEBUG?.(`cds.xt.Extensions not yet deployed for tenant ${tenant}`, error) // REVISIT: Questionable usage of try-catch pattern
        return BASE_MODEL_ETAG
      }
    }

    async function getExtResources(req) {
      const tenant = req.data.tenant || req.tenant

      if (tenant) cds.context = { tenant }
      let extSources
      try {
        const cqn = SELECT('sources').from('cds.xt.Extensions').where('sources !=', null).orderBy('timestamp')
        extSources = await cds.db.run(cqn)
      } catch (e) {
        DEBUG?.(`cds.xt.Extensions not yet deployed for tenant ${tenant}`, e)
        return null
      }
      if (extSources && extSources.length) {
        const root = await fs.mkdtemp(`${TEMP_DIR}${path.sep}extension-`)
        try {
          // important to keep the sequence of extensions
          // readData (tar) fails to run in parallel
          for (const { sources } of extSources) {
            await readData(sources, root)
          }
          return await tar.cz (root) // REVISIT: pipe to res instead of materializing buffer
        } finally {
          rimraf (root)
        }
      }
    }

    return super.init()
  }
}

module.exports.prototype._add_stub_methods = true
