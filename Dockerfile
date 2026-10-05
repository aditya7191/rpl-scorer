FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js storage.js ./
COPY reg ./reg
COPY assets ./assets
COPY public ./public
ENV PORT=8080 RPL_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
