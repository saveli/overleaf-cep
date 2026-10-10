import logger from '@overleaf/logger'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import tokenProjectAccess from './TokenApiAuthMiddleware.mjs'
import TokenApiController from './TokenApiController.mjs'

const rateLimiter = new RateLimiter('token-api', { points: 60, duration: 60 })

export default {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    logger.debug({}, 'Init token-api router')

    const guard = [
      RateLimiterMiddleware.rateLimit(rateLimiter, { ipOnly: true }),
      tokenProjectAccess,
    ]

    publicApiRouter.get(
      '/api/v1/project/:project_id/ranges',
      ...guard,
      TokenApiController.getRanges
    )
  },
}
