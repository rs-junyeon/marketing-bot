# 마케팅 봇 공용 엔진. 런타임 의존성이 없어 소스만 복사한다 (Node 26 TypeScript 직접 실행).
FROM node:26-slim
ENV NODE_ENV=production \
    ENGINE_HOST=0.0.0.0 \
    ENGINE_PORT=3200 \
    ENGINE_DB_PATH=/data/engine.db
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
COPY config ./config
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3200/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/engine/main.ts"]
