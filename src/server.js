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
import { notificationsRouter } from './routes/notifications.routes.js'
import { deliverDueNotifications } from './domain/notifications.js'

import dns from 'dns'

dns.setServers([
  '1.1.1.1',
  '8.8.8.8',
])

const app = express()

app.disable('x-powered-by')


// =====================================================
// CORS CONFIGURATION
// =====================================================

const allowedOrigins = env.corsOrigins

app.use(
  cors({
    origin: (origin, callback) => {

      // Allow requests without an Origin
      // Example: Postman or server-to-server requests
      if (!origin) {
        return callback(null, true)
      }

      // Allow only configured origins
      if (allowedOrigins.includes(origin)) {
        return callback(null, true)
      }

      return callback(
        new Error(`CORS: Origin ${origin} not allowed`)
      )
    },

    credentials: true,
  })
)


// =====================================================
// BODY PARSER
// =====================================================

app.use(
  express.json({
    limit: '2mb',
  })
)


// =====================================================
// ROOT ROUTE
// =====================================================

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


// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/api/health', (_req, res) => {

  const connected =
    mongoose.connection.readyState === 1

  res
    .status(connected ? 200 : 503)
    .json({

      status:
        connected
          ? 'ok'
          : 'unavailable',

      database:
        connected
          ? 'connected'
          : 'disconnected',

    })

})


// =====================================================
// AUTHENTICATION ROUTES
// =====================================================

app.use(
  '/api/auth',
  authRouter
)


// =====================================================
// PROTECTED API ROUTES
// =====================================================

const protectedApi = express.Router()

protectedApi.use(authRequired)


// Workspace
protectedApi.use(
  '/workspace',
  workspaceRouter
)

protectedApi.use('/notifications', notificationsRouter)


// Sales
protectedApi.use(
  '/sales',
  salesRouter
)


// Products
protectedApi.use(
  '/products',
  productsRouter
)


// Purchases
protectedApi.use(
  '/purchases',
  purchasesRouter
)


// Customers
protectedApi.use(
  '/customers',
  customersRouter
)


// Suppliers
protectedApi.use(
  '/suppliers',
  suppliersRouter
)


// Cheques
protectedApi.use(
  '/cheques',
  chequesRouter
)


// Returns
protectedApi.use(
  '/returns',
  returnsRouter
)


// Orders
protectedApi.use(
  '/orders',
  ordersRouter
)


// Claims
protectedApi.use(
  '/claims',
  claimsRouter
)


// Finance
protectedApi.use(
  '/finance',
  financeRouter
)


// Reports
protectedApi.use(
  '/reports',
  reportsRouter
)


// Admin
protectedApi.use(
  '/admin',
  adminRouter
)


// Mount protected routes
app.use(
  '/api',
  protectedApi
)


// =====================================================
// 404 HANDLER
// =====================================================

app.use(notFound)


// =====================================================
// GLOBAL ERROR HANDLER
// =====================================================

app.use(errorHandler)


// =====================================================
// DATABASE + SERVER
// =====================================================

const server = await connectDatabase().then(() => {

  const notificationWorker = setInterval(() => {
    deliverDueNotifications().catch((error) => console.error('Notification scheduler failed:', error.message))
  }, 60_000)
  notificationWorker.unref()
  deliverDueNotifications().catch((error) => console.error('Notification scheduler failed:', error.message))

  return app.listen(
    env.port,
    () => {

      console.log(
        `KataSys API listening on port ${env.port}`
      )

      console.log(
        'Allowed CORS origins:',
        allowedOrigins
      )

    }
  )

})


// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

for (
  const signal of ['SIGINT', 'SIGTERM']
) {

  process.on(signal, () => {

    server.close(() => {

      mongoose
        .disconnect()
        .finally(() => {
          process.exit(0)
        })

    })

  })

}