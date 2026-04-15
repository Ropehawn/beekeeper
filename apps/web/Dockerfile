FROM node:20-alpine
WORKDIR /app

# Copy web app files
COPY apps/web/package.json ./
RUN npm install --production

COPY apps/web/server.js ./
COPY apps/web/public/ ./public/

EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
