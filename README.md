# KataSys Backend

## Local setup

1. From the `Backend` directory, copy `.env.example` to `.env` and set `MONGODB_URI` to your MongoDB Atlas connection string. Keep the credential only in `Backend/.env`; the database name is configured separately as `kataSys`. Do not put `.env` in `src` or commit it.
2. Set `JWT_SECRET` to a unique random value of at least 32 characters. Set a private administrator email and a password of at least 12 characters if using the seed command.
3. Install dependencies with `npm install`.
4. Create the first administrator with `npm run seed`. The command will not create another user if any account already exists. Alternatively, the first account can be created through `POST /api/auth/register`.
5. Start the API with `npm run dev` and check `GET /api/health`.

The API defaults to port `5000`; configure the frontend origin with `CORS_ORIGIN`. Never commit `.env` or share the MongoDB credential. If a database credential has been disclosed, rotate it in Atlas before deployment.

## API groups

- `/api/auth`: bootstrap registration, login, current user, and user administration
- `/api/sales`: sale creation, invoice lookup/reprint data, search, and numbering
- `/api/products` and `/api/purchases`: stock, adjustments, batch receiving, and movements
- `/api/customers` and `/api/suppliers`: account detail, statements, payments, and recovery
- `/api/cheques` and `/api/returns`: cheque lifecycle, customer returns, and supplier returns
- `/api/orders` and `/api/claims`: held orders, reservations, partial delivery, and defect claims
- `/api/finance`: expenses, drawings/transfers, daily closing, bulk recovery, and installments
- `/api/reports`: period summaries, closing calculations, stock audit, and account ledgers
- `/api/admin`: settings, JSON backup/restore, and audit history

All business routes require a bearer token and the corresponding user permission. The health and authentication routes are public.

## GitHub and deployment

- Commit `.env.example`, but never commit `.env`. `Backend/.gitignore` excludes `.env`.
- Deploy the `Frontend` directory to Vercel as a Vite frontend.
- Deploy the `Backend` directory to Render as a Node web service. Use `npm install` as the build command and `npm start` as the start command. The root `server.js` delegates to the implementation in `src/server.js`.
- In Vercel, set `VITE_API_URL` to the Render service URL ending in `/api` (for example, `https://your-service.onrender.com/api`) and redeploy the frontend. Locally, the Vite development server proxies `/api` to `http://localhost:5000`.
- Add `MONGODB_URI`, `MONGODB_DB`, `JWT_SECRET`, `NODE_ENV`, and `CORS_ORIGIN` in Render's environment settings. Set `NODE_ENV` to `production`, use a unique JWT secret of at least 32 characters, and set `CORS_ORIGIN` to the deployed Vercel origin. Render supplies `PORT` automatically.
- Configure MongoDB Atlas network access to allow connections from the Render service.

The frontend now signs in against this API and loads authorized workspace data. Vercel and Render remain separate services, so `VITE_API_URL` and the Render `CORS_ORIGIN` must both be set to the corresponding deployed origins.