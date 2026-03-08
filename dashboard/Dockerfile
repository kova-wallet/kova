FROM node:20-slim AS base

# Install dependencies for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Install SDK dependencies first (parent directory) ────────────────────
COPY package.json ../package.json
COPY package-lock.json* ../package-lock.json
RUN cd .. && npm install --omit=dev

# ── Install dashboard dependencies ───────────────────────────────────────
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install

# ── Copy SDK source ──────────────────────────────────────────────────────
COPY src/ ../src/

# ── Copy dashboard source ───────────────────────────────────────────────
COPY dashboard/ ./

# ── Build ────────────────────────────────────────────────────────────────
RUN npm run build

# ── Production image ─────────────────────────────────────────────────────
FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Copy built app
COPY --from=base /app/.next ./.next
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./package.json
COPY --from=base /app/public ./public
COPY --from=base /src ../src
COPY --from=base /node_modules ../node_modules

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "start"]
