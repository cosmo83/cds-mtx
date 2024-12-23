const path = require('path')
const fs = require('fs').promises
const mtxAdapter = require('./mtx-adapter')
const { build } = require('./extension-project-builder')
module.exports.DEFAULT_TAG = 'migrated'

module.exports.getExtensionTag = function (filename, tagRegexString, defaultTag = module.exports.DEFAULT_TAG) {
    if (!tagRegexString) return defaultTag
    const regex = new RegExp(tagRegexString)
    const match = filename.match(regex)
    return match?.[1] ? match[1] : defaultTag
}

module.exports.createProjects = async function (mtxExtension, dir, tagRegex, defaultTag = module.exports.DEFAULT_TAG) {

    const validTags = []

    const extensions = _splitExtensionByTag(mtxExtension, tagRegex, defaultTag)

    for (const [tag, extension] of Object.entries(extensions)) {

        const projectFolder = path.join(dir, tag)
        try {
            await fs.rm(projectFolder, { recursive: true, force: true })
        } catch {
            // ignore
        }
        await fs.mkdir(projectFolder, { recursive: true })
        // extension is a map of files
        await mtxAdapter.writeFilesFromMap(Array.from(extension), projectFolder)
        // overwrite package.json
        await _writePackageJson(projectFolder, tag, '_base')

        // keep in mind to avoid parallel execution !! - use runner from old mtx?

        try {
            await build({ project: projectFolder })
        } catch (error) {
            if (error.code !== 'MODEL_NOT_FOUND') throw error
            // ignore extensions with no model
            continue
        }
        validTags.push(tag)
    }

    return validTags
}

function _splitExtensionByTag(mtxExtension, tagRegex, defaultTag) {

    const result = {}

    // create separate tags
    for (const [file, content] of mtxExtension) {
        if (!file.startsWith('node_modules')) {
            const tag = module.exports.getExtensionTag(file, tagRegex, defaultTag)
            if (!result[tag]) result[tag] = new Map()
            result[tag].set(file, content)
        }
    }

    // add node modules to each project to allow build
    for (const [file, content] of mtxExtension) {
        if (file.startsWith('node_modules')) {
            for (const tag in result) {
                result[tag].set(file, content)
            }
        }
    }

    return result
}

async function _writePackageJson(dir, name, main) {
    const packageJson = {
        "name": name,
        "version": "1.0.0",
        "description": "Generated extension project",
        "cds": {
            "extends": main
        }
    }

    // add compiler settings from main
    packageJson.cds.cdsc = cds.env.cdsc

    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson, 2))
}