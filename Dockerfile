FROM node:20-alpine
WORKDIR /app
COPY catalog.json ./catalog.json
COPY assets ./assets
COPY server.js ./server.js
ENV PORT=8787
# 127.0.0.1 (not localhost): alpine resolves localhost to ::1 first and
# node listens on IPv4 only -> healthcheck would false-fail.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO http://127.0.0.1:8787/healthz || exit 1
EXPOSE 8787
CMD ["node", "server.js"]
