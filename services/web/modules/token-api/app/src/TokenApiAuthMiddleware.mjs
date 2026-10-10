import logger from '@overleaf/logger'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import GitBridgePATManager from '../../../git-bridge/app/src/GitBridgePATManager.mjs'

const ID_PARAMS = ['project_id', 'doc_id', 'thread_id']
const ID_REGEX = /^[0-9a-f]{24}$/

function unauthorized(req, res, reason) {
  logger.info({ ip: req.ip, path: req.path, reason }, 'token-api: unauthorized')
  res.status(401).json({ error: 'unauthorized' })
}

function notFound(res) {
  res.status(404).json({ error: 'not found' })
}

export default async function tokenProjectAccess(req, res, next) {
  try {
    const header = req.headers.authorization || ''
    const [scheme, token] = header.trim().split(/\s+/, 2)
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return unauthorized(req, res, 'missing or malformed authorization header')
    }
    const userId = await GitBridgePATManager.getUserId(token)
    if (!userId) return unauthorized(req, res, 'invalid token')

    for (const name of ID_PARAMS) {
      const value = req.params[name]
      if (value !== undefined && !ID_REGEX.test(value)) return notFound(res)
    }
    const projectId = req.params.project_id
    if (!projectId) return notFound(res)

    let allowed
    try {
      allowed = await AuthorizationManager.promises.canUserReadProject(
        userId,
        projectId,
        null
      )
    } catch (err) {
      if (err instanceof Errors.NotFoundError) return notFound(res)
      throw err
    }
    if (!allowed) return notFound(res)

    req.tokenUserId = userId
    res.on('finish', () => {
      logger.info(
        {
          userId,
          projectId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
        },
        'token-api request'
      )
    })
    next()
  } catch (err) {
    next(err)
  }
}
