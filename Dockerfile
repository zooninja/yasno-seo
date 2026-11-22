# Ясно SEO в контейнер. Пускане: docker compose up -d  (виж README, „Инсталиране с Docker“)
FROM node:24-alpine

ENV NODE_ENV=production \
    YASNO_DOCKER=1 \
    YASNO_LISTEN=0.0.0.0 \
    PORT=4321 \
    TZ=Europe/Sofia

WORKDIR /app

# Първо само зависимостите, за да се кешират между сглобяванията
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

# Данните (ключове, проекти, одити) живеят във volume, собственост на потребителя node
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
USER node

# 4321: основният порт (и входът в Google); 80: адресът без порт, http://yasno.seo.localhost
EXPOSE 4321 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4321/api/gsc/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
