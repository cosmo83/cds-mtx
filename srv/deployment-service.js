const cds = require ('@sap/cds/lib')
module.exports = async function DeploymentService() {

  // Actually not a specific service implementation but simply bootstrapping all plugins...

  if (!cds.requires.db) throw new Error(`No database configured. Check configuration for 'cds.requires.db'`)

  const { fs, path, local } = cds.utils
  const dir = path.join(__dirname,'plugins')
  const plugins = (await fs.promises.readdir(dir))
  .filter (each => each.endsWith('.js'))
  .map (each => path.join(dir,each))

  const loaded = plugins.map(each => ({ file:each, module:require(each) }))

  const DEBUG = cds.debug('mtx')
  DEBUG && cds.once('served', ()=>{ //> prints debug output nicely at the end
    DEBUG ('loading deployer plugins:\n')
    plugins.forEach (p => DEBUG ('\x1b[2m ', local(p), '\x1b[0m'))
    console.debug()
    loaded.forEach (({ file, module:m }) => { if (m.activated) {
      DEBUG ('activated deployer plugin:', { for: m.activated, impl: local(file) })
    }})
  })

}
