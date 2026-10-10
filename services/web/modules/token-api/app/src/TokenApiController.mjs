import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'

const TokenApiController = {
  async getRanges(req, res, next) {
    try {
      const { project_id } = req.params
      // Flush unflushed edits to docstore (docs stay loaded), then read all docs from there.
      await DocumentUpdaterHandler.promises.flushProjectToMongo(project_id)
      const docs = await DocstoreManager.promises.getAllRanges(project_id)
      res.json(docs.map(doc => ({ id: doc._id, ranges: doc.ranges ?? {} })))
    } catch (err) {
      next(err)
    }
  },
}

export default TokenApiController
