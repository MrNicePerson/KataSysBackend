import { MongoMemoryServer } from 'mongodb-memory-server'

const mongo = await MongoMemoryServer.create({ instance: { dbName: 'katasys_local_test' } })
process.env.MONGODB_URI = mongo.getUri()
process.env.MONGODB_DB = 'katasys_local_test'
process.env.JWT_SECRET = 'local-only-katasys-development-secret-2026'
process.env.CORS_ORIGIN = 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5175,http://127.0.0.1:5175'
process.env.PORT = '5000'
process.env.NODE_ENV = 'development'

console.log('Isolated MongoDB started for local development')
await import('./server.js')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => mongo.stop().catch(() => {}))
}
