# Fly.io 배포용 Dockerfile — 멀티스테이지로 이미지를 가볍게 유지함.
# 레이아웃은 로컬과 동일: /app/backend 가 /app/frontend/dist 를 정적 서빙함.

# ---- 1단계: 프론트엔드 빌드 (frontend/dist 생성) ----
FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 2단계: 백엔드 운영 의존성만 설치 ----
FROM node:22-slim AS backend-deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

# ---- 3단계: 실행 이미지 ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Fly의 internal_port(8080)와 맞춤. 앱은 process.env.PORT 로 이 값을 읽어 0.0.0.0에 바인딩함.
ENV PORT=8080
WORKDIR /app/backend

# 백엔드 소스 + 운영 의존성
COPY backend/ ./
COPY --from=backend-deps /app/backend/node_modules ./node_modules
# 빌드된 프론트엔드 (백엔드가 ../frontend/dist 를 서빙)
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

EXPOSE 8080
CMD ["node", "server.js"]
