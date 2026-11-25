FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
EXPOSE 8080
CMD ["node", "server/cloud-run.js"]
