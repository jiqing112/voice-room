# syntax=docker/dockerfile:1
# voice-rooms 前端镜像（SvelteKit adapter-node）：构建阶段装全量 devDependencies，
# 构建完成后重装纯生产依赖，运行镜像只带 build/ + node_modules
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
	# --ignore-scripts：跳过 prepare 钩子（生产目录里没有 svelte-kit，会报错）
	&& npm ci --omit=dev --ignore-scripts

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "build/index.js"]
