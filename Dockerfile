FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js ./
COPY engines ./engines
COPY config/extra-playlists.example.json ./config/extra-playlists.example.json
# Informe de salud persistente (`reports/health.json`).
RUN mkdir -p reports config && chown -R node:node reports config
VOLUME ["/app/reports"]
USER node
EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080
# Las listas privadas NO se hornean en la imagen: se montan en
# `/app/config/extra-playlists.json` o se pasan por `EXTRA_PLAYLISTS`.
CMD ["node", "index.js"]
