FROM node:18-alpine AS builder
WORKDIR /build
COPY package*.json ./
COPY client/package*.json ./client/
COPY mobile/package*.json ./mobile/
RUN npm ci
RUN cd client && npm ci && cd ..
RUN cd mobile && npm ci && cd ..
COPY . .
RUN npm run build:all

FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache dumb-init
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/client/dist ./client/dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 5000) + '/api/admin/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"
EXPOSE 5000
ENTRYPOINT ["/usr/sbin/dumb-init", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
