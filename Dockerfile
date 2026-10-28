FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

CMD ["node", "src/index.js"]
