FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV RAGLENS_HOST=0.0.0.0
ENV RAGLENS_PORT=4177
ENV RAGLENS_DATA_DIR=/data

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN addgroup -S raglens && adduser -S raglens -G raglens
RUN mkdir -p /data && chown -R raglens:raglens /data /app

USER raglens

EXPOSE 4177

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4177/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
