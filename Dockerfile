FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
EXPOSE 8436
CMD ["node", "src/server.js"]
