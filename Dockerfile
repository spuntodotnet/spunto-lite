FROM node:24-bookworm-slim

# better-sqlite3 needs a toolchain if no prebuild matches; ca-certificates for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80

CMD ["npm", "run", "start"]
