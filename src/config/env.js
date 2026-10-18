import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


// =====================================================
// LOAD .ENV FILE
// =====================================================

const root = path.resolve(
  path.dirname(
    fileURLToPath(import.meta.url)
  ),
  '../..'
)

dotenv.config({
  path: path.join(
    root,
    '.env'
  ),
})


// =====================================================
// ENVIRONMENT CONFIGURATION
// =====================================================

export const env = {

  // ===================================================
  // SERVER
  // ===================================================

  port:
    Number(
      process.env.PORT || 5000
    ),

  nodeEnv:
    process.env.NODE_ENV ||
    'development',


  // ===================================================
  // MONGODB
  // ===================================================

  mongoUri:
    process.env.MONGODB_URI,

  mongoDb:
    process.env.MONGODB_DB ||
    'kataSys',


  // ===================================================
  // JWT
  // ===================================================

  jwtSecret:
    process.env.JWT_SECRET,

  jwtExpiresIn:
    process.env.JWT_EXPIRES_IN ||
    '7d',


  // ===================================================
  // CORS
  // ===================================================

  // Example Render value:
  //
  // CORS_ORIGIN=http://localhost:5173,https://kata-sys-frontend.vercel.app
  //
  // This converts the value into:
  //
  // [
  //   "http://localhost:5173",
  //   "https://kata-sys-frontend.vercel.app"
  // ]

  corsOrigins:
    (
      process.env.CORS_ORIGIN ||
      'http://localhost:5173'
    )
      .split(',')
      .map(
        (origin) =>
          origin.trim()
      )
      .filter(Boolean),


  // ===================================================
  // SEED ADMIN
  // ===================================================

  seedAdminEmail:
    process.env.SEED_ADMIN_EMAIL,

  seedAdminPassword:
    process.env.SEED_ADMIN_PASSWORD,

}


// =====================================================
// VALIDATION
// =====================================================

if (!env.mongoUri) {

  throw new Error(
    'MONGODB_URI is missing. Add it to Backend/.env'
  )

}


if (!env.jwtSecret) {

  throw new Error(
    'JWT_SECRET is missing. Add a unique secret to Backend/.env'
  )

}


// =====================================================
// JWT SECRET VALIDATION
// =====================================================

if (
  env.nodeEnv === 'production' &&
  env.jwtSecret.length < 32
) {

  throw new Error(
    'JWT_SECRET must be set to a unique value of at least 32 characters in production.'
  )

}


if (
  env.nodeEnv !== 'production' &&
  env.jwtSecret.length < 32
) {

  console.warn(
    'JWT_SECRET should be at least 32 characters long.'
  )

}