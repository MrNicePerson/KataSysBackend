import cors from 'cors'
import express from 'express'
import mongoose from 'mongoose'
import { env } from './config/env.js'
import { connectDatabase } from './config/db.js'
import { authRequired } from './middleware/auth.js'
import { errorHandler, notFound } from './middleware/errorHandler.js'
import { authRouter } from './routes/auth.routes.js'
import { adminRouter } from './routes/admin.routes.js'
import { claimsRouter } from './routes/claims.routes.js'
import { chequesRouter } from './routes/cheques.routes.js'
import { customersRouter } from './routes/customers.routes.js'
import { financeRouter } from './routes/finance.routes.js'
import { ordersRouter } from './routes/orders.routes.js'
import { productsRouter } from './routes/products.routes.js'
import { purchasesRouter } from './routes/purchases.routes.js'
import { reportsRouter } from './routes/reports.routes.js'
import { returnsRouter } from './routes/returns.routes.js'
import { salesRouter } from './routes/sales.routes.js'
import { suppliersRouter } from './routes/suppliers.routes.js'
import { workspaceRouter } from './routes/workspace.routes.js'

const app = express()

app.disable('x-powered-by')

app.use(cors({ origin: env.corsOrigin }))
app.use(express.json({ limit: '2mb' }))

// Root route
app.get('/', (_req, res) => {
  res.status(200).json({
    message: 'KataSys API is running',
    status: 'success',
    database:
      mongoose.connection.readyState === 1
        ? 'connected'
        : 'disconnected',
  })
})

// Health check
app.get('/api/health', (_req, res) => {
  res
    .status(mongoose.connection.readyState === 1 ? 200 : 503)
    .json({
      status:
        mongoose.connection.readyState === 1
          ? 'ok'
          : 'unavailable',
      database:
        mongoose.connection.readyState === 1
          ? 'connected'
          : 'disconnected',
    })
})

// Authentication routes
app.use('/api/auth', authRouter)

// Protected API routes
const protectedApi = express.Router()

protectedApi.use(authRequired)

protectedApi.use('/workspace', workspaceRouter)
protectedApi.use('/sales', salesRouter)
protectedApi.use('/products', productsRouter)
protectedApi.use('/purchases', purchasesRouter)
protectedApi.use('/customers', customersRouter)
protectedApi.use('/suppliers', suppliersRouter)
protectedApi.use('/cheques', chequesRouter)
protectedApi.use('/returns', returnsRouter)
protectedApi.use('/orders', ordersRouter)
protectedApi.use('/claims', claimsRouter)
protectedApi.use('/finance', financeRouter)
protectedApi.use('/reports', reportsRouter)
protectedApi.use('/admin', adminRouter)

app.use('/api', protectedApi)

// 404 handler
app.use(notFound)

// Global error handler
app.use(errorHandler)

// Start database and server
const server = await connectDatabase().then(() =>
  app.listen(env.port, () => {
    console.log(`KataSys API listening on port ${env.port}`)
  })
)

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      mongoose
        .disconnect()
        .finally(() => process.exit(0))
    })
  })
}