FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY db ./db

EXPOSE 3000

CMD ["sh", "-c", "npm run migrate && npm start"]
