export function notFound(req, res, next) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` })
}

export function errorHandler(err, req, res, next) {
  const message = err.message || 'Unexpected server error'
  const status = err.status || (message.includes('could not be found') || message.includes('not found') ? 404 : 400)
  if (process.env.NODE_ENV !== 'test') console.error(err)
  res.status(status).json({ error: message })
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}
