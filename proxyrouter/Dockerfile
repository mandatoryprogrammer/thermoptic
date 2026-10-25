FROM node:24.22.1-alpine

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV PROXY_ROUTER_PORT=3128

EXPOSE 3128

CMD ["node", "index.js"]
