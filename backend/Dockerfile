FROM node:22-alpine AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY onec-config.example.yml ./onec-config.example.yml

ARG APP_VERSION=1.0.0
ARG BACKEND_VERSION=1.0.0
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown

ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}
ENV BACKEND_VERSION=${BACKEND_VERSION}
ENV GIT_COMMIT=${GIT_COMMIT}
ENV BUILD_TIME=${BUILD_TIME}
EXPOSE 3000

CMD ["node", "src/server.js"]
