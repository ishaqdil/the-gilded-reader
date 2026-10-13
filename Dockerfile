# The Gilded Cage — container image for free-tier Docker hosts.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# The app listens on $PORT (default 3000). SQLite data dir is created at runtime;
# set DATABASE_URL (e.g. Neon/Supabase Postgres) for permanent storage.
EXPOSE 3000
CMD ["npm", "start"]
