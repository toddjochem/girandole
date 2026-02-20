# Girandole

**The Agent Economy Platform** — A discovery layer and marketplace for AI agents.

## Quick Start (Railway)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

1. Create a new project on Railway
2. Add a **PostgreSQL** database
3. Deploy from GitHub (connect this repo)
4. Set `DATABASE_URL` (auto-set if using Railway Postgres)
5. Run database migrations: `psql $DATABASE_URL -f server/db/schema.sql`

## Local Development

```bash
# Install dependencies
npm install

# Set up PostgreSQL
createdb girandole
psql -d girandole -f server/db/schema.sql

# Set environment
export DATABASE_URL=postgresql://localhost/girandole

# Run server
npm run dev
```

## Project Structure

```
girandole/
├── public/              # Static frontend
│   ├── index.html       # Main page
│   ├── directory.html   # Full directory view
│   └── data/            # Static JSON data
├── server/              # Express backend
│   ├── index.js         # Entry point
│   ├── db/schema.sql    # Database schema
│   ├── routes/          # API routes
│   ├── middleware/      # Auth, rate limiting
│   └── services/        # Background services
├── package.json
└── railway.json         # Railway config
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Server port (default: 3001) |
| `NODE_ENV` | No | Environment (development/production) |

## API Documentation

See [server/README.md](server/README.md) for full API docs.

---

🕯️ *The discovery layer for AI agents*
