const cds = require('@sap/cds')
const LOG = cds.log('mtx'), { read, readdir, path, tar } = cds.utils
const { promisify } = require('util')

const readData = async function (extension, root) {
  await tar.xvz(extension).to(root)

  let extCsn = {}
  try { extCsn = JSON.parse(await read(path.join(root, 'extension.csn'))) }
  catch(e) { if (e.code !== 'ENOENT') throw e }

  let bundles
  try { bundles = await read(path.join(root, 'i18n', 'i18n.json')) }
  catch(e) { if (e.code !== 'ENOENT') throw e }

  let csvs = {}
  try {
    const dirents = await readdir(path.join(root, 'data'))
    for (const dirent of dirents) {
      const basename = path.basename(dirent)
      csvs[basename] = await read(path.join(root, 'data', dirent))
    }
  }
  catch(e) { if (e.code !== 'ENOENT') throw e }
  return { extCsn, bundles, csvs }
}

// REVISIT: opt-in/out retry mechanism on runtime layer?
// Sketch: cds.tx({ tenant: 't1', retries: 2 }, ...)
// Not for all error cases a retry is an appropriate handling mechanism (e.g. 403)
// -> error code allow/blocklist

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [retryCount=5]
 * @param {number} [initialRetryGap=5000]
 * @returns {Promise<T>}
 */
const retry = async (fn, retryCount = cds.requires.multitenancy?.retries ?? 10, initialRetryGap = 5000) => {
  let errorCount = 0
  let finalError
  let retryGap = initialRetryGap
  while (errorCount < retryCount - 1) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof TypeError) throw e
      if (e.code === 400) throw e
      if (e.code === 404) throw e
      // REVISIT: ugly -> shouldn't have to code for specific DBs
      if (e.code === 'SQLITE_ERROR') throw e
      if (e.code === 259 && e.sqlState === 'HY000' && /could not find table/i.test(e.message)) throw e
      finalError = e
      errorCount++
      LOG.error('attempt', errorCount, 'errored with', e, '- retrying attempt', errorCount + 1, 'of', retryCount)
      await promisify(setTimeout)(retryGap)
      retryGap *= 1.5
    }
  }
  LOG.error(`exceeded maximum number of ${retryCount} retries`)
  throw finalError
}

const t0 = cds.env.requires.multitenancy?.t0 ?? 't0'
let _t0Csn
const t0_ = async (query) => retry(async () => {
  _t0Csn ??= cds.compile.for.nodejs(
    await cds.load(`${__dirname}/../db/t0.cds`, { silent: true })
  )
  return cds.tx({ tenant: t0 }, tx => { tx.model = _t0Csn; return tx.run(query) })
})

module.exports = {
  t0_,
  retry,
  readData
}
