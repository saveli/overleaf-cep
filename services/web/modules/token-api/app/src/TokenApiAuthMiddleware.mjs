import logger from '@overleaf/logger'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import PrivilegeLevels from '../../../../app/src/Features/Authorization/PrivilegeLevels.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import GitBridgePATManager from '../../../git-bridge/app/src/GitBridgePATManager.mjs'

const ID_PARAMS = ['project_id', 'doc_id', 'thread_id']
export const ID_REGEX = /^[0-9a-f]{24}$/
const BEARER = /^Bearer\s+(\S+)$/i

// Members only: no site-admin shortcut, no legacy public access.
const MEMBER_LEVELS = [
  PrivilegeLevels.OWNER,
  PrivilegeLevels.READ_AND_WRITE,
  PrivilegeLevels.READ_ONLY,
  PrivilegeLevels.REVIEW,
]

function unauthorized(req, res, reason) {
  logger.info({ ip: req.ip, path: req.path, reason }, 'token-api: unauthorized')
  res.status(401).json({ error: 'unauthorized' })
}

export function notFound(res) {
  res.status(404).json({ error: 'not found' })
}

export default async function tokenProjectAccess(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store')
    const match = BEARER.exec((req.headers.authorization || '').trim())
    if (!match) {
      return unauthorized(req, res, 'missing or malformed authorization header')
    }
    const userId = await GitBridgePATManager.getUserId(match[1])
    if (!userId) return unauthorized(req, res, 'invalid token')

    const projectId = req.params.project_id
    // One audit line per authenticated request, including 404s and aborted
    // connections ('close' fires in both cases, 'finish' only on success).
    res.on('close', () => {
      logger.info(
        {
          userId,
          projectId,
          method: req.method,
          path: req.path,
          status: res.writableFinished ? res.statusCode : 'aborted',
        },
        'token-api request'
      )
    })

    for (const name of ID_PARAMS) {
      const value = req.params[name]
      if (value !== undefined && !ID_REGEX.test(value)) return notFound(res)
    }
    if (!projectId) return notFound(res)

    let level
    try {
      level = await AuthorizationManager.promises.getPrivilegeLevelForProject(
        userId,
        projectId,
        null,
        { ignoreSiteAdmin: true, ignorePublicAccess: true }
      )
    } catch (err) {
      if (err instanceof Errors.NotFoundError) return notFound(res)
      throw err
    }
    if (!MEMBER_LEVELS.includes(level)) return notFound(res)

    req.tokenUserId = userId
    next()
  } catch (err) {
    next(err)
  }
}
