import { Router } from 'express'

const router = Router()

router.get('/ai-usage', async (_req, res) => {
  res.json({
    totalTokensInput: 0,
    totalTokensOutput: 0,
    totalCostUSD: 0,
    byModel: {},
  })
})

export default router
